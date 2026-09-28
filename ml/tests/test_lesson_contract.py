"""Задания в формате контракта v1 (lesson.to_contract) и запрет LaTeX в схеме.

    python -m unittest discover tests -v
"""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from lesson import SCHEMA, TASK_VARIANTS, composition, task_schema, text, to_contract  # noqa: E402

MODEL_TASKS = [
    {"type": "test", "question": "Какая формула выражает второй закон Ньютона?",
     "options": ["F = ma", "F = mv", "p = ma", "A = Fs"], "correct": 0, "level": 1},
    {"type": "calc", "question": "На тело массой 2 кг действует сила 10 Н. Найдите ускорение.",
     "solution": "a = F / m = 10 / 2 = 5 м/с²", "answer": "5 м/с²", "level": 2},
    {"type": "open", "question": "Как ускорение зависит от массы?", "answer": "Обратно пропорционально.", "level": 2},
]


class ContractTest(unittest.TestCase):
    def test_fields(self):
        for t in to_contract(MODEL_TASKS):
            self.assertLessEqual({"type", "question", "options", "answer", "level"}, set(t))
            self.assertNotIn("correct", t)

    def test_test_answer_is_one_of_options(self):
        for seed in range(20):
            t = to_contract(MODEL_TASKS, seed=seed)[0]
            self.assertEqual(t["answer"], "F = ma")
            self.assertIn(t["answer"], t["options"])
            self.assertEqual(sorted(t["options"]), sorted(MODEL_TASKS[0]["options"]))

    def test_options_are_shuffled(self):
        positions = {to_contract(MODEL_TASKS, seed=s)[0]["options"].index("F = ma") for s in range(20)}
        self.assertGreater(len(positions), 1)

    def test_calc_keeps_solution_open_has_no_options(self):
        calc, open_ = to_contract(MODEL_TASKS)[1:]
        self.assertEqual(calc["solution"], "a = F / m = 10 / 2 = 5 м/с²")
        self.assertEqual(calc["options"], [])
        self.assertEqual(open_["options"], [])
        self.assertNotIn("solution", open_)

    def test_solution_generated_before_answer(self):
        calc = next(v for v in TASK_VARIANTS if v["properties"]["type"]["const"] == "calc")
        keys = list(calc["properties"])
        self.assertLess(keys.index("solution"), keys.index("answer"))


class NoLatexPatternTest(unittest.TestCase):
    def setUp(self):
        self.pattern = re.compile(text(20)["pattern"])

    def test_unicode_formula_allowed(self):
        self.assertTrue(self.pattern.match("Φ = B·S·cos α, x²"))

    def test_latex_and_escapes_rejected(self):
        for bad in ("$x^2$", "\\frac{a}{b}", 'кавычка "', "строка\nещё"):
            self.assertIsNone(self.pattern.match(bad), bad)

    def test_length_limit(self):
        self.assertIsNone(self.pattern.match("а" * 21))
        self.assertIsNone(self.pattern.match(""))

    def test_all_strings_in_schema_use_pattern(self):
        def strings(node):
            if isinstance(node, dict):
                if node.get("type") == "string":
                    yield node
                for v in node.values():
                    yield from strings(v)
            elif isinstance(node, list):
                for v in node:
                    yield from strings(v)
        for s in strings([SCHEMA, TASK_VARIANTS]):
            self.assertIn("pattern", s)


class CompositionTest(unittest.TestCase):
    MATH = "F = ma, a = F/m, v = at, s = vt, p = mv, E = mc²"
    HISTORY = "В 1465 году Керей и Жанибек основали Казахское ханство."

    def test_math_gets_calc(self):
        self.assertEqual(composition(6, self.MATH), {"test": 3, "open": 2, "calc": 1})

    def test_history_has_no_calc(self):
        self.assertEqual(composition(6, self.HISTORY), {"test": 4, "open": 2, "calc": 0})

    def test_total_is_n(self):
        for n in range(3, 11):
            for ctx in (self.MATH, self.HISTORY):
                c = composition(n, ctx)
                self.assertEqual(sum(c.values()), n)
                self.assertGreaterEqual(c["test"], 1)

    def test_schema_fixes_order_and_types(self):
        items = task_schema({"test": 2, "open": 1, "calc": 1})["properties"]["tasks"]["prefixItems"]
        self.assertEqual([i["properties"]["type"]["const"] for i in items], ["test", "test", "open", "calc"])


if __name__ == "__main__":
    unittest.main()
