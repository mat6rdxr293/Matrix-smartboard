"""Replication between SchoolStore nodes, without HTTP: nodes hand each other their change logs."""
import random

from app.school_store import SchoolStore


def node(tmp_path, name):
    return SchoolStore(tmp_path / f"{name}.db", node_id=name)


def pull(into: SchoolStore, source: SchoolStore) -> int:
    total = 0
    while True:
        changes = source.cluster_changes(into.cluster_vector())
        applied = into.apply_cluster_changes(changes)
        total += applied
        if not changes or not applied:
            return total


def sync(*nodes: SchoolStore) -> None:
    """Every node pulls from every other until nothing moves."""
    while sum(pull(a, b) for a in nodes for b in nodes if a is not b):
        pass


def state(store: SchoolStore) -> dict:
    with store.connection() as c:
        schools = [tuple(r) for r in c.execute("SELECT id, name, normalized_name FROM schools ORDER BY id")]
        sessions = [tuple(r) for r in c.execute("SELECT token_hash, school_id FROM auth_sessions ORDER BY token_hash")]
        rooms = [tuple(r) for r in c.execute("SELECT id, school_id, normalized_name FROM rooms ORDER BY id")]
        lessons = [tuple(r) for r in c.execute("SELECT id, room_id, status, hlc FROM lessons ORDER BY id")]
        lesson_ids = [row[0] for row in lessons]
        school_of = dict(c.execute("SELECT id, school_id FROM lessons"))
    boards = {lid: [op["clientOperationId"] for op in store.board_state(school_of[lid], lid)] for lid in lesson_ids}
    chats = {lid: [m["clientMessageId"] for m in store.chat_messages(school_of[lid], lid)] for lid in lesson_ids}
    return {"schools": schools, "sessions": sessions, "rooms": rooms, "lessons": lessons, "boards": boards, "chats": chats}


def op(op_id, device=None, seq=None, **extra):
    data = {"client_operation_id": op_id, "op": "clear", "ts": 1}
    if device:
        data.update(device_id=device, client_seq=seq)
    data.update(extra)
    return data


def test_everything_written_on_one_node_reaches_another(tmp_path):
    a, b = node(tmp_path, "a"), node(tmp_path, "b")
    school = a.register_school("Школа №1", "password11")
    token = a.create_auth_session(school["id"])
    room = a.create_room(school["id"], "204")
    lesson = a.create_lesson(school["id"], room["id"], 9, "algebra")
    a.append_board_operations(school["id"], lesson["id"], [op("o1"), op("o2")])
    a.append_chat_message(school["id"], lesson["id"], client_message_id="m1", role="student", text="?")
    a.put_document("storage:algebra", {"tasks": [1]})

    sync(a, b)

    assert state(a) == state(b)
    # Signing in on one server works on the others, and so does the school password.
    assert b.school_for_token(token)["id"] == school["id"]
    assert b.authenticate_school("школа №1", "password11")["id"] == school["id"]
    assert [x["clientOperationId"] for x in b.board_state(school["id"], lesson["id"])] == ["o1", "o2"]
    assert b.get_document("storage:algebra") == {"tasks": [1]}


def test_changes_travel_through_a_middle_node(tmp_path):
    a, b, c = node(tmp_path, "a"), node(tmp_path, "b"), node(tmp_path, "c")
    school = a.register_school("Школа", "password11")
    room = a.create_room(school["id"], "101")
    c_school = c.register_school("Другая школа", "password11")
    # a and c never talk; b relays both ways.
    pull(b, a), pull(b, c), pull(c, b), pull(a, b)
    assert state(a) == state(b) == state(c)
    assert {s[0] for s in state(c)["schools"]} == {school["id"], c_school["id"]}
    assert state(c)["rooms"][0][0] == room["id"]


