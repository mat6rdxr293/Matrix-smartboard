"""Replication of the school database between the servers of a cluster.

Every write to the store also appends a change to ``cluster_log`` in the same transaction. A change
names the node it came from (``origin``) and that node's gap-free counter (``seq``); a node's
progress is its version vector ``{origin: last seq}``. Nodes pull changes newer than their vector
from each other, also passing on changes they relayed, and apply them with idempotent merge rules,
so every node ends with the same data whatever order changes arrive in. See docs/cluster-design.md.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from typing import Any, Iterable

CHANGE_KINDS = {"school", "session", "session_delete", "room", "lesson", "board_op", "chat", "doc", "media"}
MAX_CHANGES_PER_PULL = 500


class Deferred(Exception):
    """A change whose parent row has not arrived yet; it is retried after the rest of the batch."""


def _wall_ms() -> int:
    return int(time.time() * 1000)


class HybridClock:
    """Hybrid logical clock: strings that sort in causal order across nodes, even with skewed clocks."""

    def __init__(self, node_id: str):
        self.node_id = node_id
        self._wall = 0
        self._counter = 0
        self._lock = threading.Lock()

    @staticmethod
    def parse(value: str) -> tuple[int, int]:
        wall, counter, _node = value.split("-", 2)
        return int(wall), int(counter)

    def _format(self) -> str:
        return f"{self._wall:013d}-{self._counter:06d}-{self.node_id}"

    def now(self) -> str:
        with self._lock:
            wall = _wall_ms()
            if wall > self._wall:
                self._wall, self._counter = wall, 0
            else:
                self._counter += 1
            return self._format()

    def observe(self, remote: str | None) -> None:
        """Moves the clock past a timestamp seen from another node."""
        if not remote:
            return
        try:
            wall, counter = self.parse(remote)
        except (ValueError, TypeError):
            return
        with self._lock:
            if wall > self._wall or (wall == self._wall and counter > self._counter):
                self._wall, self._counter = wall, counter


def _b2h(value: bytes | None) -> str | None:
    return value.hex() if isinstance(value, (bytes, bytearray)) else value


class ClusterMixin:
    """Change capture and merge for SchoolStore; expects ``connection()`` and ``self.node_id``."""

    node_id: str
    clock: HybridClock

    # ----- schema -------------------------------------------------------------------------------

    def _initialize_cluster(self, connection: sqlite3.Connection, node_id: str | None) -> None:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS cluster_log (
                origin TEXT NOT NULL,
                seq INTEGER NOT NULL,
                hlc TEXT NOT NULL,
                kind TEXT NOT NULL,
                data TEXT NOT NULL,
                PRIMARY KEY (origin, seq)
            );
            CREATE TABLE IF NOT EXISTS cluster_docs (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                hlc TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cluster_tombstones (
                token_hash TEXT PRIMARY KEY
            );
            CREATE TABLE IF NOT EXISTS cluster_media (
                name TEXT PRIMARY KEY,
                origin TEXT NOT NULL,
                size INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            """
        )
        self._add_column(connection, "lessons", "hlc", "TEXT")
        for column, kind in (("lamport", "INTEGER"), ("device_id", "TEXT"), ("client_seq", "INTEGER"), ("origin", "TEXT")):
            self._add_column(connection, "board_operations", column, kind)
        self._add_column(connection, "chat_messages", "origin", "TEXT")

        stored = connection.execute("SELECT value FROM schema_meta WHERE key = 'node_id'").fetchone()
        chosen = node_id or (stored["value"] if stored else uuid.uuid4().hex[:24])
        connection.execute(
            "INSERT INTO schema_meta(key, value) VALUES ('node_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (chosen,),
        )
        self.node_id = chosen
        self.clock = HybridClock(chosen)
        latest = connection.execute("SELECT MAX(hlc) AS hlc FROM cluster_log").fetchone()
        self.clock.observe(latest["hlc"] if latest else None)
        self._bootstrap_log(connection)

    @staticmethod
    def _add_column(connection: sqlite3.Connection, table: str, column: str, kind: str) -> None:
        columns = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}
        if column not in columns:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")

    def _bootstrap_log(self, connection: sqlite3.Connection) -> None:
        """Writes data that predates the log as changes once, so a new peer can receive all of it."""
        done = connection.execute("SELECT value FROM schema_meta WHERE key = 'cluster_bootstrapped'").fetchone()
        if done:
            return
        for row in connection.execute("SELECT * FROM schools ORDER BY created_at, id").fetchall():
            self._log(connection, "school", self._school_row(row))
        for row in connection.execute("SELECT * FROM auth_sessions").fetchall():
            self._log(connection, "session", dict(row))
        for row in connection.execute("SELECT * FROM rooms ORDER BY created_at, id").fetchall():
            self._log(connection, "room", dict(row))
        for row in connection.execute("SELECT * FROM lessons ORDER BY started_at, id").fetchall():
            hlc = row["hlc"] or self.clock.now()
            connection.execute("UPDATE lessons SET hlc = ? WHERE id = ?", (hlc, row["id"]))
            self._log(connection, "lesson", {**self._lesson_row(row), "hlc": hlc})
        lamports: dict[str, int] = {}
        for row in connection.execute("SELECT * FROM board_operations ORDER BY lesson_id, sequence").fetchall():
            lamport = lamports.get(row["lesson_id"], 0) + 1
            lamports[row["lesson_id"]] = lamport
            connection.execute(
                "UPDATE board_operations SET lamport = ?, origin = COALESCE(origin, ?) WHERE id = ?",
                (lamport, self.node_id, row["id"]),
            )
            self._log(connection, "board_op", {**self._board_row(row), "lamport": lamport, "origin": row["origin"] or self.node_id})
        for row in connection.execute("SELECT * FROM chat_messages ORDER BY lesson_id, sequence").fetchall():
            connection.execute("UPDATE chat_messages SET origin = COALESCE(origin, ?) WHERE id = ?", (self.node_id, row["id"]))
            self._log(connection, "chat", {**self._chat_row(row), "origin": row["origin"] or self.node_id})
        connection.execute("INSERT INTO schema_meta(key, value) VALUES ('cluster_bootstrapped', '1')")

    # ----- row shapes ---------------------------------------------------------------------------

    @staticmethod
    def _school_row(row: sqlite3.Row) -> dict:
        data = dict(row)
        data["password_salt"] = _b2h(data["password_salt"])
        data["password_hash"] = _b2h(data["password_hash"])
        return data

    @staticmethod
    def _lesson_row(row: sqlite3.Row) -> dict:
        keys = ("id", "school_id", "room_id", "grade", "subject_id", "status", "started_at", "updated_at", "ended_at", "hlc")
        return {key: row[key] for key in keys}

    @staticmethod
    def _board_row(row: sqlite3.Row) -> dict:
        keys = ("lesson_id", "client_operation_id", "op_type", "payload_json", "occurred_at", "lamport", "device_id", "client_seq", "origin")
        return {key: row[key] for key in keys}

    @staticmethod
    def _chat_row(row: sqlite3.Row) -> dict:
        keys = ("lesson_id", "client_message_id", "role", "text", "mode", "status", "created_at", "origin")
        return {key: row[key] for key in keys}

    # ----- log ----------------------------------------------------------------------------------

    def _log(self, connection: sqlite3.Connection, kind: str, data: dict, *, origin: str | None = None,
             seq: int | None = None, hlc: str | None = None) -> None:
        if origin is None:
            origin = self.node_id
            row = connection.execute("SELECT COALESCE(MAX(seq), 0) AS seq FROM cluster_log WHERE origin = ?", (origin,)).fetchone()
            seq = int(row["seq"]) + 1
            hlc = hlc or self.clock.now()
        connection.execute(
            "INSERT OR IGNORE INTO cluster_log(origin, seq, hlc, kind, data) VALUES (?, ?, ?, ?, ?)",
            (origin, seq, hlc, kind, json.dumps(data, ensure_ascii=False, separators=(",", ":"))),
        )

    def cluster_vector(self) -> dict[str, int]:
        with self.connection() as connection:
            rows = connection.execute("SELECT origin, MAX(seq) AS seq FROM cluster_log GROUP BY origin").fetchall()
        return {row["origin"]: int(row["seq"]) for row in rows}

    def cluster_changes(self, after: dict[str, int], *, limit: int = MAX_CHANGES_PER_PULL) -> list[dict]:
        """Changes newer than ``after``, oldest first per origin. Includes changes relayed from others."""
        limit = max(1, min(limit, MAX_CHANGES_PER_PULL))
        out: list[dict] = []
        with self.connection() as connection:
            origins = [row["origin"] for row in connection.execute("SELECT DISTINCT origin FROM cluster_log ORDER BY origin")]
            for origin in origins:
                if len(out) >= limit:
                    break
                rows = connection.execute(
                    "SELECT * FROM cluster_log WHERE origin = ? AND seq > ? ORDER BY seq LIMIT ?",
                    (origin, int(after.get(origin, 0)), limit - len(out)),
                ).fetchall()
                out.extend(
                    {"origin": row["origin"], "seq": row["seq"], "hlc": row["hlc"], "kind": row["kind"], "data": json.loads(row["data"])}
                    for row in rows
                )
        return out

    def apply_cluster_changes(self, changes: Iterable[dict]) -> int:
        """Applies changes pulled from a peer, idempotently.

        Each origin's changes are applied in seq order without gaps. A change whose parent row
        (say, the lesson of a board operation) has not arrived yet waits, and the batch is passed
        over again until nothing more applies; whatever is left comes again on the next pull."""
        pending = sorted(
            (c for c in changes if isinstance(c, dict) and c.get("kind") in CHANGE_KINDS and isinstance(c.get("seq"), int)
             and c.get("origin") and c.get("origin") != self.node_id),
            key=lambda c: (str(c["origin"]), c["seq"]),
        )
        applied = 0
        with self.connection() as connection:
            while pending:
                waiting: list[dict] = []
                progressed = False
                for change in pending:
                    origin, seq = str(change["origin"]), change["seq"]
                    have = int(connection.execute(
                        "SELECT COALESCE(MAX(seq), 0) AS seq FROM cluster_log WHERE origin = ?", (origin,)
                    ).fetchone()["seq"])
                    if seq <= have:
                        continue
                    if seq != have + 1:
                        waiting.append(change)
                        continue
                    hlc = str(change.get("hlc") or "")
                    data = change.get("data") or {}
                    connection.execute("SAVEPOINT cluster_change")
                    try:
                        self._merge(connection, change["kind"], data)
                    except Deferred:
                        connection.execute("ROLLBACK TO SAVEPOINT cluster_change")
                        connection.execute("RELEASE SAVEPOINT cluster_change")
                        waiting.append(change)
                        continue
                    except Exception:
                        connection.execute("ROLLBACK TO SAVEPOINT cluster_change")
                        connection.execute("RELEASE SAVEPOINT cluster_change")
                        raise
                    self._log(connection, change["kind"], data, origin=origin, seq=seq, hlc=hlc)
                    connection.execute("RELEASE SAVEPOINT cluster_change")
                    self.clock.observe(hlc)
                    applied += 1
                    progressed = True
                if not progressed:
                    break
                pending = waiting
        return applied

    @staticmethod
    def _require(connection: sqlite3.Connection, table: str, row_id: str) -> None:
        if not connection.execute(f"SELECT 1 FROM {table} WHERE id = ?", (row_id,)).fetchone():
            raise Deferred(f"{table} {row_id}")

    # ----- merge rules --------------------------------------------------------------------------

    def _merge(self, connection: sqlite3.Connection, kind: str, data: dict) -> None:
        getattr(self, f"_merge_{kind}")(connection, data)

    def _merge_school(self, connection: sqlite3.Connection, data: dict) -> None:
        if connection.execute("SELECT 1 FROM schools WHERE id = ?", (data["id"],)).fetchone():
            return
        normalized = data["normalized_name"]
        clash = connection.execute("SELECT id, created_at FROM schools WHERE normalized_name = ?", (normalized,)).fetchone()
        if clash is not None:
            # Same name created on both sides of a partition: the earlier one keeps the name.
            if (clash["created_at"], clash["id"]) > (data["created_at"], data["id"]):
                connection.execute(
                    "UPDATE schools SET normalized_name = ? WHERE id = ?", (f"{normalized}#{clash['id'][:8]}", clash["id"])
                )
            else:
                normalized = f"{normalized}#{data['id'][:8]}"
        connection.execute(
            "INSERT INTO schools(id, name, normalized_name, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (data["id"], data["name"], normalized, bytes.fromhex(data["password_salt"]), bytes.fromhex(data["password_hash"]), data["created_at"]),
        )

    def _merge_session(self, connection: sqlite3.Connection, data: dict) -> None:
        self._require(connection, "schools", data["school_id"])
        # A sign-out beats the sign-in it ends, in whichever order the two arrive.
        if connection.execute("SELECT 1 FROM cluster_tombstones WHERE token_hash = ?", (data["token_hash"],)).fetchone():
            return
        connection.execute(
            "INSERT OR IGNORE INTO auth_sessions(token_hash, school_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (data["token_hash"], data["school_id"], data["created_at"], data["expires_at"]),
        )

    def _merge_session_delete(self, connection: sqlite3.Connection, data: dict) -> None:
        connection.execute("INSERT OR IGNORE INTO cluster_tombstones(token_hash) VALUES (?)", (data["token_hash"],))
        connection.execute("DELETE FROM auth_sessions WHERE token_hash = ?", (data["token_hash"],))

    def _merge_room(self, connection: sqlite3.Connection, data: dict) -> None:
        if connection.execute("SELECT 1 FROM rooms WHERE id = ?", (data["id"],)).fetchone():
            return
        self._require(connection, "schools", data["school_id"])
        normalized = data["normalized_name"]
        clash = connection.execute(
            "SELECT id, created_at FROM rooms WHERE school_id = ? AND normalized_name = ?", (data["school_id"], normalized)
        ).fetchone()
        if clash is not None:
            if (clash["created_at"], clash["id"]) > (data["created_at"], data["id"]):
                connection.execute("UPDATE rooms SET normalized_name = ? WHERE id = ?", (f"{normalized}#{clash['id'][:8]}", clash["id"]))
            else:
                normalized = f"{normalized}#{data['id'][:8]}"
        connection.execute(
            "INSERT INTO rooms(id, school_id, name, normalized_name, created_at) VALUES (?, ?, ?, ?, ?)",
            (data["id"], data["school_id"], data["name"], normalized, data["created_at"]),
        )

    def _merge_lesson(self, connection: sqlite3.Connection, data: dict) -> None:
        self._require(connection, "rooms", data["room_id"])
        current = connection.execute("SELECT hlc FROM lessons WHERE id = ?", (data["id"],)).fetchone()
        if current is not None and (current["hlc"] or "") >= data["hlc"]:
            return
        status = data["status"]
        ended_at = data["ended_at"]
        if status == "active":
            # One active lesson per room: the most recent activation wins, on every node alike.
            newer = connection.execute(
                "SELECT 1 FROM lessons WHERE room_id = ? AND status = 'active' AND id != ? AND hlc > ?",
                (data["room_id"], data["id"], data["hlc"]),
            ).fetchone()
            if newer:
                status, ended_at = "completed", ended_at or data["updated_at"]
            else:
                connection.execute(
                    "UPDATE lessons SET status = 'completed', ended_at = COALESCE(ended_at, ?) WHERE room_id = ? AND status = 'active' AND id != ?",
                    (data["updated_at"], data["room_id"], data["id"]),
                )
        connection.execute(
            """
            INSERT INTO lessons(id, school_id, room_id, grade, subject_id, status, started_at, updated_at, ended_at, hlc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at,
                ended_at = excluded.ended_at, hlc = excluded.hlc
            """,
            (data["id"], data["school_id"], data["room_id"], data["grade"], data["subject_id"], status,
             data["started_at"], data["updated_at"], ended_at, data["hlc"]),
        )

    def _merge_board_op(self, connection: sqlite3.Connection, data: dict) -> None:
        self._require(connection, "lessons", data["lesson_id"])
        if connection.execute(
            "SELECT 1 FROM board_operations WHERE lesson_id = ? AND client_operation_id = ?",
            (data["lesson_id"], data["client_operation_id"]),
        ).fetchone():
            return
        row = connection.execute(
            "SELECT COALESCE(MAX(sequence), 0) AS value FROM board_operations WHERE lesson_id = ?", (data["lesson_id"],)
        ).fetchone()
        connection.execute(
            """
            INSERT INTO board_operations(lesson_id, sequence, client_operation_id, op_type, payload_json, occurred_at,
                lamport, device_id, client_seq, origin)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (data["lesson_id"], int(row["value"]) + 1, data["client_operation_id"], data["op_type"], data["payload_json"],
             data["occurred_at"], data["lamport"], data.get("device_id"), data.get("client_seq"), data.get("origin")),
        )

    def _merge_chat(self, connection: sqlite3.Connection, data: dict) -> None:
        self._require(connection, "lessons", data["lesson_id"])
        if connection.execute(
            "SELECT 1 FROM chat_messages WHERE lesson_id = ? AND client_message_id = ?", (data["lesson_id"], data["client_message_id"])
        ).fetchone():
            return
        row = connection.execute(
            "SELECT COALESCE(MAX(sequence), 0) AS value FROM chat_messages WHERE lesson_id = ?", (data["lesson_id"],)
        ).fetchone()
        connection.execute(
            """
            INSERT INTO chat_messages(lesson_id, sequence, client_message_id, role, text, mode, status, created_at, origin)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (data["lesson_id"], int(row["value"]) + 1, data["client_message_id"], data["role"], data["text"], data["mode"],
             data["status"], data["created_at"], data.get("origin")),
        )

    def _merge_doc(self, connection: sqlite3.Connection, data: dict) -> None:
        connection.execute(
            """
            INSERT INTO cluster_docs(key, value, hlc) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, hlc = excluded.hlc WHERE excluded.hlc > cluster_docs.hlc
            """,
            (data["key"], data["value"], data["hlc"]),
        )

    def _merge_media(self, connection: sqlite3.Connection, data: dict) -> None:
        connection.execute(
            "INSERT OR IGNORE INTO cluster_media(name, origin, size, created_at) VALUES (?, ?, ?, ?)",
            (data["name"], data["origin"], int(data["size"]), int(data["created_at"])),
        )

    # ----- documents and media (used by the API) -----------------------------------------------

    def put_document(self, key: str, value: Any) -> None:
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        with self.connection() as connection:
            hlc = self.clock.now()
            connection.execute(
                "INSERT INTO cluster_docs(key, value, hlc) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value, hlc = excluded.hlc",
                (key, text, hlc),
            )
            self._log(connection, "doc", {"key": key, "value": text, "hlc": hlc}, hlc=hlc)

    def get_document(self, key: str) -> Any | None:
        with self.connection() as connection:
            row = connection.execute("SELECT value FROM cluster_docs WHERE key = ?", (key,)).fetchone()
        return json.loads(row["value"]) if row else None

    def record_media(self, name: str, size: int) -> None:
        with self.connection() as connection:
            data = {"name": name, "origin": self.node_id, "size": int(size), "created_at": _wall_ms()}
            if connection.execute("SELECT 1 FROM cluster_media WHERE name = ?", (name,)).fetchone():
                return
            self._merge_media(connection, data)
            self._log(connection, "media", data)

    def media_origin(self, name: str) -> str | None:
        with self.connection() as connection:
            row = connection.execute("SELECT origin FROM cluster_media WHERE name = ?", (name,)).fetchone()
        return row["origin"] if row else None


def board_order(rows: list[sqlite3.Row]) -> list[sqlite3.Row]:
    """The cluster-wide order of a lesson's operations (docs/cluster-design.md, "Порядок операций доски").

    Each device's own operations keep their order; across devices the lesson's Lamport time decides,
    ties broken by device id. Operations without a device keep the order they arrived in on their
    origin node."""
    by_device: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        device = row["device_id"] or f"~{row['origin'] or ''}"
        by_device.setdefault(device, []).append(row)
    keyed: list[tuple[tuple, sqlite3.Row]] = []
    for device, items in by_device.items():
        items.sort(key=lambda r: (r["client_seq"] if r["client_seq"] is not None else r["lamport"] or 0, r["sequence"]))
        effective = 0
        for item in items:
            effective = max(effective, item["lamport"] or 0)
            keyed.append(((effective, device, item["client_seq"] if item["client_seq"] is not None else 0, item["sequence"]), item))
    keyed.sort(key=lambda pair: pair[0])
    return [row for _key, row in keyed]
