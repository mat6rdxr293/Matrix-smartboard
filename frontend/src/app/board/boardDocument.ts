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
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  expressions: GraphExpression[];
  /** Stacking among graphs: higher is on top. */
  z?: number;
};

export type AiSolutionStep = {
  id: string;
  text: string;
  kind: "text" | "math" | "result" | "warning";
};

export type AiSolutionBlock = {
  id: string;
  x: number;
  y: number;
  width: number;
  minHeight: number;
  steps: AiSolutionStep[];
  status: "thinking" | "streaming" | "done" | "error";
  source: "ai";
  createdAt: number;
};

/** A picture under the ink: an uploaded image or a textbook page. `src` is a path on the lesson's server. */
export type BoardImage = {
  id: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  /** Stacking among pictures: higher is on top. Pictures without one stack in the order they were added. */
  z?: number;
};

/**
 * Pictures and graphs share one stack, so a picture can be raised over a graph and back.
 * Items saved before stacking existed have no `z`: pictures then keep the order they were
 * added in, and graphs sit above every picture, as they always did.
 */
export type StackEntry =
  | { kind: "image"; item: BoardImage; layer: number }
  | { kind: "graph"; item: GraphElement; layer: number };

const GRAPH_DEFAULT_LAYER = 1000;

/** Everything in the stack, bottom to top. */
export function boardStack(images: BoardImage[], graphs: GraphElement[]): StackEntry[] {
  const entries: (StackEntry & { order: number })[] = [
    ...images.map((item, index) => ({ kind: "image" as const, item, layer: item.z ?? index, order: index })),
    ...graphs.map((item, index) => ({ kind: "graph" as const, item, layer: item.z ?? GRAPH_DEFAULT_LAYER + index, order: images.length + index })),
  ];
  return entries.sort((a, b) => a.layer - b.layer || a.order - b.order).map(({ order: _order, ...entry }) => entry as StackEntry);
}

/**
 * Pictures with a graph under them. They are drawn among the graphs, over the ink like the graphs
 * are; the others stay under the ink so writing on them shows.
 */
export function liftedImageIds(stack: StackEntry[]): Set<string> {
  const lifted = new Set<string>();
  let graphBelow = false;
  for (const entry of stack) {
    if (entry.kind === "graph") graphBelow = true;
    else if (graphBelow) lifted.add(entry.item.id);
  }
  return lifted;
}

/** Pictures bottom to top. */
export const imagesInLayerOrder = (images: BoardImage[], graphs: GraphElement[] = []) =>
  boardStack(images, graphs).flatMap((entry) => (entry.kind === "image" ? [entry.item] : []));

/** A layer above everything: where a new graph goes. */
export const topLayer = (images: BoardImage[], graphs: GraphElement[]) => {
  const stack = boardStack(images, graphs);
  return stack.length ? stack[stack.length - 1].layer + 1 : 0;
};

/** Where a new picture goes: above the other pictures but under every graph, so it stays under the ink. */
export function newPictureLayer(images: BoardImage[], graphs: GraphElement[]): number {
  const stack = boardStack(images, graphs);
  const firstGraph = stack.findIndex((entry) => entry.kind === "graph");
  if (firstGraph < 0) return stack.length ? stack[stack.length - 1].layer + 1 : 0;
  const graphLayer = stack[firstGraph].layer;
  const below = firstGraph > 0 ? stack[firstGraph - 1].layer : graphLayer - 2;
  return below + 1 < graphLayer ? below + 1 : (below + graphLayer) / 2;
}

/**
 * The picture or graph moved one place up (`1`) or down (`-1`) the shared stack, past its
 * neighbour only; null when it is already at that end.
 */
