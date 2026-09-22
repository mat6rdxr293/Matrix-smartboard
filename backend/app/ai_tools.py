from __future__ import annotations

import inspect
import json
import re
from dataclasses import dataclass
from functools import reduce
from math import gcd
from typing import Any, Callable, Mapping, Optional

import sympy as sp
from pint import UnitRegistry
from sympy.parsing.sympy_parser import (
    convert_xor,
    implicit_multiplication_application,
    parse_expr,
    standard_transformations,
)

MAX_EXPR_LEN = 500
TRANSFORMS = standard_transformations + (convert_xor, implicit_multiplication_application)
ALLOWED_EXPR = re.compile(r"^[A-Za-z0-9+*/^().,= \t-]+$")
IDENT = re.compile(r"\b[A-Za-z][A-Za-z0-9]*\b")
FUNCTIONS: dict[str, Any] = {
    "sin": sp.sin, "cos": sp.cos, "tan": sp.tan,
    "asin": sp.asin, "acos": sp.acos, "atan": sp.atan,
    "sqrt": sp.sqrt, "exp": sp.exp, "log": sp.log, "ln": sp.log,
    "abs": sp.Abs, "Abs": sp.Abs, "pi": sp.pi, "E": sp.E,
}
UREG = UnitRegistry(autoconvert_offset_to_baseunit=True)


class ToolError(ValueError):
    pass


def _safe_text(value: str) -> str:
    text = (value or "").strip()
    if not text:
        raise ToolError("Пустое выражение")
    if len(text) > MAX_EXPR_LEN:
        raise ToolError("Выражение слишком длинное")
    if "__" in text or not ALLOWED_EXPR.fullmatch(text):
        raise ToolError("В выражении есть неподдерживаемые символы")
    return text


def _expr(value: str) -> sp.Expr:
    text = _safe_text(value)
    if "=" in text:
        raise ToolError("Здесь ожидается выражение без '='")
    local_dict = dict(FUNCTIONS)
    for name in set(IDENT.findall(text)):
        if name not in local_dict:
            if len(name) > 24:
                raise ToolError("Слишком длинное имя переменной")
            local_dict[name] = sp.Symbol(name)
    try:
        result = parse_expr(
            text,
            local_dict=local_dict,
            global_dict={
                "__builtins__": {},
                "Symbol": sp.Symbol,
                "Integer": sp.Integer,
                "Float": sp.Float,
                "Rational": sp.Rational,
            },
            transformations=TRANSFORMS,
            evaluate=True,
        )
    except Exception as exc:
        raise ToolError(f"Не удалось разобрать выражение: {exc}") from exc
    if not isinstance(result, sp.Expr):
        raise ToolError("Некорректное выражение")
    return result


def _equation(value: str) -> sp.Eq:
    text = _safe_text(value)
    if text.count("=") > 1:
        raise ToolError("Поддерживается одно равенство")
    if "=" in text:
        left, right = text.split("=", 1)
        return sp.Eq(_expr(left), _expr(right))
    return sp.Eq(_expr(text), 0)


def _symbol(exprs: list[sp.Expr], variable: Optional[str]) -> sp.Symbol:
    if variable:
        name = variable.strip()
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9]{0,23}", name):
            raise ToolError("Некорректное имя переменной")
        return sp.Symbol(name)
    symbols: set[sp.Symbol] = set()
    for expression in exprs:
        symbols.update(expression.free_symbols)
    if len(symbols) == 1:
        return next(iter(symbols))
    if not symbols:
        raise ToolError("В выражении нет переменной")
    raise ToolError("Укажите variable: в выражении несколько переменных")


def _math(value: Any) -> dict[str, str]:
    return {"text": str(value), "latex": sp.latex(value)}


def math_evaluate(expression: str, substitutions: Optional[Mapping[str, float | int]] = None) -> dict[str, Any]:
    parsed = _expr(expression)
    subs = {sp.Symbol(name): value for name, value in (substitutions or {}).items()}
    exact = sp.simplify(parsed.subs(subs))
    return {
        "expression": _math(parsed),
        "result": _math(exact),
        "approximate": _math(sp.N(exact, 15)),
    }


def math_simplify(expression: str) -> dict[str, Any]:
    parsed = _expr(expression)
    return {"input": _math(parsed), "result": _math(sp.simplify(parsed))}


def math_factor(expression: str) -> dict[str, Any]:
    parsed = _expr(expression)
    return {"input": _math(parsed), "result": _math(sp.factor(parsed))}


def math_expand(expression: str) -> dict[str, Any]:
    parsed = _expr(expression)
    return {"input": _math(parsed), "result": _math(sp.expand(parsed))}


def math_equivalent(expression_a: str, expression_b: str) -> dict[str, Any]:
    left = _expr(expression_a)
    right = _expr(expression_b)
    difference = sp.simplify(left - right)
    return {
        "expression_a": _math(left),
        "expression_b": _math(right),
        "difference": _math(difference),
        "equivalent": bool(difference == 0),
    }


def math_solve(equation: str, variable: Optional[str] = None) -> dict[str, Any]:
    parsed = _equation(equation)
    symbol = _symbol([parsed.lhs, parsed.rhs], variable)
    solutions = sp.solve(parsed, symbol)
    return {
        "equation": {"text": str(parsed), "latex": sp.latex(parsed)},
        "variable": str(symbol),
        "solutions": [_math(item) for item in solutions],
    }




def math_quadratic(equation: str, variable: Optional[str] = None) -> dict[str, Any]:
    parsed = _equation(equation)
    symbol = _symbol([parsed.lhs, parsed.rhs], variable)
    expression = sp.expand(parsed.lhs - parsed.rhs)
    try:
        poly = sp.Poly(expression, symbol)
    except Exception as exc:
        raise ToolError("Не удалось представить уравнение как полином") from exc
    if poly.degree() != 2:
        raise ToolError("Уравнение не является квадратным")

    a, b, c = [sp.simplify(value) for value in poly.all_coeffs()]
    discriminant = sp.simplify(b**2 - 4 * a * c)
    roots = sp.solve(sp.Eq(expression, 0), symbol)
    real_roots = [root for root in roots if root.is_real is not False]
    return {
        "equation": {"text": str(parsed), "latex": sp.latex(parsed)},
        "variable": str(symbol),
        "a": _math(a),
        "b": _math(b),
        "c": _math(c),
        "discriminant": _math(discriminant),
        "discriminant_sign": (
            -1 if discriminant.is_negative else 1 if discriminant.is_positive else 0 if discriminant.is_zero else None
        ),
        "roots": [_math(root) for root in roots],
        "real_roots": [_math(root) for root in real_roots],
        "has_real_roots": bool(real_roots),
    }

def math_differentiate(expression: str, variable: Optional[str] = None, order: int = 1) -> dict[str, Any]:
    if order < 1 or order > 5:
        raise ToolError("Порядок производной должен быть 1..5")
    parsed = _expr(expression)
    symbol = _symbol([parsed], variable)
    return {"input": _math(parsed), "variable": str(symbol), "order": order, "result": _math(sp.diff(parsed, symbol, order))}


def math_integrate(
    expression: str,
    variable: Optional[str] = None,
    lower: Optional[float | int | str] = None,
    upper: Optional[float | int | str] = None,
) -> dict[str, Any]:
    parsed = _expr(expression)
    symbol = _symbol([parsed], variable)
    if (lower is None) != (upper is None):
        raise ToolError("Нужны обе границы интеграла")
    if lower is None:
        result = sp.integrate(parsed, symbol)
        bounds = None
    else:
        low = _expr(str(lower))
        high = _expr(str(upper))
        result = sp.integrate(parsed, (symbol, low, high))
        bounds = [_math(low), _math(high)]
    return {"input": _math(parsed), "variable": str(symbol), "bounds": bounds, "result": _math(result)}


