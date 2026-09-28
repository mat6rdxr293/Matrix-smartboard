"""Проверка математики в заданиях урока через SymPy.

4B-модель на CPU ошибается в расчётах: «первообразная для x² — x³ + C», «10 / 4 = 2,4».
Проверяем то, что можно проверить автоматически, и дописываем в задание поле
check = {"status": ..., "note": ...}:

    ok          — ответ проверен и верен;
    fixed       — ответ был неверен и исправлен (в note — что было);
    wrong       — ошибка найдена, но исправить автоматически нельзя;
    unverified  — задание с формулами, которое проверить не удалось (нужен взгляд учителя).

Задания без формул и расчётов (обычные вопросы по тексту) поле check не получают.

Что умеем: первообразная / неопределённый интеграл, производная (вопрос вида «f(x) = … — найдите …»
или «∫ … dx»), а также цепочки чистой арифметики в ходе решения («a = 10 / 2 = 5»).

    python scripts/mathcheck.py data/lessons/<урок>.json     # проверить готовый урок и показать итог
"""
import json
import re
import sys

import sympy as sp
from sympy.parsing.sympy_parser import (convert_xor, implicit_multiplication_application, parse_expr,
                                        standard_transformations)

X = sp.Symbol("x")
TRANSFORMS = standard_transformations + (implicit_multiplication_application, convert_xor)
LOCALS = {"x": X, "e": sp.E, "pi": sp.pi, "tg": sp.tan, "ctg": sp.cot, "ln": sp.log, "sqrt": sp.sqrt,
          "sin": sp.sin, "cos": sp.cos, "tan": sp.tan, "cot": sp.cot, "log": sp.log, "exp": sp.exp}

KW_ANTI = ("первообразн", "интеграл", "∫", "antiderivative", "integral", "алғашқы функция")
KW_DERIV = ("производн", "derivative", "туынды")
# «функцию, производная которой равна f(x)» — это вопрос о первообразной, хотя в нём есть «производная»
ANTI_PHRASE = re.compile(r"производн\w* котор|whose derivative|туындысы\s+\S+\s+тең болатын")
SUP = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹⁻", "0123456789-")
SUP_RE = re.compile(r"([⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+)")
TO_SUP = str.maketrans("0123456789-", "⁰¹²³⁴⁵⁶⁷⁸⁹⁻")


# ───────────── разбор формул, записанных Unicode-текстом ─────────────

def to_sympy(s):
    """«(1/2)x² + C», «F(x) = 4x³/3», «√x», «2·sin 3x» → выражение SymPy (без константы C) или None."""
    s = s.strip().rstrip(".;")
    s = re.sub(r"^\s*(?:[A-Za-zА-Яа-я]\s*\(\s*x\s*\)|y)\s*=\s*", "", s)   # «F(x) =», «y =»
    s = re.sub(r"\s*[+-]\s*[CС]\b\s*$", "", s)                               # «+ C» (и кириллическая С)
    if re.search(r"[А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]", s):
        return None                                                         # в строке слова, а не формула
    s = SUP_RE.sub(lambda m: "^(" + m.group(1).translate(SUP) + ")", s)
    s = (s.replace("·", "*").replace("×", "*").replace("−", "-").replace("–", "-").replace(":", "/")
         .replace("π", "pi").replace(",", "."))
    s = re.sub(r"√\s*\(", "sqrt(", s)
    s = re.sub(r"√\s*([A-Za-z0-9.]+)", r"sqrt(\1)", s)
    s = re.sub(r"\b(sin|cos|tg|ctg|tan|cot|ln|log)\s+([0-9]*x)\b", r"\1(\2)", s)   # «sin 3x» → sin(3x)
    if not s or re.search(r"[^\w\s+\-*/^().]", s):
        return None
    try:
        expr = parse_expr(s, local_dict=LOCALS, transformations=TRANSFORMS, evaluate=True)
    except Exception:  # noqa: BLE001 — модель пишет что угодно; не разобрали — значит не проверяем
        return None
    return expr if isinstance(expr, sp.Expr) and expr.free_symbols <= {X} else None


def to_text(expr):
    """Выражение SymPy → текст в стиле урока: 4·x³/3."""
    s = sp.sstr(expr).replace("**", "^")
    s = re.sub(r"\^\(?(-?\d+)\)?", lambda m: m.group(1).translate(TO_SUP), s)
    return s.replace("*", "·").replace("sqrt", "√")


def longest_formula(text):
    """Самое длинное начало текста, которое разбирается как формула: «x² на промежутке (0; 1)?» → x².
    Возвращает (выражение, исходный кусок текста) или (None, None)."""
    words = re.split(r"(?<=\S)\s+(?=\S)", text)
    for k in range(len(words), 0, -1):
        chunk = " ".join(words[:k]).rstrip("?,.;")
        expr = to_sympy(chunk)
        if expr is not None:
            return expr, chunk
    return None, None


def find_function(question):
    """Функция из условия: «f(x) = …» или «∫ … dx»."""
    m = re.search(r"∫\s*(.+?)\s*d\s*x", question)
    if m:
        return to_sympy(m.group(1))
    m = re.search(r"\b[fyg]\s*\(\s*x\s*\)\s*=\s*(.+)", question) or re.search(r"\by\s*=\s*(.+)", question)
    return longest_formula(m.group(1))[0] if m else None


