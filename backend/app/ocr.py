from __future__ import annotations

import base64
import logging

from openai import OpenAI

from .settings import get_openai_key, settings

logger = logging.getLogger(__name__)

def ocr_image(png_bytes: bytes) -> str:
    api_key = get_openai_key()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")

    client = OpenAI(api_key=api_key, timeout=settings.ai_timeout_seconds)
    data_url = "data:image/png;base64," + base64.b64encode(png_bytes).decode("utf-8")
    prompt = (
        "Только транскрибируй рукописный текст и формулы в обычный текст. "
        "Без решения и без пояснений. Если неразборчиво — напиши 'Не разобрал, пожалуйста напишите более разборчиво.'."
    )

    try:
        if not hasattr(client, "responses"):
            raise RuntimeError("OpenAI SDK слишком старый. Обновите пакет openai до версии с Responses API.")

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
            max_output_tokens=1000,
        )
        text = response.output_text
        return text.strip() if text else ""
    except Exception as exc:  # noqa: BLE001
        logger.warning("OCR failed: %s", exc)
        raise