def test_partition_heals_to_the_same_data(tmp_path):
    a, b = node(tmp_path, "a"), node(tmp_path, "b")
    school = a.register_school("Школа", "password11")
    room = a.create_room(school["id"], "101")
    sync(a, b)

    # Cut off from each other, both sides start a lesson in the same room and write to it.
    la = a.create_lesson(school["id"], room["id"], 5, "math")
    lb = b.create_lesson(school["id"], room["id"], 7, "algebra")
    a.append_board_operations(school["id"], la["id"], [op("a1"), op("a2")])
    b.append_board_operations(school["id"], lb["id"], [op("b1")])
    # The same school name registered on both sides.
    a.register_school("Новая", "password11")
    b.register_school("Новая", "password11")

    sync(a, b)

    assert state(a) == state(b)
    statuses = {row[0]: row[2] for row in state(a)["lessons"]}
    # One room keeps one active lesson: the later start wins on both nodes.
    assert statuses[lb["id"]] == "active" and statuses[la["id"]] == "completed"
    names = [row[2] for row in state(a)["schools"] if row[1] == "Новая"]
    assert len(names) == 2 and "новая" in names


def test_a_board_keeps_its_order_when_it_moves_between_servers(tmp_path):
    a, b = node(tmp_path, "a"), node(tmp_path, "b")
    school = a.register_school("Школа", "password11")
    room = a.create_room(school["id"], "101")
    lesson = a.create_lesson(school["id"], room["id"], 9, "algebra")
    a.append_board_operations(school["id"], lesson["id"], [op("x0", "board", 0)])
    sync(a, b)
    # The board writes to a, then a falls silent before passing its last operations on; the board
    # moves to b and keeps writing. b has not seen x1..x3 yet.
    a.append_board_operations(school["id"], lesson["id"], [op(f"x{i}", "board", i) for i in range(1, 4)])
    b.append_board_operations(school["id"], lesson["id"], [op(f"x{i}", "board", i) for i in range(4, 6)])
    # Another board writes meanwhile.
    b.append_board_operations(school["id"], lesson["id"], [op("y0", "other", 0)])

    sync(a, b)

    order_a = state(a)["boards"][lesson["id"]]
    assert order_a == state(b)["boards"][lesson["id"]]
    board_ops = [x for x in order_a if x.startswith("x")]
    assert board_ops == [f"x{i}" for i in range(6)]


def test_applying_changes_twice_or_out_of_order_changes_nothing(tmp_path):
    a, b = node(tmp_path, "a"), node(tmp_path, "b")
    school = a.register_school("Школа", "password11")
    room = a.create_room(school["id"], "101")
    lesson = a.create_lesson(school["id"], room["id"], 9, "algebra")
    a.append_board_operations(school["id"], lesson["id"], [op(f"o{i}") for i in range(10)])
    changes = a.cluster_changes({})
    shuffled = changes[:]
    random.Random(4).shuffle(shuffled)
    b.apply_cluster_changes(shuffled)
    b.apply_cluster_changes(changes)
    b.apply_cluster_changes(changes)
    assert state(a) == state(b)
    assert b.cluster_vector() == a.cluster_vector()


def test_a_change_waits_for_its_parent_from_another_node(tmp_path):
    a, b, c = node(tmp_path, "a"), node(tmp_path, "b"), node(tmp_path, "c")
    school = a.register_school("Школа", "password11")
    room = a.create_room(school["id"], "101")
    pull(b, a)
    lesson = b.create_lesson(school["id"], room["id"], 9, "algebra")
    # c hears about b's lesson before a's room exists there: the lesson waits instead of failing.
    assert c.apply_cluster_changes(b.cluster_changes({"a": 0, "b": 0}, limit=500)[-1:]) == 0
    sync(a, b, c)
    assert state(c) == state(a)
    assert any(row[0] == lesson["id"] for row in state(c)["lessons"])