export function restackOnBoard(images: BoardImage[], graphs: GraphElement[], id: string, direction: 1 | -1): StackEntry | null {
  const stack = boardStack(images, graphs);
  const at = stack.findIndex((entry) => entry.item.id === id);
  const neighbour = stack[at + direction];
  if (at < 0 || !neighbour) return null;
  const beyond = stack[at + direction * 2];
  let z = beyond ? (neighbour.layer + beyond.layer) / 2 : neighbour.layer + direction;
  // Equal layers fall back to insertion order, so step just past the neighbour instead.
  if (z === neighbour.layer) z = neighbour.layer + direction * 0.001;
  const entry = stack[at];
  return entry.kind === "image"
    ? { kind: "image", item: { ...entry.item, z }, layer: z }
    : { kind: "graph", item: { ...entry.item, z }, layer: z };
}

export type BoardDocument = {
  strokes: Stroke[];
  graphs: GraphElement[];
  solutions: AiSolutionBlock[];
  /** Optional so documents saved before images existed still load. */
  images?: BoardImage[];
};

type Snapshot = BoardDocument;
type Command =
  | { kind: "stroke_add"; stroke: Stroke }
  | { kind: "stroke_batch_add"; strokes: Stroke[] }
  | { kind: "stroke_move"; indexes: number[]; dx: number; dy: number }
  | { kind: "stroke_delete"; entries: { index: number; stroke: Stroke }[] }
  | { kind: "graph_add"; graph: GraphElement }
  | { kind: "graph_update"; before: GraphElement; after: GraphElement }
  | { kind: "graph_delete"; graph: GraphElement; index: number }
  | { kind: "solution_add"; solution: AiSolutionBlock }
  | { kind: "solution_update"; before: AiSolutionBlock; after: AiSolutionBlock }
  | { kind: "solution_delete"; solution: AiSolutionBlock; index: number }
  | { kind: "image_add"; image: BoardImage }
  | { kind: "image_update"; before: BoardImage; after: BoardImage }
  | { kind: "image_delete"; image: BoardImage; index: number }
  | { kind: "clear"; before: Snapshot };

export type BoardHistory = {
  document: BoardDocument;
  undoStack: Command[];
  redoStack: Command[];
};

export type BoardOperation =
  | { op: "add"; stroke: Stroke }
  | { op: "stroke_batch_add"; strokes: Stroke[] }
  | { op: "stroke_move"; indexes: number[]; dx: number; dy: number }
  | { op: "stroke_delete"; indexes: number[]; strokes: Stroke[] }
  | { op: "graph_add"; graph: GraphElement }
  | { op: "graph_update"; before: GraphElement; after: GraphElement }
  | { op: "graph_delete"; graph: GraphElement }
  | { op: "solution_add"; solution: AiSolutionBlock }
  | { op: "solution_update"; before: AiSolutionBlock; after: AiSolutionBlock }
  | { op: "solution_delete"; solution: AiSolutionBlock }
  | { op: "image_add"; image: BoardImage }
  | { op: "image_update"; before: BoardImage; after: BoardImage }
  | { op: "image_delete"; image: BoardImage }
  | { op: "undo" | "redo" | "clear" };

const cloneStroke = (stroke: Stroke): Stroke => ({ ...stroke, points: stroke.points.map((point) => ({ ...point })) });
const cloneGraph = (graph: GraphElement): GraphElement => ({
  ...graph,
  expressions: graph.expressions.map((expression) => ({ ...expression })),
});
const cloneSolution = (solution: AiSolutionBlock): AiSolutionBlock => ({
  ...solution,
  steps: solution.steps.map((step) => ({ ...step })),
});
const cloneDocument = (document: BoardDocument): BoardDocument => ({
  strokes: document.strokes.map(cloneStroke),
  graphs: document.graphs.map(cloneGraph),
  solutions: (document.solutions ?? []).map(cloneSolution),
  images: (document.images ?? []).map((image) => ({ ...image })),
});

export function createBoardHistory(document: BoardDocument = { strokes: [], graphs: [], solutions: [] }): BoardHistory {
  return { document: cloneDocument(document), undoStack: [], redoStack: [] };
}

