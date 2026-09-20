from types import SimpleNamespace

import app.ai as ai_module
import app.settings as settings_module


def test_ollama_uses_chat_completions_without_openai_key(monkeypatch):
    captured = {}

    class FakeCompletions:
        def create(self, **kwargs):
            captured["request"] = kwargs
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content="  Ответ от Qwen  "))]
            )

    class FakeOpenAI:
        def __init__(self, **kwargs):
            captured["client"] = kwargs
            self.chat = SimpleNamespace(completions=FakeCompletions())

    monkeypatch.setattr(ai_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ai_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(ai_module.settings, "ai_base_url", "http://localhost:11434/v1")
    monkeypatch.setattr(ai_module.settings, "ai_model", "qwen2.5")

    result = ai_module.generate_ai_response("solution", "2 + 2")

    assert result == "Ответ от Qwen"
    assert captured["client"]["api_key"] == "ollama"
    assert captured["client"]["base_url"] == "http://localhost:11434/v1"
    assert captured["request"]["model"] == "qwen2.5"
    assert captured["request"]["messages"][0]["role"] == "system"
    assert captured["request"]["messages"][1]["role"] == "user"


def test_local_ai_is_configured_without_openai_key(monkeypatch):
    monkeypatch.setattr(settings_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(settings_module.settings, "ai_base_url", "http://localhost:11434/v1")

    assert settings_module.is_ai_configured() is True
