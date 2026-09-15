from __future__ import annotations

import os
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).resolve().parents[1]
ROOT_DIR = Path(__file__).resolve().parents[2]
MONOREPO_ROOT = Path(__file__).resolve().parents[3]
ENV_FILE = BASE_DIR / ".env"
ROOT_ENV_FILE = ROOT_DIR / ".env"
PORTAL_BACKEND_ENV_FILE = MONOREPO_ROOT / "backend" / ".env"
PORTAL_BACKEND_PROD_ENV_FILE = MONOREPO_ROOT / "backend" / ".env.production"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(
            str(ENV_FILE),
            str(ROOT_ENV_FILE),
            str(PORTAL_BACKEND_ENV_FILE),
            str(PORTAL_BACKEND_PROD_ENV_FILE),
        ),
        extra="ignore",
        case_sensitive=False,
    )

    openai_api_key: str | None = Field(default=None, validation_alias="OPENAI_API_KEY")
    ai_model: str = Field(default="gpt-5.2", validation_alias="AI_MODEL")
    ocr_model: str = Field(default="gpt-5.2", validation_alias="OCR_MODEL")
    ai_timeout_seconds: float = Field(default=30.0, validation_alias="AI_TIMEOUT_SECONDS")
    ai_reasoning_effort: str = Field(default="medium", validation_alias="AI_REASONING_EFFORT")

    rate_limit_per_minute: int = Field(default=30, validation_alias="RATE_LIMIT_PER_MINUTE")
    public_base_url: str | None = Field(default=None, validation_alias="PUBLIC_BASE_URL")
    pm_shared_secret: str | None = Field(default=None, validation_alias="PM_SHARED_SECRET")

    m365_client_id: str | None = Field(default=None, validation_alias="M365_CLIENT_ID")
    m365_tenant_id: str | None = Field(default=None, validation_alias="M365_TENANT_ID")
    m365_client_secret: str | None = Field(default=None, validation_alias="M365_CLIENT_SECRET")
    m365_redirect_uri: str | None = Field(default=None, validation_alias="M365_REDIRECT_URI")
    m365_token_encryption_key: str | None = Field(default=None, validation_alias="M365_TOKEN_ENCRYPTION_KEY")


settings = Settings()


def _read_openai_key_from_env_file(path: Path) -> str | None:
    if not path.exists():
        return None
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        normalized_key = key.strip().lstrip("\ufeff").upper()
        if normalized_key == "OPENAI_API_KEY":
            cleaned = value.strip().strip("\"'")
            return cleaned or None
    return None


def get_openai_key() -> str | None:
    env_value = os.getenv("OPENAI_API_KEY")
    if env_value:
        return env_value
    # Keep lab aligned with the main portal backend key source when available.
    for candidate in (PORTAL_BACKEND_ENV_FILE, PORTAL_BACKEND_PROD_ENV_FILE):
        try:
            file_value = _read_openai_key_from_env_file(candidate)
            if file_value:
                return file_value
        except Exception:
            continue
    if settings.openai_api_key:
        return settings.openai_api_key
    for candidate in (
        ENV_FILE,
        ROOT_ENV_FILE,
    ):
        try:
            file_value = _read_openai_key_from_env_file(candidate)
            if file_value:
                return file_value
        except Exception:
            continue
    return None