function applyCommand(document: BoardDocument, command: Command): BoardDocument {
  const next = cloneDocument(document);
  if (command.kind === "stroke_add") {
    next.strokes.push(cloneStroke(command.stroke));
  } else if (command.kind === "stroke_batch_add") {
    next.strokes.push(...command.strokes.map(cloneStroke));
  } else if (command.kind === "stroke_move") {
    const indexes = new Set(command.indexes);
    next.strokes = next.strokes.map((stroke, index) => indexes.has(index)
      ? { ...stroke, points: stroke.points.map((point) => ({ x: point.x + command.dx, y: point.y + command.dy })) }
      : stroke
    );
  } else if (command.kind === "stroke_delete") {
    const indexes = new Set(command.entries.map((entry) => entry.index));
    next.strokes = next.strokes.filter((_, index) => !indexes.has(index));
  } else if (command.kind === "graph_add") {
    next.graphs = next.graphs.filter((graph) => graph.id !== command.graph.id);
    next.graphs.push(cloneGraph(command.graph));
  } else if (command.kind === "graph_update") {
    next.graphs = next.graphs.map((graph) => graph.id === command.after.id ? cloneGraph(command.after) : graph);
  } else if (command.kind === "graph_delete") {
    next.graphs = next.graphs.filter((graph) => graph.id !== command.graph.id);
  } else if (command.kind === "solution_add") {
    next.solutions = next.solutions.filter((solution) => solution.id !== command.solution.id);
    next.solutions.push(cloneSolution(command.solution));
  } else if (command.kind === "solution_update") {
    next.solutions = next.solutions.map((solution) =>
      solution.id === command.after.id ? cloneSolution(command.after) : solution
    );
  } else if (command.kind === "solution_delete") {
    next.solutions = next.solutions.filter((solution) => solution.id !== command.solution.id);
  } else if (command.kind === "image_add") {
    next.images = [...next.images!.filter((image) => image.id !== command.image.id), { ...command.image }];
  } else if (command.kind === "image_update") {
    next.images = next.images!.map((image) => image.id === command.after.id ? { ...command.after } : image);
  } else if (command.kind === "image_delete") {
    next.images = next.images!.filter((image) => image.id !== command.image.id);
  } else if (command.kind === "clear") {
    next.strokes = [];
    next.graphs = [];
    next.solutions = [];
    next.images = [];
  }
  return next;
}