def math_intersections(expression_a: str, expression_b: str, variable: str = "x") -> dict[str, Any]:
    a = _expr(expression_a)
    b = _expr(expression_b)
    symbol = _symbol([a, b], variable)
    roots = sp.solve(sp.Eq(a, b), symbol)
    return {
        "variable": str(symbol),
        "points": [{"x": _math(root), "y": _math(sp.simplify(a.subs(symbol, root)))} for root in roots],
    }



def _relation(value: str):
    text = (value or "").strip()
    if (
        not text
        or len(text) > MAX_EXPR_LEN
        or "__" in text
        or not re.fullmatch(r"[A-Za-z0-9+*/^().,=<>! \t-]+", text)
    ):
        raise ToolError("Некорректное неравенство")
    match = re.search(r"(<=|>=|!=|<|>|=)", text)
    if not match:
        raise ToolError("Ожидалось равенство или неравенство")
    left_text = text[:match.start()].strip()
    right_text = text[match.end():].strip()
    op = match.group(1)
    left = _expr(left_text)
    right = _expr(right_text)
    relation = {
        "<": sp.Lt,
        "<=": sp.Le,
        ">": sp.Gt,
        ">=": sp.Ge,
        "=": sp.Eq,
        "!=": sp.Ne,
    }[op](left, right)
    return relation


def math_solve_system(
    equations: list[str],
    variables: Optional[list[str]] = None,
) -> dict[str, Any]:
    if not equations or len(equations) > 8:
        raise ToolError("Нужно от 1 до 8 уравнений")
    parsed = [_equation(item) for item in equations]
    if variables:
        symbols = [sp.Symbol(name.strip()) for name in variables]
    else:
        symbol_set: set[sp.Symbol] = set()
        for eq in parsed:
            symbol_set.update(eq.lhs.free_symbols)
            symbol_set.update(eq.rhs.free_symbols)
        symbols = sorted(symbol_set, key=lambda item: item.name)
    if not symbols:
        raise ToolError("В системе нет переменных")
    solutions = sp.solve(parsed, symbols, dict=True)
    return {
        "equations": [{"text": str(eq), "latex": sp.latex(eq)} for eq in parsed],
        "variables": [str(symbol) for symbol in symbols],
        "solutions": [
            {
                str(symbol): _math(sp.simplify(solution[symbol]))
                for symbol in symbols
                if symbol in solution
            }
            for solution in solutions
        ],
    }


def math_solve_inequalities(
    inequalities: list[str],
    variable: Optional[str] = None,
) -> dict[str, Any]:
    if not inequalities or len(inequalities) > 8:
        raise ToolError("Нужно от 1 до 8 неравенств")
    relations = [_relation(item) for item in inequalities]
    expressions = []
    for relation in relations:
        expressions.extend([relation.lhs, relation.rhs])
    symbol = _symbol(expressions, variable)
    try:
        if len(relations) == 1:
            result = sp.solve_univariate_inequality(
                relations[0],
                symbol,
                relational=True,
            )
        else:
            result = sp.reduce_inequalities(relations, symbol)
    except Exception as exc:
        raise ToolError(f"Не удалось решить систему неравенств: {exc}") from exc
    return {
        "inequalities": [{"text": str(item), "latex": sp.latex(item)} for item in relations],
        "variable": str(symbol),
        "result": _math(result),
    }


def math_domain(expression: str, variable: Optional[str] = None) -> dict[str, Any]:
    parsed = _expr(expression)
    symbol = _symbol([parsed], variable)
    try:
        domain = sp.calculus.util.continuous_domain(parsed, symbol, sp.S.Reals)
    except Exception as exc:
        raise ToolError(f"Не удалось найти область определения: {exc}") from exc
    return {
        "input": _math(parsed),
        "variable": str(symbol),
        "domain": _math(domain),
    }


def math_limit(
    expression: str,
    variable: Optional[str] = None,
    point: str | float | int = 0,
    direction: str = "+-",
) -> dict[str, Any]:
    parsed = _expr(expression)
    symbol = _symbol([parsed], variable)
    point_expr = _expr(str(point))
    if direction not in {"+", "-", "+-"}:
        raise ToolError("direction должен быть '+', '-' или '+-'")
    try:
        if direction == "+-":
            left = sp.limit(parsed, symbol, point_expr, dir="-")
            right = sp.limit(parsed, symbol, point_expr, dir="+")
            result = left if sp.simplify(left - right) == 0 else sp.nan
            return {
                "input": _math(parsed),
                "variable": str(symbol),
                "point": _math(point_expr),
                "left": _math(left),
                "right": _math(right),
                "exists": bool(result is not sp.nan),
                "result": None if result is sp.nan else _math(result),
            }
        result = sp.limit(parsed, symbol, point_expr, dir=direction)
        return {
            "input": _math(parsed),
            "variable": str(symbol),
            "point": _math(point_expr),
            "direction": direction,
            "result": _math(result),
        }
    except Exception as exc:
        raise ToolError(f"Не удалось вычислить предел: {exc}") from exc


def math_percent(
    operation: str,
    value: Optional[float] = None,
    percent: Optional[float] = None,
    total: Optional[float] = None,
) -> dict[str, Any]:
    op = operation.strip().lower()

    # Small local models often express "15% of 240" as
    # {percent: 15, total: 240}. Accept total as the base-value alias for
    # operations where there is only one source amount.
    if op in {"percent_of", "increase", "decrease"}:
        base_raw = value if value is not None else total
        if base_raw is None:
            raise ToolError("Нужно исходное число: value или total")
        if percent is None:
            raise ToolError("Нужен percent")
        base = float(base_raw)
        pct = float(percent)
        if op == "percent_of":
            result = base * pct / 100.0
        elif op == "increase":
            result = base * (1.0 + pct / 100.0)
        else:
            result = base * (1.0 - pct / 100.0)
        return {
            "operation": op,
            "value": base,
            "percent": pct,
            "total": total,
            "result": result,
        }

    if value is None:
        raise ToolError("Нужен value")
    numeric_value = float(value)
    if op == "what_percent":
        if total is None or float(total) == 0:
            raise ToolError("Нужен ненулевой total")
        result = numeric_value / float(total) * 100.0
    elif op == "percent_change":
        if total is None or float(total) == 0:
            raise ToolError("Для percent_change value=новое значение, total=старое ненулевое значение")
        result = (numeric_value - float(total)) / float(total) * 100.0
    else:
        raise ToolError("operation: percent_of | increase | decrease | what_percent | percent_change")
    return {
        "operation": op,
        "value": numeric_value,
        "percent": percent,
        "total": total,
        "result": result,
    }


def math_sequence(
    kind: str,
    first: str | float | int,
    n: int,
    difference: Optional[str | float | int] = None,
    ratio: Optional[str | float | int] = None,
) -> dict[str, Any]:
    if n < 1 or n > 100000:
        raise ToolError("n должен быть положительным")
    a1 = _expr(str(first))
    kind_value = kind.strip().lower()
    if kind_value == "arithmetic":
        if difference is None:
            raise ToolError("Для арифметической прогрессии нужен difference")
        d = _expr(str(difference))
        nth = sp.simplify(a1 + (n - 1) * d)
        total = sp.simplify(sp.Rational(n, 2) * (2 * a1 + (n - 1) * d))
        return {
            "kind": kind_value,
            "first": _math(a1),
            "difference": _math(d),
            "n": n,
            "nth": _math(nth),
            "sum_n": _math(total),
        }
    if kind_value == "geometric":
        if ratio is None:
            raise ToolError("Для геометрической прогрессии нужен ratio")
        q = _expr(str(ratio))
        nth = sp.simplify(a1 * q ** (n - 1))
        total = sp.simplify(n * a1 if q == 1 else a1 * (q**n - 1) / (q - 1))
        return {
            "kind": kind_value,
            "first": _math(a1),
            "ratio": _math(q),
            "n": n,
            "nth": _math(nth),
            "sum_n": _math(total),
        }
    raise ToolError("kind: arithmetic | geometric")


