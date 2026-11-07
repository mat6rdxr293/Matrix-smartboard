"""Cluster of school servers: membership, peer authentication, sync loop and load reporting.

A cluster is created on one server; others join it with a short-lived pairing code and receive the
cluster secret. Every request between nodes is signed with that secret, and every node checks the
TLS key of the peer it talks to against the pin in the member list. Each node pulls changes it has
not seen from every other node about once a second (school_cluster.py does the merging), so data
reaches every node even through a node in the middle. Boards ask any node for the member list and
move to the least loaded one, or to a live one when theirs stops answering.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator

import httpx
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .school_routes import require_server_admin
from .school_store import SchoolStore

logger = logging.getLogger("matrix-cluster")

AUTH_HEADER = "X-Matrix-Cluster"
CLOCK_WINDOW_S = 60
PAIRING_TTL_S = 600
SYNC_INTERVAL_S = 1.0
PEER_TIMEOUT_S = 5.0
COMPACT_EVERY_S = 3600
AI_CAPACITY = 2  # simultaneous AI requests a node takes before it counts as fully loaded
# A server with no school of its own takes a cluster invitation without a sign-in for this long after
# it starts: long enough to install it and add it from a board, short enough that an unattended empty
# server on the network is not left open to anyone's cluster.
OPEN_INVITE_WINDOW_S = 30 * 60


def pin_of_certificate(der: bytes) -> str:
    spki = x509.load_der_x509_certificate(der).public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return "sha256/" + hashlib.sha256(spki).hexdigest()


def sign(secret: str, cluster_id: str, node_id: str, method: str, target: str, ts: int | None = None) -> str:
    ts = int(time.time()) if ts is None else ts
    message = f"{cluster_id}\n{node_id}\n{ts}\n{method.upper()}\n{target}".encode()
    digest = hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
    return f"{cluster_id}.{node_id}.{ts}.{digest}"


def verify(secret: str, cluster_id: str, header: str | None, method: str, target: str) -> str | None:
    """The calling node's id when ``header`` is a valid, fresh signature, else None."""
    if not header:
        return None
    try:
        got_cluster, node_id, ts_text, digest = header.split(".", 3)
        ts = int(ts_text)
    except ValueError:
        return None
    if got_cluster != cluster_id or abs(time.time() - ts) > CLOCK_WINDOW_S:
        return None
    expected = sign(secret, cluster_id, node_id, method, target, ts).rsplit(".", 1)[1]
    return node_id if hmac.compare_digest(expected, digest) else None


class LoadTracker:
    """How busy this node is, for boards choosing a server: 0 is idle, 1 is full."""

    def __init__(self) -> None:
        self.ai_inflight = 0

    @contextmanager
    def ai_request(self) -> Iterator[None]:
        self.ai_inflight += 1
        try:
            yield
        finally:
            self.ai_inflight -= 1

    def snapshot(self) -> dict:
        try:
            cpu = min(1.0, os.getloadavg()[0] / max(1, os.cpu_count() or 1))
        except (AttributeError, OSError):  # Windows has no load average
            cpu = 0.0
        ai = min(1.0, self.ai_inflight / AI_CAPACITY)
        return {"score": round(max(cpu, ai), 3), "cpu": round(cpu, 3), "aiInFlight": self.ai_inflight}


@dataclass
class PeerHealth:
    online: bool = False
    last_seen: float | None = None
    last_error: str | None = None
    load: dict | None = None
    pulled: int = 0


