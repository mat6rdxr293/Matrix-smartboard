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



_RESPONSE_LANGUAGE_RULES = {
    "ru": (
        "Отвечай только на русском языке. Не используй казахский, английский, китайский или другие языки "
        "в обычном тексте. Математические обозначения и латинские переменные разрешены."
    ),
    "kk": (
        "Жауапты тек қазақ тілінде бер. Орысша, ағылшынша, қытайша немесе басқа тілдегі сөздерді араластырма. "
        "Табиғи әрі қарапайым қазақ тілін қолдан. «шаг», «берем», «ответ» сияқты орысша сөздерді қолданба. "
        "Математикалық таңбалар мен латын әріптерімен берілген айнымалыларды қолдануға болады."
    ),
    "en": (
        "Answer only in English. Do not mix Russian, Kazakh, Chinese, or other languages into ordinary prose. "
        "Mathematical notation and Latin variable names are allowed."
    ),
}

_RESPONSE_LANGUAGE_REMINDERS = {
    "ru": "Ответ дай только по-русски.",
    "kk": "Жауапты тек қазақ тілінде бер. Орысша сөздерді араластырма.",
    "en": "Answer only in English.",
}


def _response_language_rule(response_locale: str) -> str:
    return _RESPONSE_LANGUAGE_RULES.get(response_locale, _RESPONSE_LANGUAGE_RULES["ru"])


