from __future__ import annotations

import base64
import io
import logging
import re

from openai import OpenAI
from PIL import Image, ImageOps

from .settings import get_openai_key, settings

logger = logging.getLogger(__name__)

_OCR_FAILURE_RE = re.compile(
    r"(?:не\s+(?:разобрал|могу\s+распознать|удалось\s+распознать|читается)|"
    r"напишите\s+более\s+разборчиво|cannot\s+(?:recognize|read)|unable\s+to\s+(?:recognize|read))",
    re.I,
)

_OCR_PROMPTS = (
    (
        "Ты выполняешь ТОЧНОЕ OCR рукописной школьной доски. Только транскрибируй то, что реально видно; "
        "не решай, не упрощай и не восстанавливай формулу по смыслу. Сохраняй ВСЕ слагаемые, знаки, скобки, "
        "степени, корни, дроби и математические символы. "
        "Для интеграла отдельно прочитай: нижний предел под знаком интеграла, верхний предел над ним, "
        "затем весь интегранд слева направо и только потом дифференциал dx/dy. "
        "Не присоединяй символы из интегранда (например pi) к пределу интеграла. "
        "Степени записывай через ^, pi как pi, sqrt как sqrt(...), интеграл как int_[нижний]^[верхний](...) dx. "
        "Если ровно один символ неясен, поставь ? только вместо него. Верни только транскрипцию."
    ),
    (
        "Перепроверь изображение как математический OCR, не доверяя предыдущему чтению. "
        "Сначала мысленно раздели пространственные роли: пределы интегралов/сумм, основной уровень строки, "
        "верхние индексы и нижние индексы. Затем перепиши формулу полностью. "
        "Нельзя пропускать начало или конец выражения и нельзя угадывать по математическому смыслу. "
        "Используй обычную запись: x^2, sqrt(x), pi, int_[a]^[b](f(x)) dx. Только результат OCR."
    ),
    (
        "Сделай ещё одно независимое OCR школьной записи. Перепиши каждый видимый символ в порядке чтения. "
        "Проверь отдельно +/-, степени, дробные черты, скобки, пределы интеграла и дифференциал. "
        "Ничего не решай и не комментируй. Для сомнительного одиночного символа используй ?."
    ),
)

_MATH_OCR_RE = re.compile(
    r"(?:\\?int\b|∫|\\?frac\b|\\?sqrt\b|√|\^|"
    r"\\?(?:sin|cos|tan|log|ln)\b|\b(?:sin|cos|tan|log|ln)\b|"
    r"\\?pi\b|π|\bd[xyz]\b|[=<>])",
    re.I,
)

_INTEGRAL_RE = re.compile(r"(?:\\?int\b|∫)", re.I)


def _normalize_ocr_text(text: str | None) -> str:
    value = (text or "").strip()
    for left, right in (("\\[", "\\]"), ("\\(", "\\)"), ("$$", "$$")):
        if value.startswith(left) and value.endswith(right):
            value = value[len(left):-len(right)].strip()
            break
    if value.startswith("```") and value.endswith("```"):
        value = value.strip("`").strip()
        value = re.sub(r"^(?:latex|tex|text|math)\s*\n", "", value, flags=re.I)
    value = re.sub(r"^(?:ocr|transcription|распознано|транскрипция)\s*:\s*", "", value, flags=re.I)
    return value.strip()


def _usable_ocr_text(text: str | None) -> bool:
    value = _normalize_ocr_text(text)
    if len(value) < 2:
        return False
    if _OCR_FAILURE_RE.search(value):
        return False
    meaningful = sum(ch.isalnum() or ch in "+-=^/()√×·∫π_" for ch in value)
    return meaningful >= 2


def _looks_math_heavy(text: str | None) -> bool:
    value = _normalize_ocr_text(text)
    return bool(_MATH_OCR_RE.search(value))


