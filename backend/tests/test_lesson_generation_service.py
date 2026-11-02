import app.lesson_generation_service as lesson_service
from app.lesson_generation_service import (
    LessonGenerationRequest,
    _visible_text,
    _workspace_payload,
    build_contract_lesson,
    generate_lesson,
)


def test_visible_text_normalizes_common_latex():
    assert _visible_text(r"$\Phi = \frac{B}{2}\cdot x^2$") == "Φ = (B)/(2)· x²"


def test_semantic_lesson_is_laid_out_as_valid_smartboard_contract():
    lesson, notes = build_contract_lesson(
        [
            {
                "id": "task-1",
                "type": "open",
                "question": "Что такое ускорение?",
                "answer": "Изменение скорости за единицу времени.",
                "level": 1,
                "check": {"status": "unverified", "note": "Нужна проверка учителя"},
            },
            {
                "id": "task-2",
                "type": "test",
                "question": "Единица ускорения?",
                "options": ["м/с", "м/с²", "Н", "Дж"],
                "answer": "м/с²",
                "level": 1,
            },
        ],
        [
            {
                "title": "Ускорение",
                "bullets": [
                    "Ускорение показывает изменение скорости",
                    "Единица измерения — м/с²",
                ],
                "notes": "Покажите пример на доске.",
            }
        ],
    )

    assert lesson.contractVersion == "1.0"
    assert len(lesson.slides) == 1
    assert len(lesson.tasks) == 2
    assert notes == ["Покажите пример на доске."]

    for element in lesson.slides[0].elements:
        left, top, right, bottom = element.bounds()
        assert left >= 35
        assert top >= 35
        assert right <= 925
        assert bottom <= 505

    workspace = _workspace_payload(lesson, notes)
    assert workspace["slides"][0]["backgroundColor"] == "#0A0E14"
    assert workspace["slides"][0]["elements"][0]["type"] == "shape"
    assert workspace["tasks"][0]["answer"] == "Изменение скорости за единицу времени."
    assert workspace["tasks"][1]["options"] == ["м/с", "м/с²", "Н", "Дж"]


def test_generate_lesson_pipeline_returns_contract_and_workspace_without_network(monkeypatch):
    def fake_ask_structured(*, kind, **kwargs):
        if kind == "tasks":
            return [
                {
                    "type": "test",
                    "question": "Чему равно $v^2$?",
                    "options": ["v^2", "v", "2v", "0"],
                    "correct": 0,
                    "level": 1,
                },
                {
                    "type": "open",
                    "question": "Что описывает скорость?",
                    "answer": "Быстроту изменения положения.",
                    "level": 1,
                },
                {
                    "type": "calc",
                    "question": "Найдите x, если x^2 = 4.",
                    "solution": "x^2 = 4, поэтому x = ±2.",
                    "answer": "x = ±2",
                    "level": 2,
                },
            ], {"totalSeconds": 0.01, "promptTokens": 10, "completionTokens": 20}
        return [
            {
                "title": r"Скорость и $v^2$",
                "bullets": [r"$v^2$ — квадрат скорости", r"\Phi = B\cdot S"],
                "notes": "Коротко разберите формулы.",
            },
            {
                "title": "Пример",
                "bullets": ["Подставьте значения", "Проверьте единицы"],
                "notes": "Дайте минуту на расчёт.",
            },
            {
                "title": "Итог",
                "bullets": ["Сформулируйте правило", "Ответьте на вопрос"],
                "notes": "Подведите итог.",
            },
        ], {"totalSeconds": 0.01, "promptTokens": 10, "completionTokens": 20}

    monkeypatch.setattr(lesson_service, "_ask_structured", fake_ask_structured)
    monkeypatch.setattr(lesson_service, "_verify_tasks", lambda tasks: tasks)

    result = generate_lesson(
        LessonGenerationRequest(
            text=(
                "Скорость показывает изменение положения тела во времени. "
                "Квадрат скорости может встречаться в формулах движения. "
                "Магнитный поток обозначают Φ и вычисляют через B и S."
            ),
            slideCount=3,
            taskCount=3,
        )
    )

    assert result["lesson"]["contractVersion"] == "1.0"
    assert len(result["workspace"]["slides"]) == 3
    assert len(result["workspace"]["tasks"]) == 3
    assert result["workspace"]["slides"][0]["title"] == "Скорость и v²"
    assert result["workspace"]["tasks"][0]["answer"] == "v²"
    assert result["workspace"]["slides"][0]["backgroundColor"] == "#0A0E14"


