"""Определение языка текста учебника (extract_pdf.lang_guess).

    source venv/bin/activate
    python -m unittest discover tests -v
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from extract_pdf import lang_guess, strip_formulas  # noqa: E402

# Русская алгебра после Tesseract: казахские і, ә, Ә вместо i, а, д — шум OCR, язык русский
RU_ALGEBRA_OCR = (
    "ГЛАВА І ПЕРВООБРАЗНАЯ И ИНТЕГРАЛ. Функция F(x) = x³ является первообразной для функции "
    "f(x) = 3x² на всей числовой прямой, так как F'(x) = f(x). Нетрудно заметить, что первообразная "
    "функции определяется неоднозначно: F(x) = x³ + С. Найдіте первообразную для функции "
    "f(x) = 4x - 1, график которой проходит через точку М(1; 2). Решение: Ә) F(x) = 2x² - x + C."
)

# Казахская физика от модели со зрением: формулы в LaTeX, латиницы в них больше, чем кириллицы в тексте
KK_PHYSICS_LATEX = (
    "Рамка біркелкі айналғанда магнит ағыны өзгереді: $$\\Phi = B S \\cos\\alpha$$ "
    "Мұндағы $B$ — магнит индукциясы, $S$ — рамканың ауданы, $\\alpha$ — бұрыш. "
    "$$\\mathcal{E} = -\\frac{\\Delta\\Phi}{\\Delta t} = B S \\omega \\sin\\omega t = "
    "\\mathcal{E}_m \\sin\\omega t, \\quad \\mathcal{E}_m = B S \\omega$$ "
    "$$\\omega = 2\\pi \\nu, \\quad \\nu = \\frac{n p}{60}, \\quad T = \\frac{1}{\\nu}$$"
)

# Казахская физика после Tesseract: формулы без разметки, переменные и единицы — простой латиницей
KK_PHYSICS_OCR = (
    "Есеп. B = 0,2 Tl, S = 400 cm2, n = 50 Hz, N = 100 орам. Em = N B S w, "
    "w = 2 pi n = 314 rad/s, Em = 100 * 0,2 * 0,04 * 314 = 251 V. "
    "Жауабы: ЭҚК-тің ең үлкен мәні 251 В."
)

EN_TEXT = (
    "Newton's second law states that the acceleration of a body is directly proportional "
    "to the net force acting on it and inversely proportional to its mass: F = ma."
)

# Английский текст с казахским именем в скобках — это английский, а не казахский
EN_WITH_KK_NAME = (
    "Abai Kunanbayev (Абай Құнанбайұлы) was a great Kazakh poet, composer and philosopher. "
    "He translated Russian and European literature into the Kazakh language."
)

# Русский текст с английскими терминами — русский
RU_WITH_EN_TERMS = (
    "Модель обучается методом QLoRA: вместо всех весов меняется небольшой адаптер. "
    "Термины learning rate и batch size оставляем без перевода, как в документации Unsloth."
)


class LangGuessTest(unittest.TestCase):
    def test_russian_algebra_with_ocr_noise(self):
        self.assertEqual(lang_guess(RU_ALGEBRA_OCR), "ru")

    def test_kazakh_physics_with_latex(self):
        self.assertEqual(lang_guess(KK_PHYSICS_LATEX), "kk")

    def test_kazakh_physics_ocr_formulas(self):
        self.assertEqual(lang_guess(KK_PHYSICS_OCR), "kk")

    def test_english(self):
        self.assertEqual(lang_guess(EN_TEXT), "en")

    def test_english_with_kazakh_name(self):
        self.assertEqual(lang_guess(EN_WITH_KK_NAME), "en")

    def test_russian_with_english_terms(self):
        self.assertEqual(lang_guess(RU_WITH_EN_TERMS), "ru")

    def test_empty_and_formula_only(self):
        self.assertIsNone(lang_guess(""))
        self.assertIsNone(lang_guess("$$E = mc^2$$ \\( F = ma \\)"))

    def test_strip_formulas(self):
        self.assertNotIn("alpha", strip_formulas("угол $\\alpha$ и \\(\\beta\\), \\[x^2\\], \\gamma"))


if __name__ == "__main__":
    unittest.main()
