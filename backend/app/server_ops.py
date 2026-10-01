from __future__ import annotations

import io
import json
import os
import platform
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

import psutil
from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.background import BackgroundTasks
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .school_routes import require_school
from .settings import get_server_name, settings


router = APIRouter(prefix="/api/server", tags=["server-management"])

APP_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = APP_ROOT / "backend"
BACKEND_DATA_DIR = BACKEND_DIR / "app" / "data"
ENV_FILE = BACKEND_DIR / ".env"
VERSION_FILE = APP_ROOT / ".matrix-version"
BACKUP_PRODUCT = "matrix-smartboard-backup"
BACKUP_VERSION = 1
ALLOWED_MODELS = {"qwen2.5:7b", "qwen2.5vl:3b"}
MAX_RESTORE_BYTES = 1_000_000_000

_update_cache: tuple[float, dict[str, Any]] | None = None
_model_jobs: dict[str, dict[str, Any]] = {}
_model_jobs_lock = threading.Lock()


class ServiceAction(BaseModel):
    service: str = Field(pattern="^(backend|ollama)$")


class ModelPullRequest(BaseModel):
    model: str = Field(min_length=1, max_length=80)


def _require_management(request: Request) -> dict:
    return require_school(request)


def _run(command: list[str], *, timeout: float = 8.0) -> tuple[int, str]:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        output = (result.stdout or "") + (result.stderr or "")
        return result.returncode, output.strip()
    except Exception as exc:
        return -1, str(exc)


def _ollama_json(path: str, *, timeout: float = 2.0) -> dict[str, Any] | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:11434{path}", timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def _ollama_models() -> list[dict[str, Any]]:
    payload = _ollama_json("/api/tags")
    if not payload:
        return []
    models = payload.get("models")
    if not isinstance(models, list):
        return []
    result: list[dict[str, Any]] = []
    for item in models:
        if not isinstance(item, dict):
            continue
        result.append(
            {
                "name": str(item.get("name") or item.get("model") or ""),
                "size": int(item.get("size") or 0),
                "modifiedAt": item.get("modified_at"),
            }
        )
    return result


def _git_local_sha() -> str:
    if (APP_ROOT / ".git").exists():
        code, output = _run(["git", "-C", str(APP_ROOT), "rev-parse", "HEAD"], timeout=3)
        if code == 0 and output:
            return output.splitlines()[0].strip()
    try:
        return VERSION_FILE.read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def _latest_main_sha() -> str:
    request = urllib.request.Request(
        "https://api.github.com/repos/mat6rdxr293/Matrix-smartboard/commits/main",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "Matrix-Smartboard-Server"},
    )
    with urllib.request.urlopen(request, timeout=4) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return str(payload.get("sha") or "").strip()


def _update_capability() -> dict[str, Any]:
    system = platform.system()
    if system == "Windows":
        script = APP_ROOT / "deploy" / "update-server.ps1"
        return {"supported": script.exists(), "method": "powershell", "path": str(script)}
    helper = Path("/usr/local/sbin/matrix-smartboard-update")
    return {"supported": helper.exists(), "method": "sudo-helper", "path": str(helper)}


def _update_info(force: bool = False) -> dict[str, Any]:
    global _update_cache
    now = time.monotonic()
    local_sha = _git_local_sha()
    capability = _update_capability()

    if _update_cache and now - _update_cache[0] < 60:
        cached = dict(_update_cache[1])
        cached["localSha"] = local_sha
        cached["updateAvailable"] = bool(
            local_sha and cached.get("latestSha") and local_sha != cached.get("latestSha")
        )
        cached["canUpdate"] = bool(capability["supported"])
        cached["method"] = capability["method"]
        if not force:
            return cached

    if not force:
        return {
            "localSha": local_sha,
            "latestSha": "",
            "updateAvailable": False,
            "canUpdate": bool(capability["supported"]),
            "method": capability["method"],
            "error": None,
        }

    latest_sha = ""
    error = None
    try:
        latest_sha = _latest_main_sha()
    except Exception as exc:
        error = str(exc)

    info = {
        "localSha": local_sha,
        "latestSha": latest_sha,
        "updateAvailable": bool(local_sha and latest_sha and local_sha != latest_sha),
        "canUpdate": bool(capability["supported"]),
        "method": capability["method"],
        "error": error,
    }
    _update_cache = (now, info)
    return dict(info)