def math_combinatorics(
    operation: str,
    n: int,
    k: Optional[int] = None,
) -> dict[str, Any]:
    if n < 0 or n > 10000:
        raise ToolError("Некорректное n")
    op = operation.strip().lower()
    if op == "factorial":
        result = sp.factorial(n)
    elif op == "permutations":
        if k is None or k < 0 or k > n:
            raise ToolError("Для permutations нужно 0 <= k <= n")
        result = sp.factorial(n) / sp.factorial(n - k)
    elif op == "combinations":
        if k is None or k < 0 or k > n:
            raise ToolError("Для combinations нужно 0 <= k <= n")
        result = sp.binomial(n, k)
    else:
        raise ToolError("operation: factorial | permutations | combinations")
    return {"operation": op, "n": n, "k": k, "result": _math(sp.simplify(result))}


def math_probability(
    favorable: Optional[int] = None,
    total: Optional[int] = None,
    trials: Optional[int] = None,
    successes: Optional[int] = None,
    probability: Optional[float] = None,
) -> dict[str, Any]:
    if favorable is not None or total is not None:
        if favorable is None or total is None or total <= 0 or favorable < 0 or favorable > total:
            raise ToolError("Для классической вероятности нужны 0 <= favorable <= total")
        result = sp.Rational(favorable, total)
        return {
            "kind": "classical",
            "favorable": favorable,
            "total": total,
            "result": _math(result),
            "decimal": float(result),
        }
    if trials is not None or successes is not None or probability is not None:
        if trials is None or successes is None or probability is None:
            raise ToolError("Для биномиальной вероятности нужны trials, successes, probability")
        if not (0 <= successes <= trials) or not (0 <= probability <= 1):
            raise ToolError("Некорректные параметры биномиальной вероятности")
        p = sp.Rational(str(probability))
        result = sp.binomial(trials, successes) * p**successes * (1 - p) ** (trials - successes)
        return {
            "kind": "binomial",
            "trials": trials,
            "successes": successes,
            "probability": probability,
            "result": _math(sp.simplify(result)),
            "decimal": float(sp.N(result, 15)),
        }
    raise ToolError("Укажите favorable/total или trials/successes/probability")


