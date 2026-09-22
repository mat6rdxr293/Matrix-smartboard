from __future__ import annotations

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
    return {"expression": _math(parsed), "result": _math(sp.N(parsed.subs(subs), 15))}


def math_simplify(expression: str) -> dict[str, Any]:
    parsed = _expr(expression)
    return {"input": _math(parsed), "result": _math(sp.simplify(parsed))}


def math_factor(expression: str) -> dict[str, Any]:
    parsed = _expr(expression)
    return {"input": _math(parsed), "result": _math(sp.factor(parsed))}


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


def list_tool_definitions(subject: Optional[str] = None) -> list[dict[str, Any]]:
    categories = _subject_categories(subject)
    return [
        {"name": tool.name, "category": tool.category, "description": tool.description, "parameters": tool.parameters}
        for tool in TOOLS
        if tool.category in categories
    ]


def openai_chat_tools(subject: Optional[str] = None) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": item["name"],
                "description": item["description"],
                "parameters": item["parameters"],
            },
        }
        for item in list_tool_definitions(subject)
    ]


def execute_tool(name: str, arguments: Mapping[str, Any] | None = None) -> dict[str, Any]:
    definition = TOOL_BY_NAME.get(name)
    if definition is None:
        raise ToolError(f"Неизвестный инструмент: {name}")
    try:
        result = definition.handler(**dict(arguments or {}))
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