def test_generate_lesson_can_use_page_index_search(monkeypatch):
    monkeypatch.setattr(
        lesson_service,
        "search_context",
        lambda book, query, **kwargs: (
            "[стр. 42]\nЛогарифм произведения равен сумме логарифмов множителей.",
            [42],
        ),
    )

    def fake_ask_structured(*, kind, **kwargs):
        if kind == "tasks":
            return [
                {
                    "type": "open",
                    "question": "Как раскрыть логарифм произведения?",
                    "answer": "Как сумму логарифмов множителей.",
                    "level": 1,
                },
                {
                    "type": "test",
                    "question": "Какое свойство используется?",
                    "options": ["Сумма", "Произведение", "Степень", "Корень"],
                    "correct": 1,
                    "level": 1,
                },
                {
                    "type": "open",
                    "question": "Что является источником?",
                    "answer": "Страница учебника.",
                    "level": 1,
                },
            ], {"totalSeconds": 0.01}
        return [
            {"title": "Логарифмы", "bullets": ["Свойство произведения", "Пример"], "notes": "Разберите пример"},
            {"title": "Правило", "bullets": ["Сумма логарифмов", "Условия"], "notes": "Напомните ОДЗ"},
            {"title": "Практика", "bullets": ["Примените свойство", "Проверьте ответ"], "notes": "Дайте задачу"},
        ], {"totalSeconds": 0.01}

    monkeypatch.setattr(lesson_service, "_ask_structured", fake_ask_structured)
    monkeypatch.setattr(lesson_service, "_verify_tasks", lambda tasks: tasks)

    result = generate_lesson(
        LessonGenerationRequest(
            sourceType="search",
            book="algebra-11",
            query="логарифм произведения",
            slideCount=3,
            taskCount=3,
        )
    )

    assert result["meta"]["textSource"] == "page-index"
    assert result["meta"]["pages"] == [42]
    assert result["meta"]["query"] == "логарифм произведения"
    assert len(result["workspace"]["slides"]) == 3


def test_visible_text_keeps_trig_integrals_and_symbolic_powers():
    assert _visible_text(r"$\sin^2 x + \cos^2 x = 1$") == "sin² x + cos² x = 1"
    assert _visible_text(r"$\int e^{x}\,dx = e^{x} + C$") == "∫ e^(x),dx = e^(x) + C"
    assert _visible_text(r"$h=\frac{b-a}{n}$") == "h=(b-a)/(n)"


def test_contract_builder_renormalizes_tasks_after_mathcheck():
    lesson, _ = build_contract_lesson(
        [
            {
                "id": "task-4",
                "type": "test",
                "question": r"Как записать тождество $\sin^2 x + \cos^2 x$?",
                "options": [r"$\sin^2 x + \cos^2 x = 1$", "0", "2", "x"],
                "answer": r"$\sin^2 x + \cos^2 x = 1$",
                "level": 2,
                "check": {"status": "fixed", "note": r"Проверено по $\cos x$"},
            },
            {
                "id": "task-6",
                "type": "calc",
                "question": r"Найдите $\int e^{x} dx$.",
                "solution": r"$\int e^{x} dx = e^{x} + C$",
                "answer": r"$e^{x} + C$",
                "level": 2,
            },
        ],
        [{"title": "Первообразная", "bullets": ["Основные правила", "Примеры"], "notes": "Разберите пример"}],
    )

    assert lesson.tasks[0].options[0] == r"\(\sin^2 x + \cos^2 x = 1\)"
    assert lesson.tasks[0].answer == r"\(\sin^2 x + \cos^2 x = 1\)"
    assert lesson.tasks[0].check is not None
    assert lesson.tasks[0].check.note == r"Проверено по \(\cos x\)"
    assert lesson.tasks[1].solution == r"\(\int e^{x} dx = e^{x} + C\)"
    assert lesson.tasks[1].answer == r"\(e^{x} + C\)"



