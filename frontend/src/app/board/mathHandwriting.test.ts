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
      { type: "integral", lower: [{ type: "text", value: "0" }], upper: [{ type: "text", value: "4" }] },
      { type: "text", value: " (3x² + 1) dx" },
    ]);

    expect(parseMathHandwritingTokens("∫_0⁴ x² dx")).toEqual([
      { type: "integral", lower: [{ type: "text", value: "0" }], upper: [{ type: "text", value: "4" }] },
      { type: "text", value: " x² dx" },
    ]);

    expect(parseMathHandwritingTokens("∫⁴_0 x² dx")).toEqual([
      { type: "integral", lower: [{ type: "text", value: "0" }], upper: [{ type: "text", value: "4" }] },
      { type: "text", value: " x² dx" },
    ]);
  });



  it("parses normalized fractions with nested radicals and pi", () => {
    expect(parseMathHandwritingTokens("(4√(π))/(11)")).toEqual([
      {
        type: "fraction",
        numerator: [
          { type: "text", value: "4" },
          {
            type: "sqrt",
            body: [{ type: "pi" }],
          },
        ],
        denominator: [{ type: "text", value: "11" }],
      },
    ]);
  });

  it("parses a fractional radical upper integral limit", () => {
    expect(
      parseMathHandwritingTokens("∫₍-√(π)₎⁽(4√(π))/(11)⁾ f(x) dx"),
    ).toEqual([
      {
        type: "integral",
        lower: [
          { type: "text", value: "-" },
          { type: "sqrt", body: [{ type: "pi" }] },
        ],
        upper: [
          {
            type: "fraction",
            numerator: [
              { type: "text", value: "4" },
              { type: "sqrt", body: [{ type: "pi" }] },
            ],
            denominator: [{ type: "text", value: "11" }],
          },
        ],
      },
      { type: "text", value: " f(x) dx" },
    ]);
  });

  it("keeps decimal separators as dedicated math tokens", () => {
    expect(parseMathHandwritingTokens("0.0468")).toEqual([
      { type: "text", value: "0" },
      { type: "decimal", value: "." },
      { type: "text", value: "0468" },
    ]);
    expect(parseMathHandwritingTokens("0,0468")).toEqual([
      { type: "text", value: "0" },
      { type: "decimal", value: "," },
      { type: "text", value: "0468" },
    ]);
  });

  it("parses fragile operators as geometric math tokens", () => {
    expect(parseMathHandwritingTokens("a·b×c÷d±e∓f°∞g′")).toEqual([
      { type: "text", value: "a" },
      { type: "operator", value: "·" },
      { type: "text", value: "b" },
      { type: "operator", value: "×" },
      { type: "text", value: "c" },
      { type: "operator", value: "÷" },
      { type: "text", value: "d" },
      { type: "operator", value: "±" },
      { type: "text", value: "e" },
      { type: "operator", value: "∓" },
      { type: "text", value: "f" },
      { type: "operator", value: "°" },
      { type: "operator", value: "∞" },
      { type: "text", value: "g" },
      { type: "operator", value: "′" },
    ]);
  });

  it("parses the tends-to arrow as a geometric math token", () => {
    expect(parseMathHandwritingTokens("x → 0")).toEqual([
      { type: "text", value: "x " },
      { type: "arrow", value: "→" },
      { type: "text", value: " 0" },
    ]);
    expect(parseMathHandwritingTokens("A ⇔ B")).toEqual([
      { type: "text", value: "A " },
      { type: "arrow", value: "⇔" },
      { type: "text", value: " B" },
    ]);
  });

  it("accepts compact unicode lower integral limits", () => {
    expect(parseMathHandwritingTokens("∫₀⁴ x² dx")).toEqual([
      { type: "integral", lower: [{ type: "text", value: "0" }], upper: [{ type: "text", value: "4" }] },
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

  it("draws decimal point and comma as explicit visible strokes", () => {
    const point = render("0.0468");
    const comma = render("0,0468");

    const pointGlyphs = point.strokes.filter((item) =>
      item.points.length === 3 &&
      Math.max(...item.points.map((p) => p.x)) - Math.min(...item.points.map((p) => p.x)) < 10
    );
    const commaGlyphs = comma.strokes.filter((item) =>
      item.points.length === 3 &&
      Math.max(...item.points.map((p) => p.x)) - Math.min(...item.points.map((p) => p.x)) < 10
    );

    expect(pointGlyphs.length).toBeGreaterThanOrEqual(1);
    expect(commaGlyphs.length).toBeGreaterThanOrEqual(2);
  });

  it("draws tiny arithmetic operators, degrees and primes geometrically", () => {
    const result = render("a·b×c÷d±e∓f°∞g′");
    const tinyDots = result.strokes.filter((item) => {
      if (item.points.length !== 3) return false;
      const xs = item.points.map((point) => point.x);
      return Math.max(...xs) - Math.min(...xs) < 10;
    });
    const closedLoops = result.strokes.filter((item) => item.points.length >= 16);
    const diagonals = result.strokes.filter((item) => {
      if (item.points.length !== 2) return false;
      const [a, b] = item.points;
      return Math.abs(a.x - b.x) > 4 && Math.abs(a.y - b.y) > 4;
    });

    const primeStrokes = result.strokes.filter((item) => {
      if (item.points.length !== 2) return false;
      const [a, b] = item.points;
      return Math.abs(a.x - b.x) < 5 && Math.abs(a.y - b.y) > 5;
    });

    expect(tinyDots.length).toBeGreaterThanOrEqual(3);
    expect(closedLoops.length).toBeGreaterThanOrEqual(2);
    expect(diagonals.length).toBeGreaterThanOrEqual(2);
    expect(primeStrokes.length).toBeGreaterThanOrEqual(1);
  });

  it("draws x tends to zero with a real arrow shaft and head", () => {
    const result = render("x → 0");
    const shaft = result.strokes.find((item) => {
      if (item.points.length !== 2) return false;
      const [a, b] = item.points;
      return Math.abs(a.y - b.y) < 0.01 && b.x - a.x > 20;
    });
    const head = result.strokes.find((item) => item.points.length === 3);

    expect(shaft).toBeTruthy();
    expect(head).toBeTruthy();
  });

  it("draws bidirectional arrows and approximation relations geometrically", () => {
    const result = render("A ⇔ B, x ≈ y, a ≠ b, p ≡ q");
    const longHorizontal = result.strokes.filter((item) => {
      if (item.points.length !== 2) return false;
      const [a, b] = item.points;
      return Math.abs(a.y - b.y) < 0.01 && Math.abs(b.x - a.x) > 12;
    });
    const waves = result.strokes.filter((item) => item.points.length >= 10);
    const arrowHeads = result.strokes.filter((item) => item.points.length === 3);

    expect(longHorizontal.length).toBeGreaterThanOrEqual(7);
    expect(waves.length).toBeGreaterThanOrEqual(2);
    expect(arrowHeads.length).toBeGreaterThanOrEqual(2);
  });

  it("draws less/greater relations geometrically", () => {
    const result = render("< > ≤ ≥");

    const longTextSkeletons = result.strokes.filter(
      (item) => item.points.length === 2 && item.points[1].x - item.points[0].x === 1,
    );
    expect(result.strokes.length).toBeGreaterThan(longTextSkeletons.length + 8);
  });



  it("renders a real fraction bar and a geometric pi glyph", () => {
    const result = render("(4√(π))/(11)");

    const fractionBars = result.strokes.filter((item) => {
      if (item.points.length !== 2) return false;
      const [a, b] = item.points;
      return Math.abs(a.y - b.y) < 0.01 && Math.abs(b.x - a.x) > 15;
    });
    expect(fractionBars.length).toBeGreaterThanOrEqual(2);

    const piLike = result.strokes.filter((item) => item.points.length === 3);
    expect(piLike.length).toBeGreaterThanOrEqual(3);

    const ys = result.strokes.flatMap((item) => item.points.map((point) => point.y));
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(24);
  });

  it("draws an integral taller than normal text and renders both limits", () => {
    const result = render("∫₍0₎⁴ x² dx");

    expect(result.height).toBeGreaterThan(40);
    // Main integral + hooks + upper/lower plain strokes + trailing plain text.
    expect(result.strokes.length).toBeGreaterThanOrEqual(6);
  });
});
