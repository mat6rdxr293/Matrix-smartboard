from __future__ import annotations

import json
import logging
import re
from typing import Optional

from openai import OpenAI

from .settings import get_openai_key, settings
from .ai_tools import ToolError, execute_tool, openai_chat_tools

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
    board_context: bool = False,
) -> tuple[str, str, int]:
    subject_label = (subject or "алгебра").strip() or "алгебра"
    lower_subject = subject_label.lower()
    is_formula_heavy = any(
        token in lower_subject
        for token in ("алгеб", "матем", "геом", "физ", "хим", "информ", "computer", "geometry", "physics")
    )

    if board_context:
        if mode == "hint":
            max_tokens = 700
            user = (
                "Посмотри только на распознанное содержимое текущей доски и дай следующую полезную подсказку. "
                "Не раскрывай полный ответ. Если условие задачи на доске не видно полностью, не придумывай его: "
                "скажи, чего не хватает, или подскажи по тем шагам, которые действительно видны."
            )
        elif mode == "check":
            max_tokens = 2000
            user = (
                "Проверь только то решение и условие, которые реально видны в распознанном содержимом текущей доски. "
                "Не сравнивай запись с карточками заданий, выбранным заданием, прошлым заданием или любым скрытым эталоном. "
                "Если видимого условия достаточно, проверь логику каждого шага, укажи первую ошибку и в конце дай строку "
                "Выполнено: NN%. Если условия недостаточно, чтобы честно определить полноту решения, прямо скажи об этом "
                "и не ставь 0%, не придумывай процент и не утверждай, что ученик решил не то задание."
            )
        else:
            max_tokens = 2000
            user = (
                "Работай только с распознанным содержимым текущей доски. Дай полное решение или продолжение для того, "
                "что действительно написано на доске. Не используй карточки заданий и не подставляй условие из памяти. "
                "Если условие неполное, сначала кратко укажи, какой информации не хватает."
            )
    elif mode == "hint":
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
        "Если найдена ошибка, укажи первый неверный шаг и корректный вариант. "
    )
    if board_context:
        base_sys += (
            "Источник контекста — только текущая доска после OCR. "
            "Игнорируй любые карточки заданий и не делай вывод, что решение неверно из-за несовпадения с другим заданием. "
            "В режиме проверки процент допустим только когда по доске можно определить требуемую задачу и полноту решения. "
        )
    else:
        base_sys += (
            "В режиме проверки всегда завершай ответ строкой строго формата: Выполнено: NN%, где NN от 0 до 100. "
        )

    if is_formula_heavy:
        sys = (
            base_sys
            + "Формулы оформляй в LaTeX и оборачивай в $$...$$. "
            + "Таблицы/схемы только через array/aligned. "
            + "Для array используй полные границы: вертикальные | и горизонтальные \\hline. "
            + "НЕ используй tabular/table."
        )
    else:
        sys = base_sys

    if student_attempt:
        user += f"\n\nПопытка ученика:\n{student_attempt.strip()}"

    if continue_from and assistant_context:
        max_tokens = min(max_tokens + 200, 2200)
        user += (
            "\n\nНиже твой предыдущий ответ, который оборвался. "
            "Продолжи с места остановки, не повторяй уже написанное. "
            "Сохрани нумерацию шагов.\n\n"
            f"{assistant_context.strip()}"
        )

    source_label = "Распознано с текущей доски" if board_context else "Задача"
    user += f"\n\n{source_label}:\n{problem.strip()}"
    return sys, user, max_tokens



def _local_chat_with_tools(
    client,
    *,
    sys: str,
    user: str,
    max_tokens: int,
    subject: Optional[str],
    postprocess: bool = True,
) -> str:
    tools = openai_chat_tools(subject) if settings.ai_tools_enabled else []
    system_text = sys
    if tools:
        system_text += (
            "\nДля точных вычислений используй доступные инструменты вместо догадок. "
            "Не выдумывай результат инструмента. После вызова инструмента объясни результат ученику."
        )

    messages: list[dict] = [
        {"role": "system", "content": system_text},
        {"role": "user", "content": user},
    ]

    for _ in range(5):
        request = {
            "model": settings.ai_model,
            "messages": messages,
            "max_tokens": max_tokens,
        }
        if tools:
            request["tools"] = tools

        response = client.chat.completions.create(**request)
        message = response.choices[0].message
        tool_calls = getattr(message, "tool_calls", None) or []

        if not tool_calls:
            content = getattr(message, "content", None)
            text = content.strip() if content else ""
            return _postprocess_math(text) if postprocess else text

        serialized_calls = []
        for call in tool_calls:
            function = getattr(call, "function", None)
            serialized_calls.append(
                {
                    "id": getattr(call, "id", ""),
                    "type": "function",
                    "function": {
                        "name": getattr(function, "name", ""),
                        "arguments": getattr(function, "arguments", "{}") or "{}",
                    },
                }
            )

        messages.append(
            {
                "role": "assistant",
                "content": getattr(message, "content", None),
                "tool_calls": serialized_calls,
            }
        )

        for call in tool_calls:
            function = getattr(call, "function", None)
            name = getattr(function, "name", "")
            raw_arguments = getattr(function, "arguments", "{}") or "{}"
            try:
                arguments = json.loads(raw_arguments)
                if not isinstance(arguments, dict):
                    raise ToolError("Аргументы инструмента должны быть объектом")
                payload = execute_tool(name, arguments)
            except Exception as exc:  # noqa: BLE001
                payload = {"ok": False, "tool": name, "error": str(exc)}

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": getattr(call, "id", ""),
                    "content": json.dumps(payload, ensure_ascii=False),
                }
            )

    raise RuntimeError("AI tool loop exceeded 5 rounds")



