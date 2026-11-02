import pytest
from pydantic import ValidationError

from app.lesson_generation_contract import GeneratedLesson, contract_payload, resolved_lesson_payload


def valid_payload():
    return {
        "contractVersion": "1.0",
        "theme": {
            "backgroundColor": "#F7F8FA",
            "primaryColor": "#2563EB",
            "textColor": "#111827",
            "mutedTextColor": "#6B7280",
            "fontFamily": "Aptos",
        },
        "slides": [
            {
                "id": "slide_1",
                "title": "Второй закон Ньютона",
                "elements": [
                    {
                        "id": "card",
                        "type": "shape",
                        "shape": "round",
                        "x": 45,
                        "y": 55,
                        "width": 870,
                        "height": 420,
                        "fillColor": "#FFFFFF",
                    },
                    {
                        "id": "formula",
                        "type": "text",
                        "x": 80,
                        "y": 90,
                        "width": 300,
                        "height": 70,
                        "text": "F = ma",
                        "fontSize": 36,
                    },
                    {
                        "id": "book_image",
                        "type": "image",
                        "x": 520,
                        "y": 90,
                        "width": 330,
                        "height": 300,
                        "page": 14,
                        "image_index": 0,
                    },
                ],
            }
        ],
        "tasks": [
            {
                "id": "task_test_1",
                "type": "test",
                "question": "Какая формула выражает второй закон Ньютона?",
                "options": ["F = ma", "F = m / a", "F = a / m"],
                "answer": "F = ma",
            },
            {
                "id": "task_calc_1",
                "type": "calc",
                "question": "На тело массой 2 кг действует сила 10 Н. Найдите ускорение.",
                "answer": "5 м/с²",
                "solution": "a = F / m = 10 / 2 = 5 м/с²",
            },
        ],
    }


def test_shape_can_be_under_text_and_image():
    lesson = GeneratedLesson.model_validate(valid_payload())
    assert lesson.slides[0].elements[0].type == "shape"


def test_content_elements_cannot_overlap():
    payload = valid_payload()
    payload["slides"][0]["elements"][2].update({"x": 200, "y": 100})
    with pytest.raises(ValidationError, match="text/image не должны пересекаться"):
        GeneratedLesson.model_validate(payload)


def test_shape_must_appear_before_overlapping_content():
    payload = valid_payload()
    elements = payload["slides"][0]["elements"]
    payload["slides"][0]["elements"] = [elements[1], elements[0], elements[2]]
    with pytest.raises(ValidationError, match="Подложка должна находиться раньше"):
        GeneratedLesson.model_validate(payload)


def test_rich_text_allows_delimited_latex_and_plain_math_but_rejects_raw_commands():
    payload = valid_payload()
    payload["slides"][0]["elements"][1]["text"] = r"Формула: \(\Phi = BS\cos\alpha\)"
    assert GeneratedLesson.model_validate(payload)

    payload = valid_payload()
    payload["slides"][0]["elements"][1]["text"] = "v^2 = v0^2 + 2as"
    assert GeneratedLesson.model_validate(payload)

    payload = valid_payload()
    payload["slides"][0]["elements"][1]["text"] = r"Формула: \frac{x}{2}"
    with pytest.raises(ValidationError, match="LaTeX-команды должны находиться"):
        GeneratedLesson.model_validate(payload)

    payload = valid_payload()
    payload["slides"][0]["elements"][1]["text"] = "Φ = B·S·cos α; v² = v₀² + 2as"
    assert GeneratedLesson.model_validate(payload)


def test_pdf_page_is_one_based_and_image_index_is_zero_based_or_null():
    payload = valid_payload()
    payload["slides"][0]["elements"][2]["page"] = 0
    with pytest.raises(ValidationError):
        GeneratedLesson.model_validate(payload)

    payload = valid_payload()
    payload["slides"][0]["elements"][2]["image_index"] = None
    assert GeneratedLesson.model_validate(payload)

    payload = valid_payload()
    del payload["slides"][0]["elements"][2]["image_index"]
    with pytest.raises(ValidationError):
        GeneratedLesson.model_validate(payload)


