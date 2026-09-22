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


def test_parse_board_solution_accepts_structured_json():
    import json

    payload = json.dumps(
        {
            "summary": "Решение",
            "steps": [
                {"text": "$$x^2=4$$", "kind": "math"},
                {"text": "$$x=\\pm2$$", "kind": "result"},
            ],
        },
        ensure_ascii=False,
    )
    text, steps = ai_module._parse_board_solution(payload)

    assert steps == [
        {"text": "$$x^2=4$$", "kind": "math"},
        {"text": "$$x=\\pm2$$", "kind": "result"},
    ]
    assert text.startswith("Решение")
    assert "$$x^2=4$$" in text


def test_parse_board_solution_falls_back_to_plain_text():
    text, steps = ai_module._parse_board_solution("Обычный ответ")

    assert text == "Обычный ответ"
    assert steps == [{"text": "Обычный ответ", "kind": "text"}]


def test_parse_board_solution_recovers_malformed_json_like_output():
    raw = (
        '"summary" "Решаем квадратное уравнение", '
        '"steps" ["text" "На доске записано $$5x^2-20=0$$", '
        '"kind" "math", "text" "$$x^2=4$$", "kind" "math", '
        '"text" "$$x=\\pm2$$", "kind" "result"]'
    )

    text, steps = ai_module._parse_board_solution(raw)

    assert [step["text"] for step in steps] == [
        "На доске записано $$5x^2-20=0$$",
        "$$x^2=4$$",
        "$$x=\\pm2$$",
    ]
    assert '"summary"' not in text
    assert '"steps"' not in text


def test_parse_board_solution_never_falls_back_to_raw_structured_envelope():
    raw = '{"summary":"broken","steps":[{"text": }]}'

    _text, steps = ai_module._parse_board_solution(raw)

    assert steps == []


def test_board_language_sanitizer_removes_cjk_for_russian():
    text, steps = ai_module._sanitize_board_language(
        "Решение: нет 实数根.",
        [{"text": "Корней нет 实数根.", "kind": "result"}],
        "ru",
    )

    assert text == "Решение: нет."
    assert steps == [{"text": "Корней нет.", "kind": "result"}]
