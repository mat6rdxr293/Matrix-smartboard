import { describe, expect, it } from "vitest";
import { getSelectionBounds, pointInPolygon, selectGraphIds, selectStrokeIndices, translateStroke } from "./lasso";
import type { Stroke } from "./boardEngine";
import type { GraphElement } from "./boardDocument";

const square = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

describe("lasso geometry", () => {
  it("detects points inside a freeform selection", () => {
    expect(pointInPolygon({ x: 50, y: 50 }, square)).toBe(true);
    expect(pointInPolygon({ x: 140, y: 50 }, square)).toBe(false);
  });

  it("selects handwriting strokes and graphs enclosed by the lasso", () => {
    const strokes: Stroke[] = [
      { mode: "draw", color: "#fff", width: 4, points: [{ x: 10, y: 10 }, { x: 30, y: 30 }] },
      { mode: "draw", color: "#fff", width: 4, points: [{ x: 150, y: 150 }, { x: 180, y: 180 }] },
    ];
    const graphs: GraphElement[] = [{
      id: "g1", x: 20, y: 20, width: 40, height: 40,
      xLabel: "x", yLabel: "y", xMin: -10, xMax: 10, yMin: -10, yMax: 10, expressions: [],
    }];

    expect(selectStrokeIndices(strokes, square)).toEqual([0]);
    expect(selectGraphIds(graphs, square)).toEqual(["g1"]);
    expect(getSelectionBounds(strokes, [0], graphs, ["g1"])).toMatchObject({
      left: 8,
      top: 8,
      right: 60,
      bottom: 60,
    });
  });

  it("translates selected strokes without mutating the original", () => {
    const stroke: Stroke = {
      mode: "draw", color: "#fff", width: 4, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
    };
    const moved = translateStroke(stroke, 10, -5);
    expect(moved.points).toEqual([{ x: 11, y: -3 }, { x: 13, y: -1 }]);
    expect(stroke.points[0]).toEqual({ x: 1, y: 2 });
  });
});

