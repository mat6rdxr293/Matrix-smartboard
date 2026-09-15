from __future__ import annotations

import hashlib
import hmac
import json
import math
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .curriculum import is_subject_allowed


class SchoolAlreadyExists(ValueError):
    pass


class RoomAlreadyExists(ValueError):
    pass


class ResourceNotFound(LookupError):
    pass


class InvalidLesson(ValueError):
    pass


BOARD_OPERATION_TYPES = {
    "add", "graph_add", "graph_update", "graph_delete", "undo", "redo", "clear"
}
BOARD_SCHEMA_VERSION = "2"
MAX_BOARD_OPERATION_JSON_BYTES = 512_000


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _is_valid_board_stroke(stroke: object) -> bool:
    if not isinstance(stroke, dict):
        return False
    points = stroke.get("points")
    if not isinstance(points, list) or len(points) < 2 or len(points) > 5000:
        return False
    if any(not isinstance(point, dict) or not _is_number(point.get("x")) or not _is_number(point.get("y")) for point in points):
        return False
    return (
        _is_number(stroke.get("width"))
        and 0 < float(stroke["width"]) <= 100
        and isinstance(stroke.get("color"), str)
        and 1 <= len(stroke["color"]) <= 32
        and stroke.get("mode") in {"draw", "erase"}
    )


def _is_valid_graph(graph: object) -> bool:
    if not isinstance(graph, dict):
        return False
    graph_id = graph.get("id")
    if not isinstance(graph_id, str) or not graph_id.strip() or len(graph_id) > 120:
        return False
    if not _is_number(graph.get("x")) or not _is_number(graph.get("y")):
        return False
    if not _is_number(graph.get("width")) or not 260 <= float(graph["width"]) <= 1200:
        return False
    if not _is_number(graph.get("height")) or not 190 <= float(graph["height"]) <= 900:
        return False
    if any(not isinstance(graph.get(key), str) or len(graph[key]) > 32 for key in ("xLabel", "yLabel")):
        return False
    if (graph.get("xMin"), graph.get("xMax"), graph.get("yMin"), graph.get("yMax")) != (-10, 10, -10, 10):
        return False
    expressions = graph.get("expressions")
    if not isinstance(expressions, list) or not 1 <= len(expressions) <= 8:
        return False
    for item in expressions:
        if not isinstance(item, dict):
            return False
        if not isinstance(item.get("id"), str) or not item["id"] or len(item["id"]) > 120:
            return False
        if not isinstance(item.get("expression"), str) or len(item["expression"]) > 120:
            return False
        if not isinstance(item.get("color"), str) or not 1 <= len(item["color"]) <= 32:
            return False
        if not isinstance(item.get("visible"), bool):
            return False
    return True


def _now_ms() -> int:
    return int(time.time() * 1000)


def _clean_name(value: str, *, label: str, max_length: int = 120) -> str:
    cleaned = " ".join(value.strip().split())
    if not cleaned:
        raise ValueError(f"{label} is required")
    if len(cleaned) > max_length:
        raise ValueError(f"{label} is too long")
    return cleaned


def _normalize_name(value: str) -> str:
    return " ".join(value.strip().split()).casefold()


def _school_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "createdAt": row["created_at"],
    }


def _room_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "schoolId": row["school_id"],
        "name": row["name"],
        "createdAt": row["created_at"],
    }


def _lesson_dict(row: sqlite3.Row) -> dict:
    keys = set(row.keys())
    result = {
        "id": row["id"],
        "schoolId": row["school_id"],
        "roomId": row["room_id"],
        "grade": row["grade"],
        "subjectId": row["subject_id"],
        "status": row["status"],
        "startedAt": row["started_at"],
        "updatedAt": row["updated_at"],
        "endedAt": row["ended_at"],
    }
    if "room_name" in keys:
        result["roomName"] = row["room_name"]
    if "board_count" in keys:
        result["boardOperationsCount"] = row["board_count"]
    if "chat_count" in keys:
        result["chatMessagesCount"] = row["chat_count"]
    return result


