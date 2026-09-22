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
    assert requests[0]["tool_choice"] == "required"
    assert "tool_choice" not in requests[1]
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


def test_general_ai_prompt_follows_ui_locale():
    _, _, _ = ai_module._build_prompt(
        "hint",
        "2+2",
        None,
        None,
        False,
        "math",
        True,
        "ru",
    )

    en_sys, en_user, _ = ai_module._build_prompt(
        "check",
        "2+2=4",
        None,
        None,
        False,
        "math",
        True,
        "en",
    )
    assert "Answer only in English" in en_sys
    assert "Completed: NN%" in en_user
    assert "Пиши по-русски" not in en_sys

    kk_sys, kk_user, _ = ai_module._build_prompt(
        "check",
        "2+2=4",
        None,
        None,
        False,
        "math",
        True,
        "kk",
    )
    assert "Жауапты тек қазақ тілінде бер" in kk_sys
    assert "Орындалды: NN%" in kk_user
    assert "Пиши по-русски" not in kk_sys


def test_board_solution_auto_continues_until_result(monkeypatch):
    responses = [
        '{"summary":"Решение","steps":[{"text":"$$D=b^2-4ac$$","kind":"math"}]}',
        '{"summary":"Продолжение","steps":[{"text":"$$D=-84<0$$","kind":"math"},{"text":"Действительных корней нет.","kind":"result"}]}',
    ]
    calls = []

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    def fake_local_chat(client, **kwargs):
        calls.append(kwargs)
        return responses[len(calls) - 1]

    monkeypatch.setattr(ai_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ai_module, "_local_chat_with_tools", fake_local_chat)
    monkeypatch.setattr(ai_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(ai_module.settings, "ai_base_url", "http://localhost:11434/v1")
    monkeypatch.setattr(ai_module.settings, "ai_model", "qwen2.5:7b")

    text, steps = ai_module.generate_board_solution(
        "5x^2 - 4x + 5 = 0",
        subject="algebra",
        response_locale="ru",
    )

    assert len(calls) == 2
    assert steps[-1] == {"text": "Действительных корней нет.", "kind": "result"}
    assert "$$D=b^2-4ac$$" in text
    assert "Действительных корней нет." in text
    assert "не повторяй" in calls[1]["sys"].lower()


def test_semantic_final_step_avoids_unnecessary_continuation(monkeypatch):
    raw = (
        '{"summary":"Решение","steps":['
        '{"text":"$$D=16-100=-84$$","kind":"math"},'
        '{"text":"Итак, уравнение не имеет действительных корней.","kind":"text"}'
        ']}'
    )
    calls = []

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    def fake_local_chat(client, **kwargs):
        calls.append(kwargs)
        return raw

    monkeypatch.setattr(ai_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ai_module, "_local_chat_with_tools", fake_local_chat)
    monkeypatch.setattr(ai_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(ai_module.settings, "ai_base_url", "http://localhost:11434/v1")
    monkeypatch.setattr(ai_module.settings, "ai_model", "qwen2.5:7b")

    _text, steps = ai_module.generate_board_solution(
        "5x^2 - 4x + 5 = 0",
        subject="algebra",
        response_locale="ru",
    )

    assert len(calls) == 1
    assert steps[-1]["kind"] == "result"


def test_incomplete_result_tail_is_removed_and_previous_answer_promoted():
    steps = [
        {"text": "$$x_1 = 1$$", "kind": "text"},
        {"text": "$$x_2 = 2$$", "kind": "text"},
        {"text": "Добавим корректные обозначения:", "kind": "result"},
    ]

    normalized = ai_module._normalize_board_result_tail(steps, "ru")

    assert normalized == [
        {"text": "$$x_1 = 1$$", "kind": "text"},
        {"text": "$$x_2 = 2$$", "kind": "result"},
    ]


def test_board_solution_requires_model_selected_tool_before_structured_answer(monkeypatch):
    requests = []
    tool_call = SimpleNamespace(
        id="quad-1",
        function=SimpleNamespace(
            name="math_quadratic",
            arguments='{"equation":"5*x^2 - 4*x + 5 = 0","variable":"x"}',
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
                        content=(
                            '{"summary":"Решение","steps":['
                            '{"text":"$$D=-84$$","kind":"math"},'
                            '{"text":"Действительных корней нет.","kind":"result"}'
                            ']}'
                        ),
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
    monkeypatch.setattr(ai_module.settings, "ai_model", "qwen2.5:7b")
    monkeypatch.setattr(ai_module.settings, "ai_tools_enabled", True)

    text, steps = ai_module.generate_board_solution(
        "Решить квадратное уравнение 5x² - 4x + 5 = 0",
        subject="алгебра",
        response_locale="ru",
    )

    assert len(requests) == 2
    assert requests[0]["tool_choice"] == "required"
    assert requests[0]["tools"]
    assert "tool_choice" not in requests[1]
    assert requests[1]["messages"][-1]["role"] == "tool"
    assert '"discriminant"' in requests[1]["messages"][-1]["content"]
    assert '"text": "-84"' in requests[1]["messages"][-1]["content"]
    assert steps[-1] == {"text": "Действительных корней нет.", "kind": "result"}
    assert "$$D=-84$$" in text


def test_local_ai_recovers_pseudo_tool_call_printed_as_text(monkeypatch):
    requests = []
    responses = [
        SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(
                        content=(
                            '{"name":"math_evaluate","arguments":'
                            '{"expression":"(-4)^2 - 4*5*5"}}'
                        ),
                        tool_calls=[],
                    )
                )
            ]
        ),
        SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(
                        content="Дискриминант равен $$D=-84$$.",
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
    monkeypatch.setattr(ai_module.settings, "ai_model", "qwen2.5:7b")
    monkeypatch.setattr(ai_module.settings, "ai_tools_enabled", True)

    result = ai_module.generate_ai_response(
        "solution",
        "Вычисли дискриминант для 5x^2 - 4x + 5 = 0",
        subject="algebra",
        response_locale="ru",
    )

    assert result == "Дискриминант равен $$D=-84$$."
    assert len(requests) == 2
    assert requests[0]["tool_choice"] == "required"
    assert "tool_choice" not in requests[1]
    assert requests[1]["messages"][-1]["role"] == "user"
    assert "math_evaluate" in requests[1]["messages"][-1]["content"]
    assert "-84" in requests[1]["messages"][-1]["content"]


def test_board_hint_returns_compact_structured_steps_without_full_answer(monkeypatch):
    captured = {}

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    def fake_local_chat(client, **kwargs):
        captured.update(kwargs)
        return (
            '{"summary":"Подсказка","steps":['
            '{"text":"Сначала найди дискриминант.","kind":"text"},'
            '{"text":"$$D=b^2-4ac$$","kind":"math"}'
            ']}'
        )

    monkeypatch.setattr(ai_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ai_module, "_local_chat_with_tools", fake_local_chat)
    monkeypatch.setattr(ai_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(ai_module.settings, "ai_base_url", "http://localhost:11434/v1")

    text, steps = ai_module.generate_board_response(
        "hint",
        "x^2 + 4x + 5 = 0",
        subject="алгебра",
        response_locale="ru",
    )

    assert len(steps) == 2
    assert steps[0]["text"] == "Сначала найди дискриминант."
    assert "$$D=b^2-4ac$$" in text
    assert captured["require_tool"] is False
    assert "Не раскрывай конечный ответ" in captured["sys"]


def test_board_check_requires_tools_and_returns_warning_with_score(monkeypatch):
    captured = {}

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    def fake_local_chat(client, **kwargs):
        captured.update(kwargs)
        return (
            '{"summary":"Выполнено: 60%","steps":['
            '{"text":"Ошибка: неверно вычислен дискриминант.","kind":"warning"},'
            '{"text":"$$D=16-20=-4$$","kind":"math"}'
            ']}'
        )

    monkeypatch.setattr(ai_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ai_module, "_local_chat_with_tools", fake_local_chat)
    monkeypatch.setattr(ai_module, "_check_trace_covers_task", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(ai_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(ai_module.settings, "ai_base_url", "http://localhost:11434/v1")

    text, steps = ai_module.generate_board_response(
        "check",
        "x^2 + 4x + 5 = 0; D=16-5=11",
        subject="алгебра",
        response_locale="ru",
    )

    assert steps[0]["kind"] == "warning"
    assert "Выполнено: 60%" in text
    assert captured["require_tool"] is True
    assert "kind=warning" in captured["sys"]


def test_loose_board_parser_preserves_warning_and_math_kinds():
    raw = (
        '{"summary":"Выполнено: 60%","steps":['
        '{"text":"Ошибка: неверный дискриминант.","kind":"warning"},'
        '{"text":"\\(D=-4\\)","kind":"math"}'
        ']}'
    )
    _text, steps = ai_module._parse_board_solution(raw)

    assert steps == [
        {"text": "Ошибка: неверный дискриминант.", "kind": "warning"},
        {"text": "\\(D=-4\\)", "kind": "math"},
    ]


def test_compact_board_check_keeps_first_warning_and_one_correction():
    steps = [
        {"text": "Сначала проверим через инструмент.", "kind": "text"},
        {"text": "Ошибка: неверно вычислен D.", "kind": "warning"},
        {"text": "$$D=16-20=-4$$", "kind": "math"},
        {"text": "Действительных корней нет.", "kind": "result"},
    ]

    assert ai_module._compact_board_check_steps(steps) == [
        {"text": "Ошибка: неверно вычислен D.", "kind": "warning"},
        {"text": "$$D=16-20=-4$$", "kind": "math"},
    ]


def test_compact_board_check_stops_when_warning_already_contains_correction():
    steps = [
        {
            "text": "Ошибка: D=11, должно быть D=16-20=-4.",
            "kind": "warning",
        },
        {"text": "$$D=11$$", "kind": "math"},
    ]

    assert ai_module._compact_board_check_steps(steps) == [
        {
            "text": "Ошибка: D=11, должно быть D=16-20=-4.",
            "kind": "warning",
        }
    ]


def test_check_kind_normalization_marks_error_text_as_warning():
    steps = [
        {"text": "Неверно вычислен дискриминант.", "kind": "text"},
        {"text": "$$D=-4$$", "kind": "math"},
    ]

    normalized = ai_module._normalize_board_check_kinds(steps)

    assert normalized[0]["kind"] == "warning"
    assert normalized[1]["kind"] == "math"


def test_hint_quality_gate_rejects_internal_tool_names():
    steps = [{"text": "Используй math_quadratic.", "kind": "math"}]
    assert ai_module._board_hint_needs_retry(steps, "ru") is True


def test_board_check_drops_impossible_perfect_score_when_warning_exists(monkeypatch):
    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    def fake_local_chat(client, **kwargs):
        return (
            '{"summary":"Выполнено: 100%","steps":['
            '{"text":"Ошибка: D=11, должно быть D=-4.","kind":"warning"}'
            ']}'
        )

    monkeypatch.setattr(ai_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ai_module, "_local_chat_with_tools", fake_local_chat)
    monkeypatch.setattr(ai_module, "_check_trace_covers_task", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(ai_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(ai_module.settings, "ai_base_url", "http://localhost:11434/v1")

    text, steps = ai_module.generate_board_response(
        "check",
        "x^2+4x+5=0; D=11",
        subject="алгебра",
        response_locale="ru",
    )

    assert "100%" not in text
    assert steps == [
        {"text": "Ошибка: D=11, должно быть D=-4.", "kind": "warning"}
    ]


def test_board_check_detects_result_conflicting_with_tool_trace():
    trace = [
        {
            "tool": "math_quadratic",
            "arguments": {"equation": "x^2+4*x+5=0", "variable": "x"},
            "payload": {
                "ok": True,
                "tool": "math_quadratic",
                "result": {
                    "a": {"text": "1"},
                    "b": {"text": "4"},
                    "c": {"text": "5"},
                    "discriminant": {"text": "-4"},
                    "discriminant_sign": -1,
                    "real_roots": [],
                },
            },
        }
    ]

    assert ai_module._board_check_conflicts_with_tools(
        [{"text": "Дискриминант равен 11.", "kind": "result"}],
        trace,
    ) is True
    assert ai_module._board_check_conflicts_with_tools(
        [{"text": "Ошибка: D=11, должно быть D=-4.", "kind": "warning"}],
        trace,
    ) is False


def test_board_check_verifies_wrong_final_result_against_tool_trace(monkeypatch):
    trace_payload = {
        "ok": True,
        "tool": "math_quadratic",
        "category": "math",
        "result": {
            "a": {"text": "1", "latex": "1"},
            "b": {"text": "4", "latex": "4"},
            "c": {"text": "5", "latex": "5"},
            "discriminant": {"text": "-4", "latex": "-4"},
            "discriminant_sign": -1,
            "real_roots": [],
            "has_real_roots": False,
        },
    }

    def fake_local_chat(client, **kwargs):
        kwargs["tool_trace"].append({
            "tool": "math_quadratic",
            "arguments": {"equation": "x^2+4*x+5=0", "variable": "x"},
            "payload": trace_payload,
        })
        return (
            '{"summary":"Выполнено: 60%","steps":['
            '{"text":"Дискриминант равен 11.","kind":"result"}'
            ']}'
        )

    verifier_response = SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(
                    content=(
                        '{"summary":"Выполнено: 60%","steps":['
                        '{"text":"Ошибка: D=11, должно быть D=-4.","kind":"warning"}'
                        ']}'
                    )
                )
            )
        ]
    )

    class FakeCompletions:
        def create(self, **kwargs):
            return verifier_response

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=FakeCompletions())

    monkeypatch.setattr(ai_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ai_module, "_local_chat_with_tools", fake_local_chat)
    monkeypatch.setattr(ai_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(ai_module.settings, "ai_base_url", "http://localhost:11434/v1")

    text, steps = ai_module.generate_board_response(
        "check",
        "x^2+4x+5=0; D=11",
        subject="алгебра",
        response_locale="ru",
    )

    assert "D=-4" in text
    assert "Дискриминант равен 11" not in text
    assert steps == [
        {"text": "Ошибка: D=11, должно быть D=-4.", "kind": "warning"}
    ]


def _successful_trace(tool: str, result: dict):
    return [{
        "tool": tool,
        "arguments": {},
        "payload": {
            "ok": True,
            "tool": tool,
            "category": "math",
            "result": result,
        },
    }]


def test_reference_tool_policy_rejects_evaluate_for_equation():
    wrong_trace = _successful_trace(
        "math_evaluate",
        {
            "expression": {"text": "13"},
            "result": {"text": "13.0000000000000"},
        },
    )
    assert ai_module._check_task_kind(
        "Решить 2x+3=11; Ответ: x=5",
        "алгебра",
    ) == "equation"
    assert ai_module._check_trace_covers_task(
        "Решить 2x+3=11; Ответ: x=5",
        "алгебра",
        wrong_trace,
    ) is False


def test_marked_answer_verdict_linear_equation_wrong():
    trace = _successful_trace(
        "math_solve",
        {
            "equation": {"text": "Eq(2*x + 3, 11)"},
            "variable": "x",
            "solutions": [{"text": "4", "latex": "4"}],
        },
    )
    verdict = ai_module._marked_answer_verdict(
        "Решить 2x + 3 = 11; Ответ: x = 5",
        "алгебра",
        trace,
    )
    assert verdict == {
        "correct": False,
        "actual": "x = 5",
        "expected": "4",
        "kind": "solution_set",
    }


def test_marked_answer_verdict_arithmetic_wrong():
    trace = _successful_trace(
        "math_evaluate",
        {
            "expression": {"text": "15"},
            "result": {"text": "15.0000000000000", "latex": "15.0"},
        },
    )
    verdict = ai_module._marked_answer_verdict(
        "Вычислить 48/6 + 7; Ответ: 14",
        "математика",
        trace,
    )
    assert verdict and verdict["correct"] is False
    assert verdict["expected"].startswith("15")


def test_marked_answer_verdict_derivative_correct_symbolically():
    trace = _successful_trace(
        "math_differentiate",
        {
            "input": {"text": "x**3 + 2*x"},
            "variable": "x",
            "order": 1,
            "result": {"text": "3*x**2 + 2", "latex": "3 x^{2} + 2"},
        },
    )
    verdict = ai_module._marked_answer_verdict(
        "Найти производную y=x^3+2x; Ответ: y' = 2 + 3x^2",
        "алгебра",
        trace,
    )
    assert verdict and verdict["correct"] is True


def test_marked_answer_verdict_integral_wrong():
    trace = _successful_trace(
        "math_integrate",
        {
            "input": {"text": "2*x"},
            "variable": "x",
            "bounds": [{"text": "0"}, {"text": "3"}],
            "result": {"text": "9", "latex": "9"},
        },
    )
    verdict = ai_module._marked_answer_verdict(
        "Вычислить интеграл от 0 до 3 функции 2x dx; Ответ: 8",
        "алгебра",
        trace,
    )
    assert verdict and verdict["correct"] is False
    assert verdict["expected"] == "9"


def test_marked_answer_verdict_expand_wrong_symbolically():
    trace = _successful_trace(
        "math_expand",
        {
            "input": {"text": "(x + 2)**2"},
            "result": {"text": "x**2 + 4*x + 4", "latex": "x^{2} + 4 x + 4"},
        },
    )
    verdict = ai_module._marked_answer_verdict(
        "Раскрыть скобки (x+2)^2; Ответ: x^2 + 4",
        "алгебра",
        trace,
    )
    assert verdict and verdict["correct"] is False


def test_marked_answer_verdict_physics_unit_conversion_wrong():
    trace = [{
        "tool": "physics_convert_unit",
        "arguments": {"value": 72, "from_unit": "km/h", "to_unit": "m/s"},
        "payload": {
            "ok": True,
            "tool": "physics_convert_unit",
            "category": "physics",
            "result": {
                "value": 72,
                "from_unit": "km/h",
                "to_unit": "m/s",
                "result": 20.0,
            },
        },
    }]
    verdict = ai_module._marked_answer_verdict(
        "Перевести 72 km/h в m/s; Ответ: 18 m/s",
        "физика",
        trace,
    )
    assert verdict and verdict["correct"] is False
    assert verdict["expected"] == "20 m/s"


def test_marked_answer_verdict_system_equations():
    trace = [{
        "tool": "math_solve_system",
        "arguments": {"equations": ["x+y=7", "x-y=1"], "variables": ["x", "y"]},
        "payload": {
            "ok": True,
            "tool": "math_solve_system",
            "category": "math",
            "result": {
                "variables": ["x", "y"],
                "solutions": [{
                    "x": {"text": "4", "latex": "4"},
                    "y": {"text": "3", "latex": "3"},
                }],
            },
        },
    }]
    correct = ai_module._marked_answer_verdict(
        "Решить систему x+y=7, x-y=1; Ответ: y=3, x=4",
        "алгебра",
        trace,
    )
    wrong = ai_module._marked_answer_verdict(
        "Решить систему x+y=7, x-y=1; Ответ: x=5, y=2",
        "алгебра",
        trace,
    )
    assert correct and correct["correct"] is True
    assert wrong and wrong["correct"] is False


def test_marked_answer_verdict_inequality_equivalent_orientation():
    trace = [{
        "tool": "math_solve_inequalities",
        "arguments": {"inequalities": ["2*x-3>5"], "variable": "x"},
        "payload": {
            "ok": True,
            "tool": "math_solve_inequalities",
            "category": "math",
            "result": {
                "variable": "x",
                "result": {"text": "(4 < x) & (x < oo)", "latex": "4 < x"},
            },
        },
    }]
    verdict = ai_module._marked_answer_verdict(
        "Решить неравенство 2x-3>5; Ответ: x>4",
        "алгебра",
        trace,
    )
    assert verdict and verdict["correct"] is True


def test_marked_answer_verdict_percent_and_geometry():
    percent_trace = [{
        "tool": "math_percent",
        "arguments": {"operation": "percent_of", "value": 240, "percent": 15},
        "payload": {
            "ok": True,
            "tool": "math_percent",
            "category": "math",
            "result": {"operation": "percent_of", "value": 240.0, "percent": 15, "result": 36.0},
        },
    }]
    percent = ai_module._marked_answer_verdict(
        "Найти 15% от 240; Ответ: 36",
        "математика",
        percent_trace,
    )
    assert percent and percent["correct"] is True

    geometry_trace = [{
        "tool": "geometry_compute",
        "arguments": {"kind": "triangle_sides", "values": {"a": 3, "b": 4, "c": 5}},
        "payload": {
            "ok": True,
            "tool": "geometry_compute",
            "category": "math",
            "result": {
                "kind": "triangle_sides",
                "area": {"text": "6", "latex": "6"},
                "perimeter": {"text": "12", "latex": "12"},
            },
        },
    }]
    geometry = ai_module._marked_answer_verdict(
        "У треугольника стороны 3, 4, 5. Найти площадь; Ответ: 6",
        "геометрия",
        geometry_trace,
    )
    assert geometry and geometry["correct"] is True


def test_board_sanitizer_removes_internal_tool_language():
    text, steps = ai_module._sanitize_board_language(
        "Воспользуемся инструментом для вычисления. S=6",
        [{"text": "S=6. Воспользуемся инструментом для вычисления.", "kind": "result"}],
        "ru",
    )
    assert "инструмент" not in text.lower()
    assert "инструмент" not in steps[0]["text"].lower()


def test_verified_board_result_removes_nested_json_and_hallucinated_tail():
    steps = [
        {
            "text": r'{\"summary\":\"15% от 240\",\"steps\":[]}',
            "kind": "text",
        },
        {"text": "0.15 * 240", "kind": "math"},
        {"text": "36", "kind": "result"},
        {"text": "5.4", "kind": "result"},
    ]
    reference = {"kind": "numeric", "value": "36", "display": "36"}

    result = ai_module._enforce_verified_board_result(steps, reference)

    assert result == [
        {"text": "0.15 * 240", "kind": "math"},
        {"text": "36", "kind": "result"},
    ]


def test_verified_board_result_overrides_wrong_terminal_result():
    steps = [
        {"text": "2x > 8", "kind": "math"},
        {"text": "x > 3", "kind": "result"},
    ]
    reference = {"kind": "inequality", "value": "4 < x", "display": "x > 4"}

    result = ai_module._enforce_verified_board_result(steps, reference)

    assert result[-1] == {"text": "x > 4", "kind": "result"}
    assert all(step["text"] != "x > 3" for step in result)


def test_verified_terminal_result_removes_nested_json_and_false_trailing_result():
    steps = [
        {
            "text": r'{\"summary\":\"Найти 15% от 240\",\"steps\":[{\"text\":\"36\",\"kind\":\"result\"}]}',
            "kind": "text",
        },
        {"text": "15% от 240", "kind": "text"},
        {"text": "36", "kind": "result"},
        {"text": "5.4", "kind": "result"},
    ]
    reference = {"kind": "numeric", "value": "36.0", "display": "36"}

    cleaned = ai_module._enforce_verified_board_result(steps, reference)

    assert cleaned[-1] == {"text": "36", "kind": "result"}
    assert all("5.4" not in step["text"] for step in cleaned)
    assert all("summary" not in step["text"] for step in cleaned)


def test_marked_answer_verdict_inequality_wrong():
    trace = _successful_trace(
        "math_solve_inequalities",
        {
            "inequalities": [{"text": "2*x - 3 > 5"}],
            "variable": "x",
            "result": {"text": "4 < x", "latex": "4 < x"},
        },
    )
    verdict = ai_module._marked_answer_verdict(
        "Решить неравенство 2x-3>5; Ответ: x>5",
        "алгебра",
        trace,
    )
    assert verdict and verdict["correct"] is False
    assert verdict["expected"] in {"x > 4", "4 < x"}


def test_marked_answer_verdict_probability_wrong():
    trace = _successful_trace(
        "math_probability",
        {
            "kind": "classical",
            "favorable": 3,
            "total": 8,
            "result": {"text": "3/8", "latex": "\\frac{3}{8}"},
            "decimal": 0.375,
        },
    )
    verdict = ai_module._marked_answer_verdict(
        "В урне 3 красных и 5 синих шаров. Найти вероятность красного; Ответ: 1/2",
        "математика",
        trace,
    )
    assert verdict and verdict["correct"] is False
    assert verdict["expected"] == "3/8"


def test_marked_answer_verdict_trig_correct_exactly():
    trace = _successful_trace(
        "math_trig_value",
        {
            "function": "sin",
            "angle": {"text": "30"},
            "unit": "degrees",
            "result": {"text": "1/2", "latex": "\\frac{1}{2}"},
            "decimal": 0.5,
        },
    )
    verdict = ai_module._marked_answer_verdict(
        "Найти sin 30 градусов; Ответ: 0.5",
        "алгебра",
        trace,
    )
    assert verdict and verdict["correct"] is True


def test_marked_answer_verdict_geometry_wrong():
    trace = _successful_trace(
        "geometry_compute",
        {
            "kind": "triangle_sides",
            "perimeter": {"text": "12", "latex": "12"},
            "semiperimeter": {"text": "6", "latex": "6"},
            "area": {"text": "6", "latex": "6"},
        },
    )
    verdict = ai_module._marked_answer_verdict(
        "У треугольника стороны 3, 4 и 5. Найти площадь; Ответ: 5",
        "геометрия",
        trace,
    )
    assert verdict and verdict["correct"] is False
    assert verdict["expected"] == "6"


def test_marked_answer_verdict_system_correct():
    trace = _successful_trace(
        "math_solve_system",
        {
            "equations": [],
            "variables": ["x", "y"],
            "solutions": [{
                "x": {"text": "4", "latex": "4"},
                "y": {"text": "3", "latex": "3"},
            }],
        },
    )
    verdict = ai_module._marked_answer_verdict(
        "Решить систему x+y=7, x-y=1; Ответ: y=3, x=4",
        "алгебра",
        trace,
    )
    assert verdict and verdict["correct"] is True


def test_repeated_problem_step_is_removed_from_board_solution():
    problem = "У треугольника стороны 3, 4 и 5. Найти площадь."
    steps = [
        {"text": "$$S=6$$", "kind": "math"},
        {"text": problem, "kind": "text"},
        {"text": "$$S=6$$", "kind": "result"},
    ]
    cleaned = ai_module._strip_repeated_problem_steps(steps, problem)
    assert len(cleaned) == 2
    assert all(step["text"] != problem for step in cleaned)
