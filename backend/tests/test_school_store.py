import sqlite3

import pytest

from app.school_store import RoomAlreadyExists, SchoolAlreadyExists, SchoolStore


@pytest.fixture()
def store(tmp_path):
    return SchoolStore(tmp_path / "practice.db", session_days=30)


def test_registers_and_authenticates_normalized_school_name(store: SchoolStore):
    school = store.register_school("  Школа   №11 ", "correct horse")

    assert school["name"] == "Школа №11"
    assert store.authenticate_school("школа №11", "correct horse")["id"] == school["id"]
    assert store.authenticate_school("Школа №11", "wrong password") is None


def test_rejects_duplicate_normalized_school_name(store: SchoolStore):
    store.register_school("Школа №11", "correct horse")

    with pytest.raises(SchoolAlreadyExists):
        store.register_school(" школа   №11 ", "another password")


def test_auth_session_can_be_loaded_deleted_and_expired(store: SchoolStore):
    school = store.register_school("Школа №11", "correct horse")
    token = store.create_auth_session(school["id"])

    assert store.school_for_token(token)["id"] == school["id"]
    store.delete_auth_session(token)
    assert store.school_for_token(token) is None

    expired_token = store.create_auth_session(school["id"], expires_in_seconds=-1)
    assert store.school_for_token(expired_token) is None


def test_rooms_are_unique_within_school_and_isolated(store: SchoolStore):
    school_11 = store.register_school("Школа №11", "correct horse")
    school_12 = store.register_school("Школа №12", "correct horse")

    room_20 = store.create_room(school_11["id"], " 20 ")
    store.create_room(school_12["id"], "20")

    assert store.list_rooms(school_11["id"]) == [room_20]
    assert store.list_rooms(school_12["id"])[0]["schoolId"] == school_12["id"]
    with pytest.raises(RoomAlreadyExists):
        store.create_room(school_11["id"], "  20  ")


def test_password_is_not_stored_as_plain_text(store: SchoolStore):
    store.register_school("Школа №11", "correct horse")

    with sqlite3.connect(store.path) as connection:
        row = connection.execute("SELECT password_hash, password_salt FROM schools").fetchone()

    assert row is not None
    assert b"correct horse" not in row[0]
    assert len(row[0]) == 64
    assert len(row[1]) == 16
