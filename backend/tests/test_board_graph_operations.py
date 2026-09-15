import sqlite3

from fastapi.testclient import TestClient

from app.main import app
from app.school_store import SchoolStore


def registered_client(tmp_path, school_name="Школа графиков"):
    store = SchoolStore(tmp_path / "practice.db")
    app.state.school_store = store
    client = TestClient(app)
    client.post(
        "/api/auth/register-school",
        json={"school_name": school_name, "password": "password11"},
    )
    room = client.post("/api/rooms", json={"name": "20"}).json()["room"]
    lesson = client.post(
        f"/api/rooms/{room['id']}/lessons",
        json={"grade": 7, "subject_id": "physics"},
    ).json()["lesson"]
    return client, store, lesson


def graph(graph_id="g1", expression="x"):
    return {
        "id": graph_id,
        "x": 100,
        "y": 120,
        "width": 420,
        "height": 300,
        "xLabel": "x",
        "yLabel": "y",
        "xMin": -10,
        "xMax": 10,
        "yMin": -10,
        "yMax": 10,
        "expressions": [
            {"id": "e1", "expression": expression, "color": "#4DA3FF", "visible": True}
        ],
    }


def test_graph_operations_are_saved_in_exact_order_and_deduplicated(tmp_path):
    client, _, lesson = registered_client(tmp_path)
    before = graph()
    after = {**before, "x": 240}
    operations = [
        {"client_operation_id": "g-1", "op": "graph_add", "graph": before, "ts": 100},
        {"client_operation_id": "g-2", "op": "graph_update", "before": before, "after": after, "ts": 110},
        {"client_operation_id": "g-3", "op": "graph_delete", "graph": after, "ts": 120},
    ]

    first = client.post(f"/api/lessons/{lesson['id']}/board/operations", json={"operations": operations})
    second = client.post(f"/api/lessons/{lesson['id']}/board/operations", json={"operations": operations})
    saved = client.get(f"/api/lessons/{lesson['id']}/board").json()["operations"]

    assert first.status_code == 200
    assert second.status_code == 200
    assert [item["op"] for item in saved] == ["graph_add", "graph_update", "graph_delete"]
    assert saved[1]["before"] == before
    assert saved[1]["after"] == after


def test_graph_update_requires_matching_ids_and_valid_graph_shape(tmp_path):
    client, _, lesson = registered_client(tmp_path)
    before = graph("g1")
    after = graph("g2")
    mismatch = client.post(
        f"/api/lessons/{lesson['id']}/board/operations",
        json={"operations": [{"client_operation_id": "bad-1", "op": "graph_update", "before": before, "after": after}]},
    )
    broken = client.post(
        f"/api/lessons/{lesson['id']}/board/operations",
        json={"operations": [{"client_operation_id": "bad-2", "op": "graph_add", "graph": {"id": "g1"}}]},
    )

    assert mismatch.status_code == 422
    assert broken.status_code == 422


def test_graph_operations_remain_isolated_between_schools(tmp_path):
    client_a, store, lesson = registered_client(tmp_path, "Школа A")
    response = client_a.post(
        f"/api/lessons/{lesson['id']}/board/operations",
        json={"operations": [{"client_operation_id": "iso-1", "op": "graph_add", "graph": graph()}]},
    )
    assert response.status_code == 200

    app.state.school_store = store
    client_b = TestClient(app)
    client_b.post("/api/auth/register-school", json={"school_name": "Школа B", "password": "password12"})
    assert client_b.get(f"/api/lessons/{lesson['id']}/board").status_code == 404


def create_old_database(path):
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE schools (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE,
            password_salt BLOB NOT NULL, password_hash BLOB NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE auth_sessions (
            token_hash TEXT PRIMARY KEY, school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE TABLE rooms (
            id TEXT PRIMARY KEY, school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
            name TEXT NOT NULL, normalized_name TEXT NOT NULL, created_at INTEGER NOT NULL,
            UNIQUE(school_id, normalized_name)
        );
        CREATE TABLE lessons (
            id TEXT PRIMARY KEY, school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
            room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
            grade INTEGER NOT NULL CHECK(grade BETWEEN 1 AND 11), subject_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active', 'completed')),
            started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER
        );
        CREATE TABLE board_operations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL, client_operation_id TEXT NOT NULL,
            op_type TEXT NOT NULL CHECK(op_type IN ('add', 'undo', 'redo', 'clear')),
            payload_json TEXT NOT NULL, occurred_at INTEGER NOT NULL,
            UNIQUE(lesson_id, sequence), UNIQUE(lesson_id, client_operation_id)
        );
        """
    )
    connection.execute(
        "INSERT INTO schools VALUES ('s1', 'Old', 'old', X'00', X'00', 1)"
    )
    connection.execute(
        "INSERT INTO rooms VALUES ('r1', 's1', '20', '20', 1)"
    )
    connection.execute(
        "INSERT INTO lessons VALUES ('l1', 's1', 'r1', 7, 'physics', 'active', 1, 1, NULL)"
    )
    stroke = {
        "points": [{"x": 1, "y": 2}, {"x": 3, "y": 4}],
        "color": "#ffffff",
        "width": 3,
        "mode": "draw",
    }
    connection.execute(
        """
        INSERT INTO board_operations(lesson_id, sequence, client_operation_id, op_type, payload_json, occurred_at)
        VALUES ('l1', 1, 'old-op', 'add', ?, 100)
        """,
        (__import__("json").dumps({"stroke": stroke}),),
    )
    connection.commit()
    connection.close()


def test_old_board_schema_is_migrated_without_losing_operations(tmp_path):
    path = tmp_path / "old.db"
    create_old_database(path)
    store = SchoolStore(path)

    saved = store.board_state("s1", "l1")
    assert [item["op"] for item in saved] == ["add"]
    assert saved[0]["clientOperationId"] == "old-op"

    inserted = store.append_board_operations(
        "s1",
        "l1",
        [{"client_operation_id": "new-graph", "op": "graph_add", "graph": graph(), "ts": 200}],
    )
    assert inserted == 1
    assert [item["op"] for item in store.board_state("s1", "l1")] == ["add", "graph_add"]
