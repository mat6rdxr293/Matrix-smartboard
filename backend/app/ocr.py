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
        "Только транскрибируй всё, что написано на доске: текст, числа и формулы. "
        "Не решай задачу и не добавляй пояснений. Сохраняй знаки +, -, =, дроби, степени и скобки. "
        "Если один символ сомнителен, поставь ? только вместо него, но всё остальное обязательно перепиши."
    ),
    (
        "Внимательно перечитай изображение построчно. Верни максимально точную транскрипцию видимого текста и формул. "
        "Не отказывайся от всего изображения из-за одного неясного символа: сомнительное место отметь знаком ?. "
        "Без решения, комментариев и вступления."
    ),
    (
        "Сделай повторное OCR школьной доски. Сначала мысленно отдели строки друг от друга, затем перепиши их по порядку. "
        "Формулы передавай обычным математическим текстом, например x^2 - 4x + 5 = 0. "
        "Ничего не решай. Не пиши, что не можешь распознать; используй ? для отдельных неясных символов."
    ),
)


def _usable_ocr_text(text: str | None) -> bool:
    value = (text or "").strip()
    if len(value) < 2:
        return False
    if _OCR_FAILURE_RE.search(value):
        return False
    meaningful = sum(ch.isalnum() or ch in "+-=^/()√×·" for ch in value)
    return meaningful >= 2


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

    last_text = ""
    errors: list[str] = []

    for attempt, prompt in enumerate(_OCR_PROMPTS):
        image_bytes = variants[min(attempt, len(variants) - 1)]
        data_url = _data_url(image_bytes)
        try:
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

            candidate = text.strip() if text else ""
            if _usable_ocr_text(candidate):
                if attempt:
                    logger.info("OCR recovered on retry %s", attempt + 1)
                return candidate

            last_text = candidate
            errors.append(candidate or "empty response")
        except Exception as exc:  # noqa: BLE001
            errors.append(str(exc))
            logger.warning("OCR attempt %s failed: %s", attempt + 1, exc)

    logger.warning("OCR exhausted retries: %s", errors)
    if last_text and _usable_ocr_text(last_text):
        return last_text
    raise RuntimeError(
        "Не удалось надежно распознать запись после нескольких попыток. "
        "Попробуйте написать чуть крупнее или очистить лишние линии вокруг задачи."
    )