def _build_prompt(
    mode: str,
    problem: str,
    student_attempt: Optional[str],
    assistant_context: Optional[str],
    continue_from: bool,
    subject: Optional[str],
    board_context: bool = False,
    response_locale: str = "ru",
) -> tuple[str, str, int]:
    response_locale = response_locale if response_locale in {"ru", "kk", "en"} else "ru"
    language_rule = _response_language_rule(response_locale)
    score_label = {
        "ru": "Выполнено",
        "kk": "Орындалды",
        "en": "Completed",
    }[response_locale]
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
                f"{score_label}: NN%. Если условия недостаточно, чтобы честно определить полноту решения, прямо скажи об этом "
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
            f" В самом конце дай отдельную строку строго в формате: {score_label}: NN%"
        )
    else:
        max_tokens = 2000
        user = (
            "Дай полное решение/ответ по задаче. "
            "Пиши шагами 1..N, без лишней воды, кратко. "
        )

    base_sys = (
        f"Ты школьный учитель по предмету «{subject_label}». "
        f"{language_rule} "
        "Пиши понятным школьным языком, шагами 1..N. "
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
            f"В режиме проверки всегда завершай ответ строкой строго формата: {score_label}: NN%, где NN от 0 до 100. "
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

    user += f"\n\n{_RESPONSE_LANGUAGE_REMINDERS[response_locale]}"
    source_label = "Распознано с текущей доски" if board_context else "Задача"
    user += f"\n\n{source_label}:\n{problem.strip()}"
    return sys, user, max_tokens



def _requires_tool_use(subject: Optional[str], mode: str) -> bool:
    if mode not in {"solution", "check"}:
        return False
    value = (subject or "").strip().lower()
    if not value:
        return False
    is_stem = any(
        token in value
        for token in (
            "math", "mathemat", "algebra", "geometry",
            "матем", "алгеб", "геом",
            "physics", "phys", "физ",
            "chemistry", "chem", "хим",
        )
    )
    return is_stem and bool(openai_chat_tools(subject))


def _extract_pseudo_tool_calls(text: str, allowed_names: set[str]) -> list[tuple[str, dict]]:
    source = (text or "").strip()
    if not source or not allowed_names:
        return []

    decoder = json.JSONDecoder()
    found: list[tuple[str, dict]] = []
    seen: set[tuple[str, str]] = set()

    for index, char in enumerate(source):
        if char != "{":
            continue
        try:
            payload, _end = decoder.raw_decode(source[index:])
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue

        name = payload.get("name") or payload.get("tool")
        arguments = payload.get("arguments")
        if arguments is None:
            arguments = payload.get("parameters")
        if not isinstance(name, str) or name not in allowed_names:
            continue
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except Exception:
                continue
        if not isinstance(arguments, dict):
            continue

        key = (name, json.dumps(arguments, sort_keys=True, ensure_ascii=False))
        if key in seen:
            continue
        seen.add(key)
        found.append((name, arguments))

    return found


def _local_chat_with_tools(
    client,
    *,
    sys: str,
    user: str,
    max_tokens: int,
    subject: Optional[str],
    postprocess: bool = True,
    require_tool: bool = False,
) -> str:
    tools = openai_chat_tools(subject) if settings.ai_tools_enabled else []
    allowed_tool_names = {
        tool["function"]["name"]
        for tool in tools
        if isinstance(tool, dict) and isinstance(tool.get("function"), dict)
    }
    require_tool = bool(require_tool and tools)

    successful_tool_use = False
    unique_tool_calls = 0
    failed_tool_calls = 0
    tool_cache: dict[str, dict] = {}
    force_final = False
    force_final_notice_sent = False

    system_text = sys
    if tools:
        system_text += (
            "\nДля точных вычислений используй доступные инструменты вместо догадок. "
            "Ты сам выбираешь подходящий инструмент и его аргументы. "
            "Не вычисляй арифметику приблизительно в голове, если её может проверить инструмент. "
            "Не выдумывай результат инструмента. После вызова инструмента используй его фактический результат."
        )
        if require_tool:
            system_text += (
                "\nДля этой задачи перед финальным ответом ОБЯЗАТЕЛЬНО сделай хотя бы один успешный вызов инструмента."
            )

    messages: list[dict] = [
        {"role": "system", "content": system_text},
        {"role": "user", "content": user},
    ]

    def run_tool(name: str, arguments: dict) -> tuple[dict, bool]:
        nonlocal successful_tool_use, unique_tool_calls, failed_tool_calls

        signature = name + ":" + json.dumps(
            arguments,
            sort_keys=True,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        cached = tool_cache.get(signature)
        if cached is not None:
            return cached, False

        try:
            payload = execute_tool(name, arguments)
        except Exception as exc:  # noqa: BLE001
            payload = {"ok": False, "tool": name, "error": str(exc)}

        tool_cache[signature] = payload
        unique_tool_calls += 1
        if payload.get("ok"):
            successful_tool_use = True
        else:
            failed_tool_calls += 1
        return payload, True

    for round_index in range(6):
        if force_final and not force_final_notice_sent:
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "Инструменты уже дали достаточно проверенных данных. "
                        "Теперь сформируй финальный ответ, используя результаты выше. "
                        "Не запрашивай дополнительные инструменты и не пересчитывай их результаты в уме."
                    ),
                }
            )
            force_final_notice_sent = True

        request = {
            "model": settings.ai_model,
            "messages": messages,
            "max_tokens": max_tokens,
        }

        if tools and not force_final:
            request["tools"] = tools
            if require_tool and not successful_tool_use:
                request["tool_choice"] = "required"

        response = client.chat.completions.create(**request)
        message = response.choices[0].message
        tool_calls = getattr(message, "tool_calls", None) or []

        if tool_calls and not force_final:
            serialized_calls = []
            for call in tool_calls:
                function = getattr(call, "function", None)
                serialized_calls.append(
                    {
                        "id": getattr(call, "id", "") or f"call-{round_index}",
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

            saw_new_call = False
            saw_duplicate = False

            for call in tool_calls:
                function = getattr(call, "function", None)
                name = getattr(function, "name", "")
                raw_arguments = getattr(function, "arguments", "{}") or "{}"
                try:
                    arguments = json.loads(raw_arguments)
                    if not isinstance(arguments, dict):
                        raise ToolError("Аргументы инструмента должны быть объектом")
                    payload, is_new = run_tool(name, arguments)
                    saw_new_call = saw_new_call or is_new
                    saw_duplicate = saw_duplicate or not is_new
                except Exception as exc:  # noqa: BLE001
                    payload = {"ok": False, "tool": name, "error": str(exc)}

                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": getattr(call, "id", "") or f"call-{round_index}",
                        "content": json.dumps(payload, ensure_ascii=False),
                    }
                )

            if successful_tool_use and (
                unique_tool_calls >= 3
                or (saw_duplicate and not saw_new_call)
            ):
                force_final = True
            elif not successful_tool_use and failed_tool_calls >= 2:
                raise RuntimeError(
                    "AI не смог выполнить вычислительные инструменты после нескольких попыток"
                )
            continue

        content = getattr(message, "content", None)
        text = content.strip() if content else ""

        # Some local models print a tool request as JSON in normal assistant text.
        # Recover that intent instead of leaking pseudo-tool JSON to the UI.
        pseudo_calls = (
            _extract_pseudo_tool_calls(text, allowed_tool_names)
            if not force_final
            else []
        )
        if pseudo_calls:
            messages.append({"role": "assistant", "content": text})
            results = []
            saw_new_call = False
            saw_duplicate = False

            for name, arguments in pseudo_calls:
                payload, is_new = run_tool(name, arguments)
                results.append(payload)
                saw_new_call = saw_new_call or is_new
                saw_duplicate = saw_duplicate or not is_new

            messages.append(
                {
                    "role": "user",
                    "content": (
                        "Backend распознал твой текстовый запрос к инструменту и реально выполнил его. "
                        "Вот фактические результаты; продолжи решение, опираясь только на них:\n"
                        + json.dumps(results, ensure_ascii=False)
                    ),
                }
            )

            if successful_tool_use and (
                unique_tool_calls >= 3
                or (saw_duplicate and not saw_new_call)
            ):
                force_final = True
            elif not successful_tool_use and failed_tool_calls >= 2:
                raise RuntimeError(
                    "AI не смог выполнить вычислительные инструменты после нескольких попыток"
                )
            continue

        if require_tool and not successful_tool_use:
            messages.append({"role": "assistant", "content": text or None})
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "Финальный ответ пока запрещён: сначала вызови один из доступных инструментов "
                        "для проверки вычислений. Сам выбери подходящий tool и аргументы."
                    ),
                }
            )
            continue

        return _postprocess_math(text) if postprocess else text

    if successful_tool_use:
        # Last-resort finalization: no tools are exposed in this request, so the
        # model cannot loop back into another function call.
        messages.append(
            {
                "role": "user",
                "content": (
                    "Сформируй финальный ответ прямо сейчас по уже полученным результатам инструментов. "
                    "Никаких новых вычислений и вызовов инструментов."
                ),
            }
        )
        response = client.chat.completions.create(
            model=settings.ai_model,
            messages=messages,
            max_tokens=max_tokens,
        )
        message = response.choices[0].message
        content = getattr(message, "content", None)
        text = content.strip() if content else ""
        if text:
            return _postprocess_math(text) if postprocess else text

    raise RuntimeError("AI не смог завершить ответ после вызова инструментов")