def generate_ai_response(
    mode: str,
    problem: str,
    student_attempt: Optional[str] = None,
    assistant_context: Optional[str] = None,
    continue_from: bool = False,
    subject: Optional[str] = None,
    board_context: bool = False,
) -> str:
    api_key = get_openai_key()
    base_url = settings.ai_base_url
    if not api_key and not base_url:
        raise RuntimeError("AI backend is not configured")

    sys, user, max_tokens = _build_prompt(
        mode,
        problem,
        student_attempt,
        assistant_context,
        continue_from,
        subject,
        board_context,
    )

    client_options = {
        "api_key": api_key or "ollama",
        "timeout": settings.ai_timeout_seconds,
    }
    if base_url:
        client_options["base_url"] = base_url
    client = OpenAI(**client_options)
    try:
        if base_url:
            return _local_chat_with_tools(
                client,
                sys=sys,
                user=user,
                max_tokens=max_tokens,
                subject=subject,
            )

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

def _decode_loose_json_string(value: str) -> str:
    try:
        return json.loads(f'"{value}"')
    except Exception:
        decoded = re.sub(r'\\(["\\/])', r'\1', value)
        decoded = decoded.replace("\\n", "\n").replace("\\r", "\r").replace("\\t", "\t")
        return decoded


def _extract_loose_board_solution(raw: str) -> tuple[str, list[dict[str, str]]]:
    source = (raw or "").strip()
    field_pattern = re.compile(
        r'"(?P<key>summary|text|kind)"\s*:?\s*"(?P<value>(?:\\.|[^"\\])*)"',
        re.I | re.S,
    )
    fields = list(field_pattern.finditer(source))

    summary = ""
    steps: list[dict[str, str]] = []
    for index, match in enumerate(fields):
        key = match.group("key").lower()
        value = _decode_loose_json_string(match.group("value")).strip()
        if key == "summary" and not summary:
            summary = value[:2000]
            continue
        if key != "text" or not value:
            continue

        next_start = fields[index + 1].start() if index + 1 < len(fields) else min(len(source), match.end() + 300)
        tail = source[match.end():next_start]
        kind_match = re.search(
            r'"kind"\s*:?\s*"(text|math|result|warning)"',
            tail,
            flags=re.I,
        )
        kind = kind_match.group(1).lower() if kind_match else "text"
        steps.append({"text": value[:2000], "kind": kind})
        if len(steps) >= 40:
            break

    return summary, steps


def _parse_board_solution(raw: str) -> tuple[str, list[dict[str, str]]]:
    cleaned = (raw or "").strip()
    fence = chr(96) * 3
    if cleaned.startswith(fence):
        cleaned = re.sub(r"^" + re.escape(fence) + r"(?:json)?\s*", "", cleaned, flags=re.I)
        cleaned = re.sub(r"\s*" + re.escape(fence) + r"$", "", cleaned)
    try:
        payload = json.loads(cleaned)
    except Exception:
        payload = None

    steps: list[dict[str, str]] = []
    summary = ""
    if isinstance(payload, dict):
        summary_value = payload.get("summary")
        if isinstance(summary_value, str):
            summary = summary_value.strip()
        raw_steps = payload.get("steps")
        if isinstance(raw_steps, list):
            for item in raw_steps[:40]:
                if not isinstance(item, dict):
                    continue
                text = item.get("text")
                kind = item.get("kind")
                if not isinstance(text, str) or not text.strip():
                    continue
                if kind not in {"text", "math", "result", "warning"}:
                    kind = "text"
                steps.append({"text": text.strip()[:2000], "kind": kind})

    if not steps:
        loose_summary, loose_steps = _extract_loose_board_solution(cleaned)
        if loose_steps:
            summary = summary or loose_summary
            steps = loose_steps

    if not steps:
        fallback = _postprocess_math((raw or "").strip())
        looks_structured = bool(re.search(r'"(?:summary|steps|text|kind)"\s*:?', fallback, flags=re.I))
        if fallback and not looks_structured:
            steps = [{"text": fallback[:12000], "kind": "text"}]
        return fallback, steps

    text = "\n".join(f"{index + 1}. {step['text']}" for index, step in enumerate(steps))
    if summary:
        text = f"{summary}\n\n{text}"
    return _postprocess_math(text), steps


def generate_board_solution(
    problem: str,
    *,
    subject: Optional[str] = None,
    board_context: bool = True,
) -> tuple[str, list[dict[str, str]]]:
    api_key = get_openai_key()
    base_url = settings.ai_base_url

    if not base_url:
        text = generate_ai_response(
            "solution",
            problem,
            subject=subject,
            board_context=board_context,
        )
        return text, [{"text": text, "kind": "text"}] if text else []

    sys, user, max_tokens = _build_prompt(
        "solution",
        problem,
        None,
        None,
        False,
        subject,
        board_context,
    )
    sys += (
        "\nВерни ТОЛЬКО валидный JSON без markdown-обертки. "
        "Формат: {\"summary\":\"кратко\",\"steps\":["
        "{\"text\":\"шаг\",\"kind\":\"text|math|result|warning\"}]}. "
        "Каждый логический шаг должен быть отдельным элементом. "
        "Для формул внутри text используй LaTeX в $$...$$."
    )

    client_options = {
        "api_key": api_key or "ollama",
        "timeout": settings.ai_timeout_seconds,
    }
    if base_url:
        client_options["base_url"] = base_url
    client = OpenAI(**client_options)
    raw = _local_chat_with_tools(
        client,
        sys=sys,
        user=user,
        max_tokens=max_tokens,
        subject=subject,
        postprocess=False,
    )
    return _parse_board_solution(raw)
