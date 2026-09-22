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
    r"(?:\\?int(?=\b|_|\[)|∫|\\?frac\b|\\?sqrt\b|√|\^|"
    r"\\?(?:sin|cos|tan|log|ln)\b|\b(?:sin|cos|tan|log|ln)\b|"
    r"\\?pi\b|π|\bd[xyz]\b|[=<>])",
    re.I,
)

_INTEGRAL_RE = re.compile(r"(?:\\?int(?=\b|_|\[)|∫)", re.I)


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


def _ink_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    gray = ImageOps.grayscale(image.convert("RGB"))
    # The board crop is almost white. Ignore faint grid lines and keep handwriting.
    mask = gray.point(lambda value: 255 if value < 185 else 0)
    return mask.getbbox()


def _crop_png(image: Image.Image, box: tuple[int, int, int, int]) -> bytes:
    cropped = image.crop(box).convert("RGB")
    longest = max(cropped.size)
    if longest and longest < 1800:
        factor = min(3.0, 1800 / longest)
        cropped = cropped.resize(
            (
                max(1, round(cropped.width * factor)),
                max(1, round(cropped.height * factor)),
            ),
            Image.Resampling.LANCZOS,
        )
    output = io.BytesIO()
    cropped.save(output, format="PNG", optimize=True)
    return output.getvalue()


def _math_zone_crops(image_bytes: bytes) -> list[tuple[str, bytes]]:
    """Create labeled zooms for spatial math OCR.

    The source passed by the board is already one formula cluster.  For tall
    notation such as integrals, roots and fractions, a second view of the upper
    zone, lower zone and baseline substantially reduces role-mixing (e.g. a pi
    from the integrand being mistaken for an integration limit).
    """
    try:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        bbox = _ink_bbox(image)
        if not bbox:
            return []

        left, top, right, bottom = bbox
        width = max(1, right - left)
        height = max(1, bottom - top)
        margin_x = max(8, round(width * 0.04))
        margin_y = max(8, round(height * 0.05))
        left = max(0, left - margin_x)
        right = min(image.width, right + margin_x)
        top = max(0, top - margin_y)
        bottom = min(image.height, bottom + margin_y)
        width = max(1, right - left)
        height = max(1, bottom - top)

        # Limits live close to the integral sign, which is normally in the
        # left half of the formula. Give them a generous left-side crop.
        limits_right = min(right, left + round(width * 0.55))
        upper_bottom = min(bottom, top + round(height * 0.48))
        lower_top = max(top, top + round(height * 0.48))

        # Baseline/integrand gets almost the full width but trims extreme
        # superscript/subscript whitespace so characters are larger.
        main_top = max(top, top + round(height * 0.22))
        main_bottom = min(bottom, top + round(height * 0.82))

        crops: list[tuple[str, bytes]] = []
        boxes = [
            ("Увеличение верхней зоны / верхнего предела", (left, top, limits_right, upper_bottom)),
            ("Увеличение нижней зоны / нижнего предела", (left, lower_top, limits_right, bottom)),
            ("Увеличение основной строки / интегранда", (left, main_top, right, main_bottom)),
        ]
        for label, box in boxes:
            x0, y0, x1, y1 = box
            if x1 - x0 < 12 or y1 - y0 < 12:
                continue
            crops.append((label, _crop_png(image, box)))
        return crops
    except Exception as exc:  # noqa: BLE001
        logger.debug("OCR math zone crops skipped: %s", exc)
        return []


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
    extra_images: list[tuple[str, bytes]] | None = None,
) -> str:
    images = [("Полное изображение", image_bytes), *(extra_images or [])]

    if base_url:
        content = [{"type": "text", "text": prompt}]
        for label, payload in images:
            content.append({"type": "text", "text": label})
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": _data_url(payload)},
                }
            )
        response = client.chat.completions.create(
            model=settings.ocr_model,
            messages=[{"role": "user", "content": content}],
            max_tokens=1200,
            temperature=0,
        )
        text = response.choices[0].message.content
    else:
        if not hasattr(client, "responses"):
            raise RuntimeError(
                "OpenAI SDK слишком старый. Обновите пакет openai до версии с Responses API."
            )
        content = [{"type": "input_text", "text": prompt}]
        for label, payload in images:
            content.append({"type": "input_text", "text": label})
            content.append({"type": "input_image", "image_url": _data_url(payload)})
        response = client.responses.create(
            model=settings.ocr_model,
            input=[{"role": "user", "content": content}],
            max_output_tokens=1200,
        )
        text = response.output_text
    return _normalize_ocr_text(text)