def formula_in_answer(answer):
    """Формула внутри текстового ответа: «Функция F(x) = (2/3)x³ + C, где C — …» → ((2/3)x³, «(2/3)x³ + C»)."""
    m = re.search(r"\b[A-Za-z]\s*\(\s*x\s*\)\s*=\s*(.+)", answer)
    if not m:
        return None, None
    expr, chunk = longest_formula(m.group(1))
    if expr is None:
        return None, None
    tail = re.match(r"\s*\+\s*[CС]\b", m.group(1)[len(chunk):])  # «+ C» после формулы — тоже часть ответа
    return expr, chunk + (tail.group(0) if tail else "")


def same(a, b):
    try:
        return sp.simplify(a - b) == 0
    except Exception:  # noqa: BLE001
        return False


def is_correct(kind, f, candidate):
    if kind == "anti":  # первообразная определена с точностью до константы
        return same(sp.diff(candidate, X), f)
    return same(candidate, sp.diff(f, X))


def reference(kind, f):
    return sp.integrate(f, X) if kind == "anti" else sp.diff(f, X)


# ───────────── арифметика в ходе решения ─────────────

NUM = r"-?\d+(?:[.,]\d+)?"
CHAIN = re.compile(rf"(?<![\w.,]){NUM}(?:\s*[-+*/·×:]\s*\(?{NUM}\)?)+(?:\s*=\s*{NUM})+(?![\w.,])")


def check_arithmetic(text):
    """Цепочки вида «2 · 0,2 · 0,04 = 0,016». Возвращает (сколько проверено, список ошибок)."""
    errors, checked = [], 0
    for m in CHAIN.finditer(text):
        parts = [p.strip() for p in m.group(0).split("=")]
        try:
            values = [float(sp.sympify(p.replace(",", ".").replace("·", "*").replace("×", "*").replace(":", "/")))
                      for p in parts]
        except Exception:  # noqa: BLE001
            continue
        checked += 1
        for p, v in zip(parts[1:], values[1:]):
            # допускаем округление: 0.5% или последний знак записанного числа
            decimals = len(p.split(",")[-1].split(".")[-1]) if re.search(r"[.,]", p) else 0
            if abs(v - values[0]) > max(abs(values[0]) * 0.005, 0.5 * 10 ** -decimals):
                errors.append(f"{parts[0]} = {values[0]:.4g}, а не {p}")
    return checked, errors


# ───────────── проверка задания ─────────────

def check_task(t):
    q = t["question"]
    ql = q.lower()
    kind = ("anti" if any(k in ql for k in KW_ANTI) or ANTI_PHRASE.search(ql)
            else "deriv" if any(k in ql for k in KW_DERIV) else None)
    f = find_function(q) if kind else None
    notes, status = [], None

    if f is not None and t["type"] == "test":
        parsed = [to_sympy(o) for o in t["options"]]
        if all(p is not None for p in parsed):
            good = [o for o, p in zip(t["options"], parsed) if is_correct(kind, f, p)]
            ref = to_text(reference(kind, f))
            if t["answer"] in good:
                status = "ok"
            elif good:
                notes.append(f"модель отметила «{t['answer']}», верный вариант — «{good[0]}»")
                t["answer"], status = good[0], "fixed"
            else:
                fixed = ("F(x) = " if kind == "anti" else "") + ref + (" + C" if kind == "anti" else "")
                notes.append(f"среди вариантов не было верного; «{t['answer']}» заменён на «{fixed}»")
                t["options"] = [fixed if o == t["answer"] else o for o in t["options"]]
                t["answer"], status = fixed, "fixed"
    elif f is not None and t["type"] in ("calc", "open"):
        ans, chunk = to_sympy(t["answer"]), t["answer"]
        if ans is None:  # ответ словами с формулой внутри
            ans, chunk = formula_in_answer(t["answer"])
        if ans is not None:
            if is_correct(kind, f, ans):
                status = "ok"
            else:
                ref = to_text(reference(kind, f)) + (" + C" if kind == "anti" else "")
                notes.append(f"в ответе было «{chunk.strip()}», правильно: {ref}")
                t["answer"], status = t["answer"].replace(chunk, ref, 1), "fixed"

    checked, arith = check_arithmetic(" ".join([t.get("solution", ""), t["answer"]]))
    if arith:
        notes += [f"арифметика: {e}" for e in arith]
        status = "wrong" if status != "fixed" else status
    elif t["type"] == "calc" and status is None:
        # вычисления сходятся, но верны ли формулы и подстановка — автоматически не сказать
        if checked:
            notes.append("арифметика в решении сходится, формулы проверьте")
        status = "unverified"

    if status is None and f is not None:
        status = "unverified"
    if status:
        t["check"] = {"status": status, "note": "; ".join(notes)}
    return t


def check_tasks(tasks):
    return [check_task(t) for t in tasks]


def main():
    path = sys.argv[1]
    d = json.load(open(path, encoding="utf-8"))
    for t in check_tasks(d.get("tasks", [])):
        c = t.get("check")
        print(f"[{c['status'] if c else '—':10}] {t['type']:4} {t['question'][:70]}"
              + (f"\n             {c['note']}" if c and c["note"] else ""))


if __name__ == "__main__":
    main()
