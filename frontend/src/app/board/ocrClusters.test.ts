import { describe, expect, it } from "vitest";
import type { Stroke } from "./boardEngine";
import { chooseActiveOcrCluster, chooseOcrTaskClusters, clusterOcrStrokes, composeOcrText, recentUserOcrStrokes, sanitizeMultiTaskOcrTexts } from "./ocrClusters";

const stroke = (x1: number, y1: number, x2: number, y2: number, source?: "ai"): Stroke => ({
  points: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
  color: "#f00",
  width: 4,
  mode: "draw",
  source,
});

describe("recentUserOcrStrokes", () => {
  it("only returns new student work written after the latest AI answer", () => {
    const oldTask = stroke(20, 20, 80, 80);
    const aiAnswer = stroke(100, 20, 180, 80, "ai");
    const newTaskA = stroke(20, 220, 100, 280);
    const newTaskB = stroke(120, 220, 200, 280);

    expect(recentUserOcrStrokes([oldTask, aiAnswer, newTaskA, newTaskB])).toEqual([
      newTaskA,
      newTaskB,
    ]);
  });

  it("falls back to student work when nothing new was written after AI", () => {
    const task = stroke(20, 20, 80, 80);
    const aiAnswer = stroke(100, 20, 180, 80, "ai");

    expect(recentUserOcrStrokes([task, aiAnswer])).toEqual([task]);
  });
});