class SchoolStore:
    def __init__(self, path: str | Path, *, session_days: int = 30):
        self.path = Path(path)
        self.session_days = max(1, session_days)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self.connection() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS schools (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    normalized_name TEXT NOT NULL UNIQUE,
                    password_salt BLOB NOT NULL,
                    password_hash BLOB NOT NULL,
                    created_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS auth_sessions (
                    token_hash TEXT PRIMARY KEY,
                    school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_auth_sessions_school
                    ON auth_sessions(school_id);

                CREATE TABLE IF NOT EXISTS rooms (
                    id TEXT PRIMARY KEY,
                    school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    normalized_name TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    UNIQUE(school_id, normalized_name)
                );

                CREATE INDEX IF NOT EXISTS idx_rooms_school
                    ON rooms(school_id, created_at);

                CREATE TABLE IF NOT EXISTS lessons (
                    id TEXT PRIMARY KEY,
                    school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
                    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                    grade INTEGER NOT NULL CHECK(grade BETWEEN 1 AND 11),
                    subject_id TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('active', 'completed')),
                    started_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    ended_at INTEGER
                );

                CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_lesson_per_room
                    ON lessons(room_id) WHERE status = 'active';
                CREATE INDEX IF NOT EXISTS idx_lessons_room_updated
                    ON lessons(room_id, updated_at DESC);

                CREATE TABLE IF NOT EXISTS board_operations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
                    sequence INTEGER NOT NULL,
                    client_operation_id TEXT NOT NULL,
                    op_type TEXT NOT NULL CHECK(op_type IN ('add', 'graph_add', 'graph_update', 'graph_delete', 'undo', 'redo', 'clear')),
                    payload_json TEXT NOT NULL,
                    occurred_at INTEGER NOT NULL,
                    UNIQUE(lesson_id, sequence),
                    UNIQUE(lesson_id, client_operation_id)
                );

                CREATE INDEX IF NOT EXISTS idx_board_operations_lesson
                    ON board_operations(lesson_id, sequence);

                CREATE TABLE IF NOT EXISTS chat_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
                    sequence INTEGER NOT NULL,
                    client_message_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('student', 'assistant')),
                    text TEXT NOT NULL,
                    mode TEXT,
                    status TEXT NOT NULL CHECK(status IN ('ok', 'error')),
                    created_at INTEGER NOT NULL,
                    UNIQUE(lesson_id, sequence),
                    UNIQUE(lesson_id, client_message_id)
                );

                CREATE INDEX IF NOT EXISTS idx_chat_messages_lesson
                    ON chat_messages(lesson_id, sequence);

                CREATE TABLE IF NOT EXISTS schema_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                """
            )
            self._migrate_board_operations(connection)

    def _migrate_board_operations(self, connection: sqlite3.Connection) -> None:
        row = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'board_operations'"
        ).fetchone()
        ddl = row["sql"] if row and isinstance(row["sql"], str) else ""
        connection.execute("SAVEPOINT board_operations_v2")
        try:
            if "graph_add" not in ddl:
                legacy = connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'board_operations_legacy'"
                ).fetchone()
                if legacy is not None:
                    raise RuntimeError("unfinished board_operations migration")
                connection.execute("ALTER TABLE board_operations RENAME TO board_operations_legacy")
                connection.execute(
                    """
                    CREATE TABLE board_operations (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
                        sequence INTEGER NOT NULL,
                        client_operation_id TEXT NOT NULL,
                        op_type TEXT NOT NULL CHECK(op_type IN ('add', 'graph_add', 'graph_update', 'graph_delete', 'undo', 'redo', 'clear')),
                        payload_json TEXT NOT NULL,
                        occurred_at INTEGER NOT NULL,
                        UNIQUE(lesson_id, sequence),
                        UNIQUE(lesson_id, client_operation_id)
                    )
                    """
                )
                connection.execute(
                    """
                    INSERT INTO board_operations(id, lesson_id, sequence, client_operation_id, op_type, payload_json, occurred_at)
                    SELECT id, lesson_id, sequence, client_operation_id, op_type, payload_json, occurred_at
                    FROM board_operations_legacy ORDER BY id
                    """
                )
                connection.execute("DROP TABLE board_operations_legacy")
            else:
                legacy = connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'board_operations_legacy'"
                ).fetchone()
                if legacy is not None:
                    connection.execute("DROP TABLE board_operations_legacy")

            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_board_operations_lesson ON board_operations(lesson_id, sequence)"
            )
            connection.execute(
                "INSERT INTO schema_meta(key, value) VALUES ('board_operations', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (BOARD_SCHEMA_VERSION,),
            )
            connection.execute("RELEASE SAVEPOINT board_operations_v2")
        except Exception:
            connection.execute("ROLLBACK TO SAVEPOINT board_operations_v2")
            connection.execute("RELEASE SAVEPOINT board_operations_v2")
            raise

    @staticmethod
    def _hash_password(password: str, salt: bytes) -> bytes:
        return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1)

    def register_school(self, name: str, password: str) -> dict:
        cleaned_name = _clean_name(name, label="school name")
        if len(password) < 8:
            raise ValueError("password must contain at least 8 characters")
        school_id = uuid.uuid4().hex
        salt = secrets.token_bytes(16)
        password_hash = self._hash_password(password, salt)
        created_at = _now_ms()
        try:
            with self.connection() as connection:
                connection.execute(
                    """
                    INSERT INTO schools(id, name, normalized_name, password_salt, password_hash, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (school_id, cleaned_name, _normalize_name(cleaned_name), salt, password_hash, created_at),
                )
        except sqlite3.IntegrityError as exc:
            raise SchoolAlreadyExists("school already exists") from exc
        return {"id": school_id, "name": cleaned_name, "createdAt": created_at}

    def authenticate_school(self, name: str, password: str) -> dict | None:
        with self.connection() as connection:
            row = connection.execute(
                "SELECT * FROM schools WHERE normalized_name = ?",
                (_normalize_name(name),),
            ).fetchone()
        if row is None:
            return None
        candidate = self._hash_password(password, row["password_salt"])
        return _school_dict(row) if hmac.compare_digest(candidate, row["password_hash"]) else None

    def create_auth_session(self, school_id: str, *, expires_in_seconds: int | None = None) -> str:
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        created_at = _now_ms()
        ttl_seconds = expires_in_seconds if expires_in_seconds is not None else self.session_days * 86_400
        expires_at = created_at + ttl_seconds * 1000
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO auth_sessions(token_hash, school_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                (token_hash, school_id, created_at, expires_at),
            )
        return token

    def school_for_token(self, token: str | None) -> dict | None:
        if not token:
            return None
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        now = _now_ms()
        with self.connection() as connection:
            row = connection.execute(
                """
                SELECT schools.*
                FROM auth_sessions
                JOIN schools ON schools.id = auth_sessions.school_id
                WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
                """,
                (token_hash, now),
            ).fetchone()
            connection.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", (now,))
        return _school_dict(row) if row else None

    def delete_auth_session(self, token: str | None) -> None:
        if not token:
            return
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        with self.connection() as connection:
            connection.execute("DELETE FROM auth_sessions WHERE token_hash = ?", (token_hash,))

    def create_room(self, school_id: str, name: str) -> dict:
        cleaned_name = _clean_name(name, label="room name", max_length=80)
        room_id = uuid.uuid4().hex
        created_at = _now_ms()
        try:
            with self.connection() as connection:
                connection.execute(
                    """
                    INSERT INTO rooms(id, school_id, name, normalized_name, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (room_id, school_id, cleaned_name, _normalize_name(cleaned_name), created_at),
                )
        except sqlite3.IntegrityError as exc:
            raise RoomAlreadyExists("room already exists") from exc
        return {"id": room_id, "schoolId": school_id, "name": cleaned_name, "createdAt": created_at}

    def list_rooms(self, school_id: str) -> list[dict]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM rooms WHERE school_id = ? ORDER BY name COLLATE NOCASE, created_at",
                (school_id,),
            ).fetchall()
        return [_room_dict(row) for row in rows]

    def get_room(self, school_id: str, room_id: str) -> dict | None:
        with self.connection() as connection:
            row = connection.execute(
                "SELECT * FROM rooms WHERE id = ? AND school_id = ?",
                (room_id, school_id),
            ).fetchone()
        return _room_dict(row) if row else None

    def _require_room(self, connection: sqlite3.Connection, school_id: str, room_id: str) -> sqlite3.Row:
        row = connection.execute(
            "SELECT * FROM rooms WHERE id = ? AND school_id = ?",
            (room_id, school_id),
        ).fetchone()
        if row is None:
            raise ResourceNotFound("room not found")
        return row

    def _require_lesson(self, connection: sqlite3.Connection, school_id: str, lesson_id: str) -> sqlite3.Row:
        row = connection.execute(
            "SELECT * FROM lessons WHERE id = ? AND school_id = ?",
            (lesson_id, school_id),
        ).fetchone()
        if row is None:
            raise ResourceNotFound("lesson not found")
        return row

    def create_lesson(self, school_id: str, room_id: str, grade: int, subject_id: str) -> dict:
        if not is_subject_allowed(grade, subject_id):
            raise InvalidLesson("subject is not available for this grade")
        lesson_id = uuid.uuid4().hex
        now = _now_ms()
        with self.connection() as connection:
            self._require_room(connection, school_id, room_id)
            connection.execute(
                "UPDATE lessons SET status = 'completed', ended_at = ?, updated_at = ? WHERE room_id = ? AND status = 'active'",
                (now, now, room_id),
            )
            connection.execute(
                """
                INSERT INTO lessons(id, school_id, room_id, grade, subject_id, status, started_at, updated_at, ended_at)
                VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)
                """,
                (lesson_id, school_id, room_id, grade, subject_id, now, now),
            )
            row = connection.execute("SELECT * FROM lessons WHERE id = ?", (lesson_id,)).fetchone()
        return _lesson_dict(row)

    def get_lesson(self, school_id: str, lesson_id: str) -> dict | None:
        with self.connection() as connection:
            row = connection.execute(
                """
                SELECT lessons.*, rooms.name AS room_name,
                    (SELECT COUNT(*) FROM board_operations WHERE lesson_id = lessons.id) AS board_count,
                    (SELECT COUNT(*) FROM chat_messages WHERE lesson_id = lessons.id) AS chat_count
                FROM lessons JOIN rooms ON rooms.id = lessons.room_id
                WHERE lessons.id = ? AND lessons.school_id = ?
                """,
                (lesson_id, school_id),
            ).fetchone()
        return _lesson_dict(row) if row else None

    def active_lesson(self, school_id: str, room_id: str) -> dict | None:
        with self.connection() as connection:
            self._require_room(connection, school_id, room_id)
            row = connection.execute(
                """
                SELECT lessons.*, rooms.name AS room_name,
                    (SELECT COUNT(*) FROM board_operations WHERE lesson_id = lessons.id) AS board_count,
                    (SELECT COUNT(*) FROM chat_messages WHERE lesson_id = lessons.id) AS chat_count
                FROM lessons JOIN rooms ON rooms.id = lessons.room_id
                WHERE lessons.school_id = ? AND lessons.room_id = ? AND lessons.status = 'active'
                """,
                (school_id, room_id),
            ).fetchone()
        return _lesson_dict(row) if row else None

    def list_lessons(self, school_id: str, room_id: str, *, limit: int = 100) -> list[dict]:
        safe_limit = max(1, min(limit, 500))
        with self.connection() as connection:
            self._require_room(connection, school_id, room_id)
            rows = connection.execute(
                """
                SELECT lessons.*, rooms.name AS room_name,
                    (SELECT COUNT(*) FROM board_operations WHERE lesson_id = lessons.id) AS board_count,
                    (SELECT COUNT(*) FROM chat_messages WHERE lesson_id = lessons.id) AS chat_count
                FROM lessons JOIN rooms ON rooms.id = lessons.room_id
                WHERE lessons.school_id = ? AND lessons.room_id = ?
                ORDER BY CASE lessons.status WHEN 'active' THEN 0 ELSE 1 END,
                         lessons.updated_at DESC,
                         lessons.started_at DESC
                LIMIT ?
                """,
                (school_id, room_id, safe_limit),
            ).fetchall()
        return [_lesson_dict(row) for row in rows]

    def complete_lesson(self, school_id: str, lesson_id: str) -> dict:
        now = _now_ms()
        with self.connection() as connection:
            self._require_lesson(connection, school_id, lesson_id)
            connection.execute(
                "UPDATE lessons SET status = 'completed', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ?",
                (now, now, lesson_id),
            )
        lesson = self.get_lesson(school_id, lesson_id)
        if lesson is None:
            raise ResourceNotFound("lesson not found")
        return lesson

    def resume_lesson(self, school_id: str, lesson_id: str) -> dict:
        now = _now_ms()
        with self.connection() as connection:
            lesson = self._require_lesson(connection, school_id, lesson_id)
            connection.execute(
                """
                UPDATE lessons SET status = 'completed', ended_at = COALESCE(ended_at, ?), updated_at = ?
                WHERE room_id = ? AND status = 'active' AND id != ?
                """,
                (now, now, lesson["room_id"], lesson_id),
            )
            connection.execute(
                "UPDATE lessons SET status = 'active', ended_at = NULL, updated_at = ? WHERE id = ?",
                (now, lesson_id),
            )
        result = self.get_lesson(school_id, lesson_id)
        if result is None:
            raise ResourceNotFound("lesson not found")
        return result

    def append_board_operations(self, school_id: str, lesson_id: str, operations: list[dict]) -> int:
        if len(operations) > 300:
            raise ValueError("too many operations")
        inserted = 0
        with self.connection() as connection:
            self._require_lesson(connection, school_id, lesson_id)
            row = connection.execute(
                "SELECT COALESCE(MAX(sequence), 0) AS value FROM board_operations WHERE lesson_id = ?",
                (lesson_id,),
            ).fetchone()
            sequence = int(row["value"])
            for operation in operations:
                op_type = operation.get("op")
                client_id = str(operation.get("client_operation_id") or "").strip()
                if op_type not in BOARD_OPERATION_TYPES or not client_id:
                    raise ValueError("invalid board operation")
                if connection.execute(
                    "SELECT 1 FROM board_operations WHERE lesson_id = ? AND client_operation_id = ?",
                    (lesson_id, client_id),
                ).fetchone():
                    continue

                payload: dict = {}
                if op_type == "add":
                    stroke = operation.get("stroke")
                    if not _is_valid_board_stroke(stroke):
                        raise ValueError("add operation requires valid stroke")
                    payload = {"stroke": stroke}
                elif op_type in {"graph_add", "graph_delete"}:
                    graph = operation.get("graph")
                    if not _is_valid_graph(graph):
                        raise ValueError(f"{op_type} operation requires valid graph")
                    payload = {"graph": graph}
                elif op_type == "graph_update":
                    before = operation.get("before")
                    after = operation.get("after")
                    if not _is_valid_graph(before) or not _is_valid_graph(after):
                        raise ValueError("graph_update operation requires valid before and after")
                    if before["id"] != after["id"]:
                        raise ValueError("graph_update ids must match")
                    payload = {"before": before, "after": after}

                payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
                if len(payload_json.encode("utf-8")) > MAX_BOARD_OPERATION_JSON_BYTES:
                    raise ValueError("board operation is too large")
                occurred_at = operation.get("ts")
                if not isinstance(occurred_at, int):
                    occurred_at = _now_ms()
                sequence += 1
                connection.execute(
                    """
                    INSERT INTO board_operations(lesson_id, sequence, client_operation_id, op_type, payload_json, occurred_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (lesson_id, sequence, client_id, op_type, payload_json, occurred_at),
                )
                inserted += 1
            if inserted:
                connection.execute("UPDATE lessons SET updated_at = ? WHERE id = ?", (_now_ms(), lesson_id))
        return inserted

    def board_state(self, school_id: str, lesson_id: str) -> list[dict]:
        with self.connection() as connection:
            self._require_lesson(connection, school_id, lesson_id)
            rows = connection.execute(
                "SELECT * FROM board_operations WHERE lesson_id = ? ORDER BY sequence",
                (lesson_id,),
            ).fetchall()
        result = []
        for row in rows:
            payload = json.loads(row["payload_json"])
            item = {
                "sequence": row["sequence"],
                "clientOperationId": row["client_operation_id"],
                "op": row["op_type"],
                "ts": row["occurred_at"],
            }
            if row["op_type"] == "add":
                item["stroke"] = payload.get("stroke")
            elif row["op_type"] in {"graph_add", "graph_delete"}:
                item["graph"] = payload.get("graph")
            elif row["op_type"] == "graph_update":
                item["before"] = payload.get("before")
                item["after"] = payload.get("after")
            result.append(item)
        return result

    def append_chat_message(
        self,
        school_id: str,
        lesson_id: str,
        *,
        client_message_id: str,
        role: str,
        text: str,
        mode: str | None = None,
        status: str = "ok",
    ) -> bool:
        if role not in {"student", "assistant"} or status not in {"ok", "error"}:
            raise ValueError("invalid chat message")
        with self.connection() as connection:
            self._require_lesson(connection, school_id, lesson_id)
            if connection.execute(
                "SELECT 1 FROM chat_messages WHERE lesson_id = ? AND client_message_id = ?",
                (lesson_id, client_message_id),
            ).fetchone():
                return False
            row = connection.execute(
                "SELECT COALESCE(MAX(sequence), 0) AS value FROM chat_messages WHERE lesson_id = ?",
                (lesson_id,),
            ).fetchone()
            sequence = int(row["value"]) + 1
            now = _now_ms()
            connection.execute(
                """
                INSERT INTO chat_messages(lesson_id, sequence, client_message_id, role, text, mode, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (lesson_id, sequence, client_message_id, role, text, mode, status, now),
            )
            connection.execute("UPDATE lessons SET updated_at = ? WHERE id = ?", (now, lesson_id))
        return True

    def chat_messages(self, school_id: str, lesson_id: str) -> list[dict]:
        with self.connection() as connection:
            self._require_lesson(connection, school_id, lesson_id)
            rows = connection.execute(
                "SELECT * FROM chat_messages WHERE lesson_id = ? ORDER BY sequence",
                (lesson_id,),
            ).fetchall()
        return [
            {
                "sequence": row["sequence"],
                "clientMessageId": row["client_message_id"],
                "role": row["role"],
                "text": row["text"],
                "mode": row["mode"],
                "status": row["status"],
                "createdAt": row["created_at"],
            }
            for row in rows
        ]
