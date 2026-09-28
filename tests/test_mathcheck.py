"""Проверка математики в заданиях (mathcheck.py): разбор формул, исправление ответов, арифметика.

    python -m unittest discover tests -v
"""
import sys
import unittest
from pathlib import Path

import sympy as sp

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from mathcheck import X, check_arithmetic, check_task, to_sympy  # noqa: E402


def test(question, options, answer):
    return {"type": "test", "question": question, "options": options, "answer": answer, "level": 2}


class ParseTest(unittest.TestCase):
    def test_unicode_formulas(self):
        self.assertEqual(to_sympy("F(x) = 4·x³/3 + C"), 4 * X**3 / 3)
        self.assertEqual(to_sympy("(1/2)x² + С"), X**2 / 2)          # кириллическая С
        self.assertEqual(to_sympy("√x"), sp.sqrt(X))
        self.assertEqual(to_sympy("2sin 3x"), 2 * sp.sin(3 * X))
        self.assertEqual(to_sympy("x⁻¹"), 1 / X)

    def test_words_are_not_formulas(self):
        self.assertIsNone(to_sympy("На постоянную величину"))
        self.assertIsNone(to_sympy("Совокупность параллельных кривых"))


class TaskTest(unittest.TestCase):
    def test_no_correct_option_is_fixed(self):
        # реальная ошибка модели в уроке по алгебре §1
        t = check_task(test("Какая из функций является первообразной для функции f(x) = x²?",
                            ["F(x) = x + C", "F(x) = 3x² + C", "F(x) = (1/2)x² + C", "F(x) = x³ + C"],
                            "F(x) = x³ + C"))
        self.assertEqual(t["check"]["status"], "fixed")
        self.assertEqual(to_sympy(t["answer"]), X**3 / 3)
        self.assertIn(t["answer"], t["options"])
        self.assertNotIn("F(x) = x³ + C", t["options"])

    def test_wrong_option_marked_is_switched(self):
        t = check_task(test("Найдите первообразную для функции f(x) = 4x³ на промежутке (0; 1).",
                            ["x⁴ + C", "4x⁴ + C", "12x² + C", "x³ + C"], "4x⁴ + C"))
        self.assertEqual((t["check"]["status"], t["answer"]), ("fixed", "x⁴ + C"))

    def test_correct_integral(self):
        t = check_task(test("Найдите ∫ cos(3x) dx", ["-(1/3)cos(3x) + C", "(1/3)sin(3x) + C", "3sin(3x) + C",
                                                   "sin(3x) + C"], "(1/3)sin(3x) + C"))
        self.assertEqual(t["check"]["status"], "ok")

    def test_derivative_calc(self):
        t = check_task({"type": "calc", "question": "Найдите производную функции f(x) = x³ − 2x",
                        "solution": "f'(x) = 3x² − 2", "answer": "3x²", "level": 1})
        self.assertEqual(t["check"]["status"], "fixed")
        self.assertEqual(to_sympy(t["answer"]), 3 * X**2 - 2)

    def test_formula_inside_text_answer_is_fixed(self):
        # реальная ошибка модели: для f(x) = 4x² ответ «(2/3)x³ + C» вместо 4x³/3
        t = check_task({"type": "open", "level": 2,
                        "question": "Дана функция f(x) = 4x². Найдите функцию F(x), производная которой равна f(x).",
                        "answer": "Функция F(x) = (2/3)x³ + C, где C — произвольное постоянное число."})
        self.assertEqual(t["check"]["status"], "fixed")
        self.assertIn("4·x³/3 + C", t["answer"])
        self.assertTrue(t["answer"].endswith("где C — произвольное постоянное число."))

    def test_arithmetic_error(self):
        t = check_task({"type": "calc", "question": "На тело массой 4 кг действует сила 10 Н. Найдите ускорение.",
                        "solution": "a = F / m = 10 / 4 = 2,4 м/с²", "answer": "2,4 м/с²", "level": 2})
        self.assertEqual(t["check"]["status"], "wrong")
        self.assertIn("2.5", t["check"]["note"])

    def test_physics_calc_with_right_arithmetic_is_unverified(self):
        t = check_task({"type": "calc", "question": "Найдите ЭҚК.", "level": 2, "answer": "251 В",
                        "solution": "Em = N·B·S·ω = 100 · 0,2 · 0,04 · 314 = 251 В"})
        self.assertEqual(t["check"]["status"], "unverified")
        self.assertIn("сходится", t["check"]["note"])

    def test_text_questions_get_no_check(self):
        self.assertNotIn("check", check_task(test("В каком году основано Казахское ханство?",
                                                  ["1465", "1456", "1511", "1731"], "1465")))
        self.assertNotIn("check", check_task({"type": "open", "level": 1, "answer": "На постоянную C.",
                                              "question": "Чем отличаются две первообразные одной функции?"}))


class ArithmeticTest(unittest.TestCase):
    def test_rounding_is_allowed(self):
        self.assertEqual(check_arithmetic("100 · 0,2 · 0,04 · 314 = 251,2"), (1, []))
        self.assertEqual(check_arithmetic("2 / 3 = 0,67"), (1, []))

    def test_error_found(self):
        n, errors = check_arithmetic("v = 3 · 4 = 14 м/с")
        self.assertEqual(n, 1)
        self.assertEqual(len(errors), 1)


if __name__ == "__main__":
    unittest.main()
