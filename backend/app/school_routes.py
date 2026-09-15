from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .school_store import RoomAlreadyExists, SchoolAlreadyExists, SchoolStore


router = APIRouter()
SESSION_COOKIE = "school_session"


class SchoolCredentials(BaseModel):
    school_name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=8, max_length=256)


class RoomCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


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
