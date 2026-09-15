from fastapi.testclient import TestClient

from app.main import app
from app.school_store import SchoolStore


def make_client(tmp_path) -> TestClient:
    app.state.school_store = SchoolStore(tmp_path / "practice.db")
    return TestClient(app)


def test_register_session_and_logout(tmp_path):
    client = make_client(tmp_path)

    response = client.post(
        "/api/auth/register-school",
        json={"school_name": "Школа №11", "password": "password11"},
    )

    assert response.status_code == 201
    assert response.json()["school"]["name"] == "Школа №11"
    assert client.cookies.get("school_session")
    assert client.get("/api/auth/session").status_code == 200

    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/auth/session").status_code == 401


def test_duplicate_registration_and_wrong_login(tmp_path):
    client = make_client(tmp_path)
    payload = {"school_name": "Школа №11", "password": "password11"}
    assert client.post("/api/auth/register-school", json=payload).status_code == 201
    assert client.post("/api/auth/logout").status_code == 200

    duplicate = client.post("/api/auth/register-school", json=payload)
    wrong_login = client.post(
        "/api/auth/login-school",
        json={"school_name": "Школа №11", "password": "not-the-password"},
    )

    assert duplicate.status_code == 409
    assert wrong_login.status_code == 401
    assert client.post("/api/auth/login-school", json=payload).status_code == 200


def test_rooms_require_authentication_and_are_isolated(tmp_path):
    app.state.school_store = SchoolStore(tmp_path / "practice.db")
    school_11 = TestClient(app)
    school_12 = TestClient(app)
    anonymous = TestClient(app)

    assert anonymous.get("/api/rooms").status_code == 401
    school_11.post(
        "/api/auth/register-school",
        json={"school_name": "Школа №11", "password": "password11"},
    )
    school_12.post(
        "/api/auth/register-school",
        json={"school_name": "Школа №12", "password": "password12"},
    )

    created = school_11.post("/api/rooms", json={"name": "20"})
    assert created.status_code == 201
    assert school_11.get("/api/rooms").json()["items"][0]["name"] == "20"
    assert school_12.get("/api/rooms").json() == {"items": []}
    assert school_12.post("/api/rooms", json={"name": "20"}).status_code == 201
    assert school_11.post("/api/rooms", json={"name": " 20 "}).status_code == 409
