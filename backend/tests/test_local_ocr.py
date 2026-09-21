from pathlib import Path
from types import SimpleNamespace

import app.ocr as ocr_module
import app.settings as settings_module


def test_local_ocr_uses_chat_completions_with_image(monkeypatch):
    captured = {}

    class FakeCompletions:
        def create(self, **kwargs):
            captured["request"] = kwargs
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content="  x^2 - 4 = 0  "))]
            )

    class FakeOpenAI:
        def __init__(self, **kwargs):
            captured["client"] = kwargs
            self.chat = SimpleNamespace(completions=FakeCompletions())

    monkeypatch.setattr(ocr_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ocr_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(ocr_module.settings, "ocr_base_url", "http://localhost:11434/v1")
    monkeypatch.setattr(ocr_module.settings, "ocr_model", "qwen2.5vl")

    result = ocr_module.ocr_image(b"\x89PNG fake")

    assert result == "x^2 - 4 = 0"
    assert captured["client"]["api_key"] == "ollama"
    assert captured["client"]["base_url"] == "http://localhost:11434/v1"
    assert captured["request"]["model"] == "qwen2.5vl"
    content = captured["request"]["messages"][0]["content"]
    # картинка уходит в формате chat.completions, а не Responses API
    assert content[0]["type"] == "text"
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")


def test_ocr_without_key_and_without_local_url_is_not_configured(monkeypatch):
    monkeypatch.setattr(settings_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(settings_module.settings, "ocr_base_url", None)

    assert settings_module.is_ocr_configured() is False


def test_local_ocr_is_configured_without_openai_key(monkeypatch):
    monkeypatch.setattr(settings_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(settings_module.settings, "ocr_base_url", "http://localhost:11434/v1")

    assert settings_module.is_ocr_configured() is True


def test_empty_values_from_env_example_do_not_break_settings(monkeypatch):
    # именно так эти строки выглядят в .env.example
    monkeypatch.setenv("PRACTICE_DB_PATH", "")
    monkeypatch.setenv("AI_BASE_URL", "")
    monkeypatch.setenv("OCR_BASE_URL", "")

    fresh = settings_module.Settings()

    assert isinstance(fresh.practice_db_path, Path)
    assert fresh.practice_db_path.name == "practice.db"
    assert fresh.ai_base_url is None
    assert fresh.ocr_base_url is None
