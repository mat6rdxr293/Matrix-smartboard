import { describe, expect, it } from "vitest";
import {
  buildAiBoardState,
  graphFromAiAction,
  shapeActionToStrokes,
  updateGraphFromAiAction,
} from "./aiBoardActions";

const area = { x: 100, y: 200, width: 800, height: 500 };

describe("AI board actions", () => {
  it("builds a real graph element with multiple expressions", () => {
    const graph = graphFromAiAction({
      type: "add_graph",
      expressions: ["x^2", "sin(x)"],
      x_min: -5,
      x_max: 5,
      y_min: -2,
      y_max: 10,
    }, area);

    expect(graph.expressions.map((item) => item.expression)).toEqual(["x^2", "sin(x)"]);
    expect(graph.xMin).toBe(-5);
    expect(graph.xMax).toBe(5);
    expect(graph.width).toBeGreaterThanOrEqual(280);
  });
  it("updates and repositions an existing graph without changing its id", () => {
    const before = graphFromAiAction({ type: "add_graph", expressions: ["x"] }, area);
    const after = updateGraphFromAiAction(before, {
      type: "update_graph",
      target_id: before.id,
      expressions: ["x^3"],
      y_min: -20,
      y_max: 20,
      x: 60,
      y: 35,
      width: 45,
      height: 50,
    }, area);

    expect(after.id).toBe(before.id);
    expect(after.expressions[0].expression).toBe("x^3");
    expect(after.yMin).toBe(-20);
    expect(after.yMax).toBe(20);
    expect(after.x).not.toBe(before.x);
    expect(after.y).not.toBe(before.y);
  });

  it("renders shapes as persistent AI strokes", () => {
    const arrow = shapeActionToStrokes({
      type: "add_shape",
      shape: "arrow",
      x: 10,
      y: 20,
      width: 40,
      height: 10,
    }, area, "#2563EB");
    const triangle = shapeActionToStrokes({
      type: "add_shape",
      shape: "triangle",
      x: 20,
      y: 20,
      width: 35,
      height: 40,
    }, area, "#2563EB");

    expect(arrow).toHaveLength(2);
    expect(arrow[0].points).toHaveLength(2);
    expect(arrow[1].points).toHaveLength(3);
    expect(triangle).toHaveLength(1);
    expect(triangle[0].points).toHaveLength(4);
    expect(triangle.every((stroke) => stroke.source === "ai")).toBe(true);
  });

  it("exposes graph ids and compact stroke bounds instead of raw points", () => {
    const graph = graphFromAiAction({ type: "add_graph", expressions: ["x^2"] }, area);
    const strokes = [
      {
        points: [{ x: 10, y: 20 }, { x: 30, y: 50 }],
        color: "#000000",
        width: 2,
        mode: "draw" as const,
        source: "user" as const,
      },
      {
        points: [{ x: 100, y: 120 }, { x: 180, y: 150 }],
        color: "#2563EB",
        width: 2,
        mode: "draw" as const,
        source: "ai" as const,
      },
    ];
    const state = buildAiBoardState([graph], strokes);
    expect(state.stroke_count).toBe(2);
    expect(state.strokes[0]).toEqual({
      index: 0,
      x: 10,
      y: 20,
      width: 20,
      height: 30,
      source: "user",
      color: "#000000",
    });
    expect(state.graphs[0].id).toBe(graph.id);
    expect(state.graphs[0].expressions).toEqual(["x^2"]);
  });
});