function revertCommand(document: BoardDocument, command: Command): BoardDocument {
  const next = cloneDocument(document);
  if (command.kind === "stroke_add") {
    next.strokes.pop();
  } else if (command.kind === "stroke_batch_add") {
    next.strokes.splice(Math.max(0, next.strokes.length - command.strokes.length), command.strokes.length);
  } else if (command.kind === "stroke_move") {
    const indexes = new Set(command.indexes);
    next.strokes = next.strokes.map((stroke, index) => indexes.has(index)
      ? { ...stroke, points: stroke.points.map((point) => ({ x: point.x - command.dx, y: point.y - command.dy })) }
      : stroke
    );
  } else if (command.kind === "stroke_delete") {
    const restored = [...next.strokes];
    for (const entry of [...command.entries].sort((a, b) => a.index - b.index)) {
      restored.splice(Math.min(entry.index, restored.length), 0, cloneStroke(entry.stroke));
    }
    next.strokes = restored;
  } else if (command.kind === "graph_add") {
    next.graphs = next.graphs.filter((graph) => graph.id !== command.graph.id);
  } else if (command.kind === "graph_update") {
    next.graphs = next.graphs.map((graph) => graph.id === command.before.id ? cloneGraph(command.before) : graph);
  } else if (command.kind === "graph_delete") {
    const existing = next.graphs.filter((graph) => graph.id !== command.graph.id);
    existing.splice(Math.min(command.index, existing.length), 0, cloneGraph(command.graph));
    next.graphs = existing;
  } else if (command.kind === "solution_add") {
    next.solutions = next.solutions.filter((solution) => solution.id !== command.solution.id);
  } else if (command.kind === "solution_update") {
    next.solutions = next.solutions.map((solution) =>
      solution.id === command.before.id ? cloneSolution(command.before) : solution
    );
  } else if (command.kind === "solution_delete") {
    const existing = next.solutions.filter((solution) => solution.id !== command.solution.id);
    existing.splice(Math.min(command.index, existing.length), 0, cloneSolution(command.solution));
    next.solutions = existing;
  } else if (command.kind === "image_add") {
    next.images = next.images!.filter((image) => image.id !== command.image.id);
  } else if (command.kind === "image_update") {
    next.images = next.images!.map((image) => image.id === command.before.id ? { ...command.before } : image);
  } else if (command.kind === "image_delete") {
    const existing = next.images!.filter((image) => image.id !== command.image.id);
    existing.splice(Math.min(command.index, existing.length), 0, { ...command.image });
    next.images = existing;
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
  if (operation.op === "stroke_batch_add") {
    if (!operation.strokes.length) return state;
    return pushCommand(state, {
      kind: "stroke_batch_add",
      strokes: operation.strokes.map((stroke) =>
        cloneStroke({ ...stroke, source: stroke.source ?? "ai" })
      ),
    });
  }
  if (operation.op === "stroke_move") {
    const indexes = [...new Set(operation.indexes.filter((index) => Number.isInteger(index) && index >= 0))];
    if (!indexes.length || (!operation.dx && !operation.dy)) return state;
    return pushCommand(state, { kind: "stroke_move", indexes, dx: operation.dx, dy: operation.dy });
  }
  if (operation.op === "stroke_delete") {
    const entries = operation.indexes
      .map((index, position) => ({ index, stroke: operation.strokes[position] }))
      .filter((entry): entry is { index: number; stroke: Stroke } =>
        Number.isInteger(entry.index) && entry.index >= 0 && Boolean(entry.stroke)
      );
    if (!entries.length) return state;
    return pushCommand(state, {
      kind: "stroke_delete",
      entries: entries.map((entry) => ({ index: entry.index, stroke: cloneStroke(entry.stroke) })),
    });
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
  if (operation.op === "solution_add") {
    return pushCommand(state, { kind: "solution_add", solution: cloneSolution(operation.solution) });
  }
  if (operation.op === "solution_update") {
    const command: Command = {
      kind: "solution_update",
      before: cloneSolution(operation.before),
      after: cloneSolution(operation.after),
    };
    const geometryChanged =
      operation.before.x !== operation.after.x ||
      operation.before.y !== operation.after.y ||
      operation.before.width !== operation.after.width ||
      operation.before.minHeight !== operation.after.minHeight;
    if (!geometryChanged) {
      const undoStack = [...state.undoStack];
      for (let index = undoStack.length - 1; index >= 0; index -= 1) {
        const previous = undoStack[index];
        if (previous.kind === "solution_add" && previous.solution.id === operation.after.id) {
          undoStack[index] = { ...previous, solution: cloneSolution(operation.after) };
          break;
        }
        if (previous.kind === "solution_update" && previous.after.id === operation.after.id) {
          undoStack[index] = { ...previous, after: cloneSolution(operation.after) };
          break;
        }
      }
      return {
        ...state,
        document: applyCommand(state.document, command),
        undoStack,
      };
    }
    return pushCommand(state, command);
  }
  if (operation.op === "solution_delete") {
    const index = Math.max(0, state.document.solutions.findIndex((solution) => solution.id === operation.solution.id));
    return pushCommand(state, { kind: "solution_delete", solution: cloneSolution(operation.solution), index });
  }
  if (operation.op === "image_add") {
    return pushCommand(state, { kind: "image_add", image: { ...operation.image } });
  }
  if (operation.op === "image_update") {
    return pushCommand(state, { kind: "image_update", before: { ...operation.before }, after: { ...operation.after } });
  }
  if (operation.op === "image_delete") {
    const index = Math.max(0, (state.document.images ?? []).findIndex((image) => image.id === operation.image.id));
    return pushCommand(state, { kind: "image_delete", image: { ...operation.image }, index });
  }
  if (operation.op === "clear") {
    if (!state.document.strokes.length && !state.document.graphs.length && !state.document.solutions.length &&
      !(state.document.images ?? []).length) return state;
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
