from fastapi.testclient import TestClient

from app.main import app
from app.school_store import SchoolStore


def registered_client(tmp_path, school_name="Школа №11"):
    store = SchoolStore(tmp_path / "practice.db")
    app.state.school_store = store
    client = TestClient(app)
    response = client.post(
        "/api/auth/register-school",
        json={"school_name": school_name, "password": "password11"},
    )
    school = response.json()["school"]
    room = client.post("/api/rooms", json={"name": "20"}).json()["room"]
    return client, store, school, room


def test_lesson_subject_validation_and_automatic_completion(tmp_path):
    client, _, _, room = registered_client(tmp_path)

    invalid = client.post(
        f"/api/rooms/{room['id']}/lessons",
        json={"grade": 6, "subject_id": "physics"},
    )
    first = client.post(
        f"/api/rooms/{room['id']}/lessons",
        json={"grade": 6, "subject_id": "natural_science"},
    )
    second = client.post(
        f"/api/rooms/{room['id']}/lessons",
        json={"grade": 7, "subject_id": "physics"},
    )

    assert invalid.status_code == 422
    assert first.status_code == 201
    assert second.status_code == 201
    history = client.get(f"/api/rooms/{room['id']}/lessons").json()["items"]
    assert [item["status"] for item in history] == ["active", "completed"]
    assert client.get(f"/api/rooms/{room['id']}/active-lesson").json()["lesson"]["id"] == second.json()["lesson"]["id"]


def test_manual_completion_and_resume(tmp_path):
    client, _, _, room = registered_client(tmp_path)
    lesson = client.post(
        f"/api/rooms/{room['id']}/lessons",
        json={"grade": 7, "subject_id": "chemistry"},
    ).json()["lesson"]

    completed = client.post(f"/api/lessons/{lesson['id']}/complete").json()["lesson"]
    assert completed["status"] == "completed"
    assert client.get(f"/api/rooms/{room['id']}/active-lesson").json()["lesson"] is None

    resumed = client.post(f"/api/lessons/{lesson['id']}/resume").json()["lesson"]
    assert resumed["status"] == "active"
    assert resumed["endedAt"] is None


def test_lesson_isolation_between_schools(tmp_path):
    client_11, store, _, room = registered_client(tmp_path, "Школа №11")
    lesson = client_11.post(
        f"/api/rooms/{room['id']}/lessons",
        json={"grade": 7, "subject_id": "biology"},
    ).json()["lesson"]

    app.state.school_store = store
    client_12 = TestClient(app)
    client_12.post(
        "/api/auth/register-school",
        json={"school_name": "Школа №12", "password": "password12"},
    )

    assert client_12.get(f"/api/lessons/{lesson['id']}").status_code == 404
    assert client_12.post(f"/api/lessons/{lesson['id']}/resume").status_code == 404


def test_board_operations_keep_exact_order_and_ignore_retries(tmp_path):
    client, _, _, room = registered_client(tmp_path)
    lesson = client.post(
        f"/api/rooms/{room['id']}/lessons",
        json={"grade": 7, "subject_id": "physics"},
    ).json()["lesson"]
    stroke = {
        "points": [{"x": 1, "y": 2}, {"x": 3, "y": 4}],
        "color": "#ffffff",
        "width": 3,
        "mode": "draw",
    }
    operations = [
        {"client_operation_id": "op-1", "op": "add", "stroke": stroke, "ts": 100},
        {"client_operation_id": "op-2", "op": "undo", "ts": 110},
        {"client_operation_id": "op-3", "op": "redo", "ts": 120},
        {"client_operation_id": "op-4", "op": "clear", "ts": 130},
    ]

    assert client.post(f"/api/lessons/{lesson['id']}/board/operations", json={"operations": operations}).status_code == 200
    assert client.post(f"/api/lessons/{lesson['id']}/board/operations", json={"operations": operations}).status_code == 200
    saved = client.get(f"/api/lessons/{lesson['id']}/board").json()["operations"]

    assert [item["op"] for item in saved] == ["add", "undo", "redo", "clear"]
    assert [item["sequence"] for item in saved] == [1, 2, 3, 4]
    assert saved[0]["stroke"] == stroke


def test_ai_chat_is_saved_and_restored(tmp_path, monkeypatch):
    client, _, _, room = registered_client(tmp_path)
    lesson = client.post(
        f"/api/rooms/{room['id']}/lessons",
        json={"grade": 7, "subject_id": "physics"},
    ).json()["lesson"]
    monkeypatch.setattr("app.main.generate_ai_response", lambda *args: "Сила равна массе, умноженной на ускорение.")

    response = client.post(
        "/api/ai",
        json={
            "mode": "hint",
            "problem": "Найди силу",
            "student_attempt": "F = ma",
            "subject": "Физика",
            "lesson_id": lesson["id"],
            "client_message_id": "message-1",
        },
    )
    chat = client.get(f"/api/lessons/{lesson['id']}/chat").json()["items"]

    assert response.status_code == 200
    assert [(item["role"], item["status"]) for item in chat] == [("student", "ok"), ("assistant", "ok")]
    assert chat[0]["text"] == "F = ma"
    assert chat[1]["text"].startswith("Сила равна")
