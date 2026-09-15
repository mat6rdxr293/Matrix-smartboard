import type { Stroke } from "./boardEngine";

export type GraphExpression = {
  id: string;
  expression: string;
  color: string;
  visible: boolean;
};

export type GraphElement = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  xLabel: string;
  yLabel: string;
  xMin: -10;
  xMax: 10;
  yMin: -10;
  yMax: 10;
  expressions: GraphExpression[];
};

export type BoardDocument = { strokes: Stroke[]; graphs: GraphElement[] };

type Snapshot = BoardDocument;
type Command =
  | { kind: "stroke_add"; stroke: Stroke }
  | { kind: "graph_add"; graph: GraphElement }
  | { kind: "graph_update"; before: GraphElement; after: GraphElement }
  | { kind: "graph_delete"; graph: GraphElement; index: number }
  | { kind: "clear"; before: Snapshot };

export type BoardHistory = {
  document: BoardDocument;
  undoStack: Command[];
  redoStack: Command[];
};

export type BoardOperation =
  | { op: "add"; stroke: Stroke }
  | { op: "graph_add"; graph: GraphElement }
  | { op: "graph_update"; before: GraphElement; after: GraphElement }
  | { op: "graph_delete"; graph: GraphElement }
  | { op: "undo" | "redo" | "clear" };

const cloneStroke = (stroke: Stroke): Stroke => ({ ...stroke, points: stroke.points.map((point) => ({ ...point })) });
const cloneGraph = (graph: GraphElement): GraphElement => ({
  ...graph,
  expressions: graph.expressions.map((expression) => ({ ...expression })),
});
const cloneDocument = (document: BoardDocument): BoardDocument => ({
  strokes: document.strokes.map(cloneStroke),
  graphs: document.graphs.map(cloneGraph),
});

export function createBoardHistory(document: BoardDocument = { strokes: [], graphs: [] }): BoardHistory {
  return { document: cloneDocument(document), undoStack: [], redoStack: [] };
}

function applyCommand(document: BoardDocument, command: Command): BoardDocument {
  const next = cloneDocument(document);
  if (command.kind === "stroke_add") {
    next.strokes.push(cloneStroke(command.stroke));
  } else if (command.kind === "graph_add") {
    next.graphs = next.graphs.filter((graph) => graph.id !== command.graph.id);
    next.graphs.push(cloneGraph(command.graph));
  } else if (command.kind === "graph_update") {
    next.graphs = next.graphs.map((graph) => graph.id === command.after.id ? cloneGraph(command.after) : graph);
  } else if (command.kind === "graph_delete") {
    next.graphs = next.graphs.filter((graph) => graph.id !== command.graph.id);
  } else if (command.kind === "clear") {
    next.strokes = [];
    next.graphs = [];
  }
  return next;
}

function revertCommand(document: BoardDocument, command: Command): BoardDocument {
  const next = cloneDocument(document);
  if (command.kind === "stroke_add") {
    next.strokes.pop();
  } else if (command.kind === "graph_add") {
    next.graphs = next.graphs.filter((graph) => graph.id !== command.graph.id);
  } else if (command.kind === "graph_update") {
    next.graphs = next.graphs.map((graph) => graph.id === command.before.id ? cloneGraph(command.before) : graph);
  } else if (command.kind === "graph_delete") {
    const existing = next.graphs.filter((graph) => graph.id !== command.graph.id);
    existing.splice(Math.min(command.index, existing.length), 0, cloneGraph(command.graph));
    next.graphs = existing;
  } else if (command.kind === "clear") {
    return cloneDocument(command.before);
  }
  return next;
}

function pushCommand(state: BoardHistory, command: Command): BoardHistory {
  return {
    document: applyCommand(state.document, command),
    undoStack: [...state.undoStack, command],
    redoStack: [],
  };
}

export function applyBoardOperation(state: BoardHistory, operation: BoardOperation): BoardHistory {
  if (operation.op === "add") {
    return pushCommand(state, { kind: "stroke_add", stroke: cloneStroke(operation.stroke) });
  }
  if (operation.op === "graph_add") {
    return pushCommand(state, { kind: "graph_add", graph: cloneGraph(operation.graph) });
  }
  if (operation.op === "graph_update") {
    return pushCommand(state, {
      kind: "graph_update",
      before: cloneGraph(operation.before),
      after: cloneGraph(operation.after),
    });
  }
  if (operation.op === "graph_delete") {
    const index = Math.max(0, state.document.graphs.findIndex((graph) => graph.id === operation.graph.id));
    return pushCommand(state, { kind: "graph_delete", graph: cloneGraph(operation.graph), index });
  }
  if (operation.op === "clear") {
    if (!state.document.strokes.length && !state.document.graphs.length) return state;
    return pushCommand(state, { kind: "clear", before: cloneDocument(state.document) });
  }
  if (operation.op === "undo") {
    const command = state.undoStack[state.undoStack.length - 1];
    if (!command) return state;
    return {
      document: revertCommand(state.document, command),
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, command],
    };
  }
  const command = state.redoStack[state.redoStack.length - 1];
  if (!command) return state;
  return {
    document: applyCommand(state.document, command),
    undoStack: [...state.undoStack, command],
    redoStack: state.redoStack.slice(0, -1),
  };
}

export function replayBoardOperations(state: BoardHistory, operations: BoardOperation[]): BoardHistory {
  return operations.reduce((current, operation) => applyBoardOperation(current, operation), state);
}
