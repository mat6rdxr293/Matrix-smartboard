import io

from pptx import Presentation

from app.pptx_export import export_pptx


def test_export_preserves_generated_slide_background_and_font_weight():
    blob = export_pptx(
        [
            {
                "id": 1,
                "title": "Ускорение",
                "content": "",
                "notes": "",
                "backgroundColor": "#0A0E14",
                "elements": [
                    {
                        "id": "title",
                        "type": "text",
                        "x": 78,
                        "y": 48,
                        "w": 805,
                        "h": 64,
                        "text": "Ускорение",
                        "fontSize": 31,
                        "fontFamily": "Montserrat",
                        "fontWeight": "semibold",
                        "color": "#F4F7FB",
                        "align": "left",
                    }
                ],
            }
        ]
    )

    prs = Presentation(io.BytesIO(blob))
    slide = prs.slides[0]
    assert str(slide.background.fill.fore_color.rgb) == "0A0E14"
    text_shape = next(shape for shape in slide.shapes if shape.has_text_frame and shape.text.strip())
    run = text_shape.text_frame.paragraphs[0].runs[0]
    assert run.text == "Ускорение"
    assert run.font.bold is True


def test_export_math_element_uses_plain_fallback_text():
    blob = export_pptx(
        [
            {
                "id": 1,
                "title": "Интеграл",
                "content": "",
                "notes": "",
                "backgroundColor": "#0A0E14",
                "elements": [
                    {
                        "id": "formula",
                        "type": "math",
                        "x": 80,
                        "y": 120,
                        "w": 800,
                        "h": 80,
                        "latex": r"\int_0^1 x^2\,dx = \frac{1}{3}",
                        "fallbackText": "∫₀¹ x² dx = 1/3",
                        "fontSize": 30,
                        "color": "#F4F7FB",
                        "align": "center",
                        "display": True,
                    }
                ],
            }
        ]
    )

    prs = Presentation(io.BytesIO(blob))
    slide = prs.slides[0]
    text_shape = next(shape for shape in slide.shapes if shape.has_text_frame and shape.text.strip())
    assert text_shape.text.strip() == "∫₀¹ x² dx = 1/3"
