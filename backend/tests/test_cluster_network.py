"""Three real servers (separate processes, databases and TLS keys) forming a cluster over HTTPS."""
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

BACKEND = Path(__file__).resolve().parents[1]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Node:
    def __init__(self, root: Path, name: str):
        self.root = root / name
        self.root.mkdir(parents=True)
        self.name = name
        self.port = free_port()
        self.url = f"https://127.0.0.1:{self.port}"
        self.proc: subprocess.Popen | None = None
        self.token: str | None = None

    def start(self) -> "Node":
        env = {
            **os.environ,
            "PRACTICE_DB_PATH": str(self.root / "practice.db"),
            "SERVER_IDENTITY_DIR": str(self.root / "identity"),
            "SERVER_NAME": self.name,
            "MATRIX_MEDIA_DIR": str(self.root / "media"),
            "AI_BASE_URL": "",
            "OCR_BASE_URL": "",
        }
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "app.run_server", "--host", "127.0.0.1", "--port", str(self.port), "--no-mdns"],
            cwd=BACKEND, env=env, stdout=subprocess.DEVNULL, stderr=(self.root / "log.txt").open("w"),
        )
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                if httpx.get(self.url + "/api/status", verify=False, timeout=1).status_code == 200:
                    return self
            except httpx.HTTPError:
                time.sleep(0.2)
        raise RuntimeError(f"{self.name} did not start:\n" + (self.root / "log.txt").read_text())

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(timeout=10)

    def call(self, method: str, path: str, **kwargs) -> httpx.Response:
        headers = {"x-matrix-mobile": "1", **kwargs.pop("headers", {})}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return httpx.request(method, self.url + path, headers=headers, verify=False, timeout=15, **kwargs)


def eventually(check, timeout=20.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = check()
            if last:
                return last
        except (httpx.HTTPError, AssertionError, KeyError) as exc:
            last = exc
        time.sleep(0.3)
    raise AssertionError(f"never became true, last: {last!r}")


@pytest.fixture
def nodes(tmp_path):
    started = [Node(tmp_path, f"node-{i}").start() for i in range(3)]
    yield started
    for node in started:
        node.stop()


def board(node: Node, lesson_id: str) -> list[str]:
    response = node.call("GET", f"/api/lessons/{lesson_id}/board")
    response.raise_for_status()
    return [op["clientOperationId"] for op in response.json()["operations"]]


def test_three_servers_share_one_school(nodes):
    a, b, c = nodes
    # A school on a; its sign-in token is used on the other nodes once they join.
    registered = a.call("POST", "/api/auth/register-school", json={"school_name": "Кластерная школа", "password": "password11"})
    assert registered.status_code == 201
    token = registered.json()["sessionToken"]
    a.token = token
    assert a.call("POST", "/api/cluster/create").status_code == 200

    # b joins through a, c joins through b: c never pairs with a.
    for joiner, sponsor in ((b, a), (c, b)):
        code = sponsor.call("POST", "/api/cluster/pairing-code").json()["code"]
        # The joining node needs its own admin sign-in: a local school is enough.
        joiner.token = joiner.call("POST", "/api/auth/register-school",
                                   json={"school_name": f"Местная {joiner.name}", "password": "password11"}).json()["sessionToken"]
        joined = joiner.call("POST", "/api/cluster/join", json={"url": sponsor.url, "code": code})
        assert joined.status_code == 200, joined.text

    for node in nodes:
        node.token = token
    # Every node learns all three members, including through a relay.
    eventually(lambda: all(len(n.call("GET", "/api/cluster/members").json()["members"]) == 3 for n in nodes))
    eventually(lambda: all(m["online"] for m in c.call("GET", "/api/cluster").json()["members"]))

    room = c.call("POST", "/api/rooms", json={"name": "204"}).json()["room"]
    lesson = eventually(lambda: a.call("POST", f"/api/rooms/{room['id']}/lessons", json={"grade": 9, "subject_id": "algebra"}).json()["lesson"])
    ops = lambda prefix, n, device, start: [
        {"client_operation_id": f"{prefix}{i}", "op": "clear", "ts": 1, "device_id": device, "client_seq": start + i} for i in range(n)
    ]
    # The board moved to b right after the lesson started on a: b answers "retry" until the lesson
    # arrives, and the board's retries then land.
    first = b.call("POST", f"/api/lessons/{lesson['id']}/board/operations", json={"operations": ops("x", 3, "board-1", 0)})
    assert first.status_code in (200, 503)
    eventually(lambda: b.call("POST", f"/api/lessons/{lesson['id']}/board/operations",
                              json={"operations": ops("x", 3, "board-1", 0)}).status_code == 200)
    expected = ["x0", "x1", "x2"]
    eventually(lambda: all(board(n, lesson["id"]) == expected for n in nodes))

    # Tasks saved on one node appear on the others.
    saved = c.call("POST", "/api/storage?subject=physics", json={"tasks": [{"id": "t1"}], "slides": []})
    assert saved.status_code == 200
    eventually(lambda: a.call("GET", "/api/storage?subject=physics").json()["tasks"] == [{"id": "t1"}])

    # A picture uploaded to one node opens from another.
    png = b"\x89PNG\r\n\x1a\n" + b"\0" * 64
    src = a.call("POST", "/api/board/images", files={"file": ("p.png", png, "image/png")}).json()["src"]
    eventually(lambda: c.call("GET", src).content == png)

    # b goes down; the board keeps writing to c, then b comes back and catches up.
    b.stop()
    assert c.call("POST", f"/api/lessons/{lesson['id']}/board/operations", json={"operations": ops("y", 2, "board-1", 3)}).status_code == 200
    b.start()
    b.token = token
    expected = ["x0", "x1", "x2", "y0", "y1"]
    eventually(lambda: all(board(n, lesson["id"]) == expected for n in nodes))


def test_requests_between_nodes_must_be_signed(nodes):
    a = nodes[0]
    a.token = a.call("POST", "/api/auth/register-school", json={"school_name": "Школа", "password": "password11"}).json()["sessionToken"]
    a.call("POST", "/api/cluster/create")
    assert a.call("GET", "/api/cluster/changes?after={}").status_code == 403
    assert a.call("GET", "/api/cluster/changes?after={}", headers={"X-Matrix-Cluster": "x.y.1.z"}).status_code == 403
    # Guessing the pairing code is cut short.
    for _ in range(5):
        r = a.call("POST", "/api/cluster/pair", json={"code": "00000000", "nodeId": "evil", "url": "https://1.2.3.4",
                                                     "pin": "sha256/" + "0" * 64, "name": "x"})
        assert r.status_code == 403