def _math_structure_score(text: str | None) -> int:
    value = _normalize_ocr_text(text)
    if not value:
        return -100
    lower = value.lower()
    score = 0
    score += min(10, sum(ch.isalnum() for ch in value) // 5)
    score += min(6, value.count("+") + value.count("-") + value.count("="))
    score += 2 if "^" in value or re.search(r"\b[x-z]\s*[²³⁴]", value, re.I) else 0
    score += 2 if re.search(r"(?:\\?pi\b|π)", value, re.I) else 0
    score += 2 if re.search(r"(?:\\?(?:sin|cos|tan)|\b(?:sin|cos|tan)\b)", value, re.I) else 0
    score += 3 if re.search(r"\bd[xyz]\b", lower) else 0

    if _INTEGRAL_RE.search(value):
        score += 6
        has_lower = bool(re.search(r"(?:_\s*\{?[^\s\^]+|int_\[[^\]]+\])", value, re.I))
        has_upper = bool(re.search(r"(?:\^\s*\{?[^\s\(]+|\^\[[^\]]+\])", value, re.I))
        score += 4 if has_lower else -3
        score += 4 if has_upper else -3
        score += 4 if re.search(r"\bd[xyz]\b", lower) else -4
        score += 2 if re.search(r"[+\-]", value) else 0

    score -= value.count("?") * 3
    if _OCR_FAILURE_RE.search(value):
        score -= 20
    return score


def _choose_math_candidate(candidates: list[str]) -> str:
    usable = [_normalize_ocr_text(item) for item in candidates if _usable_ocr_text(item)]
    if not usable:
        return ""
    return max(usable, key=lambda item: (_math_structure_score(item), len(item)))


def _contrast_variant(image_bytes: bytes) -> bytes | None:
    try:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
        white = Image.new("RGBA", image.size, (255, 255, 255, 255))
        white.alpha_composite(image)
        gray = ImageOps.grayscale(white.convert("RGB"))
        gray = ImageOps.autocontrast(gray, cutoff=1)

        longest = max(gray.size)
        if longest and longest < 2400:
            factor = min(2.0, 2400 / longest)
            gray = gray.resize(
                (
                    max(1, round(gray.width * factor)),
                    max(1, round(gray.height * factor)),
                ),
                Image.Resampling.LANCZOS,
            )

        # Keep antialiasing around thin handwriting, but remove most grid/background noise.
        contrasted = gray.point(lambda value: 0 if value < 205 else 255)
        output = io.BytesIO()
        contrasted.save(output, format="PNG", optimize=True)
        return output.getvalue()
    except Exception as exc:  # noqa: BLE001
        logger.debug("OCR contrast preprocessing skipped: %s", exc)
        return None


def _data_url(image_bytes: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(image_bytes).decode("utf-8")


def _candidate_key(text: str) -> str:
    value = _normalize_ocr_text(text).lower()
    value = value.replace("\\pi", "pi").replace("π", "pi")
    value = re.sub(r"\\(sin|cos|tan|log|ln)\b", r"\1", value)
    value = value.replace("\\,", "").replace(" ", "").replace("\n", "")
    value = value.replace("{", "").replace("}", "")
    return value


def _request_ocr(
    client,
    *,
    prompt: str,
    image_bytes: bytes,
    base_url: str | None,
) -> str:
    data_url = _data_url(image_bytes)
    if base_url:
        response = client.chat.completions.create(
            model=settings.ocr_model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ],
            max_tokens=1200,
            temperature=0,
        )
        text = response.choices[0].message.content
    else:
        if not hasattr(client, "responses"):
            raise RuntimeError(
                "OpenAI SDK слишком старый. Обновите пакет openai до версии с Responses API."
            )
        response = client.responses.create(
            model=settings.ocr_model,
            input=[
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": prompt},
                        {"type": "input_image", "image_url": data_url},
                    ],
                }
            ],
            max_output_tokens=1200,
        )
        text = response.output_text
    return _normalize_ocr_text(text)


def _reconcile_math_prompt(candidates: list[str]) -> str:
    rendered = "\n".join(
        f"Кандидат {index + 1}: {candidate}"
        for index, candidate in enumerate(candidates[-3:])
    )
    return (
        "Это финальная проверка OCR математической рукописи. Ни один из кандидатов ниже не считается правильным. "
        "Смотри прежде всего на ИЗОБРАЖЕНИЕ и используй кандидаты только как подсказки о возможных символах. "
        "Проверь каждый видимый знак и не решай выражение. Для интеграла обязательно отдельно установи: "
        "(1) нижний предел прямо под знаком интеграла; (2) верхний предел прямо над ним; "
        "(3) весь интегранд между знаком интеграла и dx/dy; (4) степени и функции внутри интегранда. "
        "Нельзя переносить pi или другие символы из интегранда в пределы. "
        "Верни ОДНУ полную транскрипцию обычной математической записью, без комментариев и без markdown.\n\n"
        + rendered
    )


def ocr_image(png_bytes: bytes) -> str:
    api_key = get_openai_key()
    base_url = settings.ocr_base_url
    if not api_key and not base_url:
        raise RuntimeError("OCR backend is not configured")

    client_options = {
        "api_key": api_key or "ollama",
        "timeout": settings.ai_timeout_seconds,
    }
    if base_url:
        client_options["base_url"] = base_url
    client = OpenAI(**client_options)

    contrast = _contrast_variant(png_bytes)
    variants = [png_bytes]
    if contrast and contrast != png_bytes:
        variants.append(contrast)

    candidates: list[str] = []
    errors: list[str] = []
    math_mode = False

    for attempt, prompt in enumerate(_OCR_PROMPTS):
        image_bytes = variants[min(attempt, len(variants) - 1)]
        try:
            candidate = _request_ocr(
                client,
                prompt=prompt,
                image_bytes=image_bytes,
                base_url=base_url,
            )
            if not _usable_ocr_text(candidate):
                errors.append(candidate or "empty response")
                continue

            candidates.append(candidate)
            math_mode = math_mode or _looks_math_heavy(candidate)

            # Plain text should stay fast. Formula-heavy content intentionally
            # receives at least one independent second reading.
            if not math_mode:
                return candidate

            if len(candidates) >= 2:
                break
        except Exception as exc:  # noqa: BLE001
            errors.append(str(exc))
            logger.warning("OCR attempt %s failed: %s", attempt + 1, exc)

    if candidates and math_mode:
        best = _choose_math_candidate(candidates)
        keys = {_candidate_key(item) for item in candidates if item}
        needs_reconcile = bool(_INTEGRAL_RE.search(best)) or len(keys) > 1

        if needs_reconcile:
            try:
                reconciled = _request_ocr(
                    client,
                    prompt=_reconcile_math_prompt(candidates),
                    image_bytes=png_bytes,
                    base_url=base_url,
                )
                if _usable_ocr_text(reconciled):
                    candidates.append(reconciled)
            except Exception as exc:  # noqa: BLE001
                errors.append(str(exc))
                logger.warning("OCR math reconciliation failed: %s", exc)

        best = _choose_math_candidate(candidates)
        if best:
            logger.info(
                "Math OCR selected score=%s from %s candidates",
                _math_structure_score(best),
                len(candidates),
            )
            return best

    if candidates:
        return _normalize_ocr_text(candidates[-1])

    logger.warning("OCR exhausted retries: %s", errors)
    raise RuntimeError(
        "Не удалось надежно распознать запись после нескольких попыток. "
        "Попробуйте написать чуть крупнее или очистить лишние линии вокруг задачи."
    )
