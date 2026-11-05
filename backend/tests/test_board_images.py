from fastapi.testclient import TestClient
import pymupdf

import app.textbook_library as library
from app.main import app
from app.school_store import SchoolStore


def registered_client(tmp_path):
    store = SchoolStore(tmp_path / "practice.db")
    app.state.school_store = store
    client = TestClient(app)
    client.post("/api/auth/register-school", json={"school_name": "Школа картинок", "password": "password11"})
    room = client.post("/api/rooms", json={"name": "21"}).json()["room"]
    lesson = client.post(f"/api/rooms/{room['id']}/lessons", json={"grade": 7, "subject_id": "physics"}).json()["lesson"]
    return client, lesson


def image(image_id="i1", src="/api/textbooks/book/pages/3/image", **changes):
    return {"id": image_id, "src": src, "x": 40, "y": 60, "width": 600, "height": 800, "label": "Учебник, с. 3", **changes}


def test_image_operations_round_trip_in_order(tmp_path):
    client, lesson = registered_client(tmp_path)
    before = image()
    after = image(x=200, width=300, height=400)
    operations = [
        {"client_operation_id": "i-1", "op": "image_add", "image": before, "ts": 1},
        {"client_operation_id": "i-2", "op": "image_update", "before": before, "after": after, "ts": 2},
        {"client_operation_id": "i-3", "op": "image_delete", "image": after, "ts": 3},
    ]
    assert client.post(f"/api/lessons/{lesson['id']}/board/operations", json={"operations": operations}).status_code == 200
    saved = client.get(f"/api/lessons/{lesson['id']}/board").json()["operations"]
    assert [item["op"] for item in saved] == ["image_add", "image_update", "image_delete"]
    assert saved[1]["after"]["x"] == 200


def test_image_stacking_order_is_kept(tmp_path):
    client, lesson = registered_client(tmp_path)
    before = image()
    after = image(z=1.5)
    operations = [
        {"client_operation_id": "z-1", "op": "image_add", "image": before, "ts": 1},
        {"client_operation_id": "z-2", "op": "image_update", "before": before, "after": after, "ts": 2},
    ]
    assert client.post(f"/api/lessons/{lesson['id']}/board/operations", json={"operations": operations}).status_code == 200
    saved = client.get(f"/api/lessons/{lesson['id']}/board").json()["operations"]
    assert saved[1]["after"]["z"] == 1.5


def test_image_operations_reject_foreign_urls_and_bad_boxes(tmp_path):
    client, lesson = registered_client(tmp_path)
    for bad in (
        image(src="https://evil.example/x.png"),
        image(src="javascript:alert(1)"),
        image(width=0),
        image(id=""),
        image(z="top"),
    ):
        response = client.post(
            f"/api/lessons/{lesson['id']}/board/operations",
            json={"operations": [{"client_operation_id": "bad", "op": "image_add", "image": bad}]},
        )
        assert response.status_code == 422, bad


def test_board_image_upload_accepts_pictures_only(tmp_path, monkeypatch):
    import app.main as main

    monkeypatch.setattr(main, "MEDIA_DIR", tmp_path / "media")
    client = TestClient(app)
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 32
    ok = client.post("/api/board/images", files={"file": ("photo.png", png, "image/png")})
    assert ok.status_code == 200
    src = ok.json()["src"]
    assert src.startswith("/api/media/board-") and src.endswith(".png")
    assert (tmp_path / "media" / src.rsplit("/", 1)[1]).read_bytes() == png
    assert client.post("/api/board/images", files={"file": ("x.pdf", b"%PDF", "application/pdf")}).status_code == 400


def test_textbook_page_renders_to_a_cached_jpeg(tmp_path, monkeypatch):
    monkeypatch.setattr(library, "TEXTBOOK_DIR", tmp_path / "textbooks")
    monkeypatch.setattr(library, "PAGE_IMAGE_DIR", tmp_path / "page-images")
    (tmp_path / "textbooks").mkdir()
    doc = pymupdf.open()
    for text in ("Первая страница", "Вторая страница"):
        doc.new_page().insert_text((72, 72), text)
    doc.save(tmp_path / "textbooks" / "book.pdf")

    client = TestClient(app)
    response = client.get("/api/textbooks/book/pages/2/image?width=900")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert response.content[:2] == b"\xff\xd8"
    # Widths snap to a few sizes so the cache cannot grow without bound.
    assert [p.name for p in (tmp_path / "page-images").iterdir()] == ["book-p2-w800.jpg"]
    assert client.get("/api/textbooks/book/pages/9/image").status_code == 404
    assert client.get("/api/textbooks/missing/pages/1/image").status_code == 404


def test_existing_board_table_is_migrated_to_accept_images(tmp_path):
    import sqlite3

    path = tmp_path / "practice.db"
    client, lesson = registered_client(tmp_path)
    client.post(
        f"/api/lessons/{lesson['id']}/board/operations",
        json={"operations": [{"client_operation_id": "s-1", "op": "clear"}]},
    )
    # Recreate the table as schema 6 left it: same rows, CHECK without image operations.
    with sqlite3.connect(path) as connection:
        ddl = connection.execute("SELECT sql FROM sqlite_master WHERE name = 'board_operations'").fetchone()[0]
        rows = connection.execute("SELECT * FROM board_operations").fetchall()
        connection.execute("DROP TABLE board_operations")
        connection.execute(ddl.replace("'image_add', 'image_update', 'image_delete', ", ""))
        connection.executemany("INSERT INTO board_operations VALUES (?, ?, ?, ?, ?, ?, ?)", rows)

    app.state.school_store = SchoolStore(path)
    response = client.post(
        f"/api/lessons/{lesson['id']}/board/operations",
        json={"operations": [{"client_operation_id": "i-1", "op": "image_add", "image": image()}]},
    )
    assert response.status_code == 200
    saved = client.get(f"/api/lessons/{lesson['id']}/board").json()["operations"]
    assert [item["op"] for item in saved] == ["clear", "image_add"]


def test_status_advertises_board_images():
    client = TestClient(app)
    assert client.get("/api/status").json()["features"]["boardImages"] is True
