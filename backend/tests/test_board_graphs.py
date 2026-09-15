import sqlite3

from app.school_store import SchoolStore
from test_lesson_sessions import registered_client


def graph_payload(graph_id="g1", *, x=100, expression="x"):
    return {
        "id": graph_id,
        "x": x,
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


def create_lesson(client, room):
    return client.post(
        f"/api/rooms/{room['id']}/lessons",
        json={"grade": 7, "subject_id": "physics"},
    ).json()["lesson"]

def test_graph_operations_are_saved_in_order_and_deduplicated(tmp_path):
    client, _, _, room = registered_client(tmp_path)
    lesson = create_lesson(client, room)
    before = graph_payload()
    after = graph_payload(x=240, expression="x^2")
    operations = [
        {"client_operation_id": "g-op-1", "op": "graph_add", "graph": before, "ts": 100},
        {"client_operation_id": "g-op-2", "op": "graph_update", "before": before, "after": after, "ts": 110},
        {"client_operation_id": "g-op-3", "op": "undo", "ts": 120},
        {"client_operation_id": "g-op-4", "op": "redo", "ts": 130},
        {"client_operation_id": "g-op-5", "op": "graph_delete", "graph": after, "ts": 140},
    ]

    url = f"/api/lessons/{lesson['id']}/board/operations"
    assert client.post(url, json={"operations": operations}).status_code == 200
    assert client.post(url, json={"operations": operations}).json()["inserted"] == 0
    saved = client.get(f"/api/lessons/{lesson['id']}/board").json()["operations"]
    assert [item["op"] for item in saved] == [item["op"] for item in operations]
    assert saved[0]["graph"] == before
    assert saved[1]["before"] == before
    assert saved[1]["after"] == after
    assert saved[4]["graph"] == after

def test_graph_update_rejects_mismatched_ids_and_invalid_shape(tmp_path):
    client, _, _, room = registered_client(tmp_path)
    lesson = create_lesson(client, room)
    url = f"/api/lessons/{lesson['id']}/board/operations"
    before = graph_payload("g1")
    after = graph_payload("g2")

    mismatch = client.post(url, json={"operations": [
        {"client_operation_id": "bad-1", "op": "graph_update", "before": before, "after": after}
    ]})
    invalid = graph_payload()
    invalid["width"] = 100
    bad_shape = client.post(url, json={"operations": [
        {"client_operation_id": "bad-2", "op": "graph_add", "graph": invalid}
    ]})

    assert mismatch.status_code == 422
    assert bad_shape.status_code == 422


def test_board_operations_remain_isolated_between_schools(tmp_path):
    client_1, store, _, room = registered_client(tmp_path, "Школа A")
    lesson = create_lesson(client_1, room)
    client_1.post(f"/api/lessons/{lesson['id']}/board/operations", json={"operations": [
        {"client_operation_id": "g1", "op": "graph_add", "graph": graph_payload()}
    ]})
    client_2, _, _, _ = registered_client(tmp_path, "Школа B")
    assert client_2.get(f"/api/lessons/{lesson['id']}/board").status_code == 404
    assert client_2.post(
        f"/api/lessons/{lesson['id']}/board/operations",
        json={"operations": [{"client_operation_id": "x", "op": "clear"}]},
    ).status_code == 404


def test_old_board_operation_check_is_migrated_without_losing_rows(tmp_path):
    path = tmp_path / "migration.db"
    store = SchoolStore(path)
    school = store.register_school("Migration School", "password11")
    room = store.create_room(school["id"], "1")
    lesson = store.create_lesson(school["id"], room["id"], 7, "physics")
    stroke = {"points": [{"x": 0, "y": 0}, {"x": 1, "y": 1}], "color": "#fff", "width": 2, "mode": "draw"}

    with sqlite3.connect(path) as connection:
        connection.execute("DROP TABLE board_operations")
        connection.execute("DROP TABLE IF EXISTS schema_meta")
        connection.execute("""
            CREATE TABLE board_operations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
                sequence INTEGER NOT NULL,
                client_operation_id TEXT NOT NULL,
                op_type TEXT NOT NULL CHECK(op_type IN ('add', 'undo', 'redo', 'clear')),
                payload_json TEXT NOT NULL,
                occurred_at INTEGER NOT NULL,
                UNIQUE(lesson_id, sequence),
                UNIQUE(lesson_id, client_operation_id)
            )
        """)
        connection.execute(
            "INSERT INTO board_operations(lesson_id, sequence, client_operation_id, op_type, payload_json, occurred_at) VALUES (?, 1, 'old-1', 'add', ?, 10)",
            (lesson["id"], __import__("json").dumps({"stroke": stroke})),
        )
        connection.execute("CREATE INDEX idx_board_operations_lesson ON board_operations(lesson_id, sequence)")

    SchoolStore(path)
    with sqlite3.connect(path) as connection:
        sql = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='board_operations'"
        ).fetchone()[0]
        rows = connection.execute(
            "SELECT sequence, client_operation_id, op_type, payload_json FROM board_operations ORDER BY sequence"
        ).fetchall()
        legacy = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='board_operations_legacy'"
        ).fetchone()
        indexes = {row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='board_operations'"
        ).fetchall()}

    assert "graph_add" in sql
    assert rows == [(1, "old-1", "add", __import__("json").dumps({"stroke": stroke}))]
    assert legacy is None
    assert "idx_board_operations_lesson" in indexes
