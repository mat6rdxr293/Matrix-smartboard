from __future__ import annotations

import json
import io
import logging
import time
import asyncio
import secrets
import re
import os
from pathlib import Path
from typing import Any, List, Optional
from urllib.parse import parse_qsl, quote, urlencode, urlparse, urlunparse

import httpx
import jwt as pyjwt
from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from .ai import (
    ai_stream_sink,
    generate_ai_response,
    generate_board_response,
    visible_stream_steps,
    visible_stream_text,
)
from .ocr import ocr_image
from .polynomial import candidates, divide, eval_poly, horner, horner_table, normalize
from .ratelimit import RateLimiter
from .pptx_import import import_pptx, import_pptx_full, import_pptx_stickers
from .pptx_export import export_pptx
from .m365 import M365Client, M365Error
from .settings import get_openai_key, get_server_name, is_ai_configured, is_ocr_configured, settings
from .school_routes import get_store as get_school_store
from .school_routes import require_school, router as school_router
from .server_ops import router as server_ops_router
from .school_store import SchoolStore
from .cluster import ClusterService, router as cluster_router
from .server_identity import ServerIdentity
from .progress_jobs import progress_jobs
from .lesson_generation_contract import GeneratedLesson, contract_payload, resolved_lesson_payload
from .lesson_generation_service import (
    LessonGenerationRequest,
    generate_lesson,
    list_textbook_sources,
)
from .textbook_library import (
    MAX_PDF_BYTES,
    delete_textbook,
    enqueue_textbook,
    reindex_textbook,
    render_page_image,
    search_pages,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("practice-module")

SERVER_VERSION = "0.4.0"
API_VERSION = 4
MIN_CLIENT_API_VERSION = 2
server_identity = ServerIdentity(settings.server_identity_dir)

app = FastAPI()
app.state.progress_tasks = set()
# The node id of this server in a cluster is its Server ID, so it stays the same across restarts.
server_identity.ensure()
app.state.school_store = SchoolStore(
    settings.practice_db_path, session_days=settings.school_session_days, node_id=server_identity.server_id()
)
app.include_router(school_router)
app.include_router(server_ops_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"] ,
    allow_headers=["*"],
)

rate_limiter = RateLimiter(settings.rate_limit_per_minute)

DATA_DIR = Path(__file__).parent / "data"
TASKS_FILE = DATA_DIR / "tasks.json"
SLIDES_FILE = DATA_DIR / "slides.json"
SITE_BACKGROUND_FILE = DATA_DIR / "site_background.json"
PRESENTATION_SOURCE_FILE = DATA_DIR / "presentation_source.json"
# Overridable so several servers on one machine (tests, a lab cluster) keep separate pictures.
MEDIA_DIR = Path(os.environ["MATRIX_MEDIA_DIR"]) if os.environ.get("MATRIX_MEDIA_DIR") else DATA_DIR / "media"

app.state.cluster = ClusterService(
    store=app.state.school_store,
    pin=lambda: server_identity.public_key_pin(),
    name=lambda: get_server_name(),
    media_dir=MEDIA_DIR,
)
app.include_router(cluster_router)

# Paths whose requests run the local AI; while they run they count towards this node's load.
AI_LOAD_PATHS = ("/api/ai", "/api/ocr", "/api/lesson-generation/generate", "/api/lesson-generation/jobs")


_last_url_check = 0.0


@app.middleware("http")
async def _follow_own_address(request: Request, call_next):
    # Boards reach this server at its current address; if it moved, tell the rest of the cluster.
    global _last_url_check
    if request.url.path.startswith("/api/") and not request.url.path.startswith("/api/cluster/") \
            and time.time() - _last_url_check > 60 and app.state.cluster.enabled:
        _last_url_check = time.time()
        await asyncio.to_thread(app.state.cluster.note_own_url, str(request.base_url))
    return await call_next(request)


@app.middleware("http")
async def _count_ai_load(request: Request, call_next):
    if request.method == "POST" and request.url.path.startswith(AI_LOAD_PATHS):
        with app.state.cluster.load.ai_request():
            return await call_next(request)
    return await call_next(request)
BOARD_REPLAY_FILE = DATA_DIR / "board_replay.json"
BOARD_REPLAY_LOG_FILE = DATA_DIR / "board_replay.ndjson"
AI_HISTORY_LOG_FILE = DATA_DIR / "ai_history.ndjson"
M365_TOKENS_FILE = DATA_DIR / "m365_tokens.json"
M365_STATE_FILE = DATA_DIR / "m365_state.json"
M365_AUTH_STATE_FILE = DATA_DIR / "m365_auth_state.json"
board_replay_lock = asyncio.Lock()
ai_history_lock = asyncio.Lock()
m365_client = M365Client(M365_TOKENS_FILE, M365_STATE_FILE, M365_AUTH_STATE_FILE)
SUBJECT_ID_RE = re.compile(r"^[a-z0-9_-]{2,32}$")
DEFAULT_SUBJECT_ID = "algebra"
SUBJECTS_DIR = DATA_DIR / "subjects"


def _normalize_subject(subject: Optional[str]) -> str:
    if not subject:
        return DEFAULT_SUBJECT_ID
    normalized = subject.strip().lower()
    if not SUBJECT_ID_RE.match(normalized):
        return DEFAULT_SUBJECT_ID
    return normalized


def _subject_dir(subject: Optional[str]) -> Path:
    sid = _normalize_subject(subject)
    if sid == DEFAULT_SUBJECT_ID:
        return DATA_DIR
    return SUBJECTS_DIR / sid


def _subject_storage_files(subject: Optional[str]) -> tuple[Path, Path, Path, Path]:
    base = _subject_dir(subject)
    return (
        base / "tasks.json",
        base / "slides.json",
        base / "site_background.json",
        base / "presentation_source.json",
    )


def _subject_board_files(subject: Optional[str]) -> tuple[Path, Path]:
    base = _subject_dir(subject)
    return (base / "board_replay.json", base / "board_replay.ndjson")


def _subject_ai_history_file(subject: Optional[str]) -> Path:
    return _subject_dir(subject) / "ai_history.ndjson"


@app.on_event("startup")
async def _startup_log() -> None:
    server_identity.ensure()
    app.state.cluster.start()
    has_key = bool(get_openai_key())
    logger.info("AI backend configured: %s", "yes" if is_ai_configured() else "no")
    logger.info("OPENAI_API_KEY loaded: %s", "yes" if has_key else "no")


def _rate_limit_dependency(request: Request) -> None:
    ip = request.client.host if request.client else "unknown"
    if not rate_limiter.allow(ip):
        raise HTTPException(status_code=429, detail="Слишком много запросов")


class AiRequest(BaseModel):
    mode: str = Field(..., pattern="^(hint|check|solution)$")
    problem: str
    student_attempt: Optional[str] = None
    assistant_context: Optional[str] = None
    continue_from: bool = False
    subject: Optional[str] = None
    lesson_id: Optional[str] = None
    client_message_id: Optional[str] = None
    board_context: bool = False
    board_output: bool = False
    board_state: Optional[dict[str, Any]] = None
    response_locale: Optional[str] = Field(default=None, pattern="^(ru|kk|en)$")


class AiResponse(BaseModel):
    text: str
    steps: Optional[list[dict[str, str]]] = None
    board_actions: Optional[list[dict[str, Any]]] = None


class PolyRequest(BaseModel):
    coeffs: List[float]


class EvalRequest(PolyRequest):
    x: float


class HornerRequest(PolyRequest):
    a: float


class DivideRequest(BaseModel):
    dividend: List[float]
    divisor: List[float]


class StoragePayload(BaseModel):
    tasks: list[dict]
    slides: list[dict]
    siteBackground: Optional[dict] = None
    presentationSource: Optional[dict] = None


class ExportRequest(BaseModel):
    slides: list[dict]
    filename: Optional[str] = "presentation.pptx"


class M365SessionRequest(BaseModel):
    mode: str = Field(default="view", pattern="^(view|edit)$")
    access: str = Field(default="private", pattern="^(private|public)$")
    fileId: Optional[str] = None


class M365FileRequest(BaseModel):
    fileId: Optional[str] = None


class OfficeViewerLinkPayload(BaseModel):
    url: str


class BoardReplayOp(BaseModel):
    op: str = Field(..., pattern="^(add|undo|redo|clear)$")
    stroke: Optional[dict] = None
    ts: Optional[int] = None


class BoardReplayAppendPayload(BaseModel):
    ops: list[BoardReplayOp]


def _read_json(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []


def _write_json(path: Path, data: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _read_dict(path: Path) -> Optional[dict]:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _write_dict(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _default_board_replay_state() -> dict:
    return {"strokes": [], "redo": [], "updatedAt": int(time.time() * 1000)}


def _read_board_replay_state(state_file: Path = BOARD_REPLAY_FILE) -> dict:
    data = _read_dict(state_file)
    if not data:
        return _default_board_replay_state()
    strokes = data.get("strokes", [])
    redo = data.get("redo", [])
    updated_at = data.get("updatedAt", int(time.time() * 1000))
    if not isinstance(strokes, list) or not isinstance(redo, list):
        return _default_board_replay_state()
    if not isinstance(updated_at, int):
        updated_at = int(time.time() * 1000)
    return {"strokes": strokes, "redo": redo, "updatedAt": updated_at}


def _append_board_log(ops: list[BoardReplayOp], log_file: Path = BOARD_REPLAY_LOG_FILE) -> None:
    if not ops:
        return
    log_file.parent.mkdir(parents=True, exist_ok=True)
    with log_file.open("a", encoding="utf-8") as f:
        for op in ops:
            f.write(
                json.dumps(
                    {
                        "ts": op.ts if isinstance(op.ts, int) else int(time.time() * 1000),
                        "op": op.op,
                        "stroke": op.stroke,
                    },
                    ensure_ascii=False,
                )
            )
            f.write("\n")


def _is_valid_stroke(stroke: object) -> bool:
    if not isinstance(stroke, dict):
        return False
    points = stroke.get("points")
    if not isinstance(points, list) or len(points) < 1 or len(points) > 5000:
        return False
    for p in points:
        if not isinstance(p, dict):
            return False
        x = p.get("x")
        y = p.get("y")
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            return False
    width = stroke.get("width")
    if not isinstance(width, (int, float)):
        return False
    color = stroke.get("color")
    mode = stroke.get("mode")
    if not isinstance(color, str) or mode not in {"draw", "erase"}:
        return False
    return True


def _apply_board_ops(state: dict, ops: list[BoardReplayOp]) -> dict:
    strokes = state.get("strokes", [])
    redo = state.get("redo", [])
    if not isinstance(strokes, list):
        strokes = []
    if not isinstance(redo, list):
        redo = []

    for op in ops:
        if op.op == "add":
            if _is_valid_stroke(op.stroke):
                strokes.append(op.stroke)
                redo = []
        elif op.op == "undo":
            if strokes:
                last = strokes.pop()
                redo.append(last)
        elif op.op == "redo":
            if redo:
                strokes.append(redo.pop())
        elif op.op == "clear":
            if strokes:
                strokes = []
                redo = []

    return {"strokes": strokes, "redo": redo, "updatedAt": int(time.time() * 1000)}


def _read_ndjson(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows: list[dict] = []
    try:
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                raw = line.strip()
                if not raw:
                    continue
                try:
                    item = json.loads(raw)
                except Exception:
                    continue
                if isinstance(item, dict):
                    rows.append(item)
    except Exception:
        return []
    return rows


def _read_board_replay_sessions(
    limit: int = 80,
    with_ops: bool = False,
    log_file: Path = BOARD_REPLAY_LOG_FILE,
) -> list[dict]:
    rows = _read_ndjson(log_file)
    if not rows:
        return []
    sessions: list[dict] = []
    current_ops: list[dict] = []
    current_start: int | None = None
    current_end: int | None = None
    current_add = 0
    current_undo = 0
    current_redo = 0
    current_clear = 0
    idle_gap_ms = 180_000

    def flush() -> None:
        nonlocal current_ops, current_start, current_end, current_add, current_undo, current_redo, current_clear
        if not current_ops or current_start is None or current_end is None:
            current_ops = []
            current_start = None
            current_end = None
            current_add = 0
            current_undo = 0
            current_redo = 0
            current_clear = 0
            return
        sid = f"{current_start}-{len(sessions)+1}"
        item = {
            "id": sid,
            "startTs": current_start,
            "endTs": current_end,
            "durationSec": max(1, int((current_end - current_start) / 1000)),
            "opsCount": len(current_ops),
            "addCount": current_add,
            "undoCount": current_undo,
            "redoCount": current_redo,
            "clearCount": current_clear,
        }
        if with_ops:
            item["ops"] = current_ops
        sessions.append(item)
        current_ops = []
        current_start = None
        current_end = None
        current_add = 0
        current_undo = 0
        current_redo = 0
        current_clear = 0

    for row in rows:
        op = row.get("op")
        ts = row.get("ts")
        if op not in {"add", "undo", "redo", "clear"}:
            continue
        if not isinstance(ts, int):
            ts = int(time.time() * 1000)
        if current_end is not None and ts - current_end > idle_gap_ms:
            flush()
        if current_start is None:
            current_start = ts
        current_end = ts
        op_row = {"op": op, "ts": ts}
        if op == "add":
            stroke = row.get("stroke")
            if _is_valid_stroke(stroke):
                op_row["stroke"] = stroke
                current_add += 1
            else:
                continue
        elif op == "undo":
            current_undo += 1
        elif op == "redo":
            current_redo += 1
        elif op == "clear":
            current_clear += 1
        current_ops.append(op_row)
        # split on clear only when there was real drawing before it
        if op == "clear" and len(current_ops) > 1:
            flush()

    flush()
    if limit <= 0:
        limit = 1
    sessions = sessions[-limit:]
    sessions.reverse()
    return sessions


def _append_ai_history(item: dict, history_file: Path = AI_HISTORY_LOG_FILE) -> None:
    history_file.parent.mkdir(parents=True, exist_ok=True)
    with history_file.open("a", encoding="utf-8") as f:
        f.write(json.dumps(item, ensure_ascii=False))
        f.write("\n")


def _trim_text(value: Optional[str], limit: int) -> Optional[str]:
    if value is None:
        return None
    if len(value) <= limit:
        return value
    return value[: limit - 1] + "…"


def _read_ai_history(limit: int = 200, history_file: Path = AI_HISTORY_LOG_FILE) -> list[dict]:
    rows = _read_ndjson(history_file)
    if limit <= 0:
        limit = 1
    if len(rows) > limit:
        rows = rows[-limit:]
    rows.reverse()
    return rows


def _external_base_url(request: Request) -> str:
    if settings.public_base_url:
        return settings.public_base_url.strip().rstrip("/")

    forwarded_proto = request.headers.get("x-forwarded-proto")
    forwarded_host = request.headers.get("x-forwarded-host")
    host = (forwarded_host or request.headers.get("host") or "").strip()
    proto = forwarded_proto or request.url.scheme
    if host and not host.startswith(("127.0.0.1", "localhost")):
        return f"{proto}://{host}".rstrip("/")

    origin = request.headers.get("origin")
    if origin and origin.startswith(("http://", "https://")):
        try:
            parsed = urlparse(origin)
            if parsed.netloc:
                return f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
        except Exception:
            pass

    referer = request.headers.get("referer")
    if referer and referer.startswith(("http://", "https://")):
        try:
            parsed = urlparse(referer)
            if parsed.scheme and parsed.netloc:
                return f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
        except Exception:
            pass

    if host:
        return f"{proto}://{host}".rstrip("/")
    return str(request.base_url).rstrip("/")


def _normalize_office_viewer_src_url(raw_url: str) -> str:
    parsed = urlparse(raw_url)
    host = (parsed.netloc or "").lower()
    if host.endswith("1drv.ms"):
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        query["download"] = "1"
        return urlunparse(
            (
                parsed.scheme,
                parsed.netloc,
                parsed.path,
                parsed.params,
                urlencode(query),
                parsed.fragment,
            )
        )
    return raw_url


ALLOWED_ROLES = {"student", "teacher", "parent", "admin"}


@app.get("/api/auth/verify")
async def auth_verify(token: str) -> dict:
    """
    Verifies a short-lived JWT issued by the main portal backend.
    Returns { role } on success so the frontend knows which tabs to show.
    """
    secret = settings.pm_shared_secret
    if not secret:
        raise HTTPException(status_code=503, detail="PM_SHARED_SECRET not configured")
    try:
        payload = pyjwt.decode(token, secret, algorithms=["HS256"])
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except pyjwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

    role = payload.get("role", "")
    if role not in ALLOWED_ROLES:
        raise HTTPException(status_code=401, detail="Invalid role in token")

    return {"ok": True, "role": role}


def _status_payload(request: Request | None = None) -> dict:
    server_identity.ensure()
    return {
        "ok": True,
        "product": "matrix-smartboard",
        "serverVersion": SERVER_VERSION,
        "apiVersion": API_VERSION,
        "minClientApiVersion": MIN_CLIENT_API_VERSION,
        "serverId": server_identity.server_id(),
        "serverName": get_server_name(),
        "publicKeyPin": server_identity.public_key_pin(),
        "tls": bool(request is not None and request.url.scheme == "https"),
        "ai": is_ai_configured(),
        "ocr": is_ocr_configured(),
        # Background AI jobs keep running after their request returns, so they count too.
        "load": {**app.state.cluster.load.snapshot(), "backgroundJobs": len(app.state.progress_tasks)},
        "cluster": {"id": app.state.cluster.cluster_id, "nodeId": app.state.school_store.node_id}
        if app.state.cluster.enabled else None,
        # A board may add this server to its cluster without signing in here (see ClusterService).
        "clusterInviteOpen": app.state.cluster.open_to_invite(),
        "features": {
            "ai": is_ai_configured(),
            "ocr": is_ocr_configured(),
            "lessons": True,
            "boardOperations": True,
            # Older servers reject image operations, which would stall the board sync queue.
            "boardImages": True,
            "pptx": True,
            "mdns": True,
            "cluster": True,
        },
    }


@app.get("/api/status")
async def status(request: Request = None) -> dict:
    return _status_payload(request)


@app.get("/api/discovery")
async def discovery_status(request: Request) -> dict:
    payload = _status_payload(request)
    return {
        key: payload[key]
        for key in ("ok", "product", "serverVersion", "apiVersion", "minClientApiVersion", "serverId", "serverName", "publicKeyPin", "tls")
    }


@app.get("/api/media/{name}")
async def media_endpoint(name: str) -> FileResponse:
    safe_name = Path(name).name
    path = MEDIA_DIR / safe_name
    if not path.exists():
        # In a cluster the picture may have been uploaded to another node: fetch it once from there.
        fetched = await app.state.cluster.fetch_media(safe_name)
        if fetched is None:
            raise HTTPException(status_code=404, detail="Файл не найден")
        path = fetched
    media_type = None
    if path.suffix.lower() == ".pptx":
        media_type = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    return FileResponse(path, media_type=media_type)


def _ai_request_context(payload: AiRequest, request: Request) -> dict:
    """Checks the lesson and records the student's message, before the answer is generated."""
    subject_id = _normalize_subject(payload.subject)
    history_file = _subject_ai_history_file(subject_id)
    lesson_store = None
    school_id = None
    message_id = payload.client_message_id or secrets.token_hex(12)
    if payload.lesson_id:
        school = require_school(request)
        lesson_store = get_school_store(request)
        school_id = school["id"]
        if lesson_store.get_lesson(school_id, payload.lesson_id) is None:
            raise HTTPException(status_code=404, detail="Урок не найден")
        lesson_store.append_chat_message(
            school_id,
            payload.lesson_id,
            client_message_id=message_id,
            role="student",
            text=payload.student_attempt or payload.problem,
            mode=payload.mode,
        )
    return {
        "subject_id": subject_id,
        "history_file": history_file,
        "lesson_store": lesson_store,
        "school_id": school_id,
        "message_id": message_id,
    }


async def _answer_ai(payload: AiRequest, context: dict) -> AiResponse:
    subject_id = context["subject_id"]
    history_file = context["history_file"]
    lesson_store = context["lesson_store"]
    school_id = context["school_id"]
    message_id = context["message_id"]
    try:
        steps = None
        board_actions = None
        if payload.board_output and payload.mode in {"hint", "check", "solution"}:
            text, steps, board_actions = await asyncio.to_thread(
                generate_board_response,
                payload.mode,
                payload.problem,
                subject=payload.subject,
                board_context=payload.board_context,
                response_locale=payload.response_locale or "ru",
                include_actions=True,
                board_state=payload.board_state,
            )
        else:
            text = await asyncio.to_thread(
                generate_ai_response,
                payload.mode,
                payload.problem,
                payload.student_attempt,
                payload.assistant_context,
                payload.continue_from,
                payload.subject,
                payload.board_context,
                payload.response_locale or "ru",
            )
        async with ai_history_lock:
            _append_ai_history(
                {
                    "ts": int(time.time() * 1000),
                    "subject": subject_id,
                    "mode": payload.mode,
                    "problem": _trim_text(payload.problem, 6000),
                    "studentAttempt": _trim_text(payload.student_attempt, 6000),
                    "assistantContext": _trim_text(payload.assistant_context, 6000),
                    "continueFrom": payload.continue_from,
                    "boardContext": payload.board_context,
                    "response": _trim_text(text, 12000),
                    "ok": True,
                },
                history_file,
            )
        if lesson_store is not None and school_id is not None and payload.lesson_id:
            lesson_store.append_chat_message(
                school_id,
                payload.lesson_id,
                client_message_id=f"{message_id}:assistant",
                role="assistant",
                text=text,
                mode=payload.mode,
            )
        return AiResponse(text=text, steps=steps, board_actions=board_actions)
    except Exception as exc:  # noqa: BLE001
        async with ai_history_lock:
            _append_ai_history(
                {
                    "ts": int(time.time() * 1000),
                    "subject": subject_id,
                    "mode": payload.mode,
                    "problem": _trim_text(payload.problem, 6000),
                    "studentAttempt": _trim_text(payload.student_attempt, 6000),
                    "assistantContext": _trim_text(payload.assistant_context, 6000),
                    "continueFrom": payload.continue_from,
                    "error": _trim_text(str(exc), 1500),
                    "ok": False,
                },
                history_file,
            )
        if lesson_store is not None and school_id is not None and payload.lesson_id:
            lesson_store.append_chat_message(
                school_id,
                payload.lesson_id,
                client_message_id=f"{message_id}:assistant",
                role="assistant",
                text=str(exc),
                mode=payload.mode,
                status="error",
            )
        raise HTTPException(status_code=503, detail=f"AI недоступен: {exc}") from exc


@app.post("/api/ai", response_model=AiResponse, dependencies=[Depends(_rate_limit_dependency)])
async def ai_endpoint(payload: AiRequest, request: Request) -> AiResponse:
    return await _answer_ai(payload, _ai_request_context(payload, request))


async def _run_ai_job(job_id: str, payload: AiRequest, context: dict) -> None:
    # Only answers that are shown as written stream: a check's draft is replaced by the verdict.
    streams = payload.mode in {"hint", "solution"} or not payload.board_output
    locale = payload.response_locale or "ru"

    def sink(raw: str) -> None:
        progress_jobs.set_partial(job_id, visible_stream_text(raw), visible_stream_steps(raw, locale))

    token = ai_stream_sink.set(sink if streams else None)
    try:
        response = await _answer_ai(payload, context)
        progress_jobs.complete(job_id, response.model_dump())
    except HTTPException as exc:
        progress_jobs.fail(job_id, str(exc.detail))
    except Exception as exc:  # noqa: BLE001
        logger.exception("AI progress job failed")
        progress_jobs.fail(job_id, f"AI недоступен: {exc}")
    finally:
        ai_stream_sink.reset(token)


@app.post("/api/ai/jobs", dependencies=[Depends(_rate_limit_dependency)])
async def create_ai_job(payload: AiRequest, request: Request) -> dict:
    """The same answer as /api/ai, started in the background: polling the job shows the text
    while the model writes it instead of 15-30 s of nothing."""
    context = _ai_request_context(payload, request)
    job_id = progress_jobs.create("ai")
    _spawn_progress_task(_run_ai_job(job_id, payload, context))
    return {"jobId": job_id}


@app.get("/api/ai/jobs/{job_id}")
async def get_ai_job(job_id: str) -> dict:
    job = progress_jobs.get(job_id)
    if job is None or job.get("kind") != "ai":
        raise HTTPException(status_code=404, detail="AI job не найден")
    return job


def _spawn_progress_task(coro) -> None:
    task = asyncio.create_task(coro)
    app.state.progress_tasks.add(task)
    task.add_done_callback(app.state.progress_tasks.discard)


async def _run_ocr_job(job_id: str, data: bytes) -> None:
    try:
        def report(value: int, stage: str, completed: int | None, total: int | None) -> None:
            progress_jobs.update(
                job_id,
                progress=value,
                stage=stage,
                completed=completed,
                total=total,
            )

        text = await asyncio.to_thread(ocr_image, data, report)
        progress_jobs.complete(job_id, {"text": text})
    except Exception as exc:  # noqa: BLE001
        logger.exception("OCR progress job failed")
        progress_jobs.fail(job_id, f"OCR недоступен: {exc}")


@app.post("/api/ocr/jobs", dependencies=[Depends(_rate_limit_dependency)])
async def create_ocr_job(file: UploadFile = File(...)) -> dict:
    if file.content_type not in {"image/png", "image/jpeg"}:
        raise HTTPException(status_code=400, detail="Поддерживаются только PNG/JPEG")
    data = await file.read()
    job_id = progress_jobs.create("ocr")
    _spawn_progress_task(_run_ocr_job(job_id, data))
    return {"jobId": job_id}


@app.get("/api/ocr/jobs/{job_id}")
async def get_ocr_job(job_id: str) -> dict:
    job = progress_jobs.get(job_id)
    if job is None or job.get("kind") != "ocr":
        raise HTTPException(status_code=404, detail="OCR job не найден")
    return job


@app.post("/api/ocr", dependencies=[Depends(_rate_limit_dependency)])
async def ocr_endpoint(file: UploadFile = File(...)) -> dict:
    if file.content_type not in {"image/png", "image/jpeg"}:
        raise HTTPException(status_code=400, detail="Поддерживаются только PNG/JPEG")
    data = await file.read()
    try:
        text = await asyncio.to_thread(ocr_image, data)
        return {"text": text}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"OCR недоступен: {exc}") from exc


@app.post("/api/import/pptx", dependencies=[Depends(_rate_limit_dependency)])
async def import_pptx_endpoint(
    file: UploadFile = File(...),
    mode: str = "editable",
    with_background: bool = False,
) -> dict:
    if not file.filename or not file.filename.lower().endswith(".pptx"):
        raise HTTPException(status_code=400, detail="Нужен файл .pptx")
    data = await file.read()
    try:
        if mode == "full":
            slides = import_pptx_full(data)
        elif mode == "stickers":
            slides = import_pptx_stickers(data)
        else:
            slides = import_pptx(data)
            if with_background:
                # Try to add full-fidelity backgrounds when LibreOffice is available
                try:
                    full = import_pptx_full(data)
                    if len(full) == len(slides):
                        for idx, slide in enumerate(slides):
                            bg = full[idx].get("background")
                            if bg:
                                slide["background"] = bg
                except Exception:
                    pass
        return {"slides": slides}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Не удалось импортировать PPTX: {exc}") from exc


@app.get("/api/lesson-generation/contract")
async def lesson_generation_contract_endpoint() -> dict:
    return contract_payload()


@app.post("/api/lesson-generation/validate")
async def validate_lesson_generation_endpoint(payload: GeneratedLesson) -> dict:
    return {"ok": True, "lesson": resolved_lesson_payload(payload)}


def _local_book_ids() -> set[str]:
    return {str(book.get("id")) for book in (list_textbook_sources().get("books") or []) if isinstance(book, dict)}


async def _remote_owner(book_id: str) -> Optional[dict]:
    """The cluster member holding a textbook this server does not have, if any."""
    if not app.state.cluster.enabled or book_id in await asyncio.to_thread(_local_book_ids):
        return None
    return await app.state.cluster.book_owner(book_id)


def _forwarded(response: httpx.Response) -> Response:
    return Response(content=response.content, status_code=response.status_code,
                    media_type=response.headers.get("content-type"), headers={"Cache-Control": "private, max-age=86400"}
                    if response.status_code == 200 and response.headers.get("content-type", "").startswith("image/") else None)


@app.get("/api/lesson-generation/sources")
async def lesson_generation_sources_endpoint(local: bool = False) -> dict:
    sources = list_textbook_sources()
    if local or not app.state.cluster.enabled:
        return sources
    # Textbooks uploaded to other servers of the cluster are offered here too; their pages,
    # search and lesson generation are served by the server that holds them.
    books = list(sources.get("books") or [])
    known = {str(book.get("id")) for book in books if isinstance(book, dict)}
    for peer, book in await app.state.cluster.remote_books():
        if book["id"] not in known:
            known.add(book["id"])
            books.append({**book, "server": peer["name"]})
    return {**sources, "books": books}


@app.post("/api/textbooks/upload", dependencies=[Depends(_rate_limit_dependency)])
async def upload_textbook_endpoint(file: UploadFile = File(...)) -> dict:
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Нужен файл PDF")
    data = await file.read(MAX_PDF_BYTES + 1)
    if len(data) > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail="PDF слишком большой. Максимальный размер — 250 МБ")
    try:
        return {"book": enqueue_textbook(file.filename, data)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/textbooks/{book_id}/search")
async def search_textbook_endpoint(book_id: str, q: str, limit: int = 6):
    owner = await _remote_owner(book_id)
    if owner is not None:
        return _forwarded(await app.state.cluster.forward(owner, "GET", f"/api/textbooks/{book_id}/search", params={"q": q, "limit": limit}))
    try:
        return {"items": search_pages(book_id, q, limit=limit)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/textbooks/{book_id}/pages/{page_number}/image")
async def textbook_page_image_endpoint(book_id: str, page_number: int, width: int = 1400):
    owner = await _remote_owner(book_id)
    if owner is not None:
        return _forwarded(await app.state.cluster.forward(
            owner, "GET", f"/api/textbooks/{book_id}/pages/{page_number}/image", params={"width": width}
        ))
    try:
        path = await asyncio.to_thread(render_page_image, book_id, page_number, width)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


BOARD_IMAGE_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
MAX_BOARD_IMAGE_BYTES = 12 * 1024 * 1024


@app.post("/api/board/images", dependencies=[Depends(_rate_limit_dependency)])
async def upload_board_image(file: UploadFile = File(...)) -> dict:
    suffix = BOARD_IMAGE_TYPES.get((file.content_type or "").lower())
    if not suffix:
        raise HTTPException(status_code=400, detail="Нужна картинка PNG, JPEG или WebP")
    content = await file.read(MAX_BOARD_IMAGE_BYTES + 1)
    if not content:
        raise HTTPException(status_code=400, detail="Пустой файл")
    if len(content) > MAX_BOARD_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Картинка больше 12 МБ")
    stored_name = f"board-{int(time.time())}-{secrets.token_hex(8)}{suffix}"
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    (MEDIA_DIR / stored_name).write_bytes(content)
    app.state.school_store.record_media(stored_name, len(content))
    return {"src": f"/api/media/{stored_name}"}


@app.post("/api/textbooks/{book_id}/reindex", dependencies=[Depends(_rate_limit_dependency)])
async def reindex_textbook_endpoint(book_id: str) -> dict:
    try:
        return {"book": reindex_textbook(book_id)}
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.delete("/api/textbooks/{book_id}", dependencies=[Depends(_rate_limit_dependency)])
async def delete_textbook_endpoint(book_id: str) -> dict:
    try:
        delete_textbook(book_id)
        return {"ok": True}
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


async def _run_lesson_generation_job(job_id: str, payload: LessonGenerationRequest) -> None:
    try:
        def report(value: int, stage: str, completed: int | None, total: int | None) -> None:
            progress_jobs.update(
                job_id,
                progress=value,
                stage=stage,
                completed=completed,
                total=total,
            )

        result = await asyncio.to_thread(generate_lesson, payload, report)
        progress_jobs.complete(job_id, result)
    except ValidationError as exc:
        logger.warning("Lesson progress job failed contract validation: %s", exc)
        progress_jobs.fail(job_id, "ИИ вернул некорректный формат урока.")
    except Exception as exc:  # noqa: BLE001
        logger.exception("Lesson progress job failed")
        progress_jobs.fail(job_id, str(exc) or "Не удалось сгенерировать урок")


@app.post("/api/lesson-generation/jobs", dependencies=[Depends(_rate_limit_dependency)])
async def create_lesson_generation_job(payload: LessonGenerationRequest) -> dict:
    owner = await _remote_owner(payload.book) if payload.book and payload.sourceType != "text" else None
    if owner is not None:
        # The textbook's text index lives on another server: that server generates the lesson.
        response = await app.state.cluster.forward(owner, "POST", "/api/lesson-generation/jobs", json_body=payload.model_dump())
        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail=response.json().get("detail", "Ошибка генерации"))
        return {"jobId": f"{owner['node_id']}~{response.json()['jobId']}"}
    job_id = progress_jobs.create("lesson")
    _spawn_progress_task(_run_lesson_generation_job(job_id, payload))
    return {"jobId": job_id}


@app.get("/api/lesson-generation/jobs/{job_id}")
async def get_lesson_generation_job(job_id: str):
    if "~" in job_id:
        node_id, remote_id = job_id.split("~", 1)
        peer = app.state.cluster.peer(node_id)
        if peer is None:
            raise HTTPException(status_code=404, detail="Lesson job не найден")
        return _forwarded(await app.state.cluster.forward(peer, "GET", f"/api/lesson-generation/jobs/{remote_id}"))
    job = progress_jobs.get(job_id)
    if job is None or job.get("kind") != "lesson":
        raise HTTPException(status_code=404, detail="Lesson job не найден")
    return job


@app.post("/api/lesson-generation/generate", dependencies=[Depends(_rate_limit_dependency)])
async def generate_lesson_endpoint(payload: LessonGenerationRequest) -> dict:
    try:
        return await asyncio.to_thread(generate_lesson, payload)
    except ValidationError as exc:
        logger.warning("Generated lesson failed contract validation: %s", exc)
        raise HTTPException(
            status_code=422,
            detail="ИИ вернул некорректный формат урока. Попробуйте сгенерировать ещё раз.",
        ) from exc
    except json.JSONDecodeError as exc:
        logger.warning("Generated lesson returned malformed JSON: %s", exc)
        raise HTTPException(
            status_code=502,
            detail="ИИ вернул повреждённый ответ. Matrix Smartboard автоматически попробует другой ответ при следующей генерации.",
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("Lesson generation failed")
        raise HTTPException(status_code=503, detail="Не удалось сгенерировать урок. Попробуйте ещё раз.") from exc


def _storage_key(subject: Optional[str]) -> str:
    return f"storage:{_normalize_subject(subject)}"


def _storage_from_files(subject: Optional[str]) -> dict:
    tasks_file, slides_file, site_background_file, presentation_source_file = _subject_storage_files(subject)
    return {
        "tasks": _read_json(tasks_file),
        "slides": _read_json(slides_file),
        "siteBackground": _read_dict(site_background_file),
        "presentationSource": _read_dict(presentation_source_file),
    }


@app.get("/api/storage")
async def load_storage(subject: Optional[str] = None) -> dict:
    # Tasks and slides live in the replicated store so every server of a cluster has them; a
    # subject saved before that is read from its old files.
    stored = app.state.school_store.get_document(_storage_key(subject))
    return stored if isinstance(stored, dict) else _storage_from_files(subject)


@app.post("/api/storage")
async def save_storage(payload: StoragePayload, subject: Optional[str] = None) -> dict:
    previous = app.state.school_store.get_document(_storage_key(subject))
    previous = previous if isinstance(previous, dict) else _storage_from_files(subject)
    data = {
        "tasks": payload.tasks,
        "slides": payload.slides,
        "siteBackground": payload.siteBackground if payload.siteBackground is not None else previous.get("siteBackground"),
        "presentationSource": payload.presentationSource if payload.presentationSource is not None else previous.get("presentationSource"),
    }
    app.state.school_store.put_document(_storage_key(subject), data)
    return {"ok": True}


@app.get("/api/board/replay")
async def load_board_replay(subject: Optional[str] = None) -> dict:
    state_file, _ = _subject_board_files(subject)
    state = _read_board_replay_state(state_file)
    return {"strokes": state.get("strokes", []), "updatedAt": state.get("updatedAt")}


@app.post("/api/board/replay")
async def append_board_replay(payload: BoardReplayAppendPayload, subject: Optional[str] = None) -> dict:
    if not payload.ops:
        return {"ok": True}
    if len(payload.ops) > 300:
        raise HTTPException(status_code=400, detail="Слишком много операций в одном запросе")
    state_file, log_file = _subject_board_files(subject)
    async with board_replay_lock:
        state = _read_board_replay_state(state_file)
        next_state = _apply_board_ops(state, payload.ops)
        _write_dict(state_file, next_state)
        _append_board_log(payload.ops, log_file)
    return {"ok": True, "updatedAt": next_state.get("updatedAt")}


@app.get("/api/board/replays")
async def list_board_replays(limit: int = 80, subject: Optional[str] = None) -> dict:
    safe_limit = max(1, min(limit, 500))
    _, log_file = _subject_board_files(subject)
    sessions = _read_board_replay_sessions(limit=safe_limit, with_ops=False, log_file=log_file)
    return {"items": sessions}


@app.get("/api/board/replays/{replay_id}")
async def get_board_replay(replay_id: str, subject: Optional[str] = None) -> dict:
    _, log_file = _subject_board_files(subject)
    sessions = _read_board_replay_sessions(limit=500, with_ops=True, log_file=log_file)
    for session in sessions:
        if session.get("id") == replay_id:
            return {"item": session}
    raise HTTPException(status_code=404, detail="Replay not found")


@app.get("/api/ai/history")
async def list_ai_history(limit: int = 200, subject: Optional[str] = None) -> dict:
    safe_limit = max(1, min(limit, 1000))
    history_file = _subject_ai_history_file(subject)
    return {"items": _read_ai_history(limit=safe_limit, history_file=history_file)}


@app.post("/api/export/pptx")
async def export_pptx_endpoint(payload: ExportRequest) -> StreamingResponse:
    pptx_bytes = export_pptx(payload.slides)
    filename = payload.filename or "presentation.pptx"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return StreamingResponse(
        io.BytesIO(pptx_bytes),
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        headers=headers,
    )


@app.post("/api/export/pptx/save")
async def export_pptx_save_endpoint(payload: ExportRequest) -> dict:
    pptx_bytes = export_pptx(payload.slides)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    file_path = DATA_DIR / (payload.filename or "presentation.pptx")
    file_path.write_bytes(pptx_bytes)
    return {"ok": True, "path": str(file_path)}


@app.get("/api/m365/auth/start", dependencies=[Depends(_rate_limit_dependency)])
async def m365_auth_start() -> dict:
    try:
        url = m365_client.start_auth()
        return {"url": url}
    except M365Error as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/m365/auth/callback")
async def m365_auth_callback(code: Optional[str] = None, state: Optional[str] = None, error: Optional[str] = None):
    if error:
        html = (
            "<html><body><script>"
            "if(window.opener){window.opener.postMessage({type:'m365-auth-complete',ok:false,error:"
            + json.dumps(error)
            + "},'*');}"
            "window.close();"
            "</script>Auth failed. You can close this window.</body></html>"
        )
        return HTMLResponse(html)
    if not code:
        raise HTTPException(status_code=400, detail="Не передан authorization code")
    try:
        m365_client.finish_auth(code, state)
        html = (
            "<html><body><script>"
            "if(window.opener){window.opener.postMessage({type:'m365-auth-complete',ok:true},'*');}"
            "window.close();"
            "</script>Microsoft 365 connected. You can close this window.</body></html>"
        )
        return HTMLResponse(html)
    except M365Error as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/m365/auth/status")
async def m365_auth_status() -> dict:
    return m365_client.status()


@app.post("/api/m365/pptx/upload", dependencies=[Depends(_rate_limit_dependency)])
async def m365_upload_pptx(file: UploadFile = File(...)) -> dict:
    if not file.filename or not file.filename.lower().endswith(".pptx"):
        raise HTTPException(status_code=400, detail="Нужен файл .pptx")
    content = await file.read()
    try:
        uploaded = m365_client.upload_pptx(file.filename, content)
        source = m365_client.build_session(mode="view", access="private", file_id=uploaded.get("fileId"))
        return {"ok": True, "uploaded": uploaded, "presentationSource": source}
    except M365Error as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/m365/presentation/session", dependencies=[Depends(_rate_limit_dependency)])
async def m365_presentation_session(payload: M365SessionRequest) -> dict:
    try:
        source = m365_client.build_session(mode=payload.mode, access=payload.access, file_id=payload.fileId)
        return {"ok": True, "presentationSource": source}
    except M365Error as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/m365/presentation/public-link", dependencies=[Depends(_rate_limit_dependency)])
async def m365_public_link(payload: M365FileRequest) -> dict:
    try:
        link_state = m365_client.create_public_link(payload.fileId)
        source = m365_client.build_session(mode="view", access="public", file_id=link_state.get("fileId"))
        return {
            "ok": True,
            "publicUrl": link_state.get("publicUrl"),
            "presentationSource": source,
        }
    except M365Error as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/m365/presentation/fallback/pdf", dependencies=[Depends(_rate_limit_dependency)])
async def m365_fallback_pdf(payload: M365FileRequest) -> dict:
    try:
        pages = m365_client.make_fallback_images(payload.fileId)
        state = m365_client.status().get("presentationSource") or {
            "type": "m365",
            "mode": "view",
            "access": "private",
            "embedUrl": None,
            "fileId": payload.fileId,
            "lastSyncTs": int(time.time() * 1000),
            "fallbackPdf": pages,
        }
        state["embedUrl"] = None
        state["fallbackPdf"] = pages
        return {"ok": True, "fallbackPdf": pages, "presentationSource": state}
    except M365Error as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/m365/presentation/disconnect", dependencies=[Depends(_rate_limit_dependency)])
async def m365_disconnect() -> dict:
    m365_client.disconnect()
    return {"ok": True}


@app.post("/api/office/viewer/upload", dependencies=[Depends(_rate_limit_dependency)])
async def office_viewer_upload(request: Request, file: UploadFile = File(...)) -> dict:
    if not file.filename or not file.filename.lower().endswith(".pptx"):
        raise HTTPException(status_code=400, detail="Нужен файл .pptx")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Пустой файл")

    base_name = Path(file.filename).stem
    normalized = re.sub(r"[^A-Za-z0-9_-]+", "-", base_name).strip("-_")
    normalized = normalized[:40] or "presentation"
    stored_name = f"office-{int(time.time())}-{secrets.token_hex(4)}-{normalized}.pptx"

    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    stored_path = MEDIA_DIR / stored_name
    stored_path.write_bytes(content)

    src_url = f"{_external_base_url(request)}/api/media/{stored_name}"
    embed_url = f"https://view.officeapps.live.com/op/embed.aspx?src={quote(src_url, safe='')}"

    source = {
        "type": "office",
        "mode": "view",
        "access": "public",
        "embedUrl": embed_url,
        "fileId": stored_name,
        "lastSyncTs": int(time.time() * 1000),
        "fallbackPdf": [],
    }
    _write_dict(PRESENTATION_SOURCE_FILE, source)
    return {"ok": True, "fileUrl": src_url, "presentationSource": source}


@app.post("/api/office/viewer/link", dependencies=[Depends(_rate_limit_dependency)])
async def office_viewer_link(payload: OfficeViewerLinkPayload) -> dict:
    raw_url = payload.url.strip()
    if not raw_url:
        raise HTTPException(status_code=400, detail="Пустая ссылка")

    parsed = urlparse(raw_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail="Некорректная ссылка")

    src_url = _normalize_office_viewer_src_url(raw_url)
    lower_url = src_url.lower()
    if "view.officeapps.live.com/op/embed.aspx" in lower_url:
        embed_url = src_url
    else:
        embed_url = f"https://view.officeapps.live.com/op/embed.aspx?src={quote(src_url, safe='')}"

    source = {
        "type": "office",
        "mode": "view",
        "access": "public",
        "embedUrl": embed_url,
        "fileId": f"link-{int(time.time() * 1000)}",
        "lastSyncTs": int(time.time() * 1000),
        "fallbackPdf": [],
    }
    _write_dict(PRESENTATION_SOURCE_FILE, source)
    return {"ok": True, "presentationSource": source, "srcUrl": src_url}


@app.post("/api/normalize")
async def normalize_endpoint(payload: PolyRequest) -> dict:
    return {"coeffs": normalize(payload.coeffs)}


@app.post("/api/eval")
async def eval_endpoint(payload: EvalRequest) -> dict:
    return {"value": eval_poly(payload.coeffs, payload.x)}


@app.post("/api/candidates")
async def candidates_endpoint(payload: PolyRequest) -> dict:
    coeffs = [int(c) for c in payload.coeffs]
    return {"candidates": candidates(coeffs)}


@app.post("/api/horner")
async def horner_endpoint(payload: HornerRequest) -> dict:
    quotient, remainder = horner(payload.coeffs, payload.a)
    table = [step.value for step in horner_table(payload.coeffs, payload.a)]
    return {
        "quotient": quotient,
        "remainder": remainder,
        "table": table,
    }


@app.post("/api/divide")
async def divide_endpoint(payload: DivideRequest) -> dict:
    quotient, remainder = divide(payload.dividend, payload.divisor)
    return {"quotient": quotient, "remainder": remainder}


# Static frontend
static_dir = Path(__file__).parent / "static"


@app.get("/")
async def root():
    dev_frontend_url = os.getenv("PRACTICE_DEV_FRONTEND_URL", "").strip()
    if dev_frontend_url:
        return RedirectResponse(dev_frontend_url)
    index_file = static_dir / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    raise HTTPException(status_code=404, detail="Frontend not built")


if static_dir.exists():
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