@dataclass
class ClusterService:
    store: SchoolStore
    pin: Callable[[], str]
    name: Callable[[], str]
    media_dir: Path
    load: LoadTracker = field(default_factory=LoadTracker)
    health: dict[str, PeerHealth] = field(default_factory=dict)
    pairing: dict[str, float] = field(default_factory=dict)
    pairing_failures: int = 0
    # Set when another machine writes under this node's id (a backup restored elsewhere while this
    # server still runs); syncing stops until an administrator sorts it out.
    conflict: str | None = None
    _books_cache: tuple[float, list[tuple[dict, dict]]] = (0.0, [])
    _task: asyncio.Task | None = None
    started_at: float = field(default_factory=time.time)

    # ----- configuration -------------------------------------------------------------------------

    @property
    def cluster_id(self) -> str | None:
        return self.store.meta_get("cluster_id")

    @property
    def secret(self) -> str | None:
        return self.store.meta_get("cluster_secret")

    @property
    def enabled(self) -> bool:
        return bool(self.cluster_id and self.secret)

    def open_to_invite(self) -> bool:
        """Whether a board may add this server to a cluster without signing in to it: it is not in a
        cluster, no school was ever made here (so there is nothing of anyone's to hand over), no
        owner was set, and it started recently."""
        return (
            not self.enabled
            and self.store.meta_get("server_owner_school") is None
            and self.store.first_local_school_id() is None
            and time.time() - self.started_at < OPEN_INVITE_WINDOW_S
        )

    def self_url(self) -> str | None:
        return self.store.meta_get("cluster_self_url")

    def create(self, self_url: str) -> dict:
        if self.enabled:
            raise ValueError("Этот сервер уже в кластере")
        self.store.meta_set("cluster_id", secrets.token_hex(8))
        self.store.meta_set("cluster_secret", secrets.token_urlsafe(32))
        self.store.meta_set("cluster_self_url", self_url)
        self.store.announce_peer(self.store.node_id, self_url, self.pin(), self.name())
        self.start()
        return self.describe()

    def leave(self) -> None:
        self.stop()
        for key in ("cluster_id", "cluster_secret", "cluster_self_url"):
            self.store.meta_set(key, None)
        self.health.clear()

    def new_pairing_code(self) -> str:
        now = time.time()
        self.pairing = {code: until for code, until in self.pairing.items() if until > now}
        code = f"{secrets.randbelow(10**8):08d}"
        self.pairing[code] = now + PAIRING_TTL_S
        return code

    def take_pairing_code(self, code: str) -> bool:
        until = self.pairing.pop(code, None)
        if until is not None and until > time.time():
            self.pairing_failures = 0
            return True
        # An 8-digit code would fall to guessing; a few wrong tries void every code handed out.
        self.pairing_failures += 1
        if self.pairing_failures >= 5:
            self.pairing.clear()
            self.pairing_failures = 0
        return False

    def admit(self, node_id: str, url: str, pin: str, name: str) -> dict:
        """Called on an existing member when a new node presents a valid pairing code."""
        existing = next((p for p in self.store.cluster_peers() if p["node_id"] == node_id), None)
        alive = node_id == self.store.node_id or (
            existing is not None and existing["url"] != url and self.health.get(node_id, PeerHealth()).online
        )
        if alive:
            # Same key as a member that is running elsewhere: a copy of that server, not a new one.
            raise ValueError("Сервер с таким же ключом уже работает в кластере: это копия, а не новый сервер")
        self.store.announce_peer(node_id, url, pin, name)
        return {"clusterId": self.cluster_id, "secret": self.secret, "members": self.store.cluster_peers()}

    async def join(self, peer_url: str, code: str, self_url: str) -> dict:
        if self.enabled:
            raise ValueError("Этот сервер уже в кластере")
        peer_url = peer_url.rstrip("/")
        body = {"code": code, "nodeId": self.store.node_id, "url": self_url, "pin": self.pin(), "name": self.name()}
        async with httpx.AsyncClient(verify=False, timeout=PEER_TIMEOUT_S) as client:
            response = await client.post(f"{peer_url}/api/cluster/pair", json=body)
            if response.status_code != 200:
                raise ValueError(response.json().get("detail", "Не удалось присоединиться") if response.headers.get("content-type", "").startswith("application/json") else "Не удалось присоединиться")
            peer_pin = self._peer_pin(response)
            data = response.json()
        members = data.get("members") or []
        if not any(m.get("pin") == peer_pin for m in members):
            raise ValueError("Сервер ответил ключом, которого нет в его же списке узлов")
        self.store.meta_set("cluster_id", data["clusterId"])
        self.store.meta_set("cluster_secret", data["secret"])
        self.store.meta_set("cluster_self_url", self_url)
        with self.store.connection() as connection:
            for member in members:
                connection.execute(
                    "INSERT OR IGNORE INTO cluster_peers(node_id, url, pin, name, hlc) VALUES (?, ?, ?, ?, ?)",
                    (member["node_id"], member["url"], member["pin"], member["name"], member["hlc"]),
                )
        self.start()
        return self.describe()

    def note_own_url(self, url: str) -> None:
        """Boards reach this node at ``url``. When that differs from the address the cluster knows
        (the node's IP changed), the new address is announced so the other members follow."""
        if not self.enabled:
            return
        url = url.rstrip("/")
        host = httpx.URL(url).host
        if not url.startswith("https://") or host in {"localhost", "127.0.0.1", "::1"} or url == self.self_url():
            return
        self.store.meta_set("cluster_self_url", url)
        self.store.announce_peer(self.store.node_id, url, self.pin(), self.name())
        logger.info("cluster: this node is now reached at %s", url)

    # ----- describing ----------------------------------------------------------------------------

    def members(self) -> list[dict]:
        out = []
        for peer in self.store.cluster_peers():
            me = peer["node_id"] == self.store.node_id
            health = self.health.get(peer["node_id"], PeerHealth())
            out.append({
                "nodeId": peer["node_id"],
                "name": peer["name"],
                "url": peer["url"],
                "pin": peer["pin"],
                "self": me,
                "online": True if me else health.online,
                "load": self.load.snapshot() if me else health.load,
                "lastSeen": None if me else health.last_seen,
                "lastError": None if me else health.last_error,
            })
        return out

    def describe(self) -> dict:
        return {
            "enabled": self.enabled,
            "clusterId": self.cluster_id,
            "nodeId": self.store.node_id,
            "members": self.members() if self.enabled else [],
            "vector": self.store.cluster_vector(),
            "conflict": self.conflict,
        }

    # ----- sync loop ------------------------------------------------------------------------------

    def start(self) -> None:
        if self.enabled and not any(p["node_id"] == self.store.node_id for p in self.store.cluster_peers()) and self.self_url():
            # A server that got a new key (its identity folder was removed) joins under its new id.
            self.store.announce_peer(self.store.node_id, self.self_url() or "", self.pin(), self.name())
        if self.enabled and (self._task is None or self._task.done()):
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                return
            self._task = loop.create_task(self._run())

    def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            self._task = None

    async def _run(self) -> None:
        last_compaction = 0.0
        async with httpx.AsyncClient(verify=False, timeout=PEER_TIMEOUT_S) as client:
            while self.enabled:
                await self.sync_once(client)
                if time.time() - last_compaction > COMPACT_EVERY_S:
                    last_compaction = time.time()
                    try:
                        emptied = await asyncio.to_thread(self.store.compact_cluster_log)
                        if emptied:
                            logger.info("cluster log: compacted %s changes", emptied)
                    except Exception:  # noqa: BLE001 — compaction is housekeeping only
                        logger.exception("cluster log compaction failed")
                await asyncio.sleep(SYNC_INTERVAL_S)

    def _peer_pin(self, response: httpx.Response) -> str | None:
        stream = response.extensions.get("network_stream")
        ssl_object = stream.get_extra_info("ssl_object") if stream is not None else None
        der = ssl_object.getpeercert(True) if ssl_object is not None else None
        return pin_of_certificate(der) if der else None

    def _headers(self, method: str, target: str) -> dict:
        return {AUTH_HEADER: sign(self.secret or "", self.cluster_id or "", self.store.node_id, method, target)}

    async def sync_once(self, client: httpx.AsyncClient) -> int:
        """Pulls from every other member once; returns the number of changes applied."""
        total = 0
        if self.conflict:
            return 0
        for peer in self.store.cluster_peers():
            if peer["node_id"] == self.store.node_id:
                continue
            health = self.health.setdefault(peer["node_id"], PeerHealth())
            try:
                total += await self._pull(client, peer, health)
                health.online, health.last_seen, health.last_error = True, time.time(), None
            except Exception as exc:  # noqa: BLE001 — a dead peer must not stop the loop
                health.online, health.last_error = False, str(exc)[:200]
        return total

    async def _pull(self, client: httpx.AsyncClient, peer: dict, health: PeerHealth) -> int:
        applied = 0
        for _ in range(20):  # catch up in pages, but give other peers a turn
            after = json.dumps(self.store.cluster_vector(), separators=(",", ":"))
            target = f"/api/cluster/changes?after={after}"
            response = await client.get(peer["url"].rstrip("/") + "/api/cluster/changes", params={"after": after},
                                        headers=self._headers("GET", target))
            if self._peer_pin(response) != peer["pin"]:
                raise ValueError("peer TLS key does not match its pin")
            response.raise_for_status()
            data = response.json()
            health.load = data.get("load")
            # What the peer holds under this node's id must be what this node wrote: a change it never
            # made, or a different one under the same number, means a copy of this server is running.
            yours = data.get("yourLast")
            if isinstance(yours, list) and len(yours) == 2 and await asyncio.to_thread(
                self.store.change_hlc, self.store.node_id, int(yours[0])
            ) != yours[1]:
                self.conflict = (
                    f"У сервера «{peer['name']}» есть изменение №{yours[0]} от имени этого сервера, которого он не делал. "
                    "Где-то работает копия этого сервера (например, восстановленная резервная копия) или сюда восстановили "
                    "старую копию. Синхронизация остановлена, см. руководство сисадмина"
                )
                logger.error("cluster: %s", self.conflict)
                self.stop()
                return applied
            changes = data.get("changes") or []
            count = await asyncio.to_thread(self.store.apply_cluster_changes, changes)
            applied += count
            health.pulled += count
            if len(changes) < data.get("limit", 500) or not count:
                break
        return applied

    # ----- textbooks on other nodes ---------------------------------------------------------------

    def _other_members(self) -> list[dict]:
        return [p for p in self.store.cluster_peers() if p["node_id"] != self.store.node_id]

    def peer(self, node_id: str) -> dict | None:
        return next((p for p in self._other_members() if p["node_id"] == node_id), None)

    async def remote_books(self) -> list[tuple[dict, dict]]:
        """(member, book) for textbooks other members hold. Cached briefly: dialogs ask often."""
        if not self.enabled:
            return []
        cached_at, cached = self._books_cache
        if time.time() - cached_at < 30:
            return cached
        found: list[tuple[dict, dict]] = []
        async with httpx.AsyncClient(verify=False, timeout=PEER_TIMEOUT_S) as client:
            for peer in self._other_members():
                if self.health.get(peer["node_id"]) and not self.health[peer["node_id"]].online:
                    continue
                try:
                    response = await client.get(peer["url"].rstrip("/") + "/api/lesson-generation/sources", params={"local": "1"})
                    if self._peer_pin(response) != peer["pin"] or response.status_code != 200:
                        continue
                    for book in response.json().get("books") or []:
                        if isinstance(book, dict) and book.get("id"):
                            found.append((peer, book))
                except (httpx.HTTPError, ValueError):
                    continue
        self._books_cache = (time.time(), found)
        return found

    async def book_owner(self, book_id: str) -> dict | None:
        return next((peer for peer, book in await self.remote_books() if book.get("id") == book_id), None)

    async def forward(self, peer: dict, method: str, path: str, *, params: dict | None = None,
                      json_body: Any = None, timeout: float = 30) -> httpx.Response:
        """Sends a request on to another member's own endpoint, checking its key."""
        async with httpx.AsyncClient(verify=False, timeout=timeout) as client:
            response = await client.request(method, peer["url"].rstrip("/") + path, params=params, json=json_body)
        if self._peer_pin(response) != peer["pin"]:
            raise ValueError("peer TLS key does not match its pin")
        return response

    async def fetch_media(self, name: str) -> Path | None:
        """Gets a picture this node does not have from a member that does."""
        if not self.enabled:
            return None
        origin = self.store.media_origin(name)
        peers = sorted(self.store.cluster_peers(), key=lambda p: p["node_id"] != origin)
        async with httpx.AsyncClient(verify=False, timeout=15) as client:
            for peer in peers:
                if peer["node_id"] == self.store.node_id:
                    continue
                target = f"/api/cluster/media/{name}"
                try:
                    response = await client.get(peer["url"].rstrip("/") + target, headers=self._headers("GET", target))
                except httpx.HTTPError:
                    continue
                if response.status_code != 200 or self._peer_pin(response) != peer["pin"]:
                    continue
                self.media_dir.mkdir(parents=True, exist_ok=True)
                path = self.media_dir / name
                tmp = path.with_suffix(path.suffix + ".part")
                tmp.write_bytes(response.content)
                tmp.replace(path)
                return path
        return None