def _platform_logs() -> dict[str, str]:
    system = platform.system()
    if system == "Darwin":
        backend_path = Path("/var/tmp/matrix-smartboard.log")
        ollama_path = Path("/var/tmp/matrix-smartboard-ollama.log")
        return {
            "backend": _tail_file(backend_path),
            "ollama": _tail_file(ollama_path),
            "update": _tail_file(Path("/var/tmp/matrix-smartboard-update.log")),
        }
    if system == "Windows":
        root = Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "MatrixSmartboard"
        return {
            "backend": _tail_file(root / "backend.log"),
            "ollama": _tail_file(root / "ollama.log"),
            "update": _tail_file(root / "update.log"),
        }

    _, backend = _run(["journalctl", "-u", "matrix-smartboard", "-n", "160", "--no-pager"], timeout=5)
    _, ollama = _run(["journalctl", "-u", "ollama", "-n", "120", "--no-pager"], timeout=5)
    update_path = Path("/var/lib/matrix-smartboard/update.log")
    return {
        "backend": backend[-60_000:],
        "ollama": ollama[-60_000:],
        "update": _tail_file(update_path),
    }


def _tail_file(path: Path, max_bytes: int = 60_000) -> str:
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - max_bytes))
            return handle.read().decode("utf-8", errors="replace")[-max_bytes:]
    except Exception:
        return ""


def _gpu_info() -> dict[str, Any] | None:
    code, output = _run(
        ["nvidia-smi", "--query-gpu=name,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits"],
        timeout=3,
    )
    if code != 0 or not output:
        return None
    line = output.splitlines()[0]
    parts = [part.strip() for part in line.split(",")]
    if len(parts) < 4:
        return {"name": line}
    try:
        return {
            "name": parts[0],
            "memoryTotalMiB": int(parts[1]),
            "memoryUsedMiB": int(parts[2]),
            "utilizationPercent": float(parts[3]),
        }
    except Exception:
        return {"name": parts[0]}


def _backend_restart_supported() -> bool:
    system = platform.system()
    if system == "Darwin":
        return Path("/Library/LaunchDaemons/ru.matrixhost.smartboard.plist").exists()
    if system == "Windows":
        code, _ = _run(["schtasks.exe", "/Query", "/TN", "Matrix Smartboard Server"], timeout=3)
        return code == 0
    return Path("/etc/systemd/system/matrix-smartboard.service").exists()


def _ollama_restart_supported() -> bool:
    system = platform.system()
    if system == "Windows":
        code, _ = _run(["schtasks.exe", "/Query", "/TN", "Matrix Smartboard Ollama"], timeout=3)
        return code == 0
    if Path("/usr/local/sbin/matrix-smartboard-service-control").exists():
        return True
    return system == "Darwin"


def _system_status() -> dict[str, Any]:
    memory = psutil.virtual_memory()
    disk_target = settings.practice_db_path.parent
    try:
        disk = psutil.disk_usage(str(disk_target))
    except Exception:
        disk = psutil.disk_usage(str(APP_ROOT))
    boot = psutil.boot_time()
    models = _ollama_models()
    return {
        "serverName": get_server_name(),
        "hostname": socket.gethostname(),
        "platform": platform.system(),
        "platformRelease": platform.release(),
        "python": platform.python_version(),
        "uptimeSeconds": max(0, int(time.time() - boot)),
        "cpu": {
            "logicalCores": psutil.cpu_count(logical=True) or 0,
            "physicalCores": psutil.cpu_count(logical=False) or 0,
            "percent": psutil.cpu_percent(interval=0.12),
        },
        "memory": {
            "total": int(memory.total),
            "used": int(memory.used),
            "available": int(memory.available),
            "percent": float(memory.percent),
        },
        "disk": {
            "total": int(disk.total),
            "used": int(disk.used),
            "free": int(disk.free),
            "percent": float(disk.percent),
        },
        "gpu": _gpu_info(),
        "services": {
            "backend": True,
            "ollama": bool(models or _ollama_json("/api/tags")),
        },
        "capabilities": {
            "restartBackend": _backend_restart_supported(),
            "restartOllama": _ollama_restart_supported(),
            "update": bool(_update_capability()["supported"]),
            "backupRestore": True,
        },
        "models": models,
        "expectedModels": sorted(ALLOWED_MODELS),
        "update": _update_info(),
    }


def _restart_backend_later() -> None:
    def stop() -> None:
        time.sleep(1.0)
        os._exit(75)

    threading.Thread(target=stop, daemon=True).start()


def _restart_ollama() -> tuple[bool, str]:
    system = platform.system()
    if system == "Windows":
        script = (
            "$ErrorActionPreference='Stop'; "
            "$t=Get-ScheduledTask -TaskName 'Matrix Smartboard Ollama' -ErrorAction Stop; "
            "Stop-ScheduledTask -InputObject $t -ErrorAction SilentlyContinue; "
            "Start-Sleep -Milliseconds 500; Start-ScheduledTask -InputObject $t"
        )
        code, output = _run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], timeout=12)
        return code == 0, output

    helper = Path("/usr/local/sbin/matrix-smartboard-service-control")
    if helper.exists():
        code, output = _run(["sudo", "-n", str(helper), "restart-ollama"], timeout=15)
        return code == 0, output

    if system == "Darwin":
        code, output = _run(["pkill", "-f", "ollama serve"], timeout=4)
        return code in (0, 1), output

    return False, "Privileged service helper is not installed"


