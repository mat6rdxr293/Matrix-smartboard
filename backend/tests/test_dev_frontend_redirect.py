from fastapi.testclient import TestClient

from app.main import app


def test_dev_root_redirects_to_live_vite_frontend(monkeypatch):
    monkeypatch.setenv("PRACTICE_DEV_FRONTEND_URL", "http://localhost:5174")
    client = TestClient(app)

    response = client.get("/", follow_redirects=False)

    assert response.status_code in (302, 307)
    assert response.headers["location"] == "http://localhost:5174"


def test_dev_script_points_backend_root_at_vite():
    from pathlib import Path

    project_root = Path(__file__).resolve().parents[2]
    script = (project_root / "scripts" / "dev.sh").read_text(encoding="utf-8")

    assert 'PRACTICE_DEV_FRONTEND_URL="http://localhost:5174"' in script
