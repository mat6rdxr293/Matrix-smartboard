import { describe, expect, it } from "vitest";
import { formatGraphTick, getGraphTickStep, panGraphViewport, zoomGraphViewport } from "./graphViewport";

describe("graph viewport", () => {
  it("chooses Desmos-like division prices as the viewport changes", () => {
    expect(getGraphTickStep(-10, 10)).toBe(2);
    expect(getGraphTickStep(-5, 5)).toBe(1);
    expect(getGraphTickStep(-2.5, 2.5)).toBe(0.5);
    expect(getGraphTickStep(-1.25, 1.25)).toBe(0.25);
  });

  it("zooms around the pointer instead of around the origin", () => {
    const next = zoomGraphViewport(
      { xMin: -10, xMax: 10, yMin: -10, yMax: 10 },
      0.5,
      { x: 0.75, y: 0.25 },
    );
    expect(next).toEqual({ xMin: -2.5, xMax: 7.5, yMin: -2.5, yMax: 7.5 });
  });

  it("formats fractional ticks without floating point noise", () => {
    expect(formatGraphTick(0.5, 0.5)).toBe("0.5");
    expect(formatGraphTick(0.25000000000000006, 0.25)).toBe("0.25");
    expect(formatGraphTick(-0, 0.25)).toBe("0");
  });

  it("pans the mathematical viewport in screen drag direction", () => {
    expect(panGraphViewport(
      { xMin: -10, xMax: 10, yMin: -10, yMax: 10 },
      { x: 42, y: 30 },
      { width: 420, height: 300 },
    )).toEqual({ xMin: -12, xMax: 8, yMin: -8, yMax: 12 });
  });
});
