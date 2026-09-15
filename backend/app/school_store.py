from __future__ import annotations

import hashlib
import hmac
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


class SchoolAlreadyExists(ValueError):
    pass


class RoomAlreadyExists(ValueError):
    pass


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
                """
            )

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
