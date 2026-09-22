import pytest

from app.ai_tools import (
    ToolError,
    chemistry_balance_equation,
    chemistry_molar_mass,
    execute_tool,
    list_tool_definitions,
    math_differentiate,
    math_equivalent,
    math_expand,
    math_integrate,
    math_quadratic,
    math_solve,
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