# ----- HTTP ------------------------------------------------------------------------------------------

router = APIRouter()


def get_cluster(request: Request) -> ClusterService:
    return request.app.state.cluster


def _require_peer(request: Request) -> str:
    cluster = get_cluster(request)
    # The caller signs the path and the decoded `after` vector; rebuild the same string here.
    target = request.url.path + (f"?after={request.query_params['after']}" if "after" in request.query_params else "")
    node = verify(cluster.secret or "", cluster.cluster_id or "", request.headers.get(AUTH_HEADER), request.method, target) \
        if cluster.enabled else None
    if node is None:
        raise HTTPException(status_code=403, detail="not a cluster member")
    return node


def _base_url(request: Request) -> str:
    return str(request.base_url).rstrip("/")


class JoinPayload(BaseModel):
    url: str = Field(min_length=8, max_length=300)
    code: str = Field(pattern=r"^\d{8}$")
    # The school that invited this server, given by a board; it becomes the owner of a server that
    # had none, so the school that added it can manage it.
    ownerSchool: str | None = Field(default=None, max_length=64)


class PairPayload(BaseModel):
    code: str = Field(pattern=r"^\d{8}$")
    nodeId: str = Field(min_length=4, max_length=64)
    url: str = Field(min_length=8, max_length=300)
    pin: str = Field(pattern=r"^sha256/[0-9a-f]{64}$")
    name: str = Field(min_length=1, max_length=80)