def test_slide_formula_uses_math_only_when_formula_stands_alone():
    lesson, _ = build_contract_lesson(
        [],
        [
            {
                "title": "Первообразная",
                "bullets": [
                    r"\[\int x^2 dx = \frac{x^3}{3} + C\]",
                    r"Основная формула: \(\int x^2 dx = \frac{x^3}{3} + C\)",
                ],
                "notes": "Покажите формулу",
            }
        ],
    )

    elements = lesson.slides[0].elements
    math = next(element for element in elements if element.type == "math")
    assert math.latex == r"\int x^2 dx = \frac{x^3}{3} + C"
    assert "x³" in math.fallbackText

    rich = next(
        element for element in elements
        if element.type == "text" and getattr(element, "text", "").startswith("• Основная формула:")
    )
    assert r"\(\int x^2 dx = \frac{x^3}{3} + C\)" in rich.text


def test_extract_json_text_preserves_raw_latex_backslashes_before_json_decode():
    payload = lesson_service._extract_json_text(
        r'{"slides":[{"title":"Свойства","bullets":["Если \tilde F(x), то \tilde F(x)=F(x)+C","Примеры: \int x^n dx=\frac{x^{n+1}}{n+1}+C; \int \frac{1}{\sqrt{x}}dx=2\sqrt{x}+C"]}]}'
    )

    bullets = payload["slides"][0]["bullets"]
    assert bullets[0] == r"Если \tilde F(x), то \tilde F(x)=F(x)+C"
    assert r"\frac{x^{n+1}}{n+1}" in bullets[1]
    assert r"\sqrt{x}" in bullets[1]
    assert "\t" not in bullets[0]
    assert "\f" not in bullets[1]


def test_prompt_count_replacement_does_not_interpret_latex_braces():
    template = lesson_service.PROMPTS["ru"]["slides"]
    rendered = template.replace("{count}", "6")
    assert "6 слайдов" in rendered
    assert r"\text{...}" in rendered


def test_task_normalizer_recovers_aliases_and_drops_empty_open_answers():
    tasks = lesson_service._shuffle_and_normalize_tasks(
        [
            {
                "type": "test_correct",
                "question": "Какое равенство верно?",
                "options": ["A", "B", "C", "D"],
                "correct": 2,
                "level": 2,
            },
            {
                "type": "open",
                "question": "Дайте определение",
                "answer": "",
                "level": 1,
            },
            {
                "type": "calculation",
                "question": "Вычислите",
                "answer": "2",
                "solution": "1+1=2",
                "level": 2,
            },
        ],
        seed=0,
    )

    assert [task["type"] for task in tasks] == ["test", "calc"]
    assert tasks[0]["answer"] in tasks[0]["options"]
    assert tasks[1]["solution"] == "1+1=2"


def test_mathcheck_cannot_blank_a_valid_answer(monkeypatch):
    original = [
        {
            "id": "task-1",
            "type": "open",
            "question": "Что такое первообразная?",
            "answer": "Функция F, для которой F'=f.",
            "level": 1,
        }
    ]

    def fake_checker(tasks):
        checked = [dict(tasks[0])]
        checked[0]["answer"] = ""
        checked[0]["check"] = {"status": "fixed", "note": ""}
        return checked

    monkeypatch.setattr(lesson_service, "_load_mathcheck", lambda: fake_checker)
    checked = lesson_service._verify_tasks(original)
    assert checked[0]["answer"] == original[0]["answer"]


def test_contract_builder_renumbers_duplicate_task_ids():
    lesson, _ = build_contract_lesson(
        [
            {"id": "task-1", "type": "open", "question": "Q1", "answer": "A1", "level": 1},
            {"id": "task-1", "type": "open", "question": "Q2", "answer": "A2", "level": 1},
        ],
        [{"title": "Тест", "bullets": ["Первый пункт", "Второй пункт"], "notes": ""}],
    )

    assert [task.id for task in lesson.tasks] == ["task-1", "task-2"]
