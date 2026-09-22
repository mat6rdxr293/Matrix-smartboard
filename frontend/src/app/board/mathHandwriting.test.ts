import { describe, expect, it } from "vitest";
import {
  parseMathHandwritingTokens,
  renderMathAwareLine,
} from "./mathHandwriting";

const fakeStroke = (x: number, y: number) => ({
  points: [
    { x, y },
    { x: x + 1, y: y + 1 },
  ],
  color: "#000",
  width: 2,
  mode: "draw" as const,
  source: "ai" as const,
});

describe("math handwriting parsing", () => {
  it("parses integral limits separately from the integrand", () => {
    expect(parseMathHandwritingTokens("∫₍0₎⁴ (3x² + 1) dx")).toEqual([
      { type: "integral", lower: "0", upper: "4" },
      { type: "text", value: " (3x² + 1) dx" },
    ]);

    expect(parseMathHandwritingTokens("∫_0⁴ x² dx")).toEqual([
      { type: "integral", lower: "0", upper: "4" },
      { type: "text", value: " x² dx" },
    ]);

    expect(parseMathHandwritingTokens("∫⁴_0 x² dx")).toEqual([
      { type: "integral", lower: "0", upper: "4" },
      { type: "text", value: " x² dx" },
    ]);
  });

  it("keeps nested radical contents grouped under the radical token", () => {
    expect(parseMathHandwritingTokens("√(x + √(y+1)) ≤ 5")).toEqual([
      {
        type: "sqrt",
        body: [
          { type: "text", value: "x + " },
          {
            type: "sqrt",
            body: [{ type: "text", value: "y+1" }],
          },
        ],
      },
      { type: "text", value: " " },
      { type: "relation", value: "≤" },
      { type: "text", value: " 5" },
    ]);
  });
});

describe("math handwriting geometry", () => {
  const render = (source: string) =>
    renderMathAwareLine(source, {
      x: 10,
      y: 20,
      fontSize: 30,
      color: "#2563EB",
      strokeWidth: 2,
      measurePlain: (text, size) => text.length * size * 0.5,
      renderPlain: (_text, x, y) => [fakeStroke(x, y)],
    });

  it("draws a radical bar over the full radicand width", () => {
    const result = render("√(x+123)");

    const horizontal = result.strokes.find((item) => {
      if (item.points.length !== 2) return false;
      const [a, b] = item.points;
      return Math.abs(a.y - b.y) < 0.001 && b.x - a.x > 40;
    });

    expect(horizontal).toBeTruthy();
    expect(horizontal!.points[1].x - horizontal!.points[0].x).toBeGreaterThan(60);
    expect(result.width).toBeGreaterThan(90);
  });

  it("draws less/greater relations geometrically", () => {
    const result = render("< > ≤ ≥");

    const longTextSkeletons = result.strokes.filter(
      (item) => item.points.length === 2 && item.points[1].x - item.points[0].x === 1,
    );
    expect(result.strokes.length).toBeGreaterThan(longTextSkeletons.length + 8);
  });

  it("draws an integral taller than normal text and renders both limits", () => {
    const result = render("∫₍0₎⁴ x² dx");

    expect(result.height).toBeGreaterThan(40);
    // Main integral + hooks + upper/lower plain strokes + trailing plain text.
    expect(result.strokes.length).toBeGreaterThanOrEqual(6);
  });
});
