import { describe, expect, it } from "vitest";
import { createBoardHistory, replayBoardOperations, type GraphElement } from "./boardDocument";
import type { BoardReplayOp } from "./replayApi";

const graph = (id = "g1"): GraphElement => ({
  id,
  x: 100,
  y: 120,
  width: 420,
  height: 300,
  xLabel: "x",
  yLabel: "y",
  xMin: -10,
  xMax: 10,
  yMin: -10,
  yMax: 10,
  expressions: [{ id: "e1", expression: "x", color: "#4DA3FF", visible: true }],
});

describe("boardDocument", () => {
  it("replays graph add, update, undo and redo", () => {
    const before = graph();
    const after = { ...before, x: 240, expressions: [{ ...before.expressions[0], expression: "x^2" }] };
    const ops: BoardReplayOp[] = [
      { op: "graph_add", graph: before },
      { op: "graph_update", before, after },
      { op: "undo" },
      { op: "redo" },
    ];
    const state = replayBoardOperations(createBoardHistory(), ops);
    expect(state.document.graphs).toHaveLength(1);
    expect(state.document.graphs[0].x).toBe(240);
    expect(state.document.graphs[0].expressions[0].expression).toBe("x^2");
  });

  it("moves selected strokes and supports undo/redo", () => {
    const first = { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], color: "#fff", width: 2, mode: "draw" as const };
    const second = { points: [{ x: 20, y: 30 }, { x: 40, y: 50 }], color: "#fff", width: 2, mode: "draw" as const };
    const state = replayBoardOperations(createBoardHistory(), [
      { op: "add", stroke: first },
      { op: "add", stroke: second },
      { op: "stroke_move", indexes: [0], dx: 10, dy: -5 },
      { op: "undo" },
      { op: "redo" },
    ]);
    expect(state.document.strokes[0].points).toEqual([{ x: 11, y: -3 }, { x: 13, y: -1 }]);
    expect(state.document.strokes[1].points).toEqual(second.points);
  });

  it("deletes selected strokes and restores them with undo", () => {
    const first = { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], color: "#fff", width: 2, mode: "draw" as const };
    const second = { points: [{ x: 20, y: 30 }, { x: 40, y: 50 }], color: "#fff", width: 2, mode: "draw" as const };
    const state = replayBoardOperations(createBoardHistory(), [
      { op: "add", stroke: first },
      { op: "add", stroke: second },
      { op: "stroke_delete", indexes: [0], strokes: [first] },
      { op: "undo" },
    ]);
    expect(state.document.strokes).toHaveLength(2);
    expect(state.document.strokes[0].points).toEqual(first.points);
    expect(state.document.strokes[1].points).toEqual(second.points);
  });

  it("undoes graph deletion", () => {
    const g = graph();
    const state = replayBoardOperations(createBoardHistory(), [
      { op: "graph_add", graph: g },
      { op: "graph_delete", graph: g },
      { op: "undo" },
    ]);
    expect(state.document.graphs.map((item) => item.id)).toEqual(["g1"]);
  });

  it("undoes clear for a mixed document", () => {
    const stroke = { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], color: "#fff", width: 2, mode: "draw" as const };
    const state = replayBoardOperations(createBoardHistory(), [
      { op: "add", stroke },
      { op: "graph_add", graph: graph() },
      { op: "clear" },
      { op: "undo" },
    ]);
    expect(state.document.strokes).toHaveLength(1);
    expect(state.document.graphs).toHaveLength(1);
  });

  it("clears redo after a new command following undo", () => {
    const state = replayBoardOperations(createBoardHistory(), [
      { op: "graph_add", graph: graph("g1") },
      { op: "graph_add", graph: graph("g2") },
      { op: "undo" },
      { op: "graph_add", graph: graph("g3") },
      { op: "redo" },
    ]);
    expect(state.document.graphs.map((item) => item.id)).toEqual(["g1", "g3"]);
  });
});