def _integral_spatial_prompt(candidates: list[str]) -> str:
    rendered = "\\n".join(
        f"Кандидат {index + 1}: {candidate}"
        for index, candidate in enumerate(candidates[-3:])
    )
    return (
        "Это пространственная OCR-проверка ОДНОГО рукописного интеграла. "
        "Полное изображение и увеличенные зоны относятся к ОДНОЙ И ТОЙ ЖЕ формуле. "
        "Не решай и не упрощай выражение. Не доверяй кандидатам, если они противоречат изображению. "
        "Определи четыре независимых поля: "
        "1) lower_limit — только то, что написано у НИЖНЕГО предела интеграла; "
        "2) upper_limit — только то, что написано у ВЕРХНЕГО предела, включая дроби, корни, pi и знаки; "
        "3) integrand — ВСЁ выражение основной строки между знаком интеграла и dx/dy, "
        "не пропуская функции sin/cos/tan, коэффициенты, корни, степени и знаки; "
        "4) differential — dx, dy или другой реально видимый дифференциал. "
        "Особенно проверь, не потеряны ли cos/sin перед корнем и числовой коэффициент перед x^n. "
        "Если верхний предел является дробью, сохрани числитель и знаменатель как (числитель)/(знаменатель). "
        "Верни СТРОГО один JSON без markdown: "
        '{"lower_limit":"...","upper_limit":"...","integrand":"...","differential":"dx"}. '
        "Используй pi для π, sqrt(...) для корней, ^ для степеней. "
        "Для реально неразборчивого ОДНОГО символа используй ?, но не выбрасывай остальное.\\n\\n"
        + rendered
    )


def _extract_json_object(text: str) -> dict[str, str] | None:
    value = (text or "").strip()
    match = re.search(r"\{.*\}", value, flags=re.S)
    if not match:
        return None
    try:
        import json
        parsed = json.loads(match.group(0))
    except Exception:
        return None
    if not isinstance(parsed, dict):
        return None
    result: dict[str, str] = {}
    for key in ("lower_limit", "upper_limit", "integrand", "differential"):
        raw = parsed.get(key)
        if raw is None:
            continue
        result[key] = str(raw).strip()
    return result


def _integral_from_spatial_response(text: str) -> str:
    parsed = _extract_json_object(text)
    if not parsed:
        return ""
    lower = parsed.get("lower_limit", "").strip()
    upper = parsed.get("upper_limit", "").strip()
    integrand = parsed.get("integrand", "").strip()
    differential = parsed.get("differential", "").strip()
    if not integrand or not re.fullmatch(r"d[A-Za-z]", differential):
        return ""
    if not lower:
        lower = "?"
    if not upper:
        upper = "?"
    return rf"\int_{{{lower}}}^{{{upper}}} ({integrand}) {differential}"

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
                if _INTEGRAL_RE.search(best):
                    spatial_raw = _request_ocr(
                        client,
                        prompt=_integral_spatial_prompt(candidates),
                        image_bytes=png_bytes,
                        base_url=base_url,
                        extra_images=_math_zone_crops(contrast or png_bytes),
                    )
                    spatial = _integral_from_spatial_response(spatial_raw)
                    if _usable_ocr_text(spatial):
                        candidates.append(spatial)
                        logger.info("Integral OCR accepted spatially reconstructed result")
                        return spatial
                else:
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
