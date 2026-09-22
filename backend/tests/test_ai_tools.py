import pytest

from app.ai_tools import (
    ToolError,
    chemistry_balance_equation,
    chemistry_molar_mass,
    execute_tool,
    list_tool_definitions,
    geometry_compute,
    math_combinatorics,
    math_differentiate,
    math_domain,
    math_equivalent,
    math_expand,
    math_function_analysis,
    math_integrate,
    math_number_theory,
    math_percent,
    math_probability,
    math_quadratic,
    math_sequence,
    math_solve,
    math_solve_inequalities,
    math_solve_system,
    math_solve_trig,
    math_statistics,
    math_trig_value,
    math_vector,
    physics_check_dimensions,
    physics_convert_unit,
)


def test_math_tools_return_exact_results():
    solved = math_solve("x^2 - 4 = 0")
    assert [item["text"] for item in solved["solutions"]] == ["-2", "2"]

    derivative = math_differentiate("x^3 + 2*x", "x")
    assert derivative["result"]["text"] == "3*x**2 + 2"

    integral = math_integrate("2*x", "x", 0, 3)
    assert integral["result"]["text"] == "9"


def test_expand_and_equivalent_tools_verify_symbolic_answers():
    expanded = math_expand("(x+2)^2")
    assert expanded["result"]["text"] == "x**2 + 4*x + 4"

    equivalent = math_equivalent("3*x^2 + 2", "2 + 3*x^2")
    assert equivalent["equivalent"] is True

    wrong = math_equivalent("x^2 + 4", "(x+2)^2")
    assert wrong["equivalent"] is False


def test_quadratic_tool_verifies_discriminant_and_real_roots():
    result = math_quadratic("5*x^2 - 4*x + 5 = 0", "x")

    assert result["a"]["text"] == "5"
    assert result["b"]["text"] == "-4"
    assert result["c"]["text"] == "5"
    assert result["discriminant"]["text"] == "-84"
    assert result["discriminant_sign"] == -1
    assert result["has_real_roots"] is False
    assert result["real_roots"] == []


def test_physics_units_convert_and_check_dimensions():
    converted = physics_convert_unit(72, "km/h", "m/s")
    assert converted["result"] == pytest.approx(20.0)

    dimensions = physics_check_dimensions("N", "kg*m/s^2")
    assert dimensions["compatible"] is True


def test_chemistry_tools_balance_and_molar_mass():
    balanced = chemistry_balance_equation("Fe + O2 -> Fe2O3")
    assert balanced["balanced"] == "4Fe + 3O2 -> 2Fe2O3"
    assert balanced["coefficients"] == [4, 3, 2]

    water = chemistry_molar_mass("H2O")
    assert water["molar_mass_g_mol"] == pytest.approx(18.015, abs=0.001)


def test_subject_routing_exposes_only_relevant_tools():
    physics = {item["name"] for item in list_tool_definitions("physics")}
    assert "math_solve" in physics
    assert "math_quadratic" in physics
    assert "physics_convert_unit" in physics
    assert "chemistry_balance_equation" not in physics

    chemistry = {item["name"] for item in list_tool_definitions("химия")}
    assert "math_solve" in chemistry
    assert "chemistry_balance_equation" in chemistry
    assert "physics_convert_unit" not in chemistry

    assert list_tool_definitions("history") == []


def test_execute_tool_rejects_unknown_tool():
    with pytest.raises(ToolError):
        execute_tool("unknown_demo_tool", {})


def test_school_math_systems_inequalities_and_domain():
    system = math_solve_system(["x+y=7", "x-y=1"], ["x", "y"])
    assert system["solutions"][0]["x"]["text"] == "4"
    assert system["solutions"][0]["y"]["text"] == "3"

    inequality = math_solve_inequalities(["2*x-3>5"], "x")
    assert "4 < x" in inequality["result"]["text"]

    domain = math_domain("1/(x-2)", "x")
    assert "2" in domain["domain"]["text"]


def test_school_math_percent_sequences_combinatorics_probability_statistics():
    assert math_percent("percent_of", 240, 15)["result"] == pytest.approx(36.0)

    arithmetic = math_sequence("arithmetic", 3, 10, difference=2)
    assert arithmetic["nth"]["text"] == "21"
    assert arithmetic["sum_n"]["text"] == "120"

    geometric = math_sequence("geometric", 2, 5, ratio=3)
    assert geometric["nth"]["text"] == "162"
    assert geometric["sum_n"]["text"] == "242"

    assert math_combinatorics("combinations", 10, 3)["result"]["text"] == "120"
    probability = math_probability(favorable=3, total=8)
    assert probability["result"]["text"] == "3/8"

    stats = math_statistics([1, 2, 2, 3, 7])
    assert stats["mean"]["text"] == "3"
    assert stats["median"]["text"] == "2"
    assert [item["text"] for item in stats["modes"]] == ["2"]