@router.get("/api/cluster/members")
async def cluster_members(request: Request) -> dict:
    """Public: boards read it over the connection they already trust, to learn the other nodes."""
    cluster = get_cluster(request)
    return {"enabled": cluster.enabled, "nodeId": cluster.store.node_id, "members": cluster.members() if cluster.enabled else []}


@router.get("/api/cluster")
async def cluster_status(request: Request) -> dict:
    require_server_admin(request)
    return get_cluster(request).describe()


@router.post("/api/cluster/create")
async def cluster_create(request: Request) -> dict:
    require_server_admin(request)
    try:
        return get_cluster(request).create(_base_url(request))
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/api/cluster/pairing-code")
async def cluster_pairing_code(request: Request) -> dict:
    school = require_server_admin(request)
    cluster = get_cluster(request)
    if not cluster.enabled:
        raise HTTPException(status_code=409, detail="Этот сервер не в кластере")
    return {
        "code": cluster.new_pairing_code(),
        "expiresInSeconds": PAIRING_TTL_S,
        "ownerSchool": school["id"],
        # Where a new server reaches this one: the address the cluster knows it by.
        "url": cluster.self_url() or _base_url(request),
    }


@router.post("/api/cluster/join")
async def cluster_join(payload: JoinPayload, request: Request) -> dict:
    cluster = get_cluster(request)
    invited = cluster.open_to_invite()
    if not invited:
        require_server_admin(request)
    try:
        result = await cluster.join(payload.url, payload.code, _base_url(request))
    except (ValueError, httpx.HTTPError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if invited and payload.ownerSchool:
        cluster.store.meta_set("server_owner_school", payload.ownerSchool)
    logger.info("cluster: joined %s%s", payload.url, " by invitation" if invited else "")
    return result


@router.post("/api/cluster/leave")
async def cluster_leave(request: Request) -> dict:
    require_server_admin(request)
    get_cluster(request).leave()
    return {"ok": True}


@router.post("/api/cluster/pair")
async def cluster_pair(payload: PairPayload, request: Request) -> dict:
    """A new node presents the pairing code shown on this one and receives the cluster secret."""
    cluster = get_cluster(request)
    if not cluster.enabled or not cluster.take_pairing_code(payload.code):
        raise HTTPException(status_code=403, detail="Неверный или устаревший код")
    try:
        return cluster.admit(payload.nodeId, payload.url.rstrip("/"), payload.pin, payload.name)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/api/cluster/changes")
async def cluster_changes(request: Request, after: str = "{}") -> dict:
    caller = _require_peer(request)
    cluster = get_cluster(request)
    try:
        vector = {str(k): int(v) for k, v in json.loads(after).items()}
    except (ValueError, AttributeError) as exc:
        raise HTTPException(status_code=400, detail="bad vector") from exc
    changes = await asyncio.to_thread(cluster.store.cluster_changes, vector)
    return {"nodeId": cluster.store.node_id, "changes": changes, "limit": 500, "load": cluster.load.snapshot(),
            "yourLast": await asyncio.to_thread(cluster.store.last_change_of, caller)}


@router.get("/api/cluster/media/{name}")
async def cluster_media(name: str, request: Request) -> FileResponse:
    _require_peer(request)
    path = get_cluster(request).media_dir / Path(name).name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="no such picture here")
    return FileResponse(path)
