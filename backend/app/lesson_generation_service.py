from __future__ import annotations

import importlib.util
import json
import logging
import random
import re
import time
import os
from pathlib import Path
from typing import Any, Callable, Literal

from pydantic import BaseModel, Field, model_validator

from .lesson_generation_contract import GeneratedLesson, resolved_lesson_payload
from .settings import ROOT_DIR, get_openai_key, settings
from .textbook_library import list_textbooks, search_context

logger = logging.getLogger("lesson-generation")
ML_ROOT = ROOT_DIR / "ml"
# Overridable so several servers on one machine keep their own textbooks.
ML_DATA_ROOT = Path(os.environ["MATRIX_ML_DATA_DIR"]) if os.environ.get("MATRIX_ML_DATA_DIR") else ML_ROOT / "data"

_SUPERSCRIPT = str.maketrans("0123456789+-", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻")
_SUBSCRIPT = str.maketrans("0123456789+-", "₀₁₂₃₄₅₆₇₈₉₊₋")
_LATEX_SYMBOLS = {
    r"\cdot": "·",
    r"\times": "×",
    r"\leq": "≤",
    r"\le": "≤",
    r"\geq": "≥",
    r"\ge": "≥",
    r"\neq": "≠",
    r"\approx": "≈",
    r"\sim": "∼",
    r"\rightarrow": "→",
    r"\to": "→",
    r"\pi": "π",
    r"\alpha": "α",
    r"\beta": "β",
    r"\gamma": "γ",
    r"\delta": "δ",
    r"\theta": "θ",
    r"\lambda": "λ",
    r"\mu": "μ",
    r"\omega": "ω",
    r"\Omega": "Ω",
    r"\Phi": "Φ",
    r"\phi": "φ",
    r"\sin": "sin",
    r"\cos": "cos",
    r"\tan": "tan",
    r"\tg": "tg",
    r"\cot": "cot",
    r"\ctg": "ctg",
    r"\ln": "ln",
    r"\log": "log",
    r"\exp": "exp",
    r"\int": "∫",
    r"\infty": "∞",
    r"\pm": "±",
    r"\mp": "∓",
    r"\degree": "°",
}


def _visible_text(value: Any) -> str:
    """Normalize common model LaTeX into the Unicode-only Smartboard contract."""
    text = str(value or "").strip().replace("$", "")
    for source, replacement in _LATEX_SYMBOLS.items():
        text = text.replace(source, replacement)
    for _ in range(2):
        text = re.sub(r"\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}", r"(\1)/(\2)", text)
        text = re.sub(r"\\sqrt\s*\{([^{}]+)\}", r"√(\1)", text)
    text = re.sub(
        r"\^\s*\{?([0-9+-]+)\}?",
        lambda match: match.group(1).translate(_SUPERSCRIPT),
        text,
    )
    text = re.sub(
        r"_\s*\{?([0-9+-]+)\}?",
        lambda match: match.group(1).translate(_SUBSCRIPT),
        text,
    )
    # Keep symbolic powers/subscripts readable without leaving LaTeX braces behind.
    # The strict contract rejects x^{n}/a_n, while x^(n)/a_(n) is plain text math.
    text = re.sub(r"\^\s*\{([^{}]+)\}", r"^(\1)", text)
    text = re.sub(r"_\s*\{([^{}]+)\}", r"_(\1)", text)
    text = re.sub(r"\\(?:mathrm|text|mathbf|mathit|operatorname)\s*\{([^{}]+)\}", r"\1", text)
    text = re.sub(r"\\(?:left|right)\b", "", text)
    text = re.sub(r"\\[A-Za-z]+", "", text)
    text = text.replace("{", "").replace("}", "").replace("\\", "")
    return re.sub(r"[ \t]+", " ", text).strip()


_MATH_SEGMENT_RE = re.compile(
    r"(?:\$\$(?P<dd>.*?)\$\$|\\\[(?P<br>.*?)\\\]|\\\((?P<par>.*?)\\\)|(?<!\$)\$(?!\$)(?P<dol>.*?)(?<!\$)\$(?!\$))",
    re.DOTALL,
)


def _repair_latex(value: Any) -> str:
    """Repair common small-model LaTeX damage while keeping semantic math."""
    latex = str(value or "").strip()
    for open_delim, close_delim in (("$$", "$$"), (r"\[", r"\]"), (r"\(", r"\)"), ("$", "$")):
        if latex.startswith(open_delim) and latex.endswith(close_delim) and len(latex) >= len(open_delim) + len(close_delim):
            latex = latex[len(open_delim) : -len(close_delim)].strip()
            break

    replacements = {
        r"\dfrac": r"\frac",
        r"\tfrac": r"\frac",
        r"\tg": r"\tan",
        r"\ctg": r"\cot",
        r"\le ": r"\leq ",
        r"\ge ": r"\geq ",
        "\u00a0": " ",
    }
    for source, replacement in replacements.items():
        latex = latex.replace(source, replacement)

    latex = latex.replace("\r", " ").replace("\n", " ")
    latex = re.sub(r"\s+", " ", latex).strip()
    while latex.count("}") > latex.count("{") and "}" in latex:
        pos = latex.rfind("}")
        latex = latex[:pos] + latex[pos + 1 :]
    if latex.count("{") > latex.count("}"):
        latex += "}" * (latex.count("{") - latex.count("}"))
    return latex.strip()


def _latex_fallback(latex: str) -> str:
    """Readable plain-text fallback for export or a failed KaTeX render."""
    return _visible_text(latex).replace(r"\,", "").strip() or latex.strip()


def _normalize_rich_text(value: Any) -> str:
    """Keep delimited math for MathText; sanitize everything outside it."""
    source = str(value or "").strip()
    if not source:
        return ""

    parts: list[str] = []
    cursor = 0
    for match in _MATH_SEGMENT_RE.finditer(source):
        if match.start() > cursor:
            plain = _visible_text(source[cursor : match.start()])
            if plain:
                parts.append(plain)
        raw = next((group for group in match.groups() if group is not None), "")
        repaired = _repair_latex(raw)
        if repaired:
            display = match.group("dd") is not None or match.group("br") is not None
            parts.append((r"\[" + repaired + r"\]") if display else (r"\(" + repaired + r"\)"))
        cursor = match.end()

    if cursor < len(source):
        tail = _visible_text(source[cursor:])
        if tail:
            parts.append(tail)

    if not parts:
        return _visible_text(source)
    return " ".join(part for part in parts if part).strip()


def _rich_to_plain(value: Any) -> str:
    source = _normalize_rich_text(value)
    cursor = 0
    parts: list[str] = []
    for match in _MATH_SEGMENT_RE.finditer(source):
        if match.start() > cursor:
            parts.append(source[cursor : match.start()])
        raw = next((group for group in match.groups() if group is not None), "")
        parts.append(_latex_fallback(_repair_latex(raw)))
        cursor = match.end()
    parts.append(source[cursor:])
    return re.sub(r"\s+", " ", "".join(parts)).strip()


def _math_parts(value: str) -> tuple[str, list[str]]:
    """Return prose and formulas from normalized rich text."""
    source = _normalize_rich_text(value)
    formulas: list[str] = []
    prose_parts: list[str] = []
    cursor = 0
    for match in _MATH_SEGMENT_RE.finditer(source):
        if match.start() > cursor:
            prose_parts.append(source[cursor : match.start()])
        raw = next((group for group in match.groups() if group is not None), "")
        repaired = _repair_latex(raw)
        if repaired:
            formulas.append(repaired)
        cursor = match.end()
    prose_parts.append(source[cursor:])
    prose = re.sub(r"\s+", " ", " ".join(prose_parts)).strip(" •")
    return prose, formulas


SYSTEM = {
    "ru": "Ты помощник школьного учителя. Используй только данный материал, не выдумывай факты. Обычный текст пиши обычным текстом. Математические формулы записывай LaTeX и обязательно заключай в \\(...\\) для inline или \\[...\\] для отдельной формулы. Не оставляй LaTeX-команды вне этих разделителей.",
    "kk": "Сен мектеп мұғалімінің көмекшісісің. Тек берілген материалды пайдалан. Қалыпты мәтінді жай мәтінмен жаз. Математикалық формулаларды LaTeX түрінде жазып, inline үшін \\(...\\), бөлек формула үшін \\[...\\] қолдан. LaTeX командаларын бөлгіштерден тыс қалдырма.",
    "en": "You are a school teacher assistant. Use only the supplied material. Write prose as normal text. Write mathematical formulas in LaTeX, always wrapped in \\(...\\) for inline math or \\[...\\] for display math. Never leave LaTeX commands outside math delimiters.",
}

PROMPTS = {
    "ru": {
        "tasks": "Составь {count} заданий: тесты с 4 вариантами, открытые вопросы и расчётные задачи, если в тексте есть формулы. Для test correct — индекс 0–3; для open дай answer; для calc дай solution и answer. Укажи level 1–3. Формулы внутри question/options/answer/solution обязательно заключай в \\(...\\).",
        "slides": "Сделай содержание {count} слайдов: короткий title, 2–4 коротких bullets и одна короткая notes для учителя. Формулы переписывай точно из материала, не меняй обозначения и не придумывай новые. Если формула стоит отдельно, используй \\[...\\]. Если формула находится внутри предложения, используй только \\(...\\). Обычный русский текст не помещай в \\text{...}.",
    },
    "kk": {
        "tasks": "Материал бойынша {count} тапсырма құрастыр: 4 нұсқалы тесттер, ашық сұрақтар және формулалар болса есептер. test үшін correct 0–3, open үшін answer, calc үшін solution және answer бер. level 1–3. Формулаларды question/options/answer/solution ішінде міндетті түрде \\(...\\) арқылы белгіле.",
        "slides": "{count} слайдтың мазмұнын жаса: қысқа title, 2–4 қысқа bullets және мұғалімге қысқа notes. Маңызды формулаларды \\[...\\] немесе \\(...\\) ішінде жаз.",
    },
    "en": {
        "tasks": "Create {count} tasks: four-option tests, open questions, and calculation problems when appropriate. test uses correct index 0–3; open has answer; calc has solution and answer. Set level 1–3. Wrap every formula in question/options/answer/solution with \\(...\\).",
        "slides": "Create content for {count} slides: a short title, 2–4 concise bullets, and one short teacher note. Put important formulas inside \\[...\\] or \\(...\\).",
    },
}


def _text_schema(max_len: int) -> dict[str, Any]:
    return {"type": "string", "minLength": 1, "maxLength": max_len}


TASK_VARIANTS: dict[str, dict[str, Any]] = {
    "test": {
        "type": "object",
        "properties": {
            "type": {"const": "test"},
            "question": _text_schema(320),
            "options": {"type": "array", "items": _text_schema(140), "minItems": 4, "maxItems": 4},
            "correct": {"type": "integer", "enum": [0, 1, 2, 3]},
            "level": {"type": "integer", "enum": [1, 2, 3]},
        },
        "required": ["type", "question", "options", "correct", "level"],
        "additionalProperties": False,
    },
    "open": {
        "type": "object",
        "properties": {
            "type": {"const": "open"},
            "question": _text_schema(320),
            "answer": _text_schema(360),
            "level": {"type": "integer", "enum": [1, 2, 3]},
        },
        "required": ["type", "question", "answer", "level"],
        "additionalProperties": False,
    },
    "calc": {
        "type": "object",
        "properties": {
            "type": {"const": "calc"},
            "question": _text_schema(320),
            "solution": _text_schema(560),
            "answer": _text_schema(160),
            "level": {"type": "integer", "enum": [1, 2, 3]},
        },
        "required": ["type", "question", "solution", "answer", "level"],
        "additionalProperties": False,
    },
}

SLIDE_SCHEMA = {
    "type": "object",
    "properties": {
        "slides": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": _text_schema(90),
                    "bullets": {"type": "array", "items": _text_schema(170), "minItems": 2, "maxItems": 4},
                    "notes": _text_schema(240),
                },
                "required": ["title", "bullets", "notes"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["slides"],
    "additionalProperties": False,
}


class LessonGenerationRequest(BaseModel):
    sourceType: Literal["text", "textbook", "search"] = "text"
    text: str | None = None
    book: str | None = None
    section: str | None = None
    query: str | None = None
    language: Literal["auto", "ru", "kk", "en"] = "auto"
    slideCount: int = Field(default=6, ge=3, le=10)
    taskCount: int = Field(default=6, ge=3, le=12)
    title: str | None = Field(default=None, max_length=120)

    @model_validator(mode="after")
    def validate_source(self) -> "LessonGenerationRequest":
        if self.sourceType == "text":
            if not self.text or len(self.text.strip()) < 80:
                raise ValueError("Для генерации нужно минимум 80 символов исходного материала")
        elif self.sourceType == "textbook":
            if not self.book or not self.section:
                raise ValueError("Для учебника нужно выбрать книгу и параграф")
        elif not self.book or not self.query or len(self.query.strip()) < 2:
            raise ValueError("Для поиска нужно выбрать учебник и указать тему")
        return self


def _detect_lang(text: str) -> Literal["ru", "kk", "en"]:
    sample = text[:12000]
    kk = sum(sample.count(ch) for ch in "ӘәҒғҚқҢңӨөҰұҮүҺһІі")
    cyr = len(re.findall(r"[А-Яа-яЁё]", sample))
    lat = len(re.findall(r"[A-Za-z]", sample))
    if kk >= 3:
        return "kk"
    if cyr >= lat:
        return "ru"
    return "en"


def _book_label(book: str) -> str:
    label = re.sub(r"[_-]+", " ", book).strip()
    label = re.sub(r"\s+", " ", label)
    return label[:1].upper() + label[1:] if label else book


def list_textbook_sources() -> dict[str, Any]:
    return list_textbooks()


def _load_jsonl_by_page(path: Path, *, text_only: bool = False) -> dict[int, Any]:
    result: dict[int, Any] = {}
    if not path.exists():
        return result
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if not line.strip():
            continue
        try:
            item = json.loads(line)
            page = int(item["page"])
            if text_only:
                if item.get("truncated"):
                    continue
                result[page] = str(item.get("text", ""))
            else:
                result[page] = item
        except Exception:
            continue
    return result


def _load_textbook_context(
    book: str,
    section: str,
    max_chars: int = 9000,
) -> tuple[str, str, Literal["ru", "kk", "en"], dict[str, Any]]:
    safe_book = Path(book).name
    raw_path = ML_DATA_ROOT / "raw" / f"{safe_book}.jsonl"
    section_path = ML_DATA_ROOT / "sections" / f"{safe_book}.json"
    if not raw_path.exists() or not section_path.exists():
        raise ValueError("Данные выбранного учебника не найдены")

    sections = json.loads(section_path.read_text(encoding="utf-8"))
    sec = next((s for s in sections if str(s.get("num")) == str(section)), None)
    if sec is None:
        raise ValueError(f"Параграф §{section} не найден")

    page_start = int(sec["page_start"])
    page_end = int(sec["page_end"])
    pages = list(range(page_start, page_end + 1))
    raw = _load_jsonl_by_page(raw_path)
    vlm = _load_jsonl_by_page(ML_DATA_ROOT / "vlm" / f"{safe_book}.jsonl", text_only=True)

    if pages and all(page in vlm and vlm[page].strip() for page in pages):
        source_kind = "vlm"
        text = "\n\n".join(vlm[page] for page in pages)
    else:
        source_kind = "tesseract"
        text = "\n\n".join(str(raw.get(page, {}).get("text", "")) for page in pages)

    text = text.strip()
    if len(text) < 80:
        raise ValueError("В выбранном параграфе слишком мало распознанного текста")

    title = f"§{section}"
    section_title = str(sec.get("title", "")).strip()
    if section_title:
        title += f" {section_title}"
    meta = {
        "book": safe_book,
        "section": str(section),
        "pages": [page_start, page_end],
        "textSource": source_kind,
        "textChars": min(len(text), max_chars),
        "textCut": len(text) > max_chars,
    }
    return text[:max_chars], title, _detect_lang(text), meta


def _composition(count: int, context: str) -> dict[str, int]:
    calc = max(1, count // 6) if context.count("=") >= 4 or "∫" in context else 0
    open_count = max(1, round(count / 3)) if count - calc > 1 else 0
    return {"test": count - calc - open_count, "open": open_count, "calc": calc}


def _task_schema(count: int, context: str) -> dict[str, Any]:
    comp = _composition(count, context)
    prefix = [TASK_VARIANTS[kind] for kind in ("test", "open", "calc") for _ in range(comp[kind])]
    return {
        "type": "object",
        "properties": {
            "tasks": {
                "type": "array",
                "prefixItems": prefix,
                "minItems": len(prefix),
                "maxItems": len(prefix),
            }
        },
        "required": ["tasks"],
        "additionalProperties": False,
    }

_JSON_LATEX_COMMANDS = (
    "begin", "end", "text", "mathrm", "mathbf", "mathit", "operatorname",
    "dfrac", "tfrac", "frac", "sqrt", "left", "right",
    "tilde", "widetilde", "hat", "widehat", "bar", "overline", "vec",
    "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "theta",
    "lambda", "mu", "nu", "xi", "pi", "rho", "sigma", "tau", "phi",
    "varphi", "chi", "psi", "omega",
    "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Phi", "Psi", "Omega",
    "infty", "pm", "mp", "cdot", "times", "div", "leq", "geq", "neq", "approx",
    "sum", "prod", "lim", "int", "iint", "iiint", "oint",
    "sin", "cos", "tan", "cot", "sec", "csc", "log", "ln", "exp",
    "to", "rightarrow", "leftarrow", "Rightarrow", "Leftarrow",
    "qquad", "quad", "small", "displaystyle",
)
_JSON_LATEX_BACKSLASH_RE = re.compile(
    r"(?<!\\)\\(?=(?:" + "|".join(sorted((re.escape(cmd) for cmd in _JSON_LATEX_COMMANDS), key=len, reverse=True)) + r")\b|[\(\)\[\],;!])"
)


def _protect_latex_backslashes_in_json(value: str) -> str:
    """Escape raw LaTeX backslashes before json.loads can turn \t/\f/\n into control chars."""
    return _JSON_LATEX_BACKSLASH_RE.sub(r"\\\\", value)


def _extract_json_text(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\\s*```\\s*$", "", cleaned)

    start = cleaned.find("{")
    if start < 0:
        raise json.JSONDecodeError("JSON object not found", cleaned, 0)
    candidate = _protect_latex_backslashes_in_json(cleaned[start:])
    decoder = json.JSONDecoder()

    for _ in range(6):
        try:
            parsed, _end = decoder.raw_decode(candidate)
            if not isinstance(parsed, dict):
                raise json.JSONDecodeError("Top-level JSON must be an object", candidate, 0)
            return parsed
        except json.JSONDecodeError as exc:
            pos = max(0, min(exc.pos, len(candidate)))
            if exc.msg == "Expecting ',' delimiter":
                probe = pos
                while probe < len(candidate) and candidate[probe].isspace():
                    probe += 1
                before = candidate[:probe].rstrip()
                if probe < len(candidate) and candidate[probe] == '"' and before and before[-1] not in "[{,:":
                    candidate = candidate[:probe] + "," + candidate[probe:]
                    continue
            if exc.msg == "Expecting property name enclosed in double quotes":
                before = candidate[:pos].rstrip()
                if before.endswith(","):
                    comma_pos = len(before) - 1
                    candidate = candidate[:comma_pos] + candidate[comma_pos + 1:]
                    continue
            raise

    raise json.JSONDecodeError("Unable to repair JSON", candidate, 0)


def _is_degenerate(value: Any) -> bool:
    return re.search(r"(.{3,30}?)\1{5,}", json.dumps(value, ensure_ascii=False)) is not None


def _client() -> Any:
    from openai import OpenAI

    api_key = get_openai_key()
    base_url = settings.ai_base_url
    if not api_key and not base_url:
        raise RuntimeError("AI backend is not configured")
    options: dict[str, Any] = {
        "api_key": api_key or "ollama",
        "timeout": max(settings.ai_timeout_seconds, 900.0),
    }
    if base_url:
        options["base_url"] = base_url
    return OpenAI(**options)


def _ask_structured(
    *,
    kind: Literal["tasks", "slides"],
    schema: dict[str, Any],
    language: Literal["ru", "kk", "en"],
    context: str,
    count: int,
    seed: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    client = _client()
    key = "tasks" if kind == "tasks" else "slides"
    heading = "Текст учебника" if language == "ru" else "Оқулық мәтіні" if language == "kk" else "Textbook text"
    user = (
        f"{heading}:\n\n{context}\n\n---\n"
        f"{PROMPTS[language][kind].replace('{count}', str(count))}\n"
        "Важно: JSON должен быть синтаксически валидным. Каждый обратный слэш LaTeX внутри JSON-строки экранируй как двойной обратный слэш.\n"
        f"Верни только JSON-объект с ключом {key}."
    )
    request: dict[str, Any] = {
        "model": settings.ai_model,
        "messages": [
            {"role": "system", "content": SYSTEM[language]},
            {"role": "user", "content": user},
        ],
        "temperature": 0.4,
        "max_tokens": 2400,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": f"lesson_{kind}", "schema": schema},
        },
    }
    if settings.ai_base_url:
        request["extra_body"] = {
            "cache_prompt": True,
            "repeat_penalty": 1.1,
            "seed": seed,
        }

    started = time.perf_counter()
    try:
        response = client.chat.completions.create(**request)
    except Exception as first_exc:  # noqa: BLE001
        logger.warning("Structured response failed for %s, retrying as json_object: %s", kind, first_exc)
        request["response_format"] = {"type": "json_object"}
        request.pop("extra_body", None)
        response = client.chat.completions.create(**request)

    items: list[dict[str, Any]] | None = None
    parse_attempts = 0
    last_parse_error: Exception | None = None
    for parse_attempt in range(3):
        parse_attempts = parse_attempt + 1
        content = response.choices[0].message.content or ""
        try:
            parsed = _extract_json_text(content)
            candidate = parsed.get(key)
            if isinstance(candidate, list):
                items = candidate
                break
            raise RuntimeError(f"Модель не вернула массив {key}")
        except (json.JSONDecodeError, RuntimeError) as exc:
            last_parse_error = exc
            logger.warning("Structured JSON parse failed for %s: %s", kind, exc)
            if parse_attempt >= 2:
                break
            request["response_format"] = {"type": "json_object"}
            request["temperature"] = 0.1
            request.pop("extra_body", None)
            response = client.chat.completions.create(**request)

    if items is None:
        raise RuntimeError("Модель несколько раз вернула повреждённый JSON") from last_parse_error
    usage = getattr(response, "usage", None)
    timing = {
        "totalSeconds": round(time.perf_counter() - started, 2),
        "promptTokens": getattr(usage, "prompt_tokens", None) if usage else None,
        "completionTokens": getattr(usage, "completion_tokens", None) if usage else None,
    }
    return items, timing


def _canonical_task_type(raw: dict[str, Any]) -> Literal["test", "open", "calc"]:
    kind = str(raw.get("type", "") or "").strip().lower()
    aliases = {
        "test": "test",
        "test_correct": "test",
        "multiple_choice": "test",
        "multiple-choice": "test",
        "quiz": "test",
        "mcq": "test",
        "open": "open",
        "free": "open",
        "short_answer": "open",
        "short-answer": "open",
        "calc": "calc",
        "calculation": "calc",
        "problem": "calc",
        "numeric": "calc",
    }
    mapped = aliases.get(kind)
    if mapped is not None:
        return mapped  # type: ignore[return-value]
    if isinstance(raw.get("options"), list) and len(raw.get("options") or []) >= 2:
        return "test"
    if _normalize_rich_text(raw.get("solution", "")):
        return "calc"
    return "open"


def _shuffle_and_normalize_tasks(tasks: list[dict[str, Any]], seed: int) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    normalized: list[dict[str, Any]] = []
    for raw in tasks:
        kind = _canonical_task_type(raw)
        question = _normalize_rich_text(raw.get("question", ""))
        answer = _normalize_rich_text(raw.get("answer", ""))
        if not question:
            continue

        item: dict[str, Any] = {
            "id": f"task-{len(normalized) + 1}",
            "type": kind,
            "question": question,
            "answer": answer,
            "level": max(1, min(3, int(raw.get("level", 2) or 2))),
        }
        if kind == "test":
            options = [_normalize_rich_text(x) for x in raw.get("options", [])][:4]
            options = list(dict.fromkeys(option for option in options if option))
            if len(options) < 2:
                continue
            correct = int(raw.get("correct", 0) or 0)
            correct = max(0, min(correct, len(options) - 1))
            answer = options[correct]
            rng.shuffle(options)
            item["options"] = options
            item["answer"] = answer
        elif kind == "calc":
            solution = _normalize_rich_text(raw.get("solution", ""))
            if not answer and solution:
                answer = _normalize_rich_text(raw.get("result", ""))
            if not answer or not solution:
                continue
            item["answer"] = answer
            item["solution"] = solution
        elif not answer:
            continue

        normalized.append(item)
    return normalized


def _load_mathcheck():
    path = ML_ROOT / "scripts" / "mathcheck.py"
    if not path.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("matrix_ml_mathcheck", path)
        if not spec or not spec.loader:
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return getattr(module, "check_tasks", None)
    except Exception as exc:  # noqa: BLE001
        logger.warning("ML mathcheck is unavailable: %s", exc)
        return None


def _verify_tasks(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    checker = _load_mathcheck()
    if checker is None:
        return tasks

    plain_tasks: list[dict[str, Any]] = []
    for task in tasks:
        plain = dict(task)
        for field in ("question", "answer", "solution"):
            if field in plain and plain[field] is not None:
                plain[field] = _rich_to_plain(plain[field])
        if "options" in plain:
            plain["options"] = [_rich_to_plain(option) for option in plain.get("options", [])]
        plain_tasks.append(plain)

    try:
        checked = checker(plain_tasks)
    except Exception as exc:  # noqa: BLE001
        logger.warning("ML mathcheck failed: %s", exc)
        return tasks

    merged: list[dict[str, Any]] = []
    for original, before, after in zip(tasks, plain_tasks, checked):
        item = dict(original)
        if after.get("check") is not None:
            item["check"] = after.get("check")

        # Preserve model LaTeX when mathcheck did not change the semantic field.
        # If mathcheck corrected something, its Unicode/plain correction is safer
        # than keeping the now-wrong original formula.
        for field in ("answer", "solution"):
            if field in after and after.get(field) != before.get(field):
                corrected = _normalize_rich_text(after.get(field, ""))
                if corrected:
                    item[field] = corrected
        if after.get("options") != before.get("options") and after.get("options") is not None:
            corrected_options = [_normalize_rich_text(option) for option in after.get("options", [])]
            corrected_options = [option for option in corrected_options if option]
            if len(corrected_options) >= 2:
                item["options"] = corrected_options
        merged.append(item)
    return merged


def _slide_elements(index: int, title: str, bullets: list[str]) -> list[dict[str, Any]]:
    primary = "#4DA3FF"
    text_color = "#F4F7FB"
    muted = "#B6C2D1"
    card = "#151C27"
    elements: list[dict[str, Any]] = [
        {
            "id": f"s{index}-accent",
            "type": "shape",
            "shape": "round",
            "x": 55,
            "y": 52,
            "width": 7,
            "height": 54,
            "rotation": 0,
            "fillColor": primary,
            "strokeColor": None,
            "strokeWidth": 0,
            "cornerRadius": 4,
        },
        {
            "id": f"s{index}-title",
            "type": "text",
            "x": 78,
            "y": 48,
            "width": 805,
            "height": 64,
            "rotation": 0,
            "text": title,
            "fontSize": 31,
            "color": text_color,
            "fontFamily": "Montserrat",
            "fontWeight": "semibold",
            "align": "left",
        },
    ]

    bullets = bullets[:4]
    count = max(1, len(bullets))
    top = 142
    available = 328
    gap = 14
    card_h = min(82, (available - gap * (count - 1)) / count)
    for bullet_index, bullet in enumerate(bullets, start=1):
        y = top + (bullet_index - 1) * (card_h + gap)
        prose, formulas = _math_parts(bullet)
        elements.append(
            {
                "id": f"s{index}-card-{bullet_index}",
                "type": "shape",
                "shape": "round",
                "x": 60,
                "y": y,
                "width": 840,
                "height": card_h,
                "rotation": 0,
                "fillColor": card,
                "strokeColor": "#263244",
                "strokeWidth": 1,
                "cornerRadius": 18,
            }
        )

        if formulas and not prose:
            latex = formulas[0] if len(formulas) == 1 else (
                r"\begin{gathered}" + r" \\ ".join(formulas) + r"\end{gathered}"
            )
            elements.append(
                {
                    "id": f"s{index}-math-{bullet_index}",
                    "type": "math",
                    "x": 82,
                    "y": y + 9,
                    "width": 796,
                    "height": max(36, card_h - 18),
                    "rotation": 0,
                    "latex": latex,
                    "fallbackText": "\n".join(_latex_fallback(item) for item in formulas),
                    "fontSize": 25 if len(latex) < 80 else 21,
                    "color": text_color,
                    "align": "center",
                    "display": True,
                }
            )
        else:
            # Keep explanatory prose and inline formulas together. The frontend
            # renders delimited formulas through MathText/KaTeX, so definitions
            # do not split into unrelated text and formula boxes.
            rich_bullet = bullet if formulas else _visible_text(bullet)
            if formulas:
                rich_bullet = re.sub(r"\\\[(.*?)\\\]", r"\\(\1\\)", rich_bullet, flags=re.DOTALL)
                rich_bullet = re.sub(r"\$\$(.*?)\$\$", r"$\1$", rich_bullet, flags=re.DOTALL)
            text_len = len(_rich_to_plain(rich_bullet))
            elements.append(
                {
                    "id": f"s{index}-bullet-{bullet_index}",
                    "type": "text",
                    "x": 82,
                    "y": y + 10,
                    "width": 796,
                    "height": max(38, card_h - 20),
                    "rotation": 0,
                    "text": f"• {rich_bullet}",
                    "fontSize": 20 if text_len < 95 else (18 if text_len < 145 else 16),
                    "color": muted,
                    "fontFamily": "Montserrat",
                    "fontWeight": "normal",
                    "align": "left",
                }
            )
    return elements


def build_contract_lesson(
    tasks: list[dict[str, Any]],
    slides: list[dict[str, Any]],
) -> tuple[GeneratedLesson, list[str]]:
    normalized_tasks: list[dict[str, Any]] = []
    for index, task in enumerate(tasks, start=1):
        raw_check = task.get("check")
        normalized_check = None
        if isinstance(raw_check, dict):
            normalized_check = {
                "status": raw_check.get("status"),
                "note": _normalize_rich_text(raw_check.get("note", "")),
            }

        item: dict[str, Any] = {
            "id": f"task-{index}",
            "type": _canonical_task_type(task),
            "question": _normalize_rich_text(task.get("question", "")),
            "answer": _normalize_rich_text(task.get("answer", "")),
            "level": task.get("level"),
            "check": normalized_check,
        }
        if item["type"] == "test":
            options = [_normalize_rich_text(x) for x in task.get("options", [])]
            # Normalization can collapse equivalent LaTeX/Unicode options. Keep order,
            # remove exact duplicates, and preserve the normalized answer.
            item["options"] = list(dict.fromkeys(option for option in options if option))
            if item["answer"] and item["answer"] not in item["options"]:
                item["options"].append(item["answer"])
        elif item["type"] == "calc":
            item["solution"] = _normalize_rich_text(task.get("solution", ""))
        normalized_tasks.append(item)

    generated_slides: list[dict[str, Any]] = []
    notes: list[str] = []
    for index, slide in enumerate(slides, start=1):
        title = _visible_text(slide.get("title", "")) or f"Слайд {index}"
        bullets = [_normalize_rich_text(x) for x in slide.get("bullets", []) if _normalize_rich_text(x)][:4]
        if len(bullets) < 2:
            bullets = (bullets + ["Ключевая мысль", "Обсудите пример с классом"])[:2]
        generated_slides.append(
            {
                "id": f"slide-{index}",
                "title": title,
                "elements": _slide_elements(index, title, bullets),
            }
        )
        notes.append(_visible_text(slide.get("notes", "")))

    lesson = GeneratedLesson.model_validate(
        {
            "contractVersion": "1.0",
            "theme": {
                "backgroundColor": "#0A0E14",
                "primaryColor": "#4DA3FF",
                "textColor": "#F4F7FB",
                "mutedTextColor": "#B6C2D1",
                "fontFamily": "Montserrat",
            },
            "slides": generated_slides,
            "tasks": normalized_tasks,
        }
    )
    return lesson, notes


def _workspace_payload(lesson: GeneratedLesson, notes: list[str]) -> dict[str, Any]:
    resolved = resolved_lesson_payload(lesson)
    slides: list[dict[str, Any]] = []
    for index, slide in enumerate(resolved["slides"], start=1):
        elements: list[dict[str, Any]] = []
        for element in slide["elements"]:
            common: dict[str, Any] = {
                "id": element["id"],
                "type": element["type"],
                "x": element["x"],
                "y": element["y"],
                "w": element["width"],
                "h": element["height"],
                "rotation": element.get("rotation", 0),
            }
            if element["type"] == "text":
                common.update(
                    {
                        "text": element["text"],
                        "fontSize": element.get("fontSize"),
                        "fontFamily": element.get("fontFamily"),
                        "fontWeight": element.get("fontWeight"),
                        "color": element.get("color"),
                        "align": element.get("align"),
                    }
                )
            elif element["type"] == "math":
                common.update(
                    {
                        "latex": element["latex"],
                        "fallbackText": element["fallbackText"],
                        "fontSize": element.get("fontSize"),
                        "color": element.get("color"),
                        "align": element.get("align"),
                        "display": element.get("display", True),
                    }
                )
            elif element["type"] == "shape":
                common.update(
                    {
                        "shape": element["shape"],
                        "fill": element.get("fillColor"),
                        "strokeColor": element.get("strokeColor"),
                        "strokeWidth": element.get("strokeWidth"),
                    }
                )
            else:
                continue
            elements.append(common)

        slides.append(
            {
                "id": index,
                "title": slide["title"],
                "content": "",
                "notes": notes[index - 1] if index - 1 < len(notes) else "",
                "elements": elements,
                "backgroundColor": resolved["theme"]["backgroundColor"],
            }
        )

    tasks: list[dict[str, Any]] = []
    for index, task in enumerate(resolved["tasks"], start=1):
        kind = task["type"]
        question = task["question"]
        options = list(task.get("options") or [])
        if kind == "test" and options:
            letters = "ABCD"
            problem = question + "\n\n" + "\n".join(
                f"{letters[i] if i < len(letters) else i + 1}. {option}"
                for i, option in enumerate(options)
            )
        else:
            problem = question

        tasks.append(
            {
                "id": index,
                "title": _rich_to_plain(question)[:72] + ("…" if len(_rich_to_plain(question)) > 72 else ""),
                "problem": problem,
                "tags": ["AI", f"L{task.get('level') or 2}", kind],
                "kind": kind,
                "answer": task["answer"],
                "solution": task.get("solution"),
                "options": options,
                "level": task.get("level"),
                "check": task.get("check"),
            }
        )
    return {"slides": slides, "tasks": tasks}


def generate_lesson(
    request: LessonGenerationRequest,
    progress: Callable[[int, str, int | None, int | None], None] | None = None,
) -> dict[str, Any]:
    def emit(value: int, stage: str, completed: int | None = None, total: int | None = None) -> None:
        if progress is not None:
            progress(value, stage, completed, total)

    emit(3, "source")
    if request.sourceType == "textbook":
        context, inferred_title, detected_lang, source_meta = _load_textbook_context(
            request.book or "",
            request.section or "",
        )
    elif request.sourceType == "search":
        context, pages = search_context(request.book or "", request.query or "", limit=5, max_chars=9000)
        inferred_title = (request.query or "").strip()
        detected_lang = _detect_lang(context)
        source_meta = {
            "book": request.book,
            "section": None,
            "query": (request.query or "").strip(),
            "pages": pages,
            "textSource": "page-index",
            "textChars": len(context),
            "textCut": False,
        }
    else:
        original = (request.text or "").strip()
        context = original[:9000]
        inferred_title = request.title.strip() if request.title else "Новый урок"
        detected_lang = _detect_lang(context)
        source_meta = {
            "book": None,
            "section": None,
            "pages": None,
            "textSource": "manual",
            "textChars": len(context),
            "textCut": len(original) > len(context),
        }

    emit(12, "source_ready")

    language: Literal["ru", "kk", "en"] = (
        detected_lang if request.language == "auto" else request.language
    )
    timings: dict[str, Any] = {}

    emit(18, "tasks_generating", 0, request.taskCount)
    raw_tasks: list[dict[str, Any]] = []
    task_pool: list[dict[str, Any]] = []
    seen_questions: set[str] = set()
    for attempt in range(3):
        raw_tasks, timings["tasks"] = _ask_structured(
            kind="tasks",
            schema=_task_schema(request.taskCount, context),
            language=language,
            context=context,
            count=request.taskCount,
            seed=attempt,
        )
        candidates = _shuffle_and_normalize_tasks(raw_tasks, seed=attempt)
        for candidate in candidates:
            key = _rich_to_plain(candidate.get("question", "")).strip().lower()
            if not key or key in seen_questions:
                continue
            seen_questions.add(key)
            task_pool.append(candidate)
            if len(task_pool) >= request.taskCount:
                break
        if len(task_pool) >= request.taskCount:
            break

    tasks = task_pool[: request.taskCount]
    if not tasks:
        raise RuntimeError("ИИ не смог сформировать корректные задания")
    if len(tasks) < request.taskCount:
        logger.warning(
            "Lesson generator produced only %s/%s valid tasks after retries",
            len(tasks),
            request.taskCount,
        )
    timings["tasks"]["attempts"] = attempt + 1
    timings["tasks"]["validTasks"] = len(tasks)
    emit(46, "tasks_generated", len(tasks), request.taskCount)

    emit(52, "slides_generating", 0, request.slideCount)
    raw_slides: list[dict[str, Any]] = []
    for attempt in range(3):
        slide_schema = json.loads(json.dumps(SLIDE_SCHEMA))
        slide_schema["properties"]["slides"]["minItems"] = request.slideCount
        slide_schema["properties"]["slides"]["maxItems"] = request.slideCount
        raw_slides, timings["slides"] = _ask_structured(
            kind="slides",
            schema=slide_schema,
            language=language,
            context=context,
            count=request.slideCount,
            seed=attempt,
        )
        if not _is_degenerate(raw_slides):
            break
    timings["slides"]["attempts"] = attempt + 1
    emit(78, "slides_generated", request.slideCount, request.slideCount)

    emit(82, "tasks_checking", 0, request.taskCount)
    tasks = _verify_tasks(tasks)
    emit(90, "tasks_checked", len(tasks), request.taskCount)
    emit(94, "contract")
    lesson, notes = build_contract_lesson(tasks, raw_slides)
    resolved = resolved_lesson_payload(lesson)
    workspace = _workspace_payload(lesson, notes)

    emit(98, "finalizing")
    checks: dict[str, int] = {}
    for task in resolved["tasks"]:
        status = (task.get("check") or {}).get("status")
        if status:
            checks[status] = checks.get(status, 0) + 1

    return {
        "lesson": resolved,
        "workspace": workspace,
        "meta": {
            **source_meta,
            "title": request.title.strip() if request.title else inferred_title,
            "language": language,
            "timings": timings,
            "checks": checks,
        },
    }
