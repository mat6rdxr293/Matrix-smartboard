import { describe, expect, it } from "vitest";
import { buildGraphPathSegments } from "./graphPlot";

describe("graphPlot", () => {
  it("splits 1/x at its discontinuity", () => {
    const segments = buildGraphPathSegments("1/x", {
      width: 420,
      height: 300,
      xMin: -10,
      xMax: 10,
      yMin: -10,
      yMax: 10,
    });
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments.every((segment) => segment.length > 0)).toBe(true);
  });

  it("splits tan(x) at large jumps", () => {
    const segments = buildGraphPathSegments("tan(x)", {
      width: 700,
      height: 300,
      xMin: -10,
      xMax: 10,
      yMin: -10,
      yMax: 10,
    });
    expect(segments.length).toBeGreaterThan(4);
  });
});
