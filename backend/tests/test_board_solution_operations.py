from fastapi.testclient import TestClient

from app.main import app
from app.school_store import SchoolStore


def registered_client(tmp_path):
    store = SchoolStore(tmp_path / "practice.db")
    app.state.school_store = store
    client = TestClient(app)
    client.post(
        "/api/auth/register-school",
        json={"school_name": "Школа AI решений", "password": "password11"},
    )
    room = client.post("/api/rooms", json={"name": "21"}).json()["room"]
    lesson = client.post(
        f"/api/rooms/{room['id']}/lessons",
        json={"grade": 9, "subject_id": "algebra"},
    ).json()["lesson"]
    return client, lesson


def solution(solution_id="s1", *, status="done", x=500):
    return {
        "id": solution_id,
        "x": x,
        "y": 120,
        "width": 500,
        "minHeight": 280,
        "steps": [
            {"id": "step-1", "text": "$$x^2=4$$", "kind": "math"},
            {"id": "step-2", "text": "$$x=\\pm 2$$", "kind": "result"},
        ],
        "status": status,
        "source": "ai",
        "createdAt": 1_790_000_000_000,
    }


def test_solution_operations_roundtrip_and_deduplicate(tmp_path):
    client, lesson = registered_client(tmp_path)
    before = solution(status="thinking")
    after = solution(status="done")
    operations = [
        {"client_operation_id": "s-1", "op": "solution_add", "solution": before, "ts": 100},
        {"client_operation_id": "s-2", "op": "solution_update", "before": before, "after": after, "ts": 110},
        {"client_operation_id": "s-3", "op": "solution_delete", "solution": after, "ts": 120},
    ]

    first = client.post(f"/api/lessons/{lesson['id']}/board/operations", json={"operations": operations})
    second = client.post(f"/api/lessons/{lesson['id']}/board/operations", json={"operations": operations})
    saved = client.get(f"/api/lessons/{lesson['id']}/board").json()["operations"]

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["inserted"] == 3
    assert second.json()["inserted"] == 0
    assert [item["op"] for item in saved] == ["solution_add", "solution_update", "solution_delete"]
    assert saved[0]["solution"] == before
    assert saved[1]["before"] == before
    assert saved[1]["after"] == after


def test_solution_update_requires_matching_ids(tmp_path):
    client, lesson = registered_client(tmp_path)
    before = solution("s1")
    after = solution("s2")

    response = client.post(
        f"/api/lessons/{lesson['id']}/board/operations",
        json={
            "operations": [
                {
                    "client_operation_id": "bad-solution",
                    "op": "solution_update",
                    "before": before,
                    "after": after,
                }
            ]
        },
    )

    assert response.status_code == 422


def test_solution_payload_limits_are_validated(tmp_path):
    client, lesson = registered_client(tmp_path)
    broken = solution()
    broken["steps"] = [
        {"id": f"step-{index}", "text": "x", "kind": "text"}
        for index in range(41)
    ]

    response = client.post(
        f"/api/lessons/{lesson['id']}/board/operations",
        json={
            "operations": [
                {"client_operation_id": "too-many", "op": "solution_add", "solution": broken}
            ]
        },
    )

    assert response.status_code == 422

def test_handwriting_stroke_batch_roundtrip(tmp_path):
    client, lesson = registered_client(tmp_path)
    strokes = [
        {
            "points": [{"x": 10, "y": 20}, {"x": 20, "y": 25}, {"x": 30, "y": 21}],
            "color": "#ffffff",
            "width": 2.2,
            "mode": "draw",
        },
        {
            "points": [{"x": 40, "y": 20}, {"x": 50, "y": 25}],
            "color": "#ffffff",
            "width": 2.2,
            "mode": "draw",
        },
    ]

    response = client.post(
        f"/api/lessons/{lesson['id']}/board/operations",
        json={
            "operations": [
                {
                    "client_operation_id": "handwriting-1",
                    "op": "stroke_batch_add",
                    "strokes": strokes,
                    "ts": 150,
                }
            ]
        },
    )
    saved = client.get(f"/api/lessons/{lesson['id']}/board").json()["operations"]

    assert response.status_code == 200
    assert response.json()["inserted"] == 1
    assert saved[-1]["op"] == "stroke_batch_add"
    assert saved[-1]["strokes"] == strokes