def test_school_math_trigonometry_vectors_and_geometry():
    trig = math_trig_value("sin", 30)
    assert trig["result"]["text"] == "1/2"

    trig_solution = math_solve_trig("sin(x)=0", "x", 0, "2*pi")
    assert trig_solution["solution"]["text"] == "{0, pi, 2*pi}"

    dot = math_vector("dot", [1, 2], [3, 4])
    assert dot["result"]["text"] == "11"

    triangle = geometry_compute("triangle_sides", {"a": 3, "b": 4, "c": 5})
    assert triangle["area"]["text"] == "6"
    assert triangle["perimeter"]["text"] == "12"

    circle = geometry_compute("circle", {"radius": 3})
    assert circle["area"]["text"] == "9*pi"

    cylinder = geometry_compute("cylinder", {"radius": 2, "height": 5})
    assert cylinder["volume"]["text"] == "20*pi"


def test_math_evaluate_keeps_exact_fraction_and_approximation():
    result = execute_tool("math_evaluate", {"expression": "3/8"})["result"]
    assert result["result"]["text"] == "3/8"
    assert result["approximate"]["text"].startswith("0.375")


def test_task_aware_tool_routing_keeps_catalog_small_and_relevant():
    trig = {item["name"] for item in list_tool_definitions("алгебра", "Найти sin 30 градусов")}
    assert "math_trig_value" in trig
    assert "geometry_compute" not in trig
    assert "math_probability" not in trig

    geometry = {item["name"] for item in list_tool_definitions("геометрия", "Найти площадь круга радиуса 3")}
    assert "geometry_compute" in geometry
    assert "math_probability" not in geometry

    probability = {item["name"] for item in list_tool_definitions("математика", "Найти вероятность выбрать 2 красных шара")}
    assert "math_probability" in probability
    assert "math_combinatorics" in probability
    assert "geometry_compute" not in probability


def test_school_math_number_theory_and_function_analysis():
    assert math_number_theory("gcd", 84, 126)["result"] == 42
    assert math_number_theory("lcm", 12, 18)["result"] == 36
    assert math_number_theory("prime_factors", 84)["factors"] == {"2": 2, "3": 1, "7": 1}

    analysis = math_function_analysis("x^3 - 3*x", "x")
    assert analysis["derivative"]["text"] == "3*x**2 - 3"
    points = {(item["x"]["text"], item["type"]) for item in analysis["critical_points"]}
    assert ("-1", "maximum") in points
    assert ("1", "minimum") in points


def test_task_router_exposes_number_theory_and_function_analysis():
    number = {item["name"] for item in list_tool_definitions("математика", "Найти НОД 84 и 126")}
    assert "math_number_theory" in number
    assert "geometry_compute" not in number

    analysis = {item["name"] for item in list_tool_definitions("алгебра", "Исследовать функцию x^3-3x на экстремумы")}
    assert "math_function_analysis" in analysis
    assert "math_differentiate" in analysis
    assert "math_probability" not in analysis


def test_percent_tool_accepts_total_as_base_alias_for_local_model_calls():
    result = math_percent("percent_of", percent=15, total=240)
    assert result["result"] == pytest.approx(36.0)
    assert result["value"] == pytest.approx(240.0)


def test_geometry_accepts_natural_model_argument_aliases():
    triangle = geometry_compute(
        "triangle_sides",
        {"side1": 3, "side2": 4, "side3": 5},
    )
    assert triangle["area"]["text"] == "6"

    circle = geometry_compute("circle", {"r": 3})
    assert circle["area"]["text"] == "9*pi"

    prism = geometry_compute(
        "rectangular_prism",
        {"a": 2, "b": 3, "c": 4},
    )
    assert prism["volume"]["text"] == "24"


def test_execute_tool_normalizes_local_model_argument_aliases():
    geometry = execute_tool(
        "geometry_compute",
        {
            "object": "right_triangle",
            "values": {"leg1": 3, "leg2": 4},
        },
    )["result"]
    assert geometry["hypotenuse"]["text"] == "5"
    assert geometry["area"]["text"] == "6"

    sequence = execute_tool(
        "math_sequence",
        {
            "type": "arithmetic progression",
            "a1": 3,
            "d": 2,
            "n": 10,
        },
    )["result"]
    assert sequence["nth"]["text"] == "21"
    assert sequence["sum_n"]["text"] == "120"

    probability = execute_tool(
        "math_probability",
        {"favorable_outcomes": 3, "total_outcomes": 8},
    )["result"]
    assert probability["result"]["text"] == "3/8"