def _pull_model_worker(model: str) -> None:
    with _model_jobs_lock:
        _model_jobs[model] = {"state": "running", "startedAt": int(time.time() * 1000), "error": None}
    try:
        body = json.dumps({"name": model, "stream": False}).encode("utf-8")
        request = urllib.request.Request(
            "http://127.0.0.1:11434/api/pull",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=3600) as response:
            response.read()
        with _model_jobs_lock:
            _model_jobs[model] = {"state": "done", "finishedAt": int(time.time() * 1000), "error": None}
    except Exception as exc:
        with _model_jobs_lock:
            _model_jobs[model] = {"state": "error", "finishedAt": int(time.time() * 1000), "error": str(exc)}


def _backup_zip() -> Path:
    fd, filename = tempfile.mkstemp(prefix="matrix-smartboard-backup-", suffix=".zip")
    os.close(fd)
    target = Path(filename)

    with tempfile.TemporaryDirectory(prefix="matrix-smartboard-backup-work-") as work_raw:
        work = Path(work_raw)
        manifest = {
            "product": BACKUP_PRODUCT,
            "version": BACKUP_VERSION,
            "createdAt": int(time.time() * 1000),
            "serverName": get_server_name(),
            "platform": platform.system(),
        }
        (work / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

        db_out = work / "practice.db"
        source_db = settings.practice_db_path
        if source_db.exists():
            src = sqlite3.connect(source_db)
            dst = sqlite3.connect(db_out)
            try:
                src.backup(dst)
            finally:
                dst.close()
                src.close()

        identity_out = work / "identity"
        if settings.server_identity_dir.exists():
            shutil.copytree(settings.server_identity_dir, identity_out, dirs_exist_ok=True)

        data_out = work / "backend-data"
        if BACKEND_DATA_DIR.exists():
            shutil.copytree(
                BACKEND_DATA_DIR,
                data_out,
                dirs_exist_ok=True,
                ignore=shutil.ignore_patterns("server-identity", "__pycache__", "*.pyc"),
            )

        if ENV_FILE.exists():
            config_dir = work / "config"
            config_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ENV_FILE, config_dir / ".env")

        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for item in work.rglob("*"):
                if item.is_file():
                    archive.write(item, item.relative_to(work).as_posix())
    return target


def _validate_archive(archive: zipfile.ZipFile) -> None:
    total = 0
    for info in archive.infolist():
        total += info.file_size
        if total > MAX_RESTORE_BYTES:
            raise ValueError("Backup is too large")
        path = Path(info.filename)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError("Unsafe backup path")


def _restore_zip(path: Path) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="matrix-smartboard-restore-") as raw:
        work = Path(raw)
        with zipfile.ZipFile(path, "r") as archive:
            _validate_archive(archive)
            archive.extractall(work)

        manifest_path = work / "manifest.json"
        if not manifest_path.exists():
            raise ValueError("Backup manifest is missing")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("product") != BACKUP_PRODUCT or int(manifest.get("version") or 0) != BACKUP_VERSION:
            raise ValueError("Unsupported Matrix Smartboard backup")

        restored: list[str] = []
        source_db = work / "practice.db"
        if source_db.exists():
            settings.practice_db_path.parent.mkdir(parents=True, exist_ok=True)
            src = sqlite3.connect(source_db)
            dst = sqlite3.connect(settings.practice_db_path)
            try:
                src.backup(dst)
            finally:
                dst.close()
                src.close()
            restored.append("database")

        identity_source = work / "identity"
        if identity_source.exists():
            settings.server_identity_dir.mkdir(parents=True, exist_ok=True)
            for existing in settings.server_identity_dir.iterdir():
                if existing.is_file():
                    existing.unlink()
                elif existing.is_dir():
                    shutil.rmtree(existing)
            shutil.copytree(identity_source, settings.server_identity_dir, dirs_exist_ok=True)
            restored.append("identity")

        data_source = work / "backend-data"
        if data_source.exists():
            BACKEND_DATA_DIR.mkdir(parents=True, exist_ok=True)
            shutil.copytree(data_source, BACKEND_DATA_DIR, dirs_exist_ok=True)
            restored.append("backendData")

        config_source = work / "config" / ".env"
        config_restored = False
        if config_source.exists():
            try:
                ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(config_source, ENV_FILE)
                config_restored = True
                restored.append("config")
            except PermissionError:
                config_restored = False

        return {
            "ok": True,
            "restored": restored,
            "configRestored": config_restored,
            "restartRequired": True,
            "manifest": manifest,
        }


