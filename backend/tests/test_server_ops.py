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