def test_test_answer_must_match_option_exactly():
    payload = valid_payload()
    payload["tasks"][0]["answer"] = "F=ma"
    with pytest.raises(ValidationError, match="дословно совпадать"):
        GeneratedLesson.model_validate(payload)


def test_calc_requires_solution():
    payload = valid_payload()
    del payload["tasks"][1]["solution"]
    with pytest.raises(ValidationError):
        GeneratedLesson.model_validate(payload)


def test_open_task_and_ml_check_metadata_are_supported():
    payload = valid_payload()
    payload["tasks"].append(
        {
            "id": "task_open_1",
            "type": "open",
            "question": "Что показывает ускорение?",
            "answer": "Изменение скорости за единицу времени.",
            "level": 2,
            "check": {"status": "unverified", "note": "Нужна проверка учителя"},
        }
    )
    lesson = GeneratedLesson.model_validate(payload)
    task = lesson.tasks[-1]
    assert task.type == "open"
    assert task.level == 2
    assert task.check is not None
    assert task.check.status == "unverified"


def test_rotation_and_shape_stroke_are_optional():
    lesson = GeneratedLesson.model_validate(valid_payload())
    shape = lesson.slides[0].elements[0]
    text = lesson.slides[0].elements[1]
    assert shape.rotation == 0
    assert shape.strokeColor is None
    assert text.rotation == 0


def test_explicit_element_style_can_override_theme():
    payload = valid_payload()
    payload["slides"][0]["elements"][1]["color"] = "#FF00AA"
    lesson = GeneratedLesson.model_validate(payload)
    assert lesson.slides[0].elements[1].color == "#FF00AA"


def test_contract_exposes_schema_and_rules():
    payload = contract_payload()
    assert payload["canvas"] == {"width": 960, "height": 540, "safeMargin": 35}
    assert any("порядок слоёв" in rule for rule in payload["rules"])
    assert "schema" in payload


def test_theme_defaults_are_resolved_by_backend():
    lesson = GeneratedLesson.model_validate(valid_payload())
    resolved = resolved_lesson_payload(lesson)
    text = resolved["slides"][0]["elements"][1]
    assert text["color"] == "#111827"
    assert text["fontFamily"] == "Aptos"


def test_rotation_is_included_in_safe_area_validation():
    payload = valid_payload()
    payload["slides"][0]["elements"][1].update({"x": 35, "y": 35, "width": 200, "height": 80, "rotation": 45})
    with pytest.raises(ValidationError, match="не ближе 35px"):
        GeneratedLesson.model_validate(payload)


def test_math_element_accepts_latex_with_plain_fallback():
    payload = valid_payload()
    payload["slides"][0]["elements"][1] = {
        "id": "formula",
        "type": "math",
        "x": 80,
        "y": 90,
        "width": 300,
        "height": 70,
        "latex": r"\frac{x^2 + 1}{2}",
        "fallbackText": "(x² + 1) / 2",
        "fontSize": 32,
        "align": "center",
        "display": True,
    }

    lesson = GeneratedLesson.model_validate(payload)
    formula = lesson.slides[0].elements[1]
    assert formula.type == "math"
    assert formula.latex == r"\frac{x^2 + 1}{2}"
    resolved = resolved_lesson_payload(lesson)
    assert resolved["slides"][0]["elements"][1]["color"] == "#111827"


def test_task_math_must_be_explicitly_delimited():
    payload = valid_payload()
    payload["tasks"][1]["question"] = r"Найдите \frac{x}{2}"
    with pytest.raises(ValidationError, match="LaTeX-команды должны находиться"):
        GeneratedLesson.model_validate(payload)

    payload = valid_payload()
    payload["tasks"][1]["question"] = r"Найдите \(\frac{x}{2}\)"
    assert GeneratedLesson.model_validate(payload)