def _start_update() -> dict[str, Any]:
    capability = _update_capability()
    if not capability["supported"]:
        raise RuntimeError("Server update helper is not installed")

    system = platform.system()
    logs = _platform_logs()
    _ = logs
    if system == "Windows":
        script = Path(capability["path"])
        task_name = "Matrix Smartboard Update"
        escaped_script = str(script).replace("'", "''")
        action = (
            "$a=New-ScheduledTaskAction -Execute 'powershell.exe' "
            + f"-Argument '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{escaped_script}\"'; "
            + "$p=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest; "
            + "$s=New-ScheduledTaskSettingsSet -StartWhenAvailable; "
            + f"Register-ScheduledTask -TaskName '{task_name}' -Action $a -Principal $p -Settings $s -Force | Out-Null; "
            + f"Start-ScheduledTask -TaskName '{task_name}'"
        )
        code, output = _run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", action], timeout=12)
        if code != 0:
            raise RuntimeError(output or "Could not start Windows updater")
    else:
        helper = str(capability["path"])
        process = subprocess.Popen(
            ["sudo", "-n", helper],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        if process.poll() not in (None, 0):
            raise RuntimeError("Could not start server updater")

    return {"ok": True, "started": True}


@router.get("/management/status")
def management_status(request: Request) -> dict[str, Any]:
    _require_management(request)
    return _system_status()


@router.get("/management/logs")
def management_logs(request: Request) -> dict[str, str]:
    _require_management(request)
    return _platform_logs()


@router.get("/management/update")
def management_update_info(request: Request, force: bool = False) -> dict[str, Any]:
    _require_management(request)
    return _update_info(force=force)


@router.post("/management/update")
def management_update(request: Request) -> dict[str, Any]:
    _require_management(request)
    try:
        return _start_update()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/management/restart")
def management_restart(payload: ServiceAction, request: Request) -> dict[str, Any]:
    _require_management(request)
    if payload.service == "backend":
        if not _backend_restart_supported():
            raise HTTPException(status_code=503, detail="Managed backend service is not installed")
        _restart_backend_later()
        return {"ok": True, "service": "backend", "restarting": True}

    ok, detail = _restart_ollama()
    if not ok:
        raise HTTPException(status_code=503, detail=detail or "Could not restart Ollama")
    return {"ok": True, "service": "ollama", "restarting": True}


@router.post("/management/models/pull")
def management_pull_model(payload: ModelPullRequest, request: Request) -> dict[str, Any]:
    _require_management(request)
    if payload.model not in ALLOWED_MODELS:
        raise HTTPException(status_code=422, detail="This model is not allowed")
    if not _ollama_json("/api/tags"):
        raise HTTPException(status_code=503, detail="Ollama is unavailable")
    with _model_jobs_lock:
        current = _model_jobs.get(payload.model)
        if current and current.get("state") == "running":
            return {"ok": True, "model": payload.model, "state": "running"}
    threading.Thread(target=_pull_model_worker, args=(payload.model,), daemon=True).start()
    return {"ok": True, "model": payload.model, "state": "running"}


@router.get("/management/models/pull")
def management_model_jobs(request: Request) -> dict[str, Any]:
    _require_management(request)
    with _model_jobs_lock:
        return {"jobs": dict(_model_jobs)}


@router.get("/backup")
def download_backup(request: Request, background_tasks: BackgroundTasks) -> FileResponse:
    _require_management(request)
    try:
        path = _backup_zip()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not create backup: {exc}") from exc
    background_tasks.add_task(path.unlink, missing_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return FileResponse(
        path,
        media_type="application/zip",
        filename=f"matrix-smartboard-backup-{stamp}.zip",
        background=background_tasks,
    )


@router.post("/restore")
async def restore_backup(request: Request, file: UploadFile = File(...)) -> dict[str, Any]:
    _require_management(request)
    fd, filename = tempfile.mkstemp(prefix="matrix-smartboard-restore-upload-", suffix=".zip")
    os.close(fd)
    path = Path(filename)
    total = 0
    try:
        with path.open("wb") as output:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_RESTORE_BYTES:
                    raise HTTPException(status_code=413, detail="Backup is too large")
                output.write(chunk)
        try:
            return _restore_zip(path)
        except (ValueError, zipfile.BadZipFile, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Could not restore backup: {exc}") from exc
    finally:
        path.unlink(missing_ok=True)
