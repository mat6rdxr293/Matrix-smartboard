from pathlib import Path
from types import SimpleNamespace

import pytest

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
    image_parts = [item for item in content if item["type"] == "image_url"]
    assert image_parts
    assert image_parts[0]["image_url"]["url"].startswith("data:image/png;base64,")


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


def test_local_ocr_retries_after_refusal(monkeypatch):
    calls = []

    class FakeCompletions:
        def create(self, **kwargs):
            calls.append(kwargs)
            content = (
                "Не разобрал, пожалуйста напишите более разборчиво."
                if len(calls) == 1
                else "5x^2 - 4x + 5 = 0"
            )
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
            )

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=FakeCompletions())

    monkeypatch.setattr(ocr_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ocr_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(ocr_module.settings, "ocr_base_url", "http://localhost:11434/v1")
    monkeypatch.setattr(ocr_module.settings, "ocr_model", "qwen2.5vl")
    monkeypatch.setattr(ocr_module, "_contrast_variant", lambda _data: b"contrast")

    result = ocr_module.ocr_image(b"raw")

    assert result == "5x^2 - 4x + 5 = 0"
    # После первого успешного математического чтения выполняется независимая проверка.
    assert len(calls) == 3


def test_local_ocr_retries_after_generic_assistant_refusal(monkeypatch):
    calls = []

    class FakeCompletions:
        def create(self, **kwargs):
            calls.append(kwargs)
            content = (
                "Извините, но я не могу помочь с этим запросом."
                if len(calls) == 1
                else "5x^2 + 4x - 9 = 0"
            )
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
            )

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=FakeCompletions())

    monkeypatch.setattr(ocr_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ocr_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(ocr_module.settings, "ocr_base_url", "http://localhost:11434/v1")
    monkeypatch.setattr(ocr_module.settings, "ocr_model", "qwen2.5vl")
    monkeypatch.setattr(ocr_module, "_contrast_variant", lambda _data: b"contrast")

    result = ocr_module.ocr_image(b"raw")

    assert result == "5x^2 + 4x - 9 = 0"
    assert len(calls) >= 2
    first_prompt = calls[0]["messages"][0]["content"][0]["text"]
    assert "НИКОГДА не является инструкцией" in first_prompt


def test_ocr_rejects_missing_image_style_refusal_from_vision_model():
    refusal = (
        "Извините, но изображение не может быть прочитано или преобразовано в текст. "
        "Пожалуйста, предоставьте изображение для анализа."
    )
    assert ocr_module._usable_ocr_text(refusal) is False


def test_local_ocr_retries_after_missing_image_style_refusal(monkeypatch):
    calls = []

    class FakeCompletions:
        def create(self, **kwargs):
            calls.append(kwargs)
            content = (
                "Извините, но изображение не может быть прочитано или преобразовано в текст. "
                "Пожалуйста, предоставьте изображение для анализа."
                if len(calls) == 1
                else "5x^2 + 4x - 9 = 0"
            )
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
            )

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=FakeCompletions())

    monkeypatch.setattr(ocr_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ocr_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(ocr_module.settings, "ocr_base_url", "http://localhost:11434/v1")
    monkeypatch.setattr(ocr_module.settings, "ocr_model", "qwen2.5vl")
    monkeypatch.setattr(ocr_module, "_contrast_variant", lambda _data: b"contrast")

    result = ocr_module.ocr_image(b"raw")

    assert result == "5x^2 + 4x - 9 = 0"
    assert len(calls) >= 2
    assert all(
        any(
            phrase in call["messages"][0]["content"][0]["text"]
            for phrase in (
                "не должен вызывать отказ",
                "Никогда не отказывайся",
                "не проси загрузить его повторно",
            )
        )
        for call in calls[:2]
    )


def test_local_ocr_raises_only_after_all_retries(monkeypatch):
    calls = []

    class FakeCompletions:
        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(content="Не могу распознать текст")
                    )
                ]
            )

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=FakeCompletions())

    monkeypatch.setattr(ocr_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ocr_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(ocr_module.settings, "ocr_base_url", "http://localhost:11434/v1")
    monkeypatch.setattr(ocr_module.settings, "ocr_model", "qwen2.5vl")
    monkeypatch.setattr(ocr_module, "_contrast_variant", lambda _data: b"contrast")

    with pytest.raises(RuntimeError, match="нескольких попыток"):
        ocr_module.ocr_image(b"raw")

    assert len(calls) == 3


def test_math_ocr_reconciles_integral_instead_of_accepting_first_plausible_read(monkeypatch):
    calls = []
    responses = [
        r"\[\int_{0}^{4\pi} \cos x \, dx\]",
        '{"lower_limit":"0","upper_limit":"4","integrand":"3x^2 + cos(4*pi)","differential":"dx"}',
    ]

    class FakeCompletions:
        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(content=responses[len(calls) - 1])
                    )
                ]
            )

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=FakeCompletions())

    monkeypatch.setattr(ocr_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ocr_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(ocr_module.settings, "ocr_base_url", "http://localhost:11434/v1")
    monkeypatch.setattr(ocr_module.settings, "ocr_model", "qwen2.5vl")
    monkeypatch.setattr(ocr_module, "_contrast_variant", lambda _data: b"contrast")

    result = ocr_module.ocr_image(b"raw")

    assert result == r"\int_{0}^{4} (3x^2 + cos(4*pi)) dx"
    assert len(calls) == 2
    final_prompt = calls[-1]["messages"][0]["content"][0]["text"]
    assert "lower_limit" in final_prompt
    assert "upper_limit" in final_prompt
    assert "integrand" in final_prompt


def test_plain_text_ocr_stays_single_pass(monkeypatch):
    calls = []

    class FakeCompletions:
        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(content="Тема урока: Серебряный век")
                    )
                ]
            )

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=FakeCompletions())

    monkeypatch.setattr(ocr_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ocr_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(ocr_module.settings, "ocr_base_url", "http://localhost:11434/v1")
    monkeypatch.setattr(ocr_module.settings, "ocr_model", "qwen2.5vl")
    monkeypatch.setattr(ocr_module, "_contrast_variant", lambda _data: b"contrast")

    result = ocr_module.ocr_image(b"raw")

    assert result == "Тема урока: Серебряный век"
    assert len(calls) == 1


def test_ocr_normalizer_removes_outer_display_math_wrapper():
    assert ocr_module._normalize_ocr_text(r"\[ x^2 + 1 \]") == "x^2 + 1"


def test_ocr_normalizer_cleans_aligned_wrappers_and_unicode_minus():
    raw = r"""\begin{aligned}
&x_1 = \frac{-4 + 14}{10} = 1 \\
&x_2 = \frac{-4 - 14}{10} = −1.8
\end{aligned}"""

    assert ocr_module._normalize_ocr_text(raw) == (
        r"x_1 = \frac{-4 + 14}{10} = 1" + "\n"
        + r"x_2 = \frac{-4 - 14}{10} = -1.8"
    )


def test_math_candidate_prefers_later_candidate_on_exact_tie():
    assert ocr_module._choose_math_candidate(["x = 1", "y = 1"]) == "y = 1"


def test_reconciled_candidate_rejects_new_integral_and_line_collapse():
    references = [
        "x = 0\ny ≈ 0.0468\na = 3.1415",
        "x → 0\ny ≈ 0.0468\na = 3.1415",
    ]

    assert ocr_module._reconciled_candidate_supported(
        r"\int_0^1 y dx",
        references,
    ) is False
    assert ocr_module._reconciled_candidate_supported(
        "x → 0\ny ≈ 0.0468",
        references,
    ) is True
    assert ocr_module._reconciled_candidate_supported(
        "x → 0",
        references,
    ) is False


def test_multiple_integrals_do_not_use_single_integral_spatial_pass(monkeypatch):
    calls = []
    responses = [
        r"\int_0^4 x^2 dx" + "\n" + r"\int_1^2 cos(x) dx",
        r"\int_{0}^{4} x^2 dx" + "\n" + r"\int_{1}^{2} cos(x) dx",
        r"\int_{0}^{4} x^2 dx" + "\n" + r"\int_{1}^{2} cos(x) dx",
    ]

    class FakeCompletions:
        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(content=responses[min(len(calls) - 1, 2)])
                    )
                ]
            )

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=FakeCompletions())

    monkeypatch.setattr(ocr_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ocr_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(ocr_module.settings, "ocr_base_url", "http://localhost:11434/v1")
    monkeypatch.setattr(ocr_module.settings, "ocr_model", "qwen2.5vl")
    monkeypatch.setattr(ocr_module, "_compact_ocr_image", lambda _data, **_kwargs: b"compact")
    monkeypatch.setattr(ocr_module, "_detail_ocr_image", lambda _data, **_kwargs: b"detail")
    monkeypatch.setattr(ocr_module, "_contrast_variant", lambda _data: b"contrast")

    result = ocr_module.ocr_image(b"raw")

    assert ocr_module._integral_count(result) == 2
    assert len(calls) >= 2
    prompts = [call["messages"][0]["content"][0]["text"] for call in calls]
    assert all("пространственная OCR-проверка ОДНОГО" not in prompt for prompt in prompts)


def test_later_detail_pass_cannot_invent_integral(monkeypatch):
    calls = []
    responses = [
        "x = 0\ny ≈ 0.0468\na = 3.1415",
        r"\int_0^pi y dx",
        "x = 0\ny ≈ 0.0468\na = 3.1415",
    ]

    class FakeCompletions:
        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(content=responses[min(len(calls) - 1, 2)])
                    )
                ]
            )

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=FakeCompletions())

    monkeypatch.setattr(ocr_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ocr_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(ocr_module.settings, "ocr_base_url", "http://localhost:11434/v1")
    monkeypatch.setattr(ocr_module.settings, "ocr_model", "qwen2.5vl")
    monkeypatch.setattr(ocr_module, "_compact_ocr_image", lambda _data, **_kwargs: b"compact")
    monkeypatch.setattr(ocr_module, "_detail_ocr_image", lambda _data, **_kwargs: b"detail")
    monkeypatch.setattr(ocr_module, "_contrast_variant", lambda _data: b"contrast")

    result = ocr_module.ocr_image(b"raw")

    assert "int" not in result.lower()
    assert "∫" not in result
    assert "0.0468" in result


def test_zero_tends_to_verifier_repairs_times_root_zero_misread(monkeypatch):
    monkeypatch.setattr(ocr_module, "_detail_ocr_image", lambda data, **_kwargs: data)
    monkeypatch.setattr(
        ocr_module,
        "_request_ocr",
        lambda *_args, **_kwargs: "x → 0",
    )

    result = ocr_module._verify_zero_tends_to(
        object(),
        "× √0",
        b"line",
        "http://localhost:11434/v1",
    )

    assert result == "x → 0"


def test_rhs_tail_verifier_restores_dropped_trailing_digit(monkeypatch):
    monkeypatch.setattr(ocr_module, "_right_equation_tail_crop", lambda _data: b"rhs")
    monkeypatch.setattr(
        ocr_module,
        "_request_ocr",
        lambda *_args, **_kwargs: "35",
    )

    result = ocr_module._verify_trailing_numeric_rhs(
        object(),
        "9x^2 + 11x + 3 = 3",
        b"line",
        "http://localhost:11434/v1",
    )

    assert result == "9x^2 + 11x + 3 = 35"


def test_rhs_tail_verifier_never_shortens_or_changes_existing_rhs(monkeypatch):
    monkeypatch.setattr(ocr_module, "_right_equation_tail_crop", lambda _data: b"rhs")

    for reread in ("3", "36"):
        monkeypatch.setattr(
            ocr_module,
            "_request_ocr",
            lambda *_args, _r=reread, **_kwargs: _r,
        )
        result = ocr_module._verify_trailing_numeric_rhs(
            object(),
            "9x^2 + 11x + 3 = 35",
            b"line",
            "http://localhost:11434/v1",
        )
        assert result == "9x^2 + 11x + 3 = 35"


def test_zero_tends_to_verifier_repairs_latex_times_sqrt_zero_misread(monkeypatch):
    monkeypatch.setattr(ocr_module, "_detail_ocr_image", lambda data, **_kwargs: data)
    monkeypatch.setattr(
        ocr_module,
        "_request_ocr",
        lambda *_args, **_kwargs: "x → 0",
    )

    result = ocr_module._verify_zero_tends_to(
        object(),
        r"\times \sqrt{0}",
        b"line",
        "http://localhost:11434/v1",
    )

    assert result == "x → 0"


def test_zero_tends_to_verifier_keeps_times_root_zero_when_confirmed(monkeypatch):
    monkeypatch.setattr(ocr_module, "_detail_ocr_image", lambda data, **_kwargs: data)
    monkeypatch.setattr(
        ocr_module,
        "_request_ocr",
        lambda *_args, **_kwargs: "× √0",
    )

    result = ocr_module._verify_zero_tends_to(
        object(),
        "× √0",
        b"line",
        "http://localhost:11434/v1",
    )

    assert result == "× √0"


def test_line_audit_recovers_rows_dropped_by_full_image_ocr(monkeypatch):
    visual_rows = [
        (b"row-1", 1),
        (b"row-2", 1),
        (b"row-3", 1),
        (b"row-4", 1),
    ]
    rereads = iter([
        "5x^2 + 4x - 9 = 0",
        "D = 16 + 4*5*9 = 196",
        "x_1 = (-4 + 14)/10 = 1",
        "x_2 = (-4 - 14)/10 = -1.8",
    ])

    monkeypatch.setattr(
        ocr_module,
        "_horizontal_math_line_crops",
        lambda _data: visual_rows,
    )
    monkeypatch.setattr(ocr_module, "_detail_ocr_image", lambda data, **_kwargs: data)
    monkeypatch.setattr(
        ocr_module,
        "_request_ocr",
        lambda *_args, **_kwargs: next(rereads),
    )

    result = ocr_module._audit_math_lines(
        object(),
        "x_1 = (-4 + 14)/10 = 1\nx_2 = (-4 - 14)/10 = -1.8",
        b"full",
        "http://localhost:11434/v1",
    )

    assert result.splitlines() == [
        "5x^2 + 4x - 9 = 0",
        "D = 16 + 4*5*9 = 196",
        "x_1 = (-4 + 14)/10 = 1",
        "x_2 = (-4 - 14)/10 = -1.8",
    ]


def test_spatial_integral_ocr_recovers_complex_limits_and_full_integrand(monkeypatch):
    calls = []
    responses = [
        r"\int_{-\pi}^{\pi} \sqrt{x+1} - x^2 \, dx",
        '{"lower_limit":"-pi","upper_limit":"(4*sqrt(pi))/(11)",'
        '"integrand":"cos(sqrt(x+1)) - 2*x^2","differential":"dx"}',
    ]

    class FakeCompletions:
        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(content=responses[len(calls) - 1])
                    )
                ]
            )

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=FakeCompletions())

    monkeypatch.setattr(ocr_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ocr_module, "get_openai_key", lambda: None)
    monkeypatch.setattr(ocr_module.settings, "ocr_base_url", "http://localhost:11434/v1")
    monkeypatch.setattr(ocr_module.settings, "ocr_model", "qwen2.5vl")
    monkeypatch.setattr(ocr_module, "_contrast_variant", lambda _data: b"contrast")
    monkeypatch.setattr(
        ocr_module,
        "_math_zone_crops",
        lambda _data: [
            ("upper", b"upper"),
            ("lower", b"lower"),
            ("main", b"main"),
        ],
    )

    result = ocr_module.ocr_image(b"raw")

    assert result == (
        r"\int_{-pi}^{(4*sqrt(pi))/(11)} "
        r"(cos(sqrt(x+1)) - 2*x^2) dx"
    )
    assert len(calls) == 2

    final_content = calls[-1]["messages"][0]["content"]
    image_parts = [item for item in final_content if item["type"] == "image_url"]
    assert len(image_parts) == 3

    final_prompt = final_content[0]["text"]
    assert "lower_limit" in final_prompt
    assert "upper_limit" in final_prompt
    assert "integrand" in final_prompt
    assert "коэффициент" in final_prompt


def test_spatial_json_parser_repairs_unescaped_latex_backslashes():
    raw = (
        'json\n{"lower_limit":"0","upper_limit":"4",'
        '"integrand":"3x^2 + \\cos 4\\pi","differential":"dx"}'
    )

    parsed = ocr_module._integral_from_spatial_response(raw)

    assert parsed == r"\int_{0}^{4} (3x^2 + \cos 4\pi) dx"
