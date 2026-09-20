from app.ai import _build_prompt


def test_board_context_check_is_not_bound_to_task_cards():
    system, user, _ = _build_prompt(
        "check",
        "x^2 = 4\nx = 2",
        None,
        None,
        False,
        "Алгебра",
        True,
    )

    assert "только текущая доска" in system.lower()
    assert "игнорируй любые карточки заданий" in system.lower()
    assert "не ставь 0%" in user.lower()
    assert "распознано с текущей доски" in user.lower()
    assert "Задача:\n" not in user


def test_regular_check_keeps_required_score_line():
    system, user, _ = _build_prompt(
        "check",
        "Реши x=2",
        "x=2",
        None,
        False,
        "Алгебра",
        False,
    )

    assert "всегда завершай ответ строкой" in system.lower()
    assert "Задача:\nРеши x=2" in user

