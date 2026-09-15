from __future__ import annotations

import logging
import re
from typing import Optional

from openai import OpenAI

from .settings import get_openai_key, settings

logger = logging.getLogger(__name__)


def _find_math_ranges(text: str) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "\\":
            i += 2
            continue
        if ch == "$":
            if i + 1 < n and text[i + 1] == "$":
                end = text.find("$$", i + 2)
                if end == -1:
                    break
                ranges.append((i, end + 2))
                i = end + 2
                continue
            end = text.find("$", i + 1)
            if end == -1:
                break
            ranges.append((i, end + 1))
            i = end + 1
            continue
        i += 1
    return ranges


def _range_inside(ranges: list[tuple[int, int]], start: int, end: int) -> bool:
    for r_start, r_end in ranges:
        if start >= r_start and end <= r_end:
            return True
    return False


def _wrap_envs_in_display_math(text: str, envs: list[str]) -> str:
    env_group = "|".join(re.escape(env) for env in envs)
    pattern = re.compile(rf"\\begin{{({env_group})}}.*?\\end{{\\1}}", re.S)
    matches = list(pattern.finditer(text))
    if not matches:
        return text
    ranges = _find_math_ranges(text)
    # wrap from end to start to keep indices valid
    for match in reversed(matches):
        start, end = match.span()
        if _range_inside(ranges, start, end):
            continue
        block = match.group(0).strip()
        text = f"{text[:start]}$$\n{block}\n$${text[end:]}"
    return text


def _tabular_to_markdown(text: str) -> str:
    pattern = re.compile(r"\\begin{tabular}{.*?}(.*?)\\end{tabular}", re.S)

    def repl(match: re.Match) -> str:
        body = match.group(1)
        body = body.replace("\\hline", "")
        rows_raw = [r.strip() for r in re.split(r"\\\\", body) if r.strip()]
        rows = []
        for row in rows_raw:
            cols = [c.strip() for c in row.split("&")]
            if cols:
                rows.append(cols)
        if not rows:
            return ""
        max_cols = max(len(r) for r in rows)
        rows = [r + [""] * (max_cols - len(r)) for r in rows]
        header = " | ".join(rows[0])
        if len(rows) == 1:
            return header
        sep = " | ".join(["---"] * max_cols)
        body_md = "\n".join(" | ".join(r) for r in rows[1:])
        return f"{header}\n{sep}\n{body_md}"

    return pattern.sub(repl, text)


def _array_with_borders(text: str) -> str:
    pattern = re.compile(r"\\begin{array}{(.*?)}(.*?)\\end{array}", re.S)

    def repl(match: re.Match) -> str:
        body = match.group(2)
        # Remove existing hlines to avoid duplicates
        body = body.replace("\\hline", "")
        rows_raw = [r.strip() for r in re.split(r"\\\\", body) if r.strip()]
        if not rows_raw:
            return match.group(0)
        # Infer column count from first row
        first_row = rows_raw[0]
        col_count = first_row.count("&") + 1
        col_spec = "|" + "|".join(["c"] * col_count) + "|"
        rows = []
        for row in rows_raw:
            cols = [c.strip() for c in row.split("&")]
            if len(cols) < col_count:
                cols += [""] * (col_count - len(cols))
            rows.append(" & ".join(cols))
        body_with_lines = "\\hline\n" + " \\\\\n\\hline\n".join(rows) + "\n\\\\\n\\hline"
        return f"\\begin{{array}}{{{col_spec}}}\n{body_with_lines}\n\\end{{array}}"

    return pattern.sub(repl, text)


def _postprocess_math(text: str) -> str:
    if not text:
        return text
    # Fallback for unsupported tabular -> markdown table
    if "\\begin{tabular}" in text:
        text = _tabular_to_markdown(text)
    # Ensure array has full borders
    if "\\begin{array}" in text:
        text = _array_with_borders(text)
    # Wrap array/aligned blocks into display math if missing
    text = _wrap_envs_in_display_math(text, ["array", "aligned"])
    return text



