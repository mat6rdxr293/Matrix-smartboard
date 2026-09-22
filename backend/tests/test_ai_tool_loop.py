from types import SimpleNamespace

import app.ai as ai_module


def test_local_ai_executes_tool_call_and_returns_final_answer(monkeypatch):
    requests = []
    tool_call = SimpleNamespace(
        id="call-1",
        function=SimpleNamespace(
            name="math_solve",
            arguments='{"equation":"x^2 - 4 = 0","variable":"x"}',
        ),
    )
    responses = [
        SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content=None, tool_calls=[tool_call])
                )
            ]
        ),
        SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(
                        content="Корни: $$x=-2$$ и $$x=2$$",
                        tool_calls=[],
                    )
                )
            ]
        ),
    ]

    class FakeCompletions:
        def create(self, **kwargs):
            requests.append(kwargs)
            return responses[len(requests) - 1]

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=FakeCompletions())

    monkeypatch.setattr(ai_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ai_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(ai_module.settings, "ai_base_url", "http://localhost:11434/v1")
    monkeypatch.setattr(ai_module.settings, "ai_model", "qwen")
    monkeypatch.setattr(ai_module.settings, "ai_tools_enabled", True)

    result = ai_module.generate_ai_response(
        "solution",
        "Реши x^2 - 4 = 0",
        subject="algebra",
    )

    assert result == "Корни: $$x=-2$$ и $$x=2$$"
    assert len(requests) == 2
    assert requests[0]["tools"]
    assert requests[0]["messages"][0]["role"] == "system"
    assert requests[1]["messages"][-1]["role"] == "tool"
    assert '"solutions"' in requests[1]["messages"][-1]["content"]


def test_humanities_local_ai_does_not_send_stem_tools(monkeypatch):
    captured = {}

    class FakeCompletions:
        def create(self, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(content="Ответ", tool_calls=[])
                    )
                ]
            )

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=FakeCompletions())

    monkeypatch.setattr(ai_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ai_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(ai_module.settings, "ai_base_url", "http://localhost:11434/v1")
    monkeypatch.setattr(ai_module.settings, "ai_model", "qwen")
    monkeypatch.setattr(ai_module.settings, "ai_tools_enabled", True)

    result = ai_module.generate_ai_response(
        "solution",
        "Кто такой Александр Блок?",
        subject="history",
    )

    assert result == "Ответ"
    assert "tools" not in captured
