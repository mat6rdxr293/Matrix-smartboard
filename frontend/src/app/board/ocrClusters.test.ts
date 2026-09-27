import { describe, expect, it } from "vitest";
import type { Stroke } from "./boardEngine";
import { chooseActiveOcrCluster, clusterOcrStrokes } from "./ocrClusters";

const stroke = (x1: number, y1: number, x2: number, y2: number, source?: "ai"): Stroke => ({
  points: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
  color: "#f00",
  width: 4,
  mode: "draw",
  source,
});

describe("clusterOcrStrokes", () => {
  it("keeps two nearby equations as separate blocks and picks the most recent one", () => {
    const strokes = [
      stroke(50, 80, 120, 140),
      stroke(125, 100, 180, 100),
      stroke(190, 70, 190, 145),
      stroke(430, 90, 500, 150),
      stroke(505, 110, 565, 110),
      stroke(580, 80, 580, 155),
    ];

    const clusters = clusterOcrStrokes(strokes);
    expect(clusters).toHaveLength(2);
    expect(chooseActiveOcrCluster(clusters)?.indices).toEqual([3, 4, 5]);
  });

  it("merges a superscript with its equation", () => {
    const strokes = [
      stroke(50, 120, 120, 190),
      stroke(125, 110, 180, 180),
      stroke(165, 70, 190, 95),
      stroke(200, 145, 250, 145),
    ];
    expect(clusterOcrStrokes(strokes)).toHaveLength(1);
  });

  it("ignores AI-generated handwriting when choosing OCR input", () => {
    const strokes = [
      stroke(50, 80, 120, 140),
      stroke(125, 100, 180, 100),
      stroke(600, 500, 700, 540, "ai"),
      stroke(710, 500, 780, 540, "ai"),
    ];
    const clusters = clusterOcrStrokes(strokes);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].indices).toEqual([0, 1]);
  });

  it("uses lasso selection as a single OCR target", () => {
    const strokes = [
      stroke(50, 80, 120, 140),
      stroke(125, 100, 180, 100),
      stroke(430, 90, 500, 150),
      stroke(505, 110, 565, 110),
    ];
    const clusters = clusterOcrStrokes(strokes, [0, 1]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].indices).toEqual([0, 1]);
  });
});


it("keeps one handwritten formula together across a moderate operator gap", () => {
  const strokes = [
    stroke(0, 0, 20, 90),
    stroke(30, 30, 80, 70),
    stroke(85, 25, 135, 65),
    stroke(140, 10, 160, 30),
    // About 38 px gap: should still be the same handwritten formula.
    stroke(198, 30, 235, 70),
    stroke(240, 30, 275, 70),
    stroke(280, 30, 320, 70),
  ];

  const clusters = clusterOcrStrokes(strokes);

  expect(clusters).toHaveLength(1);
  expect(clusters[0].indices).toEqual([0, 1, 2, 3, 4, 5, 6]);
});
