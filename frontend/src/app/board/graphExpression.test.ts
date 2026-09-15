import { describe, expect, it } from "vitest";
import { compileExpression } from "./graphExpression";

describe("graphExpression", () => {
  it("respects precedence, unary minus, powers and implicit multiplication", () => {
    expect(compileExpression("2+3*4").evaluate(0)).toBe(14);
    expect(compileExpression("-x^2").evaluate(3)).toBe(-9);
    expect(compileExpression("2x+2(x+1)+(x+1)(x-1)").evaluate(2)).toBe(13);
  });

  it("supports constants, decimal comma, logs, roots and helper functions", () => {
    expect(compileExpression("pi+e").evaluate(0)).toBeCloseTo(Math.PI + Math.E);
    expect(compileExpression("1,5x").evaluate(2)).toBeCloseTo(3);
    expect(compileExpression("ln(e)+lg(100)+log2(8)").evaluate(0)).toBeCloseTo(6);
    expect(compileExpression("sqrt(9)+cbrt(8)+abs(-2)+floor(1.9)+ceil(1.1)+round(1.6)+sign(-5)").evaluate(0)).toBeCloseTo(11);
  });

  it("supports trigonometric aliases, inverse and hyperbolic functions", () => {
    expect(compileExpression("tg(pi/4)+ctg(pi/4)").evaluate(0)).toBeCloseTo(2);
    expect(compileExpression("arcsin(1)+arccos(1)+arctg(1)+arccot(1)").evaluate(0)).toBeCloseTo(Math.PI);
    expect(compileExpression("sinh(0)+cosh(0)+tanh(0)+coth(1)").evaluate(0)).toBeCloseTo(1 + 1 / Math.tanh(1));
  });

  it("returns non-finite values for points outside a function domain", () => {
    expect(Number.isFinite(compileExpression("sqrt(x)").evaluate(-1))).toBe(false);
    expect(Number.isFinite(compileExpression("ln(x)").evaluate(0))).toBe(false);
  });

  it("reuses the compiled program for the same normalized expression", () => {
    const first = compileExpression(" x^2 + 1 ");
    const second = compileExpression("x^2 + 1");
    expect(second).toBe(first);
  });

  it("rejects unknown names and expressions longer than 120 characters", () => {
    expect(() => compileExpression("evil(x)")).toThrow(/неизвест|unknown/i);
    expect(() => compileExpression("x".repeat(121))).toThrow(/120|длин/i);
  });
});