def math_statistics(values: list[float]) -> dict[str, Any]:
    if not values or len(values) > 10000:
        raise ToolError("Нужен непустой список значений")
    numbers = [sp.Rational(str(value)) for value in values]
    sorted_values = sorted(numbers)
    count = len(numbers)
    mean = sp.simplify(sum(numbers) / count)
    if count % 2:
        median = sorted_values[count // 2]
    else:
        median = sp.simplify((sorted_values[count // 2 - 1] + sorted_values[count // 2]) / 2)
    frequencies: dict[sp.Rational, int] = {}
    for value in numbers:
        frequencies[value] = frequencies.get(value, 0) + 1
    max_frequency = max(frequencies.values())
    modes = [value for value, freq in frequencies.items() if freq == max_frequency and max_frequency > 1]
    variance = sp.simplify(sum((value - mean) ** 2 for value in numbers) / count)
    return {
        "count": count,
        "mean": _math(mean),
        "median": _math(median),
        "modes": [_math(value) for value in sorted(modes)],
        "variance_population": _math(variance),
        "stddev_population": _math(sp.sqrt(variance)),
    }


def math_trig_value(
    function: str,
    angle: str | float | int,
    unit: str = "degrees",
) -> dict[str, Any]:
    fn_name = function.strip().lower()
    fn = {"sin": sp.sin, "cos": sp.cos, "tan": sp.tan}.get(fn_name)
    if fn is None:
        raise ToolError("function: sin | cos | tan")
    angle_expr = _expr(str(angle))
    unit_value = unit.strip().lower()
    if unit_value in {"degree", "degrees", "deg"}:
        radians = sp.simplify(angle_expr * sp.pi / 180)
    elif unit_value in {"radian", "radians", "rad"}:
        radians = angle_expr
    else:
        raise ToolError("unit: degrees | radians")
    result = sp.simplify(sp.trigsimp(fn(radians)))
    return {
        "function": fn_name,
        "angle": _math(angle_expr),
        "unit": unit_value,
        "radians": _math(radians),
        "result": _math(result),
        "decimal": float(sp.N(result, 15)) if result.is_real is not False else None,
    }


def math_solve_trig(
    equation: str,
    variable: str = "x",
    start: str | float | int = 0,
    end: str | float | int = "2*pi",
) -> dict[str, Any]:
    parsed = _equation(equation)
    symbol = _symbol([parsed.lhs, parsed.rhs], variable)
    start_expr = _expr(str(start))
    end_expr = _expr(str(end))
    domain = sp.Interval(start_expr, end_expr)
    try:
        solution = sp.solveset(parsed.lhs - parsed.rhs, symbol, domain=domain)
    except Exception as exc:
        raise ToolError(f"Не удалось решить тригонометрическое уравнение: {exc}") from exc
    return {
        "equation": {"text": str(parsed), "latex": sp.latex(parsed)},
        "variable": str(symbol),
        "domain": _math(domain),
        "solution": _math(solution),
    }


def math_vector(
    operation: str,
    vector_a: list[float],
    vector_b: Optional[list[float]] = None,
) -> dict[str, Any]:
    if len(vector_a) not in {2, 3}:
        raise ToolError("Вектор должен иметь 2 или 3 координаты")
    a = sp.Matrix([sp.Rational(str(value)) for value in vector_a])
    b = None
    if vector_b is not None:
        if len(vector_b) != len(vector_a):
            raise ToolError("Размерности векторов должны совпадать")
        b = sp.Matrix([sp.Rational(str(value)) for value in vector_b])
    op = operation.strip().lower()
    if op == "magnitude":
        result = sp.sqrt(a.dot(a))
        return {"operation": op, "result": _math(sp.simplify(result))}
    if b is None:
        raise ToolError("Для этой операции нужен vector_b")
    if op == "add":
        result = a + b
        return {"operation": op, "result": [_math(item) for item in result]}
    if op == "subtract":
        result = a - b
        return {"operation": op, "result": [_math(item) for item in result]}
    if op == "dot":
        return {"operation": op, "result": _math(sp.simplify(a.dot(b)))}
    if op == "angle":
        denominator = sp.sqrt(a.dot(a)) * sp.sqrt(b.dot(b))
        if denominator == 0:
            raise ToolError("Угол с нулевым вектором не определён")
        cosine = sp.simplify(a.dot(b) / denominator)
        angle = sp.acos(cosine)
        return {
            "operation": op,
            "cosine": _math(cosine),
            "radians": _math(angle),
            "degrees": _math(sp.simplify(angle * 180 / sp.pi)),
        }
    raise ToolError("operation: magnitude | add | subtract | dot | angle")


def math_number_theory(
    operation: str,
    a: int,
    b: Optional[int] = None,
) -> dict[str, Any]:
    op = operation.strip().lower()
    a_int = int(a)
    if op == "gcd":
        if b is None:
            raise ToolError("Для gcd нужен b")
        result = sp.gcd(a_int, int(b))
        return {"operation": op, "a": a_int, "b": int(b), "result": int(result)}
    if op == "lcm":
        if b is None:
            raise ToolError("Для lcm нужен b")
        result = sp.ilcm(a_int, int(b))
        return {"operation": op, "a": a_int, "b": int(b), "result": int(result)}
    if op == "prime_factors":
        if a_int == 0:
            raise ToolError("0 нельзя разложить на простые множители")
        factors = sp.factorint(abs(a_int))
        return {
            "operation": op,
            "a": a_int,
            "factors": {str(prime): exponent for prime, exponent in factors.items()},
        }
    if op == "divisors":
        if a_int == 0:
            raise ToolError("У 0 бесконечно много делителей")
        return {
            "operation": op,
            "a": a_int,
            "divisors": [int(value) for value in sp.divisors(abs(a_int))],
        }
    if op == "is_prime":
        return {"operation": op, "a": a_int, "result": bool(sp.isprime(a_int))}
    raise ToolError("operation: gcd | lcm | prime_factors | divisors | is_prime")


def math_function_analysis(
    expression: str,
    variable: Optional[str] = None,
) -> dict[str, Any]:
    parsed = _expr(expression)
    symbol = _symbol([parsed], variable)
    derivative = sp.simplify(sp.diff(parsed, symbol))
    second = sp.simplify(sp.diff(parsed, symbol, 2))
    try:
        domain = sp.calculus.util.continuous_domain(parsed, symbol, sp.S.Reals)
    except Exception:
        domain = sp.S.Reals
    try:
        critical = [
            item
            for item in sp.solve(sp.Eq(derivative, 0), symbol)
            if item.is_real is not False and item in domain
        ]
    except Exception:
        critical = []

    points = []
    for point in critical:
        value = sp.simplify(parsed.subs(symbol, point))
        second_value = sp.simplify(second.subs(symbol, point))
        if second_value.is_positive:
            point_type = "minimum"
        elif second_value.is_negative:
            point_type = "maximum"
        else:
            point_type = "undetermined"
        points.append({
            "x": _math(point),
            "y": _math(value),
            "second_derivative": _math(second_value),
            "type": point_type,
        })

    increasing = None
    decreasing = None
    try:
        increasing = sp.solve_univariate_inequality(
            derivative > 0,
            symbol,
            relational=True,
        )
        decreasing = sp.solve_univariate_inequality(
            derivative < 0,
            symbol,
            relational=True,
        )
    except Exception:
        pass

    return {
        "input": _math(parsed),
        "variable": str(symbol),
        "domain": _math(domain),
        "derivative": _math(derivative),
        "second_derivative": _math(second),
        "critical_points": points,
        "increasing": _math(increasing) if increasing is not None else None,
        "decreasing": _math(decreasing) if decreasing is not None else None,
    }


def geometry_compute(kind: str, values: Mapping[str, float | int | str]) -> dict[str, Any]:
    shape = kind.strip().lower()
    parsed = {
        re.sub(r"[^a-z0-9]+", "_", str(key).strip().lower()).strip("_"): _expr(str(value))
        for key, value in (values or {}).items()
    }

    aliases = {
        "side1": "a", "side_1": "a", "side_a": "a", "leg1": "a", "leg_1": "a",
        "side2": "b", "side_2": "b", "side_b": "b", "leg2": "b", "leg_2": "b",
        "side3": "c", "side_3": "c", "side_c": "c",
        "h": "height", "altitude": "height",
        "angle": "angle_deg", "angle_degrees": "angle_deg", "theta": "angle_deg",
        "r": "radius", "rad": "radius",
        "diam": "diameter", "dia": "diameter",
        "diagonal1": "d1", "diagonal_1": "d1",
        "diagonal2": "d2", "diagonal_2": "d2",
        "side_length": "side",
        "num_sides": "n", "number_of_sides": "n", "sides_count": "n",
        "x_1": "x1", "y_1": "y1", "z_1": "z1",
        "x_2": "x2", "y_2": "y2", "z_2": "z2",
        "basearea": "base_area", "base_s": "base_area", "s_base": "base_area",
    }
    for source, target in aliases.items():
        if source in parsed and target not in parsed:
            parsed[target] = parsed[source]

    # Shape-specific natural aliases from model function calls.
    if shape == "triangle_base_height":
        if "a" in parsed and "base" not in parsed:
            parsed["base"] = parsed["a"]
        if "side" in parsed and "base" not in parsed:
            parsed["base"] = parsed["side"]
    elif shape == "trapezoid":
        if "base1" in parsed and "a" not in parsed:
            parsed["a"] = parsed["base1"]
        if "base2" in parsed and "b" not in parsed:
            parsed["b"] = parsed["base2"]
    elif shape == "rectangle":
        if "a" in parsed and "length" not in parsed:
            parsed["length"] = parsed["a"]
        if "b" in parsed and "width" not in parsed:
            parsed["width"] = parsed["b"]
    elif shape == "rectangular_prism":
        if "a" in parsed and "length" not in parsed:
            parsed["length"] = parsed["a"]
        if "b" in parsed and "width" not in parsed:
            parsed["width"] = parsed["b"]
        if "c" in parsed and "height" not in parsed:
            parsed["height"] = parsed["c"]
    elif shape in {"prism", "pyramid"}:
        if "base" in parsed and "base_area" not in parsed:
            parsed["base_area"] = parsed["base"]

    def need(*keys: str):
        missing = [key for key in keys if key not in parsed]
        if missing:
            raise ToolError("Не хватает параметров: " + ", ".join(missing))
        return [parsed[key] for key in keys]

    if shape == "triangle_sides":
        a, b, c = need("a", "b", "c")
        if any(value.is_positive is False for value in (a, b, c)):
            raise ToolError("Стороны должны быть положительными")
        s = sp.simplify((a + b + c) / 2)
        area = sp.simplify(sp.sqrt(s * (s - a) * (s - b) * (s - c)))
        return {
            "kind": shape,
            "perimeter": _math(sp.simplify(a + b + c)),
            "semiperimeter": _math(s),
            "area": _math(area),
        }
    if shape == "triangle_base_height":
        base, height = need("base", "height")
        return {"kind": shape, "area": _math(sp.simplify(base * height / 2))}
    if shape == "right_triangle":
        a, b = need("a", "b")
        c = sp.simplify(sp.sqrt(a**2 + b**2))
        return {
            "kind": shape,
            "hypotenuse": _math(c),
            "area": _math(sp.simplify(a * b / 2)),
            "perimeter": _math(sp.simplify(a + b + c)),
        }
    if shape == "triangle_two_sides_angle":
        a, b, angle_deg = need("a", "b", "angle_deg")
        angle = sp.simplify(angle_deg * sp.pi / 180)
        c = sp.simplify(sp.sqrt(a**2 + b**2 - 2 * a * b * sp.cos(angle)))
        area = sp.simplify(a * b * sp.sin(angle) / 2)
        return {"kind": shape, "third_side": _math(c), "area": _math(area)}
    if shape == "parallelogram":
        a, b = need("a", "b")
        if "height" in parsed:
            area = sp.simplify(a * parsed["height"])
        elif "angle_deg" in parsed:
            angle = sp.simplify(parsed["angle_deg"] * sp.pi / 180)
            area = sp.simplify(a * b * sp.sin(angle))
        else:
            raise ToolError("Для параллелограмма нужен height или angle_deg")
        return {
            "kind": shape,
            "area": _math(area),
            "perimeter": _math(sp.simplify(2 * (a + b))),
        }
    if shape == "rhombus":
        d1, d2 = need("d1", "d2")
        side = sp.simplify(sp.sqrt((d1 / 2) ** 2 + (d2 / 2) ** 2))
        return {
            "kind": shape,
            "area": _math(sp.simplify(d1 * d2 / 2)),
            "side": _math(side),
            "perimeter": _math(sp.simplify(4 * side)),
        }
    if shape == "sector":
        radius, angle_deg = need("radius", "angle_deg")
        area = sp.simplify(sp.pi * radius**2 * angle_deg / 360)
        arc = sp.simplify(2 * sp.pi * radius * angle_deg / 360)
        return {
            "kind": shape,
            "area": _math(area),
            "arc_length": _math(arc),
        }
    if shape == "rectangle":
        length, width = need("length", "width")
        return {
            "kind": shape,
            "area": _math(sp.simplify(length * width)),
            "perimeter": _math(sp.simplify(2 * (length + width))),
            "diagonal": _math(sp.simplify(sp.sqrt(length**2 + width**2))),
        }
    if shape == "circle":
        radius = parsed.get("radius")
        if radius is None and "diameter" in parsed:
            radius = sp.simplify(parsed["diameter"] / 2)
        if radius is None:
            raise ToolError("Нужен radius или diameter")
        return {
            "kind": shape,
            "radius": _math(radius),
            "diameter": _math(sp.simplify(2 * radius)),
            "circumference": _math(sp.simplify(2 * sp.pi * radius)),
            "area": _math(sp.simplify(sp.pi * radius**2)),
        }
    if shape == "trapezoid":
        a, b, height = need("a", "b", "height")
        result = {"kind": shape, "area": _math(sp.simplify((a + b) * height / 2))}
        if "c" in parsed and "d" in parsed:
            result["perimeter"] = _math(sp.simplify(a + b + parsed["c"] + parsed["d"]))
        return result
    if shape == "regular_polygon":
        n, side = need("n", "side")
        if not n.is_integer or int(n) < 3:
            raise ToolError("n должно быть целым >= 3")
        n_int = int(n)
        perimeter = sp.simplify(n_int * side)
        area = sp.simplify(n_int * side**2 / (4 * sp.tan(sp.pi / n_int)))
        return {"kind": shape, "perimeter": _math(perimeter), "area": _math(area)}
    if shape == "coordinate_distance":
        x1, y1, x2, y2 = need("x1", "y1", "x2", "y2")
        result = sp.simplify(sp.sqrt((x2 - x1)**2 + (y2 - y1)**2))
        return {"kind": shape, "distance": _math(result)}
    if shape == "coordinate_midpoint":
        x1, y1, x2, y2 = need("x1", "y1", "x2", "y2")
        return {
            "kind": shape,
            "x": _math(sp.simplify((x1 + x2) / 2)),
            "y": _math(sp.simplify((y1 + y2) / 2)),
        }
    if shape == "coordinate_distance_3d":
        x1, y1, z1, x2, y2, z2 = need("x1", "y1", "z1", "x2", "y2", "z2")
        result = sp.simplify(sp.sqrt((x2 - x1)**2 + (y2 - y1)**2 + (z2 - z1)**2))
        return {"kind": shape, "distance": _math(result)}
    if shape == "coordinate_midpoint_3d":
        x1, y1, z1, x2, y2, z2 = need("x1", "y1", "z1", "x2", "y2", "z2")
        return {
            "kind": shape,
            "x": _math(sp.simplify((x1 + x2) / 2)),
            "y": _math(sp.simplify((y1 + y2) / 2)),
            "z": _math(sp.simplify((z1 + z2) / 2)),
        }
    if shape == "coordinate_line":
        x1, y1, x2, y2 = need("x1", "y1", "x2", "y2")
        if sp.simplify(x2 - x1) == 0:
            return {"kind": shape, "vertical": True, "equation": f"x = {x1}"}
        slope = sp.simplify((y2 - y1) / (x2 - x1))
        intercept = sp.simplify(y1 - slope * x1)
        x = sp.Symbol("x")
        expression = sp.simplify(slope * x + intercept)
        return {
            "kind": shape,
            "slope": _math(slope),
            "intercept": _math(intercept),
            "equation": {"text": f"y = {expression}", "latex": f"y = {sp.latex(expression)}"},
        }
    if shape == "cube":
        side, = need("side")
        return {
            "kind": shape,
            "surface_area": _math(sp.simplify(6 * side**2)),
            "volume": _math(sp.simplify(side**3)),
            "space_diagonal": _math(sp.simplify(side * sp.sqrt(3))),
        }
    if shape == "rectangular_prism":
        length, width, height = need("length", "width", "height")
        return {
            "kind": shape,
            "surface_area": _math(sp.simplify(2 * (length * width + length * height + width * height))),
            "volume": _math(sp.simplify(length * width * height)),
            "space_diagonal": _math(sp.simplify(sp.sqrt(length**2 + width**2 + height**2))),
        }
    if shape == "cylinder":
        radius, height = need("radius", "height")
        return {
            "kind": shape,
            "lateral_area": _math(sp.simplify(2 * sp.pi * radius * height)),
            "surface_area": _math(sp.simplify(2 * sp.pi * radius * (radius + height))),
            "volume": _math(sp.simplify(sp.pi * radius**2 * height)),
        }
    if shape == "cone":
        radius, height = need("radius", "height")
        slant = sp.simplify(sp.sqrt(radius**2 + height**2))
        return {
            "kind": shape,
            "slant_height": _math(slant),
            "lateral_area": _math(sp.simplify(sp.pi * radius * slant)),
            "surface_area": _math(sp.simplify(sp.pi * radius * (radius + slant))),
            "volume": _math(sp.simplify(sp.pi * radius**2 * height / 3)),
        }
    if shape == "sphere":
        radius, = need("radius")
        return {
            "kind": shape,
            "surface_area": _math(sp.simplify(4 * sp.pi * radius**2)),
            "volume": _math(sp.simplify(sp.Rational(4, 3) * sp.pi * radius**3)),
        }
    if shape == "prism":
        base_area, height = need("base_area", "height")
        return {"kind": shape, "volume": _math(sp.simplify(base_area * height))}
    if shape == "pyramid":
        base_area, height = need("base_area", "height")
        return {"kind": shape, "volume": _math(sp.simplify(base_area * height / 3))}
    raise ToolError(
        "kind: triangle_sides | triangle_base_height | right_triangle | triangle_two_sides_angle | "
        "parallelogram | rhombus | sector | rectangle | circle | trapezoid | regular_polygon | "
        "coordinate_distance | coordinate_midpoint | coordinate_distance_3d | coordinate_midpoint_3d | "
        "coordinate_line | cube | rectangular_prism | cylinder | cone | sphere | prism | pyramid"
    )


def _unit(source: str):
    text = (source or "").strip()
    if not text or len(text) > 80:
        raise ToolError("Некорректная единица измерения")
    try:
        return UREG.parse_units(text)
    except Exception as exc:
        raise ToolError(f"Не удалось разобрать единицу '{source}': {exc}") from exc


def physics_convert_unit(value: float, from_unit: str, to_unit: str) -> dict[str, Any]:
    source = _unit(from_unit)
    target = _unit(to_unit)
    try:
        converted = (float(value) * source).to(target)
    except Exception as exc:
        raise ToolError(f"Несовместимые единицы: {exc}") from exc
    return {"value": value, "from_unit": from_unit, "to_unit": to_unit, "result": float(converted.magnitude)}


def physics_check_dimensions(left_unit: str, right_unit: str) -> dict[str, Any]:
    left = _unit(left_unit)
    right = _unit(right_unit)
    return {
        "left_unit": left_unit,
        "right_unit": right_unit,
        "compatible": left.dimensionality == right.dimensionality,
        "left_dims": str(left.dimensionality),
        "right_dims": str(right.dimensionality),
    }


ATOMIC_MASS = {
    "H": 1.008, "He": 4.0026, "Li": 6.94, "Be": 9.0122, "B": 10.81, "C": 12.011,
    "N": 14.007, "O": 15.999, "F": 18.998, "Ne": 20.180, "Na": 22.990, "Mg": 24.305,
    "Al": 26.982, "Si": 28.085, "P": 30.974, "S": 32.06, "Cl": 35.45, "Ar": 39.948,
    "K": 39.0983, "Ca": 40.078, "Cr": 51.996, "Mn": 54.938, "Fe": 55.845, "Co": 58.933,
    "Ni": 58.693, "Cu": 63.546, "Zn": 65.38, "Br": 79.904, "Ag": 107.8682, "I": 126.904,
    "Ba": 137.327, "Pt": 195.084, "Au": 196.96657, "Hg": 200.592, "Pb": 207.2, "U": 238.02891,
}
FORMULA_TOKEN = re.compile(r"([A-Z][a-z]?|\(|\)|\d+)")


def _formula(source: str) -> dict[str, int]:
    raw = source.strip().replace(" ", "")
    if not raw:
        raise ToolError("Пустая химическая формула")
    tokens = FORMULA_TOKEN.findall(raw)
    if "".join(tokens) != raw:
        raise ToolError(f"Не удалось разобрать формулу: {source}")
    stack: list[dict[str, int]] = [{}]
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token == "(":
            stack.append({})
        elif token == ")":
            if len(stack) == 1:
                raise ToolError("Лишняя закрывающая скобка")
            group = stack.pop()
            multiplier = 1
            if index + 1 < len(tokens) and tokens[index + 1].isdigit():
                multiplier = int(tokens[index + 1])
                index += 1
            for element, count in group.items():
                stack[-1][element] = stack[-1].get(element, 0) + count * multiplier
        elif token.isdigit():
            raise ToolError("Коэффициент стоит в неожиданном месте")
        else:
            count = 1
            if index + 1 < len(tokens) and tokens[index + 1].isdigit():
                count = int(tokens[index + 1])
                index += 1
            stack[-1][token] = stack[-1].get(token, 0) + count
        index += 1
    if len(stack) != 1:
        raise ToolError("Незакрытая скобка")
    return stack[0]


def chemistry_molar_mass(formula: str) -> dict[str, Any]:
    atoms = _formula(formula)
    unknown = sorted(element for element in atoms if element not in ATOMIC_MASS)
    if unknown:
        raise ToolError(f"Нет атомной массы для: {', '.join(unknown)}")
    mass = sum(ATOMIC_MASS[element] * count for element, count in atoms.items())
    return {"formula": formula, "atoms": atoms, "molar_mass_g_mol": round(mass, 6)}


def chemistry_balance_equation(equation: str) -> dict[str, Any]:
    normalized = equation.replace("→", "->").replace("=", "->")
    if normalized.count("->") != 1:
        raise ToolError("Нужен один знак '->' или '='")
    left, right = normalized.split("->", 1)
    reactants = [item.strip() for item in left.split("+") if item.strip()]
    products = [item.strip() for item in right.split("+") if item.strip()]
    if not reactants or not products:
        raise ToolError("Нужны реагенты и продукты")
    if any(re.match(r"^\d", item) for item in reactants + products):
        raise ToolError("Перед балансировкой уберите исходные коэффициенты")
    species = reactants + products
    compositions = [_formula(item) for item in species]
    elements = sorted({element for composition in compositions for element in composition})
    matrix = sp.Matrix([
        [
            composition.get(element, 0) if index < len(reactants) else -composition.get(element, 0)
            for index, composition in enumerate(compositions)
        ]
        for element in elements
    ])
    nullspace = matrix.nullspace()
    if len(nullspace) != 1:
        raise ToolError("Уравнение не балансируется однозначно")
    vector = nullspace[0]
    denominator = sp.ilcm(*[term.q for term in vector])
    coefficients = [int(term * denominator) for term in vector]
    if all(value < 0 for value in coefficients):
        coefficients = [-value for value in coefficients]
    if any(value <= 0 for value in coefficients):
        raise ToolError("Не удалось получить положительные коэффициенты")
    common = reduce(gcd, coefficients)
    coefficients = [value // common for value in coefficients]

    def render(items: list[str], offset: int) -> str:
        return " + ".join(
            f"{'' if coefficients[offset + i] == 1 else coefficients[offset + i]}{item}"
            for i, item in enumerate(items)
        )

    return {
        "input": equation,
        "balanced": f"{render(reactants, 0)} -> {render(products, len(reactants))}",
        "coefficients": coefficients,
    }


def chemistry_element(symbol: str) -> dict[str, Any]:
    key = symbol.strip()
    if key not in ATOMIC_MASS:
        raise ToolError(f"Неизвестный элемент: {symbol}")
    return {"symbol": key, "atomic_mass": ATOMIC_MASS[key]}


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    category: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[..., dict[str, Any]]


def _schema(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


TOOLS: tuple[ToolDefinition, ...] = (
    ToolDefinition("math_evaluate", "math", "Вычислить выражение с подстановками.", _schema({
        "expression": {"type": "string"},
        "substitutions": {"type": "object", "additionalProperties": {"type": "number"}},
    }, ["expression"]), math_evaluate),
    ToolDefinition("math_simplify", "math", "Упростить выражение.", _schema({"expression": {"type": "string"}}, ["expression"]), math_simplify),
    ToolDefinition("math_factor", "math", "Разложить выражение на множители.", _schema({"expression": {"type": "string"}}, ["expression"]), math_factor),
    ToolDefinition("math_expand", "math", "Раскрыть скобки и привести выражение к развёрнутому виду.", _schema({"expression": {"type": "string"}}, ["expression"]), math_expand),
    ToolDefinition("math_equivalent", "math", "Проверить математическую эквивалентность двух выражений.", _schema({
        "expression_a": {"type": "string"}, "expression_b": {"type": "string"},
    }, ["expression_a", "expression_b"]), math_equivalent),
    ToolDefinition("math_solve", "math", "Решить уравнение.", _schema({
        "equation": {"type": "string"}, "variable": {"type": "string"},
    }, ["equation"]), math_solve),
    ToolDefinition("math_quadratic", "math", "Точно разобрать квадратное уравнение: коэффициенты, дискриминант и корни.", _schema({
        "equation": {"type": "string"}, "variable": {"type": "string"},
    }, ["equation"]), math_quadratic),
    ToolDefinition("math_differentiate", "math", "Найти производную.", _schema({
        "expression": {"type": "string"}, "variable": {"type": "string"},
        "order": {"type": "integer", "minimum": 1, "maximum": 5},
    }, ["expression"]), math_differentiate),
    ToolDefinition("math_integrate", "math", "Найти интеграл.", _schema({
        "expression": {"type": "string"}, "variable": {"type": "string"},
        "lower": {"type": ["number", "string"]}, "upper": {"type": ["number", "string"]},
    }, ["expression"]), math_integrate),
    ToolDefinition("math_intersections", "math", "Найти пересечения двух функций.", _schema({
        "expression_a": {"type": "string"}, "expression_b": {"type": "string"}, "variable": {"type": "string"},
    }, ["expression_a", "expression_b"]), math_intersections),
    ToolDefinition("math_solve_system", "math", "Решить систему уравнений с несколькими переменными.", _schema({
        "equations": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 8},
        "variables": {"type": "array", "items": {"type": "string"}},
    }, ["equations"]), math_solve_system),
    ToolDefinition("math_solve_inequalities", "math", "Решить одно неравенство или систему неравенств.", _schema({
        "inequalities": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 8},
        "variable": {"type": "string"},
    }, ["inequalities"]), math_solve_inequalities),
    ToolDefinition("math_domain", "math", "Найти область определения функции над действительными числами.", _schema({
        "expression": {"type": "string"}, "variable": {"type": "string"},
    }, ["expression"]), math_domain),
    ToolDefinition("math_limit", "math", "Вычислить предел функции.", _schema({
        "expression": {"type": "string"}, "variable": {"type": "string"},
        "point": {"type": ["number", "string"]},
        "direction": {"type": "string", "enum": ["+", "-", "+-"]},
    }, ["expression"]), math_limit),
    ToolDefinition("math_percent", "math", "Решить типовые задачи на проценты: процент от числа, увеличение, уменьшение, доля в процентах, процентное изменение.", _schema({
        "operation": {"type": "string", "enum": ["percent_of", "increase", "decrease", "what_percent", "percent_change"]},
        "value": {"type": "number"}, "percent": {"type": "number"}, "total": {"type": "number"},
    }, ["operation", "value"]), math_percent),
    ToolDefinition("math_sequence", "math", "Вычислить n-й член и сумму арифметической или геометрической прогрессии.", _schema({
        "kind": {"type": "string", "enum": ["arithmetic", "geometric"]},
        "first": {"type": ["number", "string"]}, "n": {"type": "integer", "minimum": 1},
        "difference": {"type": ["number", "string"]}, "ratio": {"type": ["number", "string"]},
    }, ["kind", "first", "n"]), math_sequence),
    ToolDefinition("math_combinatorics", "math", "Факториал, размещения без повторений и сочетания.", _schema({
        "operation": {"type": "string", "enum": ["factorial", "permutations", "combinations"]},
        "n": {"type": "integer", "minimum": 0}, "k": {"type": "integer", "minimum": 0},
    }, ["operation", "n"]), math_combinatorics),
    ToolDefinition("math_probability", "math", "Вычислить классическую или биномиальную вероятность.", _schema({
        "favorable": {"type": "integer", "minimum": 0},
        "total": {"type": "integer", "minimum": 1},
        "trials": {"type": "integer", "minimum": 0},
        "successes": {"type": "integer", "minimum": 0},
        "probability": {"type": "number", "minimum": 0, "maximum": 1},
    }, []), math_probability),
    ToolDefinition("math_statistics", "math", "Найти среднее, медиану, моду, дисперсию и стандартное отклонение набора чисел.", _schema({
        "values": {"type": "array", "items": {"type": "number"}, "minItems": 1},
    }, ["values"]), math_statistics),
    ToolDefinition("math_number_theory", "math", "НОД, НОК, простые множители, делители и проверка простоты числа.", _schema({
        "operation": {"type": "string", "enum": ["gcd", "lcm", "prime_factors", "divisors", "is_prime"]},
        "a": {"type": "integer"}, "b": {"type": "integer"},
    }, ["operation", "a"]), math_number_theory),
    ToolDefinition("math_function_analysis", "math", "Исследовать функцию: область определения, производная, критические точки, экстремумы и интервалы возрастания/убывания.", _schema({
        "expression": {"type": "string"}, "variable": {"type": "string"},
    }, ["expression"]), math_function_analysis),
    ToolDefinition("math_trig_value", "math", "Найти точное значение sin/cos/tan заданного угла.", _schema({
        "function": {"type": "string", "enum": ["sin", "cos", "tan"]},
        "angle": {"type": ["number", "string"]},
        "unit": {"type": "string", "enum": ["degrees", "radians"]},
    }, ["function", "angle"]), math_trig_value),
    ToolDefinition("math_solve_trig", "math", "Решить тригонометрическое уравнение на заданном промежутке.", _schema({
        "equation": {"type": "string"}, "variable": {"type": "string"},
        "start": {"type": ["number", "string"]}, "end": {"type": ["number", "string"]},
    }, ["equation"]), math_solve_trig),
    ToolDefinition("math_vector", "math", "Операции с 2D/3D векторами: длина, сумма, разность, скалярное произведение, угол.", _schema({
        "operation": {"type": "string", "enum": ["magnitude", "add", "subtract", "dot", "angle"]},
        "vector_a": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 3},
        "vector_b": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 3},
    }, ["operation", "vector_a"]), math_vector),
    ToolDefinition("geometry_compute", "math", "Вычислительная школьная геометрия: треугольники, окружности, четырёхугольники, координаты и объёмы/площади тел.", _schema({
        "kind": {
            "type": "string",
            "enum": [
                "triangle_sides", "triangle_base_height", "right_triangle", "triangle_two_sides_angle",
                "parallelogram", "rhombus", "sector",
                "rectangle", "circle", "trapezoid", "regular_polygon",
                "coordinate_distance", "coordinate_midpoint", "coordinate_distance_3d", "coordinate_midpoint_3d",
                "coordinate_line",
                "cube", "rectangular_prism", "cylinder", "cone", "sphere", "prism", "pyramid"
            ],
        },
        "values": {"type": "object", "additionalProperties": {"type": ["number", "string"]}},
    }, ["kind", "values"]), geometry_compute),
    ToolDefinition("physics_convert_unit", "physics", "Перевести величину между совместимыми единицами.", _schema({
        "value": {"type": "number"}, "from_unit": {"type": "string"}, "to_unit": {"type": "string"},
    }, ["value", "from_unit", "to_unit"]), physics_convert_unit),
    ToolDefinition("physics_check_dimensions", "physics", "Проверить совместимость физических размерностей.", _schema({
        "left_unit": {"type": "string"}, "right_unit": {"type": "string"},
    }, ["left_unit", "right_unit"]), physics_check_dimensions),
    ToolDefinition("chemistry_molar_mass", "chemistry", "Вычислить молярную массу вещества.", _schema({
        "formula": {"type": "string"},
    }, ["formula"]), chemistry_molar_mass),
    ToolDefinition("chemistry_balance_equation", "chemistry", "Расставить коэффициенты в химическом уравнении.", _schema({
        "equation": {"type": "string"},
    }, ["equation"]), chemistry_balance_equation),
    ToolDefinition("chemistry_element", "chemistry", "Получить атомную массу элемента.", _schema({
        "symbol": {"type": "string"},
    }, ["symbol"]), chemistry_element),
)
TOOL_BY_NAME = {tool.name: tool for tool in TOOLS}


def _subject_categories(subject: Optional[str]) -> set[str]:
    value = (subject or "").strip().lower()
    if not value:
        return {"math", "physics", "chemistry"}
    if any(token in value for token in ("chem", "хим")):
        return {"math", "chemistry"}
    if any(token in value for token in ("phys", "физ")):
        return {"math", "physics"}
    if any(token in value for token in ("math", "algebra", "geometry", "матем", "алгеб", "геом")):
        return {"math"}
    return set()


def _math_tool_names_for_task(subject: Optional[str], task_text: Optional[str]) -> set[str] | None:
    if not task_text:
        return None
    text = f"{subject or ''} {task_text}".lower()
    names = {
        "math_evaluate",
        "math_simplify",
        "math_equivalent",
        "math_solve",
        "math_quadratic",
        "math_factor",
        "math_expand",
    }

    if any(cue in text for cue in ("систем", "system of", "жүйе")):
        names.add("math_solve_system")
    if any(cue in text for cue in ("неравен", "inequal", "теңсіз", "<", ">")):
        names.add("math_solve_inequalities")
    if any(cue in text for cue in ("област", "domain", "одз", "анықталу облысы")):
        names.add("math_domain")
    if any(cue in text for cue in ("предел", "limit", "шек")):
        names.update({"math_limit", "math_domain"})
    if any(cue in text for cue in ("производн", "derivative", "туынды")):
        names.update({"math_differentiate", "math_domain"})
    if any(cue in text for cue in ("интеграл", "integral", "алғашқы функция")):
        names.update({"math_integrate", "math_domain"})
    if any(cue in text for cue in ("процент", "percent", "%", "пайыз")):
        names.add("math_percent")
    if any(cue in text for cue in ("прогресс", "sequence", "последователь", "тізбек")):
        names.add("math_sequence")
    if any(cue in text for cue in ("сочетан", "размещен", "перестанов", "factorial", "combination", "permutation", "факториал")):
        names.update({"math_combinatorics", "math_probability"})
    if any(cue in text for cue in ("вероят", "probab", "ықтимал")):
        names.update({"math_probability", "math_combinatorics"})
    if any(cue in text for cue in ("средн", "медиан", "мод", "дисперс", "стандартн", "mean", "median", "mode", "variance", "statistics", "статист")):
        names.add("math_statistics")
    if any(cue in text for cue in ("нод", "нок", "gcd", "lcm", "простые множители", "prime factor", "делител", "divisor", "простое число")):
        names.add("math_number_theory")
    if any(cue in text for cue in ("исследовать функцию", "исследование функции", "экстрем", "монотон", "возраст", "убыва", "critical point", "extrem", "increasing", "decreasing")):
        names.update({"math_function_analysis", "math_differentiate", "math_domain"})
    if any(cue in text for cue in ("sin", "cos", "tan", "tg", "ctg", "тригоном", "синус", "косинус", "танген")):
        names.update({"math_trig_value", "math_solve_trig"})
    if any(cue in text for cue in ("вектор", "vector", "скаляр", "dot product")):
        names.add("math_vector")
    if any(cue in text for cue in (
        "геометр", "geometry", "треуг", "triangle", "окруж", "circle",
        "прямоуголь", "rectangle", "трапец", "polygon", "многоуг",
        "параллел", "ромб", "сектор", "дуг", "arc",
        "площад", "area", "периметр", "perimeter", "объём", "объем", "volume",
        "цилинд", "cylinder", "конус", "cone", "сфер", "sphere", "куб", "призм",
        "координат", "расстояние между точ", "midpoint", "пирами",
    )):
        names.update({"geometry_compute", "math_vector", "math_trig_value"})
    if any(cue in text for cue in ("график", "graph", "пересеч", "intersection")):
        names.update({"math_intersections", "math_domain"})

    return names


def list_tool_definitions(
    subject: Optional[str] = None,
    task_text: Optional[str] = None,
) -> list[dict[str, Any]]:
    categories = _subject_categories(subject)
    allowed_math = _math_tool_names_for_task(subject, task_text)
    return [
        {"name": tool.name, "category": tool.category, "description": tool.description, "parameters": tool.parameters}
        for tool in TOOLS
        if tool.category in categories
        and (
            tool.category != "math"
            or allowed_math is None
            or tool.name in allowed_math
        )
    ]


def openai_chat_tools(
    subject: Optional[str] = None,
    task_text: Optional[str] = None,
) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": item["name"],
                "description": item["description"],
                "parameters": item["parameters"],
            },
        }
        for item in list_tool_definitions(subject, task_text)
    ]


