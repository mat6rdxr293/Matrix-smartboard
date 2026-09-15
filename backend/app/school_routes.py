from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .school_store import (
    InvalidLesson,
    ResourceNotFound,
    RoomAlreadyExists,
    SchoolAlreadyExists,
    SchoolStore,
)


router = APIRouter()
SESSION_COOKIE = "school_session"


class SchoolCredentials(BaseModel):
    school_name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=8, max_length=256)


class RoomCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class LessonCreate(BaseModel):
    grade: int = Field(ge=1, le=11)
    subject_id: str = Field(min_length=1, max_length=40)


class BoardOperationInput(BaseModel):
    client_operation_id: str = Field(min_length=1, max_length=120)
    op: Literal["add", "undo", "redo", "clear"]
    stroke: dict[str, Any] | None = None
    ts: int | None = None


class BoardOperationsPayload(BaseModel):
    operations: list[BoardOperationInput]


def get_store(request: Request) -> SchoolStore:
    store = getattr(request.app.state, "school_store", None)
    if not isinstance(store, SchoolStore):
        raise HTTPException(status_code=503, detail="Хранилище школ недоступно")
    return store


def require_school(request: Request) -> dict:
    school = get_store(request).school_for_token(request.cookies.get(SESSION_COOKIE))
    if school is None:
        raise HTTPException(status_code=401, detail="Требуется вход школы")
    return school


def _session_response(request: Request, school: dict, token: str, *, status_code: int) -> JSONResponse:
    store = get_store(request)
    response = JSONResponse({"school": school}, status_code=status_code)
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=store.session_days * 86_400,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
        path="/",
    )
    return response


@router.post("/api/auth/register-school")
def register_school(payload: SchoolCredentials, request: Request) -> JSONResponse:
    store = get_store(request)
    try:
        school = store.register_school(payload.school_name, payload.password)
    except SchoolAlreadyExists as exc:
        raise HTTPException(status_code=409, detail="Школа с таким названием уже зарегистрирована") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    token = store.create_auth_session(school["id"])
    return _session_response(request, school, token, status_code=201)


@router.post("/api/auth/login-school")
def login_school(payload: SchoolCredentials, request: Request) -> JSONResponse:
    store = get_store(request)
    school = store.authenticate_school(payload.school_name, payload.password)
    if school is None:
        raise HTTPException(status_code=401, detail="Неверное название школы или пароль")
    token = store.create_auth_session(school["id"])
    return _session_response(request, school, token, status_code=200)


@router.post("/api/auth/logout")
def logout_school(request: Request) -> JSONResponse:
    store = get_store(request)
    store.delete_auth_session(request.cookies.get(SESSION_COOKIE))
    response = JSONResponse({"ok": True})
    response.delete_cookie(SESSION_COOKIE, path="/")
    return response


@router.get("/api/auth/session")
def current_school(request: Request) -> dict:
    return {"school": require_school(request)}


@router.get("/api/rooms")
def list_rooms(request: Request) -> dict:
    school = require_school(request)
    return {"items": get_store(request).list_rooms(school["id"])}


@router.post("/api/rooms", status_code=201)
def create_room(payload: RoomCreate, request: Request) -> dict:
    school = require_school(request)
    try:
        return {"room": get_store(request).create_room(school["id"], payload.name)}
    except RoomAlreadyExists as exc:
        raise HTTPException(status_code=409, detail="Такой кабинет уже существует") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/api/rooms/{room_id}/lessons")
def list_lessons(room_id: str, request: Request, limit: int = 100) -> dict:
    school = require_school(request)
    try:
        return {"items": get_store(request).list_lessons(school["id"], room_id, limit=limit)}
    except ResourceNotFound as exc:
        raise HTTPException(status_code=404, detail="Кабинет не найден") from exc


@router.get("/api/rooms/{room_id}/active-lesson")
def active_lesson(room_id: str, request: Request) -> dict:
    school = require_school(request)
    try:
        return {"lesson": get_store(request).active_lesson(school["id"], room_id)}
    except ResourceNotFound as exc:
        raise HTTPException(status_code=404, detail="Кабинет не найден") from exc


@router.post("/api/rooms/{room_id}/lessons", status_code=201)
def create_lesson(room_id: str, payload: LessonCreate, request: Request) -> dict:
    school = require_school(request)
    try:
        lesson = get_store(request).create_lesson(
            school["id"], room_id, payload.grade, payload.subject_id
        )
        return {"lesson": lesson}
    except ResourceNotFound as exc:
        raise HTTPException(status_code=404, detail="Кабинет не найден") from exc
    except InvalidLesson as exc:
        raise HTTPException(status_code=422, detail="Этот предмет не изучается в выбранном классе") from exc


@router.get("/api/lessons/{lesson_id}")
def get_lesson(lesson_id: str, request: Request) -> dict:
    school = require_school(request)
    lesson = get_store(request).get_lesson(school["id"], lesson_id)
    if lesson is None:
        raise HTTPException(status_code=404, detail="Урок не найден")
    return {"lesson": lesson}


@router.post("/api/lessons/{lesson_id}/complete")
def complete_lesson(lesson_id: str, request: Request) -> dict:
    school = require_school(request)
    try:
        return {"lesson": get_store(request).complete_lesson(school["id"], lesson_id)}
    except ResourceNotFound as exc:
        raise HTTPException(status_code=404, detail="Урок не найден") from exc


@router.post("/api/lessons/{lesson_id}/resume")
def resume_lesson(lesson_id: str, request: Request) -> dict:
    school = require_school(request)
    try:
        return {"lesson": get_store(request).resume_lesson(school["id"], lesson_id)}
    except ResourceNotFound as exc:
        raise HTTPException(status_code=404, detail="Урок не найден") from exc


@router.get("/api/lessons/{lesson_id}/board")
def get_lesson_board(lesson_id: str, request: Request) -> dict:
    school = require_school(request)
    try:
        return {"operations": get_store(request).board_state(school["id"], lesson_id)}
    except ResourceNotFound as exc:
        raise HTTPException(status_code=404, detail="Урок не найден") from exc


@router.post("/api/lessons/{lesson_id}/board/operations")
def append_lesson_board_operations(
    lesson_id: str, payload: BoardOperationsPayload, request: Request
) -> dict:
    school = require_school(request)
    try:
        inserted = get_store(request).append_board_operations(
            school["id"],
            lesson_id,
            [operation.model_dump() for operation in payload.operations],
        )
        return {"ok": True, "inserted": inserted}
    except ResourceNotFound as exc:
        raise HTTPException(status_code=404, detail="Урок не найден") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/api/lessons/{lesson_id}/chat")
def get_lesson_chat(lesson_id: str, request: Request) -> dict:
    school = require_school(request)
    try:
        return {"items": get_store(request).chat_messages(school["id"], lesson_id)}
    except ResourceNotFound as exc:
        raise HTTPException(status_code=404, detail="Урок не найден") from exc
