from __future__ import annotations

import math
import re
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

SLIDE_WIDTH = 960
SLIDE_HEIGHT = 540
SAFE_MARGIN = 35
CONTRACT_VERSION = "1.0"

_HEX_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")
_LATEX_MARKERS = re.compile(
    r"(?:\$[^$]+\$|\\[A-Za-z]+\b|\^\s*(?:\{[^}]+\}|[A-Za-z0-9.+-]+)|_\s*(?:\{[^}]+\}|[A-Za-z0-9]+))"
)


def _color(value: str) -> str:
    if not _HEX_COLOR.fullmatch(value):
        raise ValueError("Цвет должен быть в формате #RRGGBB")
    return value.upper()


def _unicode_text(value: str, *, field_name: str) -> str:
    if _LATEX_MARKERS.search(value):
        raise ValueError(
            f"{field_name}: LaTeX запрещён. Используйте Unicode, например Φ = B·S·cos α или a²."
        )
    return value


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LessonTheme(ContractModel):
    backgroundColor: str = "#F7F8FA"
    primaryColor: str = "#2563EB"
    textColor: str = "#111827"
    mutedTextColor: str = "#6B7280"
    fontFamily: str = "Aptos"

    @model_validator(mode="after")
    def validate_colors(self) -> "LessonTheme":
        for field in ("backgroundColor", "primaryColor", "textColor", "mutedTextColor"):
            object.__setattr__(self, field, _color(getattr(self, field)))
        return self


class PositionedElement(ContractModel):
    id: str = Field(min_length=1, max_length=120)
    x: float
    y: float
    width: float = Field(gt=0)
    height: float = Field(gt=0)
    rotation: float = Field(default=0, ge=-360, le=360)

    def bounds(self) -> tuple[float, float, float, float]:
        if self.rotation == 0:
            return (self.x, self.y, self.x + self.width, self.y + self.height)
        radians = math.radians(self.rotation)
        half_w = self.width / 2
        half_h = self.height / 2
        extent_x = abs(half_w * math.cos(radians)) + abs(half_h * math.sin(radians))
        extent_y = abs(half_w * math.sin(radians)) + abs(half_h * math.cos(radians))
        center_x = self.x + half_w
        center_y = self.y + half_h
        return (center_x - extent_x, center_y - extent_y, center_x + extent_x, center_y + extent_y)

    @model_validator(mode="after")
    def validate_safe_area(self) -> "PositionedElement":
        left, top, right, bottom = self.bounds()
        if left < SAFE_MARGIN or top < SAFE_MARGIN:
            raise ValueError(f"Элемент должен быть не ближе {SAFE_MARGIN}px к краю слайда")
        if right > SLIDE_WIDTH - SAFE_MARGIN:
            raise ValueError(f"Элемент выходит за правую безопасную границу {SLIDE_WIDTH - SAFE_MARGIN}px")
        if bottom > SLIDE_HEIGHT - SAFE_MARGIN:
            raise ValueError(f"Элемент выходит за нижнюю безопасную границу {SLIDE_HEIGHT - SAFE_MARGIN}px")
        return self


class TextElement(PositionedElement):
    type: Literal["text"]
    text: str = Field(min_length=1)
    fontSize: float = Field(gt=0)
    color: str | None = None
    fontFamily: str | None = None
    fontWeight: Literal["normal", "medium", "semibold", "bold"] | None = None
    align: Literal["left", "center", "right"] | None = None

    @model_validator(mode="after")
    def validate_text(self) -> "TextElement":
        _unicode_text(self.text, field_name=f"text element {self.id}")
        if self.color is not None:
            self.color = _color(self.color)
        return self


class ShapeElement(PositionedElement):
    type: Literal["shape"]
    shape: Literal["rect", "round", "ellipse"]
    fillColor: str
    strokeColor: str | None = None
    strokeWidth: float | None = Field(default=None, ge=0)
    cornerRadius: float | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_shape(self) -> "ShapeElement":
        self.fillColor = _color(self.fillColor)
        if self.strokeColor is not None:
            self.strokeColor = _color(self.strokeColor)
        return self


class ImageElement(PositionedElement):
    type: Literal["image"]
    page: int = Field(ge=1, description="Физическая страница PDF, нумерация с 1")
    image_index: int | None = Field(ge=0, description="Индекс изображения на странице с 0; null, если модель не уверена")


SlideElement = Annotated[Union[TextElement, ShapeElement, ImageElement], Field(discriminator="type")]


def _intersects(a: PositionedElement, b: PositionedElement) -> bool:
    a_left, a_top, a_right, a_bottom = a.bounds()
    b_left, b_top, b_right, b_bottom = b.bounds()
    return a_left < b_right and a_right > b_left and a_top < b_bottom and a_bottom > b_top


