import { describe, expect, it } from "vitest";
import type { Point } from "./boardEngine";
import { recognizeShape } from "./shapeRecognition";

// Deterministic wobble so the tests exercise tolerance without being flaky.
const wobble = (i: number, amount: number) => Math.sin(i * 1.7) * amount;

const along = (from: Point, to: Point, steps: number, noise: number, offset = 0): Point[] =>
  Array.from({ length: steps }, (_, i) => {
    const t = i / steps;
    return { x: from.x + (to.x - from.x) * t + wobble(i + offset, noise), y: from.y + (to.y - from.y) * t + wobble(i + offset + 3, noise) };
  });

const polygon = (vertices: Point[], noise = 2): Point[] => [
  ...vertices.flatMap((v, i) => along(v, vertices[(i + 1) % vertices.length], 20, noise, i * 20)),
  { ...vertices[0] },
];

const ellipse = (cx: number, cy: number, rx: number, ry: number, noise = 2, sweep = 2 * Math.PI): Point[] =>
  Array.from({ length: 80 }, (_, i) => {
    const t = (i / 79) * sweep;
    return { x: cx + rx * Math.cos(t) + wobble(i, noise), y: cy + ry * Math.sin(t) + wobble(i + 5, noise) };
  });

describe("recognizeShape", () => {
  it("straightens a slightly wobbly line between its ends", () => {
    const shape = recognizeShape(along({ x: 0, y: 0 }, { x: 300, y: 40 }, 60, 3));
    expect(shape?.kind).toBe("line");
    // Every point lies on the chord between the drawn ends.
    const [start, end] = [shape!.points[0], shape!.points[shape!.points.length - 1]];
    const cross = (p: Point) => (end.x - start.x) * (p.y - start.y) - (end.y - start.y) * (p.x - start.x);
    expect(shape!.points.every((p) => Math.abs(cross(p)) < 1e-6 * 300 * 300)).toBe(true);
  });

  it("recognizes circles and ellipses", () => {
    expect(recognizeShape(ellipse(100, 100, 80, 78))?.kind).toBe("circle");
    expect(recognizeShape(ellipse(100, 100, 150, 60))?.kind).toBe("ellipse");
  });

  it("recognizes a triangle", () => {
    expect(recognizeShape(polygon([{ x: 0, y: 200 }, { x: 120, y: 0 }, { x: 240, y: 200 }]))?.kind).toBe("triangle");
  });

  it("squares an almost axis-aligned rectangle onto the axes", () => {
    const shape = recognizeShape(polygon([{ x: 0, y: 0 }, { x: 300, y: 6 }, { x: 296, y: 180 }, { x: 4, y: 176 }]));
    expect(shape?.kind).toBe("rectangle");
    const xs = new Set(shape!.points.filter((_, i) => i % 10 === 0).map((p) => Math.round(p.x)));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    // Every corner now shares an x or y with its neighbours.
    const corners = [shape!.points[0], ...shape!.points.filter((p, i, all) => i > 0 && i < all.length - 1 && (
      Math.abs(p.x - all[i - 1].x) > 0.01) !== (Math.abs(p.x - all[i + 1].x) > 0.01))];
    expect(corners.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps a skewed four-sided shape as a quadrilateral", () => {
    expect(recognizeShape(polygon([{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 380, y: 180 }, { x: 80, y: 180 }]))?.kind).toBe("quadrilateral");
  });

  it("leaves handwriting and small marks alone", () => {
    const scribble = Array.from({ length: 60 }, (_, i) => ({ x: i * 4, y: Math.sin(i * 0.9) * 30 }));
    expect(recognizeShape(scribble)).toBeNull();
    expect(recognizeShape(along({ x: 0, y: 0 }, { x: 10, y: 4 }, 20, 0.5))).toBeNull();
    expect(recognizeShape(ellipse(100, 100, 80, 80, 2, Math.PI))).toBeNull();
  });
});