def _build_prompt(
    mode: str,
    problem: str,
    student_attempt: Optional[str],
    assistant_context: Optional[str],
    continue_from: bool,
    subject: Optional[str],
) -> tuple[str, str, int]:
    subject_label = (subject or "алгебра").strip() or "алгебра"
    lower_subject = subject_label.lower()
    is_formula_heavy = any(
        token in lower_subject
        for token in ("алгеб", "матем", "геом", "физ", "хим", "информ", "computer", "geometry", "physics")
    )

    if mode == "hint":
        max_tokens = 500
        user = (
            "Дай подсказку без полного ответа. "
            "Объясняй по-школьному, максимально кратко, доступно, шагами."
        )
    elif mode == "check":
        max_tokens = 2000
        user = (
            "Проверь попытку ученика не только по итоговому ответу, но и по логике каждого шага."
            " Меньше воды, больше сути."
            " Если ученик ничего не написал, не решай всё за него."
            " Если есть попытка, укажи первый неверный шаг и как исправить."
            " Оценку ставь только за предметную корректность и полноту."
            " Не снижай балл за оформление, стиль записи, пунктуацию и опечатки."
            " Если нет ошибок, похвали. И посчитай на сколько процентов ученик решил задание. "
            " В самом конце дай отдельную строку строго в формате: Выполнено: NN%"
        )
    else:
        max_tokens = 2000
        user = (
            "Дай полное решение/ответ по задаче. "
            "Пиши шагами 1..N, без лишней воды, кратко. "
        )

    base_sys = (
        f"Ты школьный учитель по предмету «{subject_label}». "
        "Пиши по-русски, понятным школьным языком, шагами 1..N. "
        "Для подсказки не раскрывай полный ответ. "
        "В режиме проверки всегда завершай ответ строкой строго формата: Выполнено: NN%, где NN от 0 до 100. "
        "Если найдена ошибка, укажи первый неверный шаг и корректный вариант."
    )
    if is_formula_heavy:
        sys = (
            base_sys
            + " Формулы оформляй в LaTeX и оборачивай в $$...$$. "
            + "Таблицы/схемы только через array/aligned. "
            + "Для array используй полные границы: вертикальные | и горизонтальные \\hline. "
            + "НЕ используй tabular/table."
        )
    else:
        sys = base_sys

    if student_attempt:
        user += f"\n\nПопытка ученика:\n{student_attempt.strip()}"

    if continue_from and assistant_context:
        max_tokens = min(max_tokens + 200, 1200)
        user += (
            "\n\nНиже твой предыдущий ответ, который оборвался. "
            "Продолжи с места остановки, не повторяй уже написанное. "
            "Сохрани нумерацию шагов.\n\n"
            f"{assistant_context.strip()}"
        )

    user += f"\n\nЗадача:\n{problem.strip()}"
    return sys, user, max_tokens


def generate_ai_response(
    mode: str,
    problem: str,
    student_attempt: Optional[str] = None,
    assistant_context: Optional[str] = None,
    continue_from: bool = False,
    subject: Optional[str] = None,
) -> str:
    api_key = get_openai_key()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")

    sys, user, max_tokens = _build_prompt(
        mode,
        problem,
        student_attempt,
        assistant_context,
        continue_from,
        subject,
    )

    client = OpenAI(api_key=api_key, timeout=settings.ai_timeout_seconds)
    try:
        if not hasattr(client, "responses"):
            raise RuntimeError("OpenAI SDK слишком старый. Обновите пакет openai до версии с Responses API.")

        response = client.responses.create(
            model=settings.ai_model,
            instructions=sys,
            input=[
                {"role": "user", "content": user},
            ],
            max_output_tokens=max_tokens,
            reasoning={"effort": settings.ai_reasoning_effort},
        )
        text = getattr(response, "output_text", None)
        if text is None:
            parts = []
            for item in getattr(response, "output", []) or []:
                for c in getattr(item, "content", []) or []:
                    t = getattr(c, "text", None)
                    if t:
                        parts.append(t)
            text = "\n".join(parts)
        text = text.strip() if text else ""
        return _postprocess_math(text)
    except Exception as exc:  # noqa: BLE001
        logger.warning("AI request failed: %s", exc)
        raise