def _normalize_tool_arguments(name: str, arguments: Mapping[str, Any] | None) -> dict[str, Any]:
    args = dict(arguments or {})

    def alias(target: str, *sources: str) -> None:
        if target in args:
            return
        for source in sources:
            if source in args:
                args[target] = args[source]
                return

    if name == "geometry_compute":
        alias("kind", "object", "shape", "type", "figure")
        values = args.get("values")
        if not isinstance(values, Mapping):
            values = {}
        else:
            values = dict(values)
        for key in list(args):
            if key not in {"kind", "object", "shape", "type", "figure", "values"}:
                values.setdefault(key, args[key])
        args = {"kind": args.get("kind"), "values": values}

    elif name == "math_sequence":
        alias("kind", "type", "sequence_type", "progression")
        alias("first", "a1", "a_1", "first_term")
        alias("n", "term_number", "index", "count")
        alias("difference", "d", "common_difference")
        alias("ratio", "q", "r", "common_ratio")
        kind = str(args.get("kind", "")).lower()
        if "arith" in kind or "ариф" in kind:
            args["kind"] = "arithmetic"
        elif "geom" in kind or "геом" in kind:
            args["kind"] = "geometric"

    elif name == "math_probability":
        alias("favorable", "favourable", "favorable_outcomes", "successful", "successes_count")
        alias("total", "total_outcomes", "outcomes")
        alias("trials", "n", "number_of_trials")
        alias("successes", "k", "number_of_successes")
        alias("probability", "p", "success_probability")

    elif name == "math_combinatorics":
        alias("operation", "type", "kind", "op")
        alias("k", "r", "choose")

    elif name == "math_trig_value":
        alias("function", "fn", "trig", "function_name")
        alias("angle", "value", "theta")
        alias("unit", "angle_unit")
        if "degrees" in args and "angle" not in args:
            args["angle"] = args["degrees"]
            args["unit"] = "degrees"
        if "radians" in args and "angle" not in args:
            args["angle"] = args["radians"]
            args["unit"] = "radians"

    elif name == "math_solve_trig":
        alias("equation", "expression", "eq")
        alias("variable", "var")
        alias("start", "from", "interval_start", "left")
        alias("end", "to", "interval_end", "right")

    elif name == "math_solve_system":
        alias("equations", "system", "eqs")
        alias("variables", "vars", "unknowns")
        if isinstance(args.get("equations"), str):
            args["equations"] = [
                part.strip()
                for part in re.split(r"[;\n]+", args["equations"])
                if part.strip()
            ]

    elif name == "math_solve_inequalities":
        alias("inequalities", "system", "ineqs")
        alias("variable", "var")
        if "inequality" in args and "inequalities" not in args:
            args["inequalities"] = [args["inequality"]]
        if isinstance(args.get("inequalities"), str):
            args["inequalities"] = [
                part.strip()
                for part in re.split(r"[;\n]+", args["inequalities"])
                if part.strip()
            ]

    elif name == "math_limit":
        alias("expression", "function", "fx")
        alias("variable", "var")
        alias("point", "x0", "at")
        alias("direction", "dir")

    elif name == "math_vector":
        alias("operation", "op", "type")
        alias("vector_a", "vector1", "a", "v1")
        alias("vector_b", "vector2", "b", "v2")

    elif name == "math_number_theory":
        alias("operation", "op", "type")
        alias("a", "n", "first")
        alias("b", "m", "second")

    elif name == "math_function_analysis":
        alias("expression", "function", "fx")
        alias("variable", "var")

    elif name in {"math_solve", "math_quadratic"}:
        alias("equation", "expression", "eq")
        alias("variable", "var")

    elif name in {"math_simplify", "math_factor", "math_expand"}:
        alias("expression", "expr", "formula")

    elif name in {"math_differentiate", "math_integrate", "math_domain"}:
        alias("expression", "function", "fx", "expr")
        alias("variable", "var")

    return args


def execute_tool(name: str, arguments: Mapping[str, Any] | None = None) -> dict[str, Any]:
    definition = TOOL_BY_NAME.get(name)
    if definition is None:
        raise ToolError(f"Неизвестный инструмент: {name}")
    normalized_arguments = _normalize_tool_arguments(name, arguments)
    allowed_arguments = set(inspect.signature(definition.handler).parameters)
    normalized_arguments = {
        key: value
        for key, value in normalized_arguments.items()
        if key in allowed_arguments
    }
    try:
        result = definition.handler(**normalized_arguments)
    except TypeError as exc:
        raise ToolError(f"Некорректные аргументы для {name}: {exc}") from exc
    return {"ok": True, "tool": name, "category": definition.category, "result": result}


def execute_tool_json(name: str, arguments_json: str | None) -> str:
    try:
        arguments = json.loads(arguments_json or "{}")
    except json.JSONDecodeError as exc:
        raise ToolError("Аргументы инструмента должны быть JSON") from exc
    if not isinstance(arguments, dict):
        raise ToolError("Аргументы инструмента должны быть объектом")
    return json.dumps(execute_tool(name, arguments), ensure_ascii=False)