class GeneratedSlide(ContractModel):
    id: str = Field(min_length=1, max_length=120)
    title: str = Field(min_length=1)
    elements: list[SlideElement] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_elements(self) -> "GeneratedSlide":
        _unicode_text(self.title, field_name=f"slide {self.id}.title")
        ids = [element.id for element in self.elements]
        if len(ids) != len(set(ids)):
            raise ValueError(f"Слайд {self.id}: id элементов должны быть уникальными")

        # Array order is the z-order. Earlier elements are rendered below later ones.
        for left_index, left in enumerate(self.elements):
            for right_index in range(left_index + 1, len(self.elements)):
                right = self.elements[right_index]
                if not _intersects(left, right):
                    continue

                left_content = left.type in {"text", "image"}
                right_content = right.type in {"text", "image"}
                if left_content and right_content:
                    raise ValueError(
                        f"Слайд {self.id}: элементы {left.id} и {right.id} пересекаются. "
                        "text/image не должны пересекаться друг с другом."
                    )

                # A shape may be a card/background, but it must be below the content it overlaps.
                if left_content and right.type == "shape":
                    raise ValueError(
                        f"Слайд {self.id}: shape {right.id} перекрывает {left.id}. "
                        "Подложка должна находиться раньше содержимого в elements."
                    )
        return self


class BaseTask(ContractModel):
    id: str = Field(min_length=1, max_length=120)
    question: str = Field(min_length=1)
    answer: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_unicode(self) -> "BaseTask":
        _unicode_text(self.question, field_name=f"task {self.id}.question")
        _unicode_text(self.answer, field_name=f"task {self.id}.answer")
        return self


class TestTask(BaseTask):
    type: Literal["test"]
    options: list[str] = Field(min_length=2)

    @model_validator(mode="after")
    def validate_test(self) -> "TestTask":
        for index, option in enumerate(self.options):
            _unicode_text(option, field_name=f"task {self.id}.options[{index}]")
        if len(set(self.options)) != len(self.options):
            raise ValueError(f"Задание {self.id}: варианты ответа должны быть уникальными")
        if self.answer not in self.options:
            raise ValueError(f"Задание {self.id}: answer должен дословно совпадать с одним из options")
        return self


class CalcTask(BaseTask):
    type: Literal["calc"]
    solution: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_solution(self) -> "CalcTask":
        _unicode_text(self.solution, field_name=f"task {self.id}.solution")
        return self


GeneratedTask = Annotated[Union[TestTask, CalcTask], Field(discriminator="type")]


class GeneratedLesson(ContractModel):
    contractVersion: Literal["1.0"] = CONTRACT_VERSION
    theme: LessonTheme
    slides: list[GeneratedSlide] = Field(min_length=1)
    tasks: list[GeneratedTask] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_ids(self) -> "GeneratedLesson":
        slide_ids = [slide.id for slide in self.slides]
        if len(slide_ids) != len(set(slide_ids)):
            raise ValueError("id слайдов должны быть уникальными")
        task_ids = [task.id for task in self.tasks]
        if len(task_ids) != len(set(task_ids)):
            raise ValueError("id заданий должны быть уникальными")
        return self


MODEL_RULES = [
    "Слайд имеет размер 960×540. Все элементы находятся не ближе 35 px к краям.",
    "elements — это порядок слоёв: первый элемент рисуется снизу, последний сверху.",
    "text и image не пересекаются друг с другом. shape может лежать под ними как карточка или фон.",
    "Если shape пересекает text/image, shape должен стоять раньше этого элемента в elements.",
    "Формулы во всех видимых строках задаются Unicode-текстом, не LaTeX: Φ = B·S·cos α, a², ω.",
    "page — физический номер страницы PDF с 1. image_index — индекс изображения на этой странице с 0; null означает, что модель не уверена.",
    "Явный стиль элемента имеет приоритет над theme. Отсутствующие color/fontFamily у text наследуются из theme.",
    "Цвет элемента не обязан дословно совпадать с палитрой theme, но theme должна оставаться основной палитрой.",
    "Для test answer дословно совпадает с одним из options. Для calc обязательно поле solution.",
    "Разрешены только примитивы text, shape и image. В v1 нет градиентного фона и специальных 'card/formulaBlock/hero' элементов.",
]


def resolved_lesson_payload(lesson: GeneratedLesson) -> dict:
    payload = lesson.model_dump(mode="json")
    theme = lesson.theme
    for slide in payload["slides"]:
        for element in slide["elements"]:
            if element["type"] != "text":
                continue
            if element.get("color") is None:
                element["color"] = theme.textColor
            if element.get("fontFamily") is None:
                element["fontFamily"] = theme.fontFamily
    return payload


def contract_payload() -> dict:
    return {
        "version": CONTRACT_VERSION,
        "canvas": {"width": SLIDE_WIDTH, "height": SLIDE_HEIGHT, "safeMargin": SAFE_MARGIN},
        "rules": MODEL_RULES,
        "schema": GeneratedLesson.model_json_schema(),
    }