def test_sign_out_wins_over_the_sign_in_it_ends(tmp_path):
    a, b = node(tmp_path, "a"), node(tmp_path, "b")
    school = a.register_school("Школа", "password11")
    token = a.create_auth_session(school["id"])
    a.delete_auth_session(token)
    # b gets the sign-out before the sign-in (as if relayed in another order).
    changes = a.cluster_changes({})
    delete = [c for c in changes if c["kind"] == "session_delete"]
    others = [c for c in changes if c["kind"] != "session_delete"]
    b.apply_cluster_changes(others[:1])
    b.apply_cluster_changes(changes)
    assert b.school_for_token(token) is None


def test_data_from_before_the_cluster_is_shared_too(tmp_path):
    path = tmp_path / "old.db"
    old = SchoolStore(path, node_id="old")
    school = old.register_school("Школа", "password11")
    room = old.create_room(school["id"], "101")
    lesson = old.create_lesson(school["id"], room["id"], 9, "algebra")
    old.append_board_operations(school["id"], lesson["id"], [op("o1"), op("o2")])
    # Simulate a database written before the log existed.
    with old.connection() as c:
        c.execute("DELETE FROM cluster_log")
        c.execute("DELETE FROM schema_meta WHERE key = 'cluster_bootstrapped'")
        c.execute("UPDATE board_operations SET lamport = NULL, origin = NULL")
    reopened = SchoolStore(path, node_id="old")
    fresh = node(tmp_path, "fresh")
    sync(reopened, fresh)
    assert state(fresh) == state(reopened)
    assert state(fresh)["boards"][lesson["id"]] == ["o1", "o2"]


def test_compacting_the_log_keeps_what_new_nodes_need(tmp_path):
    a = node(tmp_path, "a")
    school = a.register_school("Школа", "password11")
    room = a.create_room(school["id"], "101")
    lesson = a.create_lesson(school["id"], room["id"], 9, "algebra")
    big = {"points": [{"x": i, "y": i} for i in range(200)], "color": "#000", "width": 2, "mode": "draw"}
    a.append_board_operations(school["id"], lesson["id"], [{"client_operation_id": f"s{i}", "op": "add", "stroke": big} for i in range(5)])
    for version in range(20):
        a.put_document("storage:algebra", {"tasks": [version] * 50})
    a.complete_lesson(school["id"], lesson["id"])
    a.resume_lesson(school["id"], lesson["id"])

    with a.connection() as c:
        before = c.execute("SELECT SUM(LENGTH(data)) FROM cluster_log").fetchone()[0]
        # Strokes live once, in board_operations; the log only points at them.
        assert c.execute("SELECT COUNT(*) FROM cluster_log WHERE kind = 'board_op' AND data LIKE '%points%'").fetchone()[0] == 0
    emptied = a.compact_cluster_log()
    with a.connection() as c:
        after = c.execute("SELECT SUM(LENGTH(data)) FROM cluster_log").fetchone()[0]
    assert emptied >= 19 and after < before / 2

    fresh = node(tmp_path, "fresh")
    sync(a, fresh)
    assert state(fresh) == state(a)
    assert fresh.get_document("storage:algebra") == {"tasks": [19] * 50}
    assert [op["stroke"]["points"][-1] for op in fresh.board_state(school["id"], lesson["id"])] == [{"x": 199, "y": 199}] * 5
    assert fresh.cluster_vector() == a.cluster_vector()


def test_a_node_that_moved_tells_the_others_its_new_address(tmp_path):
    from pathlib import Path

    from app.cluster import ClusterService

    a, b = node(tmp_path, "a"), node(tmp_path, "b")
    service = ClusterService(store=a, pin=lambda: "sha256/" + "a" * 64, name=lambda: "A", media_dir=Path(tmp_path))
    service.create("https://10.0.0.5:8443")
    pull(b, a)
    service.note_own_url("https://127.0.0.1:8443/")  # a local request says nothing about the network address
    service.note_own_url("https://10.0.0.9:8443/")
    pull(b, a)
    assert [p["url"] for p in b.cluster_peers() if p["node_id"] == "a"] == ["https://10.0.0.9:8443"]
