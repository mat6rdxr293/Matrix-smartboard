from __future__ import annotations

import json
import logging
import re
from decimal import Decimal, InvalidOperation
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


_TERMINAL_TOOL_NAMES = {
    "math_solve_system",
    "math_solve_inequalities",
    "math_domain",
    "math_limit",
    "math_percent",
    "math_sequence",
    "math_combinatorics",
    "math_probability",
    "math_statistics",
    "math_number_theory",
    "math_function_analysis",
    "math_trig_value",
    "math_solve_trig",
    "math_vector",
    "geometry_compute",
    "physics_convert_unit",
    "physics_check_dimensions",
    "chemistry_molar_mass",
    "chemistry_balance_equation",
    "chemistry_element",
}


def _local_chat_with_tools(
    client,
    *,
    sys: str,
    user: str,
    max_tokens: int,
    subject: Optional[str],
    task_text: Optional[str] = None,
    postprocess: bool = True,
    require_tool: bool = False,
    tool_trace: Optional[list[dict]] = None,
    finalize_after_tool: bool = False,
    return_after_tool_names: Optional[set[str]] = None,
    only_tool_names: Optional[set[str]] = None,
) -> str:
    tools = openai_chat_tools(subject, task_text or user) if settings.ai_tools_enabled else []
    only_tool_names = set(only_tool_names or ())
    if only_tool_names:
        tools = [
            tool
            for tool in tools
            if isinstance(tool, dict)
            and isinstance(tool.get("function"), dict)
            and tool["function"].get("name") in only_tool_names
        ]
    allowed_tool_names = {
        tool["function"]["name"]
        for tool in tools
        if isinstance(tool, dict) and isinstance(tool.get("function"), dict)
    }
    require_tool = bool(require_tool and tools)
    return_after_tool_names = set(return_after_tool_names or ())

    successful_tool_use = False
    unique_tool_calls = 0
    failed_tool_calls = 0
    tool_cache: dict[str, dict] = {}
    internal_tool_trace: list[dict] = []
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

    def finalize_from_tools() -> str:
        verified = [
            item
            for item in internal_tool_trace
            if isinstance(item.get("payload"), dict) and item["payload"].get("ok")
        ]
        if not verified:
            return ""

        structured_board = (
            "валидный JSON" in sys
            and '"steps"' in sys
        )
        requires_result_step = (
            "Последний элемент steps ОБЯЗАТЕЛЬНО должен иметь kind=result" in sys
        )
        final_system = (
            sys
            + "\nИнструменты уже выполнены backend-ом. "
            + "Новых инструментов сейчас нет. Используй ТОЛЬКО фактические результаты ниже "
            + "и сформируй финальный ответ в требуемом формате. "
            + "Не выдумывай вычисления и не противоречь результатам tools."
        )
        if structured_board:
            final_system += (
                "\nВерни один JSON-объект без markdown. "
                "В steps обязательно должны быть короткие логические шаги."
            )
            if requires_result_step:
                final_system += (
                    " Последний шаг ОБЯЗАТЕЛЬНО должен иметь kind=result "
                    "и содержать конечный ответ."
                )

        final_messages = [
            {"role": "system", "content": final_system},
            {
                "role": "user",
                "content": (
                    user
                    + "\n\nПРОВЕРЕННЫЕ РЕЗУЛЬТАТЫ ИНСТРУМЕНТОВ:\n"
                    + json.dumps(verified, ensure_ascii=False)[:12000]
                    + "\n\nТеперь дай финальный ответ."
                ),
            },
        ]

        json_mode_supported = True
        for attempt in range(3):
            request = {
                "model": settings.ai_model,
                "messages": final_messages,
                "max_tokens": max_tokens,
                "temperature": 0,
            }
            if structured_board and json_mode_supported:
                request["response_format"] = {"type": "json_object"}
            try:
                response = client.chat.completions.create(**request)
            except Exception:
                if structured_board and json_mode_supported:
                    json_mode_supported = False
                    request.pop("response_format", None)
                    response = client.chat.completions.create(**request)
                else:
                    raise

            message = response.choices[0].message
            content = getattr(message, "content", None)
            text = content.strip() if content else ""
            if not text:
                final_messages.append(
                    {
                        "role": "user",
                        "content": "Ответ пустой. Верни финальный ответ прямо сейчас.",
                    }
                )
                continue

            if structured_board:
                _parsed_text, parsed_steps = _parse_board_solution(text)
                parsed_steps = _normalize_board_result_tail(parsed_steps, "ru")
                if parsed_steps and (
                    not requires_result_step
                    or _board_solution_has_result(parsed_steps)
                ):
                    return text
                correction = (
                    "JSON не завершён: последний шаг должен быть kind=result "
                    "и содержать конечный ответ. Верни исправленный полный JSON."
                    if requires_result_step
                    else "JSON не содержит корректных steps. Верни исправленный полный JSON."
                )
                final_messages.append(
                    {
                        "role": "user",
                        "content": correction,
                    }
                )
                continue

            return _postprocess_math(text) if postprocess else text

        return ""

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
        trace_item = {
            "tool": name,
            "arguments": dict(arguments),
            "payload": payload,
        }
        internal_tool_trace.append(trace_item)
        if tool_trace is not None:
            tool_trace.append(dict(trace_item))
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
                    "content": getattr(message, "content", None) or "",
                    "tool_calls": serialized_calls,
                }
            )

            saw_new_call = False
            saw_duplicate = False
            saw_terminal_success = False
            saw_requested_return = False

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
                    if is_new and payload.get("ok") and name in _TERMINAL_TOOL_NAMES:
                        saw_terminal_success = True
                    if is_new and payload.get("ok") and name in return_after_tool_names:
                        saw_requested_return = True
                except Exception as exc:  # noqa: BLE001
                    payload = {"ok": False, "tool": name, "error": str(exc)}

                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": getattr(call, "id", "") or f"call-{round_index}",
                        "content": json.dumps(payload, ensure_ascii=False),
                    }
                )

            if saw_requested_return:
                return ""
            if successful_tool_use and (finalize_after_tool or saw_terminal_success):
                finalized = finalize_from_tools()
                if finalized:
                    return finalized
                force_final = True
            elif successful_tool_use and (
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
            saw_terminal_success = False
            saw_requested_return = False

            for name, arguments in pseudo_calls:
                payload, is_new = run_tool(name, arguments)
                results.append(payload)
                saw_new_call = saw_new_call or is_new
                saw_duplicate = saw_duplicate or not is_new
                if is_new and payload.get("ok") and name in _TERMINAL_TOOL_NAMES:
                    saw_terminal_success = True
                if is_new and payload.get("ok") and name in return_after_tool_names:
                    saw_requested_return = True

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

            if saw_requested_return:
                return ""
            if successful_tool_use and (finalize_after_tool or saw_terminal_success):
                finalized = finalize_from_tools()
                if finalized:
                    return finalized
                force_final = True
            elif successful_tool_use and (
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
            messages.append({"role": "assistant", "content": text or ""})
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
        finalized = finalize_from_tools()
        if finalized:
            return finalized

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
                task_text=problem,
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

        kind = "text"
        for following in fields[index + 1:index + 4]:
            following_key = following.group("key").lower()
            if following_key in {"text", "summary"}:
                break
            if following_key == "kind":
                candidate_kind = _decode_loose_json_string(following.group("value")).strip().lower()
                if candidate_kind in {"text", "math", "result", "warning"}:
                    kind = candidate_kind
                break
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


def _looks_like_nested_board_json(value: str) -> bool:
    normalized = (value or "").replace("\\", "").strip()
    if not normalized.startswith(("{", "[")):
        return False
    lower = normalized.lower()
    return '"steps"' in lower or '"summary"' in lower or '"kind"' in lower


def _clean_board_step_artifacts(steps: list[dict[str, str]]) -> list[dict[str, str]]:
    return [
        dict(step)
        for step in steps
        if step.get("text", "").strip()
        and not _looks_like_nested_board_json(step.get("text", ""))
    ]


def _strip_repeated_problem_steps(
    steps: list[dict[str, str]],
    problem: str,
) -> list[dict[str, str]]:
    def normalize(value: str) -> str:
        value = re.sub(r"[$\\()]+", " ", value or "")
        value = re.sub(r"[^0-9A-Za-zА-Яа-яӘәҒғҚқҢңӨөҰұҮүҺһІіЁё]+", " ", value)
        return re.sub(r"\s+", " ", value).strip().lower()

    target = normalize(problem)
    if not target:
        return [dict(step) for step in steps]

    cleaned: list[dict[str, str]] = []
    for step in steps:
        step_text = normalize(step.get("text", ""))
        if step_text and (
            step_text == target
            or (
                len(step_text) >= 24
                and len(target) >= 24
                and (step_text in target or target in step_text)
            )
        ):
            continue
        cleaned.append(dict(step))
    return cleaned


def _enforce_verified_board_result(
    steps: list[dict[str, str]],
    reference: dict | None,
) -> list[dict[str, str]]:
    cleaned = _clean_board_step_artifacts(steps)
    if not reference:
        return cleaned

    display = str(reference.get("display", "")).strip()
    if not display:
        return cleaned

    # Preserve a correctly localized "no real roots" phrase if the model
    # already expressed the verified result cleanly.
    if reference.get("kind") == "no_real_roots":
        for step in reversed(cleaned):
            if step.get("kind") != "result":
                continue
            lower = step.get("text", "").lower()
            if any(cue in lower for cue in _NO_REAL_ROOT_CUES):
                return [
                    *[dict(item) for item in cleaned if item.get("kind") != "result"],
                    dict(step),
                ]

    # A terminal solver/tool is authoritative for the final value. Keep AI
    # reasoning, but never allow a hallucinated trailing result to override it.
    without_results = [
        dict(step)
        for step in cleaned
        if step.get("kind") != "result"
    ]
    if without_results and without_results[-1].get("text", "").strip() == display:
        without_results[-1]["kind"] = "result"
        return without_results
    without_results.append({"text": display, "kind": "result"})
    return without_results


def _sanitize_board_language(
    text: str,
    steps: list[dict[str, str]],
    response_locale: str,
) -> tuple[str, list[dict[str, str]]]:
    if response_locale not in {"ru", "kk", "en"}:
        return text, steps

    def clean(value: str) -> str:
        # Local models sometimes emit single-backslash LaTeX inside JSON.
        # json.loads then interprets valid JSON escapes such as \f in \frac
        # or \t in \theta. Repair the common math commands before rendering.
        latex_repairs = {
            chr(12) + "rac": "\\frac",
            chr(8) + "eta": "\\beta",
            chr(8) + "egin": "\\begin",
            chr(13) + "ight": "\\right",
            chr(9) + "heta": "\\theta",
            chr(9) + "an": "\\tan",
            chr(9) + "imes": "\\times",
            chr(9) + "ext": "\\text",
            chr(9) + "au": "\\tau",
            chr(10) + "eq": "\\neq",
        }
        for broken, repaired in latex_repairs.items():
            value = value.replace(broken, repaired)
        value = _CJK_SCRIPT_RE.sub(" ", value)
        value = re.sub(
            r"(?i)\b(?:воспользуемся|используем|воспользуйся)\s+(?:доступным\s+)?инструментом[^.!?]*[.!?]?",
            " ",
            value,
        )
        value = re.sub(
            r"(?i)\b(?:с помощью|через)\s+(?:доступного\s+)?инструмента\b",
            " ",
            value,
        )
        value = re.sub(r"(?i)\b(?:tool|backend|api)\b", " ", value)
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


def _board_hint_needs_retry(steps: list[dict[str, str]], response_locale: str) -> bool:
    if not steps:
        return True
    joined = " ".join(step.get("text", "") for step in steps).strip()
    lower = joined.lower()
    if not joined:
        return True

    action_cues = {
        "ru": ("найди", "найдите", "вычисли", "вычислите", "подстав", "раскрой", "вынеси", "сократ", "проверь", "сравни", "разлож", "определи", "дискриминант"),
        "kk": ("тап", "есепте", "қой", "аш", "қысқарт", "тексер", "салыстыр"),
        "en": ("find", "calculate", "compute", "substitute", "expand", "factor", "simplify", "check", "compare"),
    }.get(response_locale, ("find", "calculate", "найди", "вычисли"))
    if re.search(r"\b(?:math|physics|chemistry)_[a-z0-9_]+\b", lower):
        return True
    has_action = any(cue in lower for cue in action_cues)
    has_math = bool(
        re.search(
            r"(?:[=+*/^√-]|\\[A-Za-z]+|[A-Za-z]\s*[_^]?\d*)",
            joined,
        )
    )
    generic = bool(
        re.fullmatch(
            r"(?:решаем|реши|solve|шешем|шешу)\s+.{0,35}(?:уравнение|задачу|equation|problem|теңдеу)[.!]?",
            lower,
        )
    )
    return generic or not (has_action or has_math)


def _normalize_board_check_kinds(steps: list[dict[str, str]]) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    error_cues = (
        "ошиб", "невер", "неправ", "должно быть", "вместо",
        "wrong", "incorrect", "error", "should be", "instead of",
        "қате", "дұрыс емес", "болуы керек", "орнына",
    )
    ok_cues = (
        "ошибок нет", "верно", "правильно", "correct", "no errors",
        "қате жоқ", "дұрыс",
    )
    for step in steps:
        item = dict(step)
        text = item.get("text", "").lower()
        if item.get("kind") not in {"warning", "result"}:
            if any(cue in text for cue in error_cues):
                item["kind"] = "warning"
            elif any(cue in text for cue in ok_cues):
                item["kind"] = "result"
        normalized.append(item)
    return normalized


def _board_check_needs_retry(text: str, steps: list[dict[str, str]], response_locale: str) -> bool:
    if not steps:
        return True
    joined = " ".join(step.get("text", "") for step in steps).lower()
    if re.search(r"\b(?:math|physics|chemistry)_[a-z0-9_]+\b", joined):
        return True
    return not any(step.get("kind") in {"warning", "result"} for step in steps)


def _compact_board_check_steps(steps: list[dict[str, str]]) -> list[dict[str, str]]:
    if not steps:
        return []
    warning_index = next(
        (index for index, step in enumerate(steps) if step.get("kind") == "warning"),
        None,
    )
    if warning_index is not None:
        warning = dict(steps[warning_index])
        compact = [warning]
        warning_text = warning.get("text", "").strip().lower()
        already_corrects = any(
            cue in warning_text
            for cue in (
                "должно быть",
                "правильно:",
                "верно:",
                "should be",
                "correct:",
                "дұрысы",
                "болуы керек",
            )
        )
        if already_corrects:
            return compact
        for step in steps[warning_index + 1:]:
            if step.get("text", "").strip():
                compact.append(dict(step))
                break
        return compact

    result = next(
        (dict(step) for step in steps if step.get("kind") == "result"),
        None,
    )
    if result is not None:
        return [result]
    return [dict(step) for step in steps[:2]]


_NUMERIC_TOKEN_RE = re.compile(
    r"(?<![A-Za-zА-Яа-яЁё0-9_])[-+]?\d+(?:[.,]\d+)?(?:/\d+(?:[.,]\d+)?)?"
)


def _canonical_numeric_token(value: str) -> str | None:
    raw = value.strip().replace(",", ".")
    if not raw:
        return None
    try:
        if "/" in raw:
            numerator, denominator = raw.split("/", 1)
            den = Decimal(denominator)
            if den == 0:
                return raw.lstrip("+")
            number = Decimal(numerator) / den
        else:
            number = Decimal(raw)
        if number == 0:
            return "0"
        normalized = format(number.normalize(), "f")
        return normalized.rstrip("0").rstrip(".") if "." in normalized else normalized
    except (InvalidOperation, ValueError, ZeroDivisionError):
        return raw.lstrip("+")


def _numeric_tokens(text: str) -> set[str]:
    result: set[str] = set()
    for match in _NUMERIC_TOKEN_RE.finditer(text or ""):
        token = _canonical_numeric_token(match.group(0))
        if token is not None:
            result.add(token)
    return result


_ANSWER_MARKER_RE = re.compile(
    r"(?:ответ|answer|жауап)\s*[:=]\s*",
    flags=re.I,
)


def _split_problem_and_marked_answer(problem: str) -> tuple[str, str | None]:
    matches = list(_ANSWER_MARKER_RE.finditer(problem or ""))
    if not matches:
        return (problem or "").strip(), None
    marker = matches[-1]
    task = (problem or "")[:marker.start()].strip(" \n\t;,.")
    answer = (problem or "")[marker.end():].strip(" \n\t;,.")
    return task, answer or None


def _check_task_kind(problem: str, subject: Optional[str]) -> str:
    task, _answer = _split_problem_and_marked_answer(problem)
    lower = task.lower()
    subject_value = (subject or "").lower()

    if any(cue in lower for cue in ("неравен", "inequal", "теңсіз", "<", ">")):
        return "inequality"
    if any(cue in lower for cue in ("систем", "system of equations", "теңдеулер жүй")):
        return "system"
    if any(cue in lower for cue in ("област", "domain", "одз", "анықталу облысы")):
        return "domain"
    if any(cue in lower for cue in ("предел", "limit", "шек")):
        return "limit"
    if any(cue in lower for cue in ("производн", "derivative", "туынды")):
        return "derivative"
    if any(cue in lower for cue in ("интеграл", "integral", "интегралын")):
        return "integral"
    if any(cue in lower for cue in ("раскры", "expand", "жақшаны аш")):
        return "expand"
    if any(cue in lower for cue in ("упрост", "simplif", "ықшамда")):
        return "simplify"
    if any(cue in lower for cue in ("разлож", "factor", "көбейткіш")):
        return "factor"
    if any(cue in lower for cue in ("процент", "percent", "%", "пайыз")):
        return "percent"
    if any(cue in lower for cue in ("прогресс", "sequence", "последователь", "тізбек")):
        asks_sum = any(cue in lower for cue in ("сумм", "sum", "қосынды"))
        asks_nth = bool(
            re.search(r"\ba\s*[_]?[{]?\d+[}]?", lower)
            or any(cue in lower for cue in ("n-й", "n-ый", "nth", "n мүш"))
        )
        if asks_sum and asks_nth:
            return "sequence_both"
        if asks_sum:
            return "sequence_sum"
        return "sequence_nth"
    if any(cue in lower for cue in ("сочетан", "размещен", "перестанов", "factorial", "combination", "permutation", "факториал")):
        return "combinatorics"
    if any(cue in lower for cue in ("вероят", "probab", "ықтимал")):
        return "probability"
    if any(cue in lower for cue in ("медиан", "median")):
        return "statistics_median"
    if any(cue in lower for cue in ("мода", "mode")):
        return "statistics_mode"
    if any(cue in lower for cue in ("дисперс", "variance")):
        return "statistics_variance"
    if any(cue in lower for cue in ("средн", "mean", "average", "арифметическое среднее")):
        return "statistics_mean"
    if any(cue in lower for cue in ("нод", "нок", "gcd", "lcm", "простые множители", "prime factor", "делител", "divisor", "простое число")):
        return "number_theory"
    if any(cue in lower for cue in ("исследовать функцию", "исследование функции", "экстрем", "монотон", "возраст", "убыва", "critical point", "extrem", "increasing", "decreasing")):
        return "function_analysis"
    if any(cue in lower for cue in ("sin", "cos", "tan", "tg", "ctg", "тригоном", "синус", "косинус", "танген")):
        return "trig_equation" if "=" in task else "trig_value"
    if any(cue in lower for cue in ("вектор", "vector", "скаляр")):
        return "vector"
    if any(cue in lower for cue in ("моляр", "molar mass", "молярлық")):
        return "molar_mass"
    if any(cue in lower for cue in ("уравнен", "теңдеу", "equation")) and any(
        cue in lower for cue in ("расстав", "balance", "теңестір")
    ):
        return "chem_balance"
    if any(cue in lower for cue in ("перевест", "convert", "аудар")) and (
        "физ" in subject_value or "phys" in subject_value or "/" in lower
    ):
        return "unit_convert"
    if any(cue in lower for cue in (
        "геометр", "geometry", "треуг", "triangle", "окруж", "circle",
        "прямоуголь", "rectangle", "трапец", "polygon", "многоуг",
        "параллел", "ромб", "сектор", "дуг", "arc",
        "площад", "area", "периметр", "perimeter", "объём", "объем", "volume",
        "цилинд", "cylinder", "конус", "cone", "сфер", "sphere", "куб", "призм",
        "координат", "расстояние между точ", "midpoint", "пирами",
    )) or any(token in subject_value for token in ("geometry", "геом")):
        return "geometry"

    if "=" in task and re.search(r"[A-Za-z]", task):
        return "equation"

    if any(token in subject_value for token in ("math", "матем", "алгеб", "algebra")):
        return "arithmetic"
    return "unknown"


_REFERENCE_TOOLS: dict[str, set[str]] = {
    "equation": {"math_solve", "math_quadratic"},
    "system": {"math_solve_system"},
    "inequality": {"math_solve_inequalities"},
    "domain": {"math_domain"},
    "limit": {"math_limit"},
    "derivative": {"math_differentiate"},
    "integral": {"math_integrate"},
    "expand": {"math_expand"},
    "simplify": {"math_simplify"},
    "factor": {"math_factor"},
    "percent": {"math_percent"},
    "sequence_nth": {"math_sequence"},
    "sequence_sum": {"math_sequence"},
    "sequence_both": {"math_sequence"},
    "combinatorics": {"math_combinatorics"},
    "probability": {"math_probability"},
    "statistics_mean": {"math_statistics"},
    "statistics_median": {"math_statistics"},
    "statistics_mode": {"math_statistics"},
    "statistics_variance": {"math_statistics"},
    "number_theory": {"math_number_theory"},
    "function_analysis": {"math_function_analysis"},
    "trig_value": {"math_trig_value"},
    "trig_equation": {"math_solve_trig"},
    "vector": {"math_vector"},
    "geometry": {"geometry_compute"},
    "arithmetic": {"math_evaluate"},
    "unit_convert": {"physics_convert_unit"},
    "molar_mass": {"chemistry_molar_mass"},
    "chem_balance": {"chemistry_balance_equation"},
}


def _successful_tool_entries(tool_trace: list[dict]) -> list[dict]:
    return [
        entry
        for entry in tool_trace
        if isinstance(entry.get("payload"), dict) and entry["payload"].get("ok")
    ]


def _check_trace_covers_task(
    problem: str,
    subject: Optional[str],
    tool_trace: list[dict],
) -> bool:
    successful = _successful_tool_entries(tool_trace)
    if not successful:
        return False
    required = _REFERENCE_TOOLS.get(_check_task_kind(problem, subject))
    if not required:
        return True
    return any(entry.get("tool") in required for entry in successful)


def _reference_tool_entry(
    problem: str,
    subject: Optional[str],
    tool_trace: list[dict],
) -> dict | None:
    successful = _successful_tool_entries(tool_trace)
    required = _REFERENCE_TOOLS.get(_check_task_kind(problem, subject))
    if required:
        for entry in reversed(successful):
            if entry.get("tool") in required:
                return entry
        return None
    return successful[-1] if successful else None


def _strip_answer_lhs(answer: str) -> str:
    value = (answer or "").strip()
    if "=" in value:
        left, right = value.split("=", 1)
        if len(left.strip()) <= 18:
            value = right.strip()
    return value.strip(" .;")


def _pretty_reference_value(value: str) -> str:
    text = str(value or "").strip()

    # Preserve exact rational answers from SymPy (1/2, 3/8, ...). Converting
    # them to decimal here destroys the distinction between an exact school
    # answer and an approximation.
    if re.fullmatch(r"[-+]?\d+/\d+", text):
        return text

    numeric = _canonical_numeric_token(text)
    if numeric is not None and re.fullmatch(r"[-+]?\d+(?:\.\d+)?", text):
        return numeric

    text = text.replace("**", "^")
    text = re.sub(r"(?<=\d)\*(?=[A-Za-z])", "", text)
    text = text.replace("*", "·")
    return text


def _pretty_inequality_text(value: str, variable: str = "x") -> str:
    text = str(value or "").strip()
    escaped = re.escape(variable)
    patterns = [
        (rf"^\((.+) < {escaped}\) & \({escaped} < oo\)$", lambda m: f"{variable} > {m.group(1)}"),
        (rf"^\((.+) <= {escaped}\) & \({escaped} < oo\)$", lambda m: f"{variable} >= {m.group(1)}"),
        (rf"^\(-oo < {escaped}\) & \({escaped} < (.+)\)$", lambda m: f"{variable} < {m.group(1)}"),
        (rf"^\(-oo < {escaped}\) & \({escaped} <= (.+)\)$", lambda m: f"{variable} <= {m.group(1)}"),
        (rf"^\((.+) < {escaped}\) & \({escaped} < (.+)\)$", lambda m: f"{m.group(1)} < {variable} < {m.group(2)}"),
        (rf"^\((.+) <= {escaped}\) & \({escaped} <= (.+)\)$", lambda m: f"{m.group(1)} <= {variable} <= {m.group(2)}"),
    ]
    for pattern, render in patterns:
        match = re.match(pattern, text)
        if match:
            return render(match)
    return _pretty_reference_value(text)


def _problem_has_intermediate_work(problem: str) -> bool:
    task, answer = _split_problem_and_marked_answer(problem)
    if not answer:
        return False
    return "\n" in task or ";" in task


def _geometry_reference_key(problem: str, result: dict) -> str | None:
    lower = (problem or "").lower()
    preferences = [
        (("объём", "объем", "volume"), ("volume",)),
        (("площадь поверхности", "surface area"), ("surface_area",)),
        (("боков", "lateral"), ("lateral_area",)),
        (("площад", "area"), ("area", "surface_area")),
        (("периметр", "perimeter"), ("perimeter",)),
        (("длина окруж", "circumference"), ("circumference",)),
        (("дуг", "arc"), ("arc_length",)),
        (("диагон", "diagonal"), ("space_diagonal", "diagonal")),
        (("гипотен", "hypotenuse"), ("hypotenuse",)),
        (("сторон", "side"), ("side", "third_side")),
        (("расстоя", "distance"), ("distance",)),
        (("наклон", "slope"), ("slope",)),
        (("радиус", "radius"), ("radius",)),
        (("диаметр", "diameter"), ("diameter",)),
    ]
    for cues, keys in preferences:
        if any(cue in lower for cue in cues):
            for key in keys:
                if key in result:
                    return key
    computed = [
        key
        for key, value in result.items()
        if key != "kind" and isinstance(value, dict) and "text" in value
    ]
    return computed[0] if len(computed) == 1 else None


def _math_item_reference(item: Any) -> dict | None:
    if isinstance(item, dict):
        value = str(item.get("text", "")).strip()
        if value:
            return {
                "kind": "expression",
                "value": value,
                "display": _pretty_reference_value(value),
            }
    return None


def _reference_answer_from_trace(
    problem: str,
    subject: Optional[str],
    tool_trace: list[dict],
) -> dict | None:
    entry = _reference_tool_entry(problem, subject, tool_trace)
    if not entry:
        return None
    tool = entry.get("tool")
    payload = entry.get("payload") or {}
    result = payload.get("result")
    if not isinstance(result, dict):
        return None
    task_kind = _check_task_kind(problem, subject)

    if tool == "math_solve":
        solutions = [
            str(item.get("text", "")).strip()
            for item in result.get("solutions", [])
            if isinstance(item, dict) and str(item.get("text", "")).strip()
        ]
        return {
            "kind": "solution_set",
            "values": solutions,
            "display": ", ".join(_pretty_reference_value(value) for value in solutions) if solutions else "нет решений",
        }

    if tool == "math_quadratic":
        roots = result.get("real_roots") or []
        solutions = [
            str(item.get("text", "")).strip()
            for item in roots
            if isinstance(item, dict) and str(item.get("text", "")).strip()
        ]
        if not result.get("has_real_roots"):
            return {
                "kind": "no_real_roots",
                "values": [],
                "display": "действительных корней нет",
            }
        return {
            "kind": "solution_set",
            "values": solutions,
            "display": ", ".join(_pretty_reference_value(value) for value in solutions),
        }

    if tool == "math_solve_system":
        solutions = result.get("solutions") or []
        if not solutions:
            return {"kind": "text", "value": "нет решений", "display": "нет решений"}
        first = solutions[0]
        if isinstance(first, dict):
            pairs = []
            for variable in result.get("variables", []):
                item = first.get(variable)
                if isinstance(item, dict) and str(item.get("text", "")).strip():
                    pairs.append(f"{variable}={_pretty_reference_value(str(item['text']))}")
            if pairs:
                value = ", ".join(pairs)
                return {"kind": "system_solution", "value": value, "display": value}

    if tool == "math_solve_inequalities":
        item = result.get("result")
        if isinstance(item, dict) and str(item.get("text", "")).strip():
            value = str(item["text"]).strip()
            return {
                "kind": "inequality",
                "value": value,
                "variable": str(result.get("variable", "x")),
                "display": _pretty_inequality_text(
                    value,
                    str(result.get("variable", "x")),
                ),
            }

    if tool == "math_domain":
        return _math_item_reference(result.get("domain"))

    if tool == "math_limit":
        return _math_item_reference(result.get("result"))

    if tool == "math_percent":
        value = result.get("result")
        if value is not None:
            return {
                "kind": "numeric",
                "value": str(value),
                "display": _pretty_reference_value(str(value)),
            }

    if tool == "math_sequence":
        if task_kind == "sequence_both":
            nth = result.get("nth")
            total = result.get("sum_n")
            if isinstance(nth, dict) and isinstance(total, dict):
                n = result.get("n")
                nth_text = _pretty_reference_value(str(nth.get("text", "")))
                sum_text = _pretty_reference_value(str(total.get("text", "")))
                display = f"a_{n}={nth_text}, S_{n}={sum_text}"
                return {"kind": "text", "value": display, "display": display}
        key = "sum_n" if task_kind == "sequence_sum" else "nth"
        return _math_item_reference(result.get(key))

    if tool in {"math_combinatorics", "math_probability", "math_trig_value"}:
        return _math_item_reference(result.get("result"))

    if tool == "math_statistics":
        key = {
            "statistics_mean": "mean",
            "statistics_median": "median",
            "statistics_variance": "variance_population",
        }.get(task_kind)
        if key:
            return _math_item_reference(result.get(key))
        if task_kind == "statistics_mode":
            modes = [
                str(item.get("text", "")).strip()
                for item in result.get("modes", [])
                if isinstance(item, dict) and str(item.get("text", "")).strip()
            ]
            if modes:
                value = ", ".join(modes)
                return {"kind": "solution_set", "values": modes, "display": value}

    if tool == "math_solve_trig":
        item = result.get("solution")
        if isinstance(item, dict) and str(item.get("text", "")).strip():
            value = str(item["text"]).strip()
            return {"kind": "text", "value": value, "display": _pretty_reference_value(value)}

    if tool == "math_number_theory":
        operation = str(result.get("operation", "")).strip()
        if "result" in result and isinstance(result.get("result"), (int, float)):
            value = str(result["result"])
            return {
                "kind": "numeric",
                "value": value,
                "display": _pretty_reference_value(value),
            }
        if operation == "prime_factors" and isinstance(result.get("factors"), dict):
            parts = []
            for prime, exponent in sorted(result["factors"].items(), key=lambda item: int(item[0])):
                parts.append(str(prime) if int(exponent) == 1 else f"{prime}^{exponent}")
            value = " · ".join(parts)
            return {"kind": "text", "value": value, "display": value}
        if operation == "divisors" and isinstance(result.get("divisors"), list):
            value = ", ".join(str(item) for item in result["divisors"])
            return {"kind": "text", "value": value, "display": value}

    if tool == "math_vector":
        item = result.get("result")
        if isinstance(item, dict):
            return _math_item_reference(item)
        if isinstance(item, list):
            values = [
                _pretty_reference_value(str(part.get("text", "")))
                for part in item
                if isinstance(part, dict) and str(part.get("text", "")).strip()
            ]
            if values:
                value = "(" + ", ".join(values) + ")"
                return {"kind": "text", "value": value, "display": value}

    if tool == "geometry_compute":
        key = _geometry_reference_key(problem, result)
        if key:
            return _math_item_reference(result.get(key))

    if tool in {
        "math_evaluate",
        "math_simplify",
        "math_factor",
        "math_expand",
        "math_differentiate",
        "math_integrate",
    }:
        item = result.get("result")
        if isinstance(item, dict):
            value = str(item.get("text", "")).strip()
            if value:
                return {
                    "kind": "expression",
                    "value": value,
                    "display": _pretty_reference_value(value),
                }

    if tool == "physics_convert_unit":
        value = result.get("result")
        if value is not None:
            to_unit = str(result.get("to_unit", "")).strip()
            pretty_value = _pretty_reference_value(str(value))
            return {
                "kind": "numeric",
                "value": str(value),
                "display": f"{pretty_value} {to_unit}".strip(),
            }

    if tool == "chemistry_molar_mass":
        value = result.get("molar_mass_g_mol")
        if value is not None:
            return {
                "kind": "numeric",
                "value": str(value),
                "display": f"{value} g/mol",
            }

    if tool == "chemistry_balance_equation":
        value = str(result.get("balanced", "")).strip()
        if value:
            return {
                "kind": "text",
                "value": value,
                "display": value,
            }

    return None


_NO_REAL_ROOT_CUES = (
    "нет действительных корней",
    "действительных корней нет",
    "no real roots",
    "has no real roots",
    "нақты түбір жоқ",
    "нақты түбірлер жоқ",
)


def _marked_answer_verdict(
    problem: str,
    subject: Optional[str],
    tool_trace: list[dict],
) -> dict | None:
    _task, answer = _split_problem_and_marked_answer(problem)
    if not answer:
        return None
    reference = _reference_answer_from_trace(problem, subject, tool_trace)
    if not reference:
        return None

    actual = answer.strip()
    actual_rhs = _strip_answer_lhs(actual)
    kind = reference["kind"]
    correct: bool | None = None

    if kind == "no_real_roots":
        lower = actual.lower()
        correct = any(cue in lower for cue in _NO_REAL_ROOT_CUES)
    elif kind == "solution_set":
        expected_tokens = {
            token
            for value in reference["values"]
            for token in _numeric_tokens(value)
        }
        actual_tokens = _numeric_tokens(actual_rhs)
        if expected_tokens or actual_tokens:
            correct = actual_tokens == expected_tokens
    elif kind == "numeric":
        expected_tokens = _numeric_tokens(reference["value"])
        actual_tokens = _numeric_tokens(actual_rhs)
        if expected_tokens and actual_tokens:
            correct = actual_tokens == expected_tokens
    elif kind == "system_solution":
        expected_pairs = {
            name: value
            for name, value in re.findall(
                r"([A-Za-z][A-Za-z0-9]*)\s*=\s*([^,;\s]+)",
                str(reference["value"]),
            )
        }
        actual_pairs = {
            name: value
            for name, value in re.findall(
                r"([A-Za-z][A-Za-z0-9]*)\s*=\s*([^,;\s]+)",
                actual,
            )
        }
        if expected_pairs and set(expected_pairs) == set(actual_pairs):
            checks = []
            for name, expected_value in expected_pairs.items():
                try:
                    comparison = execute_tool(
                        "math_equivalent",
                        {
                            "expression_a": expected_value,
                            "expression_b": actual_pairs[name],
                        },
                    )
                    checks.append(bool((comparison.get("result") or {}).get("equivalent")))
                except Exception:
                    checks.append(False)
            correct = all(checks)
    elif kind == "inequality":
        try:
            comparison = execute_tool(
                "math_solve_inequalities",
                {
                    "inequalities": [actual_rhs],
                    "variable": reference.get("variable", "x"),
                },
            )
            compared_result = ((comparison.get("result") or {}).get("result") or {}).get("text")
            correct = str(compared_result).strip() == str(reference["value"]).strip()
        except Exception:
            correct = False
    elif kind == "expression":
        expected = str(reference["value"]).strip()
        candidate = actual_rhs
        try:
            comparison = execute_tool(
                "math_equivalent",
                {"expression_a": expected, "expression_b": candidate},
            )
            correct = bool((comparison.get("result") or {}).get("equivalent"))
        except Exception:
            expected_tokens = _numeric_tokens(expected)
            actual_tokens = _numeric_tokens(candidate)
            if expected_tokens and actual_tokens:
                correct = actual_tokens == expected_tokens
    elif kind == "text":
        normalized_expected = re.sub(r"\s+", "", str(reference["value"])).lower()
        normalized_actual = re.sub(r"\s+", "", actual).lower().replace("→", "->")
        correct = normalized_actual == normalized_expected

    if correct is None:
        return None
    return {
        "correct": correct,
        "actual": actual,
        "expected": reference["display"],
        "kind": kind,
    }


def _tool_result_numeric_facts(tool_trace: list[dict]) -> set[str]:
    facts: set[str] = set()
    for entry in tool_trace:
        payload = entry.get("payload")
        if not isinstance(payload, dict) or not payload.get("ok"):
            continue
        result = payload.get("result")
        facts.update(_numeric_tokens(json.dumps(result, ensure_ascii=False)))
    return facts


def _board_check_conflicts_with_tools(
    steps: list[dict[str, str]],
    tool_trace: list[dict],
) -> bool:
    facts = _tool_result_numeric_facts(tool_trace)
    if not facts:
        return False
    for step in steps:
        if step.get("kind") != "result":
            continue
        claims = _numeric_tokens(step.get("text", ""))
        if claims and not claims.issubset(facts):
            return True
    return False


def _verify_board_check_against_tools(
    client,
    *,
    problem: str,
    candidate_text: str,
    candidate_steps: list[dict[str, str]],
    tool_trace: list[dict],
    response_locale: str,
) -> tuple[str, list[dict[str, str]]]:
    verified_trace = [
        {
            "tool": entry.get("tool"),
            "arguments": entry.get("arguments"),
            "result": (entry.get("payload") or {}).get("result"),
        }
        for entry in tool_trace
        if isinstance(entry.get("payload"), dict) and entry["payload"].get("ok")
    ]
    language_rule = _response_language_rule(response_locale)
    score_label = {
        "ru": "Выполнено",
        "kk": "Орындалды",
        "en": "Completed",
    }.get(response_locale, "Выполнено")
    verifier_sys = (
        f"{language_rule} "
        "Ты проверяешь уже выполненную AI-проверку школьной работы. "
        "Результаты вычислительных tools ниже являются авторитетными фактами: не пересчитывай их и не противоречь им. "
        "Сравни запись ученика и черновик проверки с этими фактами. "
        "Верни ТОЛЬКО JSON формата "
        '{"summary":"' + score_label + ': NN%","steps":['
        '{"text":"первая ошибка или подтверждение","kind":"warning|result|math"}]}. '
        "Если в черновике или работе ученика есть числовое утверждение, противоречащее фактам tools, "
        "обязательно пометь его как warning и коротко укажи проверенное значение. "
        "Не упоминай внутренние имена tools/API. Для школьной алгебры не переходи к комплексным числам без явного требования."
    )
    verifier_user = (
        "Запись на доске:\n"
        + problem.strip()
        + "\n\nАвторитетные результаты tools:\n"
        + json.dumps(verified_trace, ensure_ascii=False)[:8000]
        + "\n\nЧерновик проверки:\n"
        + candidate_text[:5000]
        + "\n\nParsed steps:\n"
        + json.dumps(candidate_steps, ensure_ascii=False)[:5000]
    )
    response = client.chat.completions.create(
        model=settings.ai_model,
        messages=[
            {"role": "system", "content": verifier_sys},
            {"role": "user", "content": verifier_user},
        ],
        max_tokens=900,
    )
    message = response.choices[0].message
    raw = (getattr(message, "content", None) or "").strip()
    text, steps = _parse_board_solution(raw)
    text, steps = _sanitize_board_language(text, steps, response_locale)
    steps = _normalize_board_check_kinds(steps)
    return text, steps


def generate_board_response(
    mode: str,
    problem: str,
    *,
    subject: Optional[str] = None,
    board_context: bool = True,
    response_locale: str = "ru",
) -> tuple[str, list[dict[str, str]]]:
    if mode == "solution":
        return generate_board_solution(
            problem,
            subject=subject,
            board_context=board_context,
            response_locale=response_locale,
        )
    if mode not in {"hint", "check"}:
        raise ValueError(f"Unsupported board AI mode: {mode}")

    api_key = get_openai_key()
    base_url = settings.ai_base_url
    if not base_url:
        text = generate_ai_response(
            mode,
            problem,
            subject=subject,
            board_context=board_context,
            response_locale=response_locale,
        )
        steps = [{"text": text, "kind": "text"}] if text else []
        return _sanitize_board_language(text, steps, response_locale)

    sys, user, max_tokens = _build_prompt(
        mode,
        problem,
        None,
        None,
        False,
        subject,
        board_context,
        response_locale,
    )
    language_rule = _response_language_rule(response_locale)
    simple_marked_check = False
    reference_tool_names: set[str] = set()
    score_label = {
        "ru": "Выполнено",
        "kk": "Орындалды",
        "en": "Completed",
    }.get(response_locale, "Выполнено")

    if mode == "hint":
        sys += (
            f"\n{language_rule} "
            "Ответ будет написан прямо на доске рядом с работой ученика. "
            "Верни ТОЛЬКО валидный JSON без markdown-обертки. "
            "Формат: {\"summary\":\"кратко\",\"steps\":["
            "{\"text\":\"подсказка\",\"kind\":\"text|math|warning\"}]}. "
            "Дай 1-3 очень коротких шага. Не переписывай условие. "
            "Не раскрывай конечный ответ и не выполняй последний решающий шаг за ученика. "
            "Предпочитай формулу или короткую фразу длинному объяснению. "
            "Не упоминай tools, функции, API или внутренние названия инструментов в тексте для ученика. "
            "Для формул используй LaTeX в $$...$$."
        )
    else:
        task_kind = _check_task_kind(problem, subject)
        reference_tools = sorted(_REFERENCE_TOOLS.get(task_kind, set()))
        reference_tool_names = set(reference_tools)
        _task_text, marked_answer = _split_problem_and_marked_answer(problem)
        simple_marked_check = bool(
            marked_answer
            and not _problem_has_intermediate_work(problem)
            and reference_tool_names
        )
        reference_tool_rule = (
            " Для этого типа задания эталон должен быть получен через один из инструментов: "
            + ", ".join(reference_tools)
            + "."
            if reference_tools
            else ""
        )
        sys += (
            f"\n{language_rule} "
            "Ответ будет написан прямо на доске рядом с работой ученика. "
            "Верни ТОЛЬКО валидный JSON без markdown-обертки. "
            "Формат: {\"summary\":\"" + score_label + ": NN%\",\"steps\":["
            "{\"text\":\"короткая проверка\",\"kind\":\"text|math|warning|result\"}]}. "
            "Если есть ошибка, укажи первую конкретную ошибку короткой строкой с kind=warning, "
            "затем при необходимости одной строкой покажи корректный вариант. "
            "Если ошибок нет, дай одну короткую строку с kind=result. "
            "Для проверки сначала получи независимый эталон из ИСХОДНОГО условия через подходящий tool; "
            "не ограничивайся вычислением уже записанного учеником выражения, потому что оно само может быть ошибочным. "
            + reference_tool_rule
            + " Если в записи есть явный «Ответ:», ОБЯЗАТЕЛЬНО сравни его с эталонным результатом tool. "
            "После первой найденной ошибки и одной корректирующей строки остановись. "
            "В школьной алгебре, если D<0 и комплексные числа не требуются условием, "
            "не пиши комплексные корни: достаточно указать, что действительных корней нет. "
            "Не переписывай всё решение и не давай длинное объяснение. "
            "Не упоминай tools, функции, API или внутренние названия инструментов в тексте для ученика. "
            f"summary ОБЯЗАТЕЛЬНО должен быть ровно формата {score_label}: NN%. "
            "Для формул используй LaTeX в $$...$$."
        )

    client_options = {
        "api_key": api_key or "ollama",
        "timeout": settings.ai_timeout_seconds,
    }
    if base_url:
        client_options["base_url"] = base_url
    client = OpenAI(**client_options)
    tool_trace: list[dict] = []
    raw = _local_chat_with_tools(
        client,
        sys=sys,
        user=user,
        max_tokens=min(max_tokens, 900 if mode == "hint" else 1200),
        subject=subject,
        task_text=problem,
        postprocess=False,
        require_tool=_requires_tool_use(subject, mode),
        tool_trace=tool_trace,
        return_after_tool_names=reference_tool_names if simple_marked_check else None,
        only_tool_names=reference_tool_names if simple_marked_check else None,
    )

    if simple_marked_check and _check_trace_covers_task(problem, subject, tool_trace):
        fast_verdict = _marked_answer_verdict(problem, subject, tool_trace)
        if fast_verdict is not None:
            if fast_verdict["correct"]:
                messages = {
                    "ru": "Ответ верный.",
                    "kk": "Жауап дұрыс.",
                    "en": "The answer is correct.",
                }
                result_text = messages.get(response_locale, messages["ru"])
                return result_text, [{"text": result_text, "kind": "result"}]
            messages = {
                "ru": "Ответ неверный: у тебя {actual}, должно быть {expected}.",
                "kk": "Жауап қате: сенде {actual}, дұрысы {expected}.",
                "en": "The answer is incorrect: you wrote {actual}, but it should be {expected}.",
            }
            result_text = messages.get(response_locale, messages["ru"]).format(
                actual=fast_verdict["actual"],
                expected=fast_verdict["expected"],
            )
            return result_text, [{"text": result_text, "kind": "warning"}]

    text, steps = _parse_board_solution(raw)
    text, steps = _sanitize_board_language(text, steps, response_locale)
    if mode == "check":
        steps = _normalize_board_check_kinds(steps)

    needs_retry = (
        _board_hint_needs_retry(steps, response_locale)
        if mode == "hint"
        else (
            _board_check_needs_retry(text, steps, response_locale)
            or not _check_trace_covers_task(problem, subject, tool_trace)
        )
    )
    if needs_retry:
        if mode == "hint":
            retry_sys = (
                sys
                + "\nПредыдущая подсказка получилась слишком общей. "
                + "Назови ОДНО конкретное следующее действие или формулу, которую ученик должен применить. "
                + "Не пиши общие фразы вроде «решаем уравнение» и не раскрывай конечный ответ."
            )
        else:
            retry_sys = (
                sys
                + "\nПредыдущая проверка ненадёжна. Перепроверь работу с нуля. "
                + "Сначала выбери reference-tool, который решает ИСХОДНОЕ задание, а не просто считает выражение из ответа ученика. "
                + "Для уравнения используй math_solve или math_quadratic; для производной math_differentiate; "
                + "для интеграла math_integrate; для раскрытия скобок math_expand; для перевода единиц physics_convert_unit. "
                + "Числовые и символические ответы ученика обязательно сверяй с фактическим результатом reference-tool. "
                + "Если значение ученика отличается от результата инструмента, это и есть ошибка: "
                + "первый такой шаг верни с kind=warning и покажи правильное значение. "
                + "Не называй неверное вычисление верным. Не переходи к комплексным числам, если их не требует условие."
            )
        retry_user = (
            user
            + "\n\nТвой предыдущий черновик:\n"
            + raw[:6000]
            + "\n\nВерни исправленный JSON."
        )
        retry_raw = _local_chat_with_tools(
            client,
            sys=retry_sys,
            user=retry_user,
            max_tokens=min(max_tokens, 900 if mode == "hint" else 1200),
            subject=subject,
            task_text=problem,
            postprocess=False,
            require_tool=_requires_tool_use(subject, mode),
            tool_trace=tool_trace,
            only_tool_names=reference_tool_names if simple_marked_check else None,
        )
        retry_text, retry_steps = _parse_board_solution(retry_raw)
        retry_text, retry_steps = _sanitize_board_language(
            retry_text,
            retry_steps,
            response_locale,
        )
        if mode == "check":
            retry_steps = _normalize_board_check_kinds(retry_steps)
        retry_bad = (
            _board_hint_needs_retry(retry_steps, response_locale)
            if mode == "hint"
            else (
                _board_check_needs_retry(retry_text, retry_steps, response_locale)
                or not _check_trace_covers_task(problem, subject, tool_trace)
            )
        )
        if retry_bad:
            fallback_messages = {
                "hint": {
                    "ru": "Определи следующий промежуточный шаг и выбери подходящую формулу.",
                    "kk": "Келесі аралық қадамды анықтап, сәйкес формуланы таңда.",
                    "en": "Identify the next intermediate step and choose the appropriate formula.",
                },
                "check": {
                    "ru": "Не удалось надёжно определить ошибку. Проверь запись условия и промежуточные вычисления.",
                    "kk": "Қатені сенімді анықтау мүмкін болмады. Шарт пен аралық есептеулерді тексер.",
                    "en": "The error could not be determined reliably. Check the problem statement and intermediate calculations.",
                },
            }
            fallback = fallback_messages[mode].get(
                response_locale,
                fallback_messages[mode]["ru"],
            )
            text = fallback
            steps = [{
                "text": fallback,
                "kind": "warning" if mode == "check" else "text",
            }]
        else:
            text, steps = retry_text, retry_steps

    deterministic_answer_verdict = (
        _marked_answer_verdict(problem, subject, tool_trace)
        if mode == "check" and not _problem_has_intermediate_work(problem)
        else None
    )

    if (
        mode == "check"
        and deterministic_answer_verdict is None
        and any(
            isinstance(entry.get("payload"), dict) and entry["payload"].get("ok")
            for entry in tool_trace
        )
    ):
        verified_text, verified_steps = _verify_board_check_against_tools(
            client,
            problem=problem,
            candidate_text=text,
            candidate_steps=steps,
            tool_trace=tool_trace,
            response_locale=response_locale,
        )
        verifier_bad = (
            _board_check_needs_retry(verified_text, verified_steps, response_locale)
            or _board_check_conflicts_with_tools(verified_steps, tool_trace)
        )
        if verifier_bad:
            if any(step.get("kind") == "warning" for step in steps):
                # The first pass found an explicit error; keep that safer diagnosis
                # instead of replacing it with an unreliable verifier response.
                pass
            else:
                fallback = {
                    "ru": "Не удалось надёжно локализовать ошибку. Сверь промежуточное вычисление с проверенным результатом.",
                    "kk": "Қатені нақты анықтау мүмкін болмады. Аралық есептеуді тексерілген нәтижемен салыстыр.",
                    "en": "The exact error could not be located reliably. Compare the intermediate calculation with the verified result.",
                }.get(
                    response_locale,
                    "Не удалось надёжно локализовать ошибку. Сверь промежуточное вычисление с проверенным результатом.",
                )
                text = fallback
                steps = [{"text": fallback, "kind": "warning"}]
        else:
            text, steps = verified_text, verified_steps

    if mode == "check":
        answer_verdict = (
            deterministic_answer_verdict
            if deterministic_answer_verdict is not None
            else _marked_answer_verdict(problem, subject, tool_trace)
        )
        if answer_verdict is not None and not answer_verdict["correct"]:
            messages = {
                "ru": "Ответ неверный: у тебя {actual}, должно быть {expected}.",
                "kk": "Жауап қате: сенде {actual}, дұрысы {expected}.",
                "en": "The answer is incorrect: you wrote {actual}, but it should be {expected}.",
            }
            warning = messages.get(response_locale, messages["ru"]).format(
                actual=answer_verdict["actual"],
                expected=answer_verdict["expected"],
            )
            text = warning
            steps = [{"text": warning, "kind": "warning"}]
        elif (
            answer_verdict is not None
            and answer_verdict["correct"]
            and not _problem_has_intermediate_work(problem)
        ):
            correct_messages = {
                "ru": "Ответ верный.",
                "kk": "Жауап дұрыс.",
                "en": "The answer is correct.",
            }
            confirmed = correct_messages.get(response_locale, correct_messages["ru"])
            text = confirmed
            steps = [{"text": confirmed, "kind": "result"}]

    if mode == "hint":
        text = "\n".join(
            f"{index + 1}. {step['text']}"
            for index, step in enumerate(steps)
        )
    elif mode == "check":
        steps = _compact_board_check_steps(steps)
        score_patterns = {
            "ru": r"Выполнено\s*:\s*(\d{1,3})%",
            "kk": r"Орындалды\s*:\s*(\d{1,3})%",
            "en": r"Completed\s*:\s*(\d{1,3})%",
        }
        score_match = re.search(
            score_patterns.get(response_locale, score_patterns["ru"]),
            text,
            flags=re.I,
        )
        score_line = score_match.group(0) if score_match else ""
        if score_match and any(step.get("kind") == "warning" for step in steps):
            score_value = int(score_match.group(1))
            if score_value >= 95:
                score_line = ""
        body = "\n".join(
            f"{index + 1}. {step['text']}"
            for index, step in enumerate(steps)
        )
        text = "\n\n".join(part for part in (score_line, body) if part)

    return text, steps


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
        "Для неравенств: знак неравенства меняется ТОЛЬКО при умножении или делении обеих частей на отрицательное число; "
        "обычный перенос слагаемого или прибавление/вычитание одного и того же числа знак не меняет. "
        "Если дискриминант D < 0, пиши кратко: действительных корней нет; не переходи к комплексным корням. "
        "Не смешивай язык ответа с английскими математическими словами: используй терминологию выбранного языка UI. "
        "Никогда не упоминай ученику tools, API, backend или то, что вычисления выполнялись инструментом. "
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
    tool_trace: list[dict] = []
    raw = _local_chat_with_tools(
        client,
        sys=sys,
        user=user,
        max_tokens=max_tokens,
        subject=subject,
        task_text=problem,
        postprocess=False,
        require_tool=_requires_tool_use(subject, "solution"),
        tool_trace=tool_trace,
    )
    text, steps = _parse_board_solution(raw)
    text, steps = _sanitize_board_language(text, steps, response_locale)
    steps = _strip_repeated_problem_steps(steps, problem)
    steps = _normalize_board_result_tail(steps, response_locale)
    verified_reference = _reference_answer_from_trace(problem, subject, tool_trace)
    steps = _enforce_verified_board_result(steps, verified_reference)
    if steps:
        text = "\n".join(
            f"{index + 1}. {step['text']}"
            for index, step in enumerate(steps)
        )

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
            task_text=problem,
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