describe("clusterOcrStrokes", () => {
  it("reattaches a detached trailing digit on the same equation row", () => {
    const strokes = [
      // Main equation row, deliberately wide and internally connected.
      stroke(40, 100, 110, 165),
      stroke(115, 125, 185, 125),
      stroke(190, 95, 260, 165),
      stroke(265, 125, 335, 125),
      stroke(340, 95, 410, 165),
      stroke(415, 125, 485, 125),
      // Large final digit is visibly on the same row, but detached by a wide gap.
      stroke(635, 95, 735, 165),
      stroke(735, 95, 665, 120),
      stroke(665, 120, 730, 135),
      stroke(730, 135, 670, 165),
      stroke(670, 165, 730, 165),
      stroke(730, 165, 740, 150),
    ];

    const clusters = clusterOcrStrokes(strokes);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(clusters[0].bounds.right).toBeGreaterThan(735);
  });

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

  it("returns multiple substantial tasks in reading order", () => {
    const strokes = [
      // Task 1, left.
      stroke(50, 80, 120, 140),
      stroke(125, 100, 180, 100),
      stroke(190, 70, 190, 145),
      // Task 2, right.
      stroke(430, 90, 500, 150),
      stroke(505, 110, 565, 110),
      stroke(580, 80, 580, 155),
      // Tiny accidental scribble below.
      stroke(820, 520, 832, 530),
      stroke(835, 528, 844, 536),
    ];

    const clusters = clusterOcrStrokes(strokes);
    const tasks = chooseOcrTaskClusters(clusters);

    expect(tasks).toHaveLength(2);
    expect(tasks[0].indices).toEqual([0, 1, 2]);
    expect(tasks[1].indices).toEqual([3, 4, 5]);
  });

  it("keeps the rows of each worked task together while keeping tasks separate", () => {
    const strokes = [
      // Task 1, two rows.
      stroke(40, 70, 110, 120),
      stroke(120, 90, 185, 90),
      stroke(50, 200, 115, 245),
      stroke(125, 220, 210, 220),
      // Task 2, two rows far to the right.
      stroke(500, 75, 575, 125),
      stroke(585, 95, 650, 95),
      stroke(505, 205, 575, 250),
      stroke(585, 225, 675, 225),
    ];

    const clusters = clusterOcrStrokes(strokes);
    const tasks = chooseOcrTaskClusters(clusters);

    expect(tasks).toHaveLength(2);
    expect(tasks[0].indices).toEqual([0, 1, 2, 3]);
    expect(tasks[1].indices).toEqual([4, 5, 6, 7]);
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


it("merges a vertically stacked worked solution into one OCR target", () => {
  const strokes = [
    // equation
    stroke(60, 80, 125, 135),
    stroke(132, 105, 195, 105),
    stroke(205, 78, 260, 138),
    // discriminant row
    stroke(80, 205, 135, 245),
    stroke(145, 225, 250, 225),
    stroke(260, 205, 330, 245),
    // x1 row
    stroke(72, 325, 135, 365),
    stroke(145, 345, 285, 345),
    stroke(295, 325, 360, 365),
    // x2 row
    stroke(70, 445, 135, 485),
    stroke(145, 465, 290, 465),
    stroke(300, 445, 380, 485),
  ];

  const clusters = clusterOcrStrokes(strokes);
  expect(clusters.length).toBeGreaterThanOrEqual(2);
  expect(chooseActiveOcrCluster(clusters)?.indices).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
  ]);
});

it("does not merge a distant problem written lower on the board", () => {
  const strokes = [
    stroke(60, 80, 130, 135),
    stroke(140, 105, 205, 105),
    stroke(70, 205, 135, 250),
    stroke(145, 225, 240, 225),
    // Separate later task, far below.
    stroke(65, 650, 145, 705),
    stroke(155, 675, 235, 675),
    stroke(245, 650, 315, 705),
  ];

  const clusters = clusterOcrStrokes(strokes);
  const active = chooseActiveOcrCluster(clusters);
  expect(active?.indices).toEqual([4, 5, 6]);
});

it("ignores a tiny newer scribble when an older equation is much more substantial", () => {
  const strokes = [
    stroke(40, 90, 120, 150),
    stroke(125, 115, 200, 115),
    stroke(205, 80, 260, 155),
    stroke(265, 110, 340, 110),
    stroke(345, 80, 420, 150),
    // Newer accidental scribble far away.
    stroke(760, 520, 778, 535),
    stroke(780, 532, 795, 540),
  ];

  const clusters = clusterOcrStrokes(strokes);
  expect(clusters).toHaveLength(2);
  expect(chooseActiveOcrCluster(clusters)?.indices).toEqual([0, 1, 2, 3, 4]);
});

it("keeps completed work visible while still finding the next task", () => {
  expect(
    sanitizeMultiTaskOcrTexts([
      "5x^2 + 4x - 9 = 0\nD = 196\nx1 = 1\nx2 = -1.8",
      "9x^2 + 11x + 3 = 3",
      "OK",
    ]),
  ).toEqual([
    "5x^2 + 4x - 9 = 0\nD = 196\nx1 = 1\nx2 = -1.8",
    "9x^2 + 11x + 3 = 3",
  ]);
});

it("splits two fresh equations even when OCR returns them in one close block", () => {
  expect(
    sanitizeMultiTaskOcrTexts([
      "x^2 - 4 = 0\n9x^2 + 11x + 3 = 3",
    ]),
  ).toEqual([
    "x^2 - 4 = 0",
    "9x^2 + 11x + 3 = 3",
  ]);
});

it("splits a new close task out of a completed first solution in one OCR block", () => {
  expect(
    sanitizeMultiTaskOcrTexts([
      "5x^2 + 4x - 9 = 0\nD = 196\nx1 = 1\nx2 = -1.8\n9x^2 + 11x + 3 = 3",
    ]),
  ).toEqual([
    "5x^2 + 4x - 9 = 0\nD = 196\nx1 = 1\nx2 = -1.8",
    "9x^2 + 11x + 3 = 3",
  ]);
});

it("cuts a stale root row accidentally attached before a new equation", () => {
  expect(
    sanitizeMultiTaskOcrTexts([
      "x2 = (-4 - 14) / 10 = -1.8\n9x^2 + 11x + 3 = 3",
      "OK",
    ]),
  ).toEqual(["9x^2 + 11x + 3 = 3"]);
});

it("keeps several fresh standalone tasks", () => {
  expect(
    sanitizeMultiTaskOcrTexts([
      "x^2 - 4 = 0",
      "9x^2 + 11x + 3 = 3",
      "2x + 7 = 11",
    ]),
  ).toEqual([
    "x^2 - 4 = 0",
    "9x^2 + 11x + 3 = 3",
    "2x + 7 = 11",
  ]);
});

it("keeps graph text out of OCR when handwriting was actually recognized", () => {
  expect(
    composeOcrText("5x^2 + 4x - 9 = 0", ["График: y = 5x^2+4x-9"], true),
  ).toBe("5x^2 + 4x - 9 = 0");
});

it("still exposes graph text when the board has no handwritten OCR target", () => {
  expect(
    composeOcrText("", ["График: y = 5x^2+4x-9"], false),
  ).toBe("График: y = 5x^2+4x-9");
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
