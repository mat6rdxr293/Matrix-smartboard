import { describe, expect, it } from "vitest";
import { findGraphIntersections } from "./graphIntersections";
import type { GraphExpression } from "./boardDocument";

const expression = (id: string, value: string, visible = true): GraphExpression => ({
  id,
  expression: value,
  color: "#fff",
  visible,
});

const bounds = { xMin: -5, xMax: 5, yMin: -5, yMax: 5 };

const hasPoint = (points: ReturnType<typeof findGraphIntersections>, x: number, y: number, precision = 4) =>
  points.some((point) => {
    const tolerance = 10 ** -precision;
    return Math.abs(point.x - x) < tolerance && Math.abs(point.y - y) < tolerance;
  });

describe("findGraphIntersections", () => {
  it("finds intersections of one function with both axes", () => {
    const points = findGraphIntersections([expression("a", "x+2")], bounds);
    expect(points).toHaveLength(2);
    expect(hasPoint(points, -2, 0)).toBe(true);
    expect(hasPoint(points, 0, 2)).toBe(true);
  });

  it("deduplicates the origin when a function crosses both axes there", () => {
    const points = findGraphIntersections([expression("a", "x")], bounds);
    expect(points).toHaveLength(1);
    expect(hasPoint(points, 0, 0)).toBe(true);
  });

  it("finds intersections between functions in addition to axis intersections", () => {
    const points = findGraphIntersections([expression("a", "x^2"), expression("b", "1")], bounds);
    expect(hasPoint(points, -1, 1)).toBe(true);
    expect(hasPoint(points, 1, 1)).toBe(true);
    expect(hasPoint(points, 0, 0)).toBe(true);
    expect(hasPoint(points, 0, 1)).toBe(true);
  });

  it("finds a tangent intersection with the X axis without a sign change", () => {
    const points = findGraphIntersections([expression("a", "(x-1.234)^2")], bounds);
    const tangent = points.find((point) => Math.abs(point.y) < 1e-5);
    expect(tangent).toBeDefined();
    expect(tangent?.x).toBeCloseTo(1.234, 3);
  });

  it("does not report a discontinuity as an axis intersection", () => {
    const points = findGraphIntersections([expression("a", "1/x")], bounds);
    expect(points).toHaveLength(0);
  });

  it("ignores hidden and invalid expressions", () => {
    const points = findGraphIntersections([
      expression("a", "x", false),
      expression("b", "unknown_fn(x)"),
    ], bounds);
    expect(points).toHaveLength(0);
  });

  it("deduplicates a shared origin across axes and multiple functions", () => {
    const points = findGraphIntersections([expression("a", "x"), expression("b", "-x")], bounds);
    expect(points).toHaveLength(1);
    expect(hasPoint(points, 0, 0)).toBe(true);
  });
});

