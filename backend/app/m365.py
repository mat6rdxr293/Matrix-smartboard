from __future__ import annotations

import base64
import hashlib
import json
import secrets
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx
from cryptography.fernet import Fernet, InvalidToken

from .pptx_import import _render_pptx_to_pngs, _save_media, import_pptx_full
from .settings import settings


AUTH_STATE_TTL_SEC = 900
GRAPH_BASE = "https://graph.microsoft.com/v1.0"


class M365Error(RuntimeError):
    pass


def _now_ts() -> int:
    return int(time.time())


def _json_load(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _json_dump(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


class M365Client:
    def __init__(self, tokens_file: Path, state_file: Path, auth_state_file: Path):
        self.tokens_file = tokens_file
        self.state_file = state_file
        self.auth_state_file = auth_state_file

    def _is_configured(self) -> bool:
        return bool(
            settings.m365_client_id
            and settings.m365_tenant_id
            and settings.m365_client_secret
            and settings.m365_redirect_uri
            and settings.m365_token_encryption_key
        )

    def _require_config(self) -> None:
        if self._is_configured():
            return
        raise M365Error("Microsoft 365 не настроен на сервере")

    def _fernet(self) -> Fernet:
        self._require_config()
        raw = (settings.m365_token_encryption_key or "").strip().encode("utf-8")
        if not raw:
            raise M365Error("Пустой ключ шифрования M365")
        try:
            return Fernet(raw)
        except Exception:
            # Если передан не Fernet-ключ, детерминированно преобразуем в валидный.
            digest = hashlib.sha256(raw).digest()
            key = base64.urlsafe_b64encode(digest)
            return Fernet(key)

    def _load_tokens(self) -> dict[str, Any] | None:
        if not self.tokens_file.exists():
            return None
        try:
            encrypted = self.tokens_file.read_bytes()
            decrypted = self._fernet().decrypt(encrypted)
            data = json.loads(decrypted.decode("utf-8"))
            if isinstance(data, dict):
                return data
        except (InvalidToken, ValueError, OSError, json.JSONDecodeError):
            return None
        return None

    def _save_tokens(self, data: dict[str, Any]) -> None:
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        encrypted = self._fernet().encrypt(payload)
        self.tokens_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.tokens_file.with_suffix(".tmp")
        tmp.write_bytes(encrypted)
        tmp.replace(self.tokens_file)

    def _clear_tokens(self) -> None:
        if self.tokens_file.exists():
            self.tokens_file.unlink(missing_ok=True)

    def _load_state(self) -> dict[str, Any]:
        data = _json_load(self.state_file, default={})
        return data if isinstance(data, dict) else {}

    def _save_state(self, state: dict[str, Any]) -> None:
        _json_dump(self.state_file, state)

    def _load_auth_state(self) -> dict[str, Any]:
        data = _json_load(self.auth_state_file, default={})
        return data if isinstance(data, dict) else {}

    def _save_auth_state(self, data: dict[str, Any]) -> None:
        _json_dump(self.auth_state_file, data)

    def _clear_auth_state(self) -> None:
        if self.auth_state_file.exists():
            self.auth_state_file.unlink(missing_ok=True)

    def _token_endpoint(self) -> str:
        tenant = settings.m365_tenant_id or "common"
        return f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"

    def _auth_endpoint(self) -> str:
        tenant = settings.m365_tenant_id or "common"
        return f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize"

    def _scopes(self) -> str:
        return "offline_access User.Read Files.ReadWrite"

    def start_auth(self) -> str:
        self._require_config()
        state = secrets.token_urlsafe(24)
        self._save_auth_state({"state": state, "ts": _now_ts()})
        query = urlencode(
            {
                "client_id": settings.m365_client_id,
                "response_type": "code",
                "redirect_uri": settings.m365_redirect_uri,
                "response_mode": "query",
                "scope": self._scopes(),
                "state": state,
                "prompt": "select_account",
            }
        )
        return f"{self._auth_endpoint()}?{query}"

    def _validate_callback_state(self, incoming_state: str | None) -> None:
        saved = self._load_auth_state()
        expected = saved.get("state")
        created = saved.get("ts", 0)
        self._clear_auth_state()
        if not incoming_state or not expected or incoming_state != expected:
            raise M365Error("Некорректный state в OAuth callback")
        if not isinstance(created, int) or _now_ts() - created > AUTH_STATE_TTL_SEC:
            raise M365Error("OAuth callback просрочен")

    def _token_request(self, payload: dict[str, str]) -> dict[str, Any]:
        with httpx.Client(timeout=30.0) as client:
            resp = client.post(self._token_endpoint(), data=payload)
        if resp.status_code >= 400:
            try:
                err = resp.json()
                msg = err.get("error_description") or err.get("error")
            except Exception:
                msg = resp.text
            raise M365Error(f"Не удалось получить токен Microsoft: {msg}")
        data = resp.json()
        if not isinstance(data, dict) or "access_token" not in data:
            raise M365Error("Некорректный ответ токен-эндпоинта Microsoft")
        return data

    def finish_auth(self, code: str, state: str | None) -> dict[str, Any]:
        self._require_config()
        self._validate_callback_state(state)
        token_payload = self._token_request(
            {
                "client_id": settings.m365_client_id or "",
                "client_secret": settings.m365_client_secret or "",
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": settings.m365_redirect_uri or "",
                "scope": self._scopes(),
            }
        )
        expires_in = int(token_payload.get("expires_in", 3600))
        token_data = {
            "access_token": token_payload.get("access_token"),
            "refresh_token": token_payload.get("refresh_token"),
            "expires_at": _now_ts() + max(60, expires_in - 60),
            "scope": token_payload.get("scope"),
            "token_type": token_payload.get("token_type", "Bearer"),
        }
        self._save_tokens(token_data)
        me = self.get_me()
        return {"connected": True, "user": me}

    def _refresh_if_needed(self) -> str:
        self._require_config()
        tokens = self._load_tokens()
        if not tokens:
            raise M365Error("Microsoft 365 не подключен")
        access_token = tokens.get("access_token")
        expires_at = int(tokens.get("expires_at", 0))
        if access_token and _now_ts() < expires_at:
            return str(access_token)

        refresh_token = tokens.get("refresh_token")
        if not refresh_token:
            raise M365Error("Требуется повторный вход Microsoft 365")

        refreshed = self._token_request(
            {
                "client_id": settings.m365_client_id or "",
                "client_secret": settings.m365_client_secret or "",
                "grant_type": "refresh_token",
                "refresh_token": str(refresh_token),
                "redirect_uri": settings.m365_redirect_uri or "",
                "scope": self._scopes(),
            }
        )
        expires_in = int(refreshed.get("expires_in", 3600))
        tokens["access_token"] = refreshed.get("access_token")
        tokens["refresh_token"] = refreshed.get("refresh_token") or refresh_token
        tokens["expires_at"] = _now_ts() + max(60, expires_in - 60)
        tokens["scope"] = refreshed.get("scope", tokens.get("scope"))
        self._save_tokens(tokens)
        return str(tokens["access_token"])

    def _graph(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        content: bytes | None = None,
        headers: dict[str, str] | None = None,
        absolute_url: str | None = None,
        timeout: float = 60.0,
    ) -> dict[str, Any]:
        token = self._refresh_if_needed()
        req_headers = {"Authorization": f"Bearer {token}"}
        if headers:
            req_headers.update(headers)
        url = absolute_url or f"{GRAPH_BASE}{path}"
        with httpx.Client(timeout=timeout) as client:
            resp = client.request(method, url, json=json_body, content=content, headers=req_headers)
        if resp.status_code >= 400:
            detail = None
            try:
                payload = resp.json()
                detail = (
                    payload.get("error", {}).get("message")
                    if isinstance(payload, dict)
                    else None
                )
            except Exception:
                detail = None
            raise M365Error(detail or f"Graph API error ({resp.status_code})")
        if not resp.content:
            return {}
        try:
            data = resp.json()
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def get_me(self) -> dict[str, Any]:
        data = self._graph("GET", "/me")
        return {
            "id": data.get("id"),
            "displayName": data.get("displayName"),
            "userPrincipalName": data.get("userPrincipalName"),
        }

    def upload_pptx(self, filename: str, content: bytes) -> dict[str, Any]:
        self._require_config()
        if not filename.lower().endswith(".pptx"):
            filename = f"{filename}.pptx"
        safe_name = f"algebra-{int(time.time())}-{Path(filename).name}"
        if len(content) <= 4 * 1024 * 1024:
            item = self._graph("PUT", f"/me/drive/root:/{safe_name}:/content", content=content, timeout=120.0)
        else:
            session = self._graph(
                "POST",
                f"/me/drive/root:/{safe_name}:/createUploadSession",
                json_body={"item": {"@microsoft.graph.conflictBehavior": "replace", "name": safe_name}},
                timeout=60.0,
            )
            upload_url = session.get("uploadUrl")
            if not upload_url:
                raise M365Error("Microsoft не вернул uploadUrl")
            chunk_size = 5 * 1024 * 1024
            item = {}
            for start in range(0, len(content), chunk_size):
                end = min(start + chunk_size, len(content)) - 1
                chunk = content[start : end + 1]
                headers = {
                    "Content-Length": str(len(chunk)),
                    "Content-Range": f"bytes {start}-{end}/{len(content)}",
                }
                result = self._graph(
                    "PUT",
                    "",
                    absolute_url=str(upload_url),
                    content=chunk,
                    headers=headers,
                    timeout=180.0,
                )
                if "id" in result:
                    item = result
            if not item:
                raise M365Error("Не удалось завершить загрузку PPTX в Microsoft 365")

        result = {
            "fileId": item.get("id"),
            "name": item.get("name"),
            "webUrl": item.get("webUrl"),
            "lastSyncTs": int(time.time() * 1000),
        }
        state = self._load_state()
        state.update(result)
        self._save_state(state)
        return result

    def build_session(self, *, mode: str, access: str, file_id: str | None = None) -> dict[str, Any]:
        state = self._load_state()
        fid = file_id or state.get("fileId")
        if not fid:
            raise M365Error("Сначала загрузите PPTX в Microsoft 365")

        item = self._graph("GET", f"/me/drive/items/{fid}")
        web_url = item.get("webUrl")
        embed_url: str | None = None
        if mode == "edit":
            embed_url = str(web_url) if web_url else None
        else:
            try:
                preview = self._graph("POST", f"/me/drive/items/{fid}/preview", json_body={"viewer": "office"})
                embed_url = preview.get("getUrl")
            except Exception:
                embed_url = str(web_url) if web_url else None
        if not embed_url:
            raise M365Error("Не удалось создать embed-сессию Microsoft 365")

        next_state = {
            **state,
            "type": "m365",
            "mode": mode,
            "access": access,
            "fileId": fid,
            "embedUrl": embed_url,
            "lastSyncTs": int(time.time() * 1000),
            "fallbackPdf": state.get("fallbackPdf", []),
        }
        self._save_state(next_state)
        return next_state

    def create_public_link(self, file_id: str | None = None) -> dict[str, Any]:
        state = self._load_state()
        fid = file_id or state.get("fileId")
        if not fid:
            raise M365Error("Нет файла для публикации")
        payload = {"type": "view", "scope": "anonymous"}
        try:
            data = self._graph("POST", f"/me/drive/items/{fid}/createLink", json_body=payload)
        except Exception:
            payload["scope"] = "organization"
            data = self._graph("POST", f"/me/drive/items/{fid}/createLink", json_body=payload)

        web_url = data.get("link", {}).get("webUrl")
        if not web_url:
            raise M365Error("Microsoft не вернул публичную ссылку")

        next_state = {
            **state,
            "type": "m365",
            "access": "public",
            "fileId": fid,
            "publicUrl": web_url,
            "lastSyncTs": int(time.time() * 1000),
        }
        self._save_state(next_state)
        return next_state

    def _download_pptx(self, file_id: str) -> bytes:
        token = self._refresh_if_needed()
        headers = {"Authorization": f"Bearer {token}"}
        with httpx.Client(timeout=180.0, follow_redirects=True) as client:
            resp = client.get(f"{GRAPH_BASE}/me/drive/items/{file_id}/content", headers=headers)
        if resp.status_code >= 400:
            raise M365Error("Не удалось скачать PPTX из Microsoft 365")
        return resp.content

    def make_fallback_images(self, file_id: str | None = None) -> list[str]:
        state = self._load_state()
        fid = file_id or state.get("fileId")
        if not fid:
            raise M365Error("Нет файла для fallback")
        pptx_bytes = self._download_pptx(str(fid))
        urls: list[str] = []

        try:
            full = import_pptx_full(pptx_bytes)
            urls = [str(slide.get("background")) for slide in full if isinstance(slide.get("background"), str)]
            urls = [u for u in urls if u]
        except Exception:
            urls = []

        if not urls:
            with tempfile.TemporaryDirectory() as td:
                tmp_path = Path(td)
                images = _render_pptx_to_pngs(pptx_bytes, tmp_path)
                for image in images:
                    urls.append(_save_media(image.read_bytes(), "png"))

        if not urls:
            raise M365Error("Не удалось построить fallback-страницы")

        next_state = {
            **state,
            "type": "m365",
            "fileId": fid,
            "embedUrl": None,
            "fallbackPdf": urls,
            "lastSyncTs": int(time.time() * 1000),
        }
        self._save_state(next_state)
        return urls

    def status(self) -> dict[str, Any]:
        if not self._is_configured():
            return {"configured": False, "connected": False, "user": None, "presentationSource": None}
        tokens = self._load_tokens()
        if not tokens:
            return {"configured": True, "connected": False, "user": None, "presentationSource": None}
        try:
            me = self.get_me()
            state = self._load_state()
            source = None
            if state.get("fileId"):
                source = {
                    "type": "m365",
                    "mode": state.get("mode", "view"),
                    "access": state.get("access", "private"),
                    "embedUrl": state.get("embedUrl"),
                    "fileId": state.get("fileId"),
                    "lastSyncTs": state.get("lastSyncTs"),
                    "fallbackPdf": state.get("fallbackPdf", []),
                }
            return {"configured": True, "connected": True, "user": me, "presentationSource": source}
        except Exception:
            return {"configured": True, "connected": False, "user": None, "presentationSource": None}

    def disconnect(self) -> None:
        self._clear_tokens()
        self._clear_auth_state()
        if self.state_file.exists():
            self.state_file.unlink(missing_ok=True)
