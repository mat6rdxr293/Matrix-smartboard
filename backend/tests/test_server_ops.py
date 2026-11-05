from __future__ import annotations

from fastapi.testclient import TestClient

from app import server_ops
from app.main import app
from app.school_store import SchoolStore


def _client(tmp_path) -> TestClient:
    app.state.school_store = SchoolStore(tmp_path / "practice.db")
    return TestClient(app)


def _register(client: TestClient) -> None:
    response = client.post(
        "/api/auth/register-school",
        json={"school_name": "Ops School", "password": "password11"},
    )
    assert response.status_code == 201


def test_management_status_requires_school_auth(tmp_path, monkeypatch):
    client = _client(tmp_path)
    assert client.get("/api/server/management/status").status_code == 401

    _register(client)
    monkeypatch.setattr(
        server_ops,
        "_update_info",
        lambda force=False: {
            "localSha": "abc",
            "latestSha": "abc",
            "updateAvailable": False,
            "canUpdate": False,
            "method": "test",
            "error": None,
        },
    )
    monkeypatch.setattr(server_ops, "_ollama_models", lambda: [])
    monkeypatch.setattr(server_ops, "_ollama_json", lambda *args, **kwargs: None)
    monkeypatch.setattr(server_ops, "_gpu_info", lambda: None)

    response = client.get("/api/server/management/status")
    assert response.status_code == 200
    payload = response.json()
    assert payload["services"]["backend"] is True
    assert payload["update"]["localSha"] == "abc"
    assert payload["cpu"]["logicalCores"] >= 1
    assert payload["memory"]["total"] > 0


def test_backup_restore_roundtrip(tmp_path, monkeypatch):
    db_path = tmp_path / "practice.db"
    app.state.school_store = SchoolStore(db_path)
    client = TestClient(app)
    _register(client)

    identity = tmp_path / "identity"
    identity.mkdir()
    (identity / "server-key.pem").write_text("original-key", encoding="utf-8")

    backend_data = tmp_path / "backend-data"
    backend_data.mkdir()
    (backend_data / "tasks.json").write_text('{"version":"original"}', encoding="utf-8")

    env_file = tmp_path / ".env"
    env_file.write_text('SERVER_NAME="Original"\n', encoding="utf-8")

    monkeypatch.setattr(server_ops.settings, "practice_db_path", db_path)
    monkeypatch.setattr(server_ops.settings, "server_identity_dir", identity)
    monkeypatch.setattr(server_ops, "BACKEND_DATA_DIR", backend_data)
    monkeypatch.setattr(server_ops, "ENV_FILE", env_file)

    assert client.post("/api/rooms", json={"name": "A"}).status_code == 201

    backup = client.get("/api/server/backup")
    assert backup.status_code == 200
    assert backup.headers["content-type"].startswith("application/zip")
    backup_bytes = backup.content
    assert backup_bytes

    assert client.post("/api/rooms", json={"name": "B"}).status_code == 201
    (identity / "server-key.pem").write_text("changed-key", encoding="utf-8")
    (backend_data / "tasks.json").write_text('{"version":"changed"}', encoding="utf-8")
    env_file.write_text('SERVER_NAME="Changed"\n', encoding="utf-8")

    restored = client.post(
        "/api/server/restore",
        files={"file": ("backup.zip", backup_bytes, "application/zip")},
    )
    assert restored.status_code == 200
    payload = restored.json()
    assert payload["ok"] is True
    assert payload["restartRequired"] is True
    assert {"database", "identity", "backendData", "config"}.issubset(set(payload["restored"]))

    rooms = client.get("/api/rooms").json()["items"]
    assert [room["name"] for room in rooms] == ["A"]
    assert (identity / "server-key.pem").read_text(encoding="utf-8") == "original-key"
    assert (backend_data / "tasks.json").read_text(encoding="utf-8") == '{"version":"original"}'
    assert env_file.read_text(encoding="utf-8") == 'SERVER_NAME="Original"\n'


def test_only_the_first_school_of_a_server_manages_it(tmp_path, monkeypatch):
    client = _client(tmp_path)
    monkeypatch.setattr(server_ops, "_update_info", lambda force=False: {"supported": False})
    owner = TestClient(app)
    other = TestClient(app)
    assert owner.post("/api/auth/register-school", json={"school_name": "ОСШГ №11", "password": "password11"}).status_code == 201
    assert other.post("/api/auth/register-school", json={"school_name": "Demo", "password": "password11"}).status_code == 201
    # The later school signs in fine but cannot download a backup with everyone's data.
    denied = other.get("/api/server/backup")
    assert denied.status_code == 403
    assert "ОСШГ №11" in denied.json()["detail"]
    assert other.post("/api/cluster/create").status_code == 403
    assert owner.get("/api/server/backup").status_code == 200


def test_a_school_from_another_cluster_member_does_not_own_the_server(tmp_path):
    from app.school_store import SchoolStore as Store

    remote = Store(tmp_path / "remote.db", node_id="remote")
    remote.register_school("Чужая", "password11")
    local = Store(tmp_path / "local.db", node_id="local")
    local.apply_cluster_changes(remote.cluster_changes({}))
    assert local.first_local_school_id() is None
    mine = local.register_school("Своя", "password11")
    assert local.first_local_school_id() == mine["id"]