def generate_ai_response(
    mode: str,
    problem: str,
    student_attempt: Optional[str] = None,
    assistant_context: Optional[str] = None,
    continue_from: bool = False,
    subject: Optional[str] = None,
    board_context: bool = False,
    response_locale: str = "ru",
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
        response_locale,
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
                require_tool=_requires_tool_use(subject, mode),
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


_CJK_SCRIPT_RE = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+")


def _sanitize_board_language(
    text: str,
    steps: list[dict[str, str]],
    response_locale: str,
) -> tuple[str, list[dict[str, str]]]:
    if response_locale not in {"ru", "kk", "en"}:
        return text, steps

    def clean(value: str) -> str:
        value = _CJK_SCRIPT_RE.sub(" ", value)
        value = re.sub(r"\s+([.,;:!?])", r"\1", value)
        value = re.sub(r"[ \t]{2,}", " ", value)
        return value.strip()

    cleaned_steps: list[dict[str, str]] = []
    for step in steps:
        step_text = clean(step.get("text", ""))
        if not step_text:
            continue
        cleaned_steps.append({**step, "text": step_text})

    return clean(text), cleaned_steps


def _promote_semantic_result(
    steps: list[dict[str, str]],
    response_locale: str,
) -> list[dict[str, str]]:
    if not steps or steps[-1].get("kind") == "result":
        return steps

    final_text = steps[-1].get("text", "").strip()
    lower = final_text.lower()
    cues = {
        "ru": ("ответ", "итак", "следовательно", "корней нет", "не имеет действительных корней", "получаем"),
        "kk": ("жауап", "түбір", "сондықтан", "нақты түбірі жоқ", "аламыз"),
        "en": ("answer", "therefore", "no real roots", "has no real roots", "we get"),
    }.get(response_locale, ("ответ", "итак", "answer", "therefore"))

    has_cue = any(cue in lower for cue in cues)
    has_final_assignment = bool(
        re.search(
            r"(?:^|[\s$\\(])(x|y|z|t|n)(?:_\{?\d+\}?)?\s*(?:=|\\in)\s*[^=]+$",
            final_text,
            flags=re.I,
        )
    )
    if not has_cue and not has_final_assignment:
        return steps

    promoted = [dict(step) for step in steps]
    promoted[-1]["kind"] = "result"
    return promoted


def _normalize_board_result_tail(
    steps: list[dict[str, str]],
    response_locale: str,
) -> list[dict[str, str]]:
    normalized = [dict(step) for step in steps]
    incomplete_cues = (
        "добавим",
        "найдем",
        "найдём",
        "рассчитаем",
        "вычислим",
        "подставим",
        "используем",
        "продолжим",
        "add ",
        "find ",
        "calculate",
        "substitute",
        "continue",
        "табамыз",
        "есептейміз",
        "қоямыз",
        "жалғастырамыз",
    )
    while len(normalized) > 1 and normalized[-1].get("kind") == "result":
        text = normalized[-1].get("text", "").strip()
        lower = text.lower()
        if not text.endswith((':', '=', '→', '-')) and not any(cue in lower for cue in incomplete_cues):
            break
        normalized.pop()

    return _promote_semantic_result(normalized, response_locale)


def _board_solution_has_result(steps: list[dict[str, str]]) -> bool:
    return bool(steps) and steps[-1].get("kind") == "result" and bool(steps[-1].get("text", "").strip())


def _merge_board_solution_steps(
    existing: list[dict[str, str]],
    continuation: list[dict[str, str]],
) -> list[dict[str, str]]:
    merged = [dict(step) for step in existing]
    seen = {
        re.sub(r"\s+", " ", step.get("text", "")).strip().lower()
        for step in merged
        if step.get("text")
    }
    for step in continuation:
        key = re.sub(r"\s+", " ", step.get("text", "")).strip().lower()
        if not key or key in seen:
            continue
        merged.append(dict(step))
        seen.add(key)
        if len(merged) >= 40:
            break
    return merged


def generate_board_solution(
    problem: str,
    *,
    subject: Optional[str] = None,
    board_context: bool = True,
    response_locale: str = "ru",
) -> tuple[str, list[dict[str, str]]]:
    api_key = get_openai_key()
    base_url = settings.ai_base_url

    if not base_url:
        text = generate_ai_response(
            "solution",
            problem,
            subject=subject,
            board_context=board_context,
            response_locale=response_locale,
        )
        steps = [{"text": text, "kind": "text"}] if text else []
        return _sanitize_board_language(text, steps, response_locale)

    sys, user, max_tokens = _build_prompt(
        "solution",
        problem,
        None,
        None,
        False,
        subject,
        board_context,
        response_locale,
    )
    language_rule = _response_language_rule(response_locale)
    sys += (
        f"\n{language_rule} "
        "Не вставляй текст на других языках, если его нет в условии задачи. "
        "Верни ТОЛЬКО валидный JSON без markdown-обертки. "
        "Формат: {\"summary\":\"кратко\",\"steps\":["
        "{\"text\":\"шаг\",\"kind\":\"text|math|result|warning\"}]}. "
        "Каждый логический шаг должен быть отдельным элементом. "
        "Это запись НА ДОСКЕ: пиши предельно кратко, как ученик или учитель от руки. "
        "Не переписывай условие задачи и не объясняй очевидные действия длинными предложениями. "
        "Обычно используй 3-7 коротких шагов, по возможности одну строку на шаг; предпочитай формулы словам. "
        "В школьной алгебре решай над действительными числами, если комплексные числа явно не требуются условием. "
        "Если дискриминант D < 0, пиши кратко: действительных корней нет; не переходи к комплексным корням. "
        "Не смешивай язык ответа с английскими математическими словами: используй терминологию выбранного языка UI. "
        "Обязательно доведи решение до конечного ответа. "
        "Последний элемент steps ОБЯЗАТЕЛЬНО должен иметь kind=result и содержать конечный ответ, "
        "а не промежуточную формулу. "
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
        require_tool=_requires_tool_use(subject, "solution"),
    )
    text, steps = _parse_board_solution(raw)
    text, steps = _sanitize_board_language(text, steps, response_locale)
    steps = _normalize_board_result_tail(steps, response_locale)

    if steps and not _board_solution_has_result(steps):
        continuation_sys = (
            sys
            + "\nПредыдущий ответ оборвался до конечного результата. "
            + "Верни ТОЛЬКО недостающие шаги в том же JSON-формате. "
            + "Не повторяй уже готовые шаги. Последний шаг ОБЯЗАТЕЛЬНО kind=result."
        )
        continuation_user = (
            user
            + "\n\nУже полученные шаги:\n"
            + json.dumps(steps, ensure_ascii=False)
            + "\n\nПродолжи строго с места остановки и доведи решение до конечного ответа."
        )
        raw_continuation = _local_chat_with_tools(
            client,
            sys=continuation_sys,
            user=continuation_user,
            max_tokens=max_tokens,
            subject=subject,
            postprocess=False,
        )
        continuation_text, continuation_steps = _parse_board_solution(raw_continuation)
        continuation_text, continuation_steps = _sanitize_board_language(
            continuation_text,
            continuation_steps,
            response_locale,
        )
        if continuation_steps:
            steps = _merge_board_solution_steps(steps, continuation_steps)
            steps = _normalize_board_result_tail(steps, response_locale)
            text = "\n".join(
                f"{index + 1}. {step['text']}"
                for index, step in enumerate(steps)
            )
        elif continuation_text.strip():
            text = f"{text}\n{continuation_text}".strip()

    return text, steps
