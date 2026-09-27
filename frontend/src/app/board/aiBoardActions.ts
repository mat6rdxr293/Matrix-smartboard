import type { Stroke } from "./boardEngine";
import type { GraphElement } from "./boardDocument";

export type AiBoardPoint = { x: number; y: number };

export type AiBoardAction =
  | {
      type: "add_graph";
      expressions?: string[];
      x_min?: number; x_max?: number; y_min?: number; y_max?: number;
      x?: number; y?: number; width?: number; height?: number;
    }
  | {
      type: "update_graph";
      target_id: string;
      expressions?: string[];
      x_min?: number; x_max?: number; y_min?: number; y_max?: number;
      x?: number; y?: number; width?: number; height?: number;
    }
  | { type: "delete_graph"; target_id: string }
  | {
      type: "add_shape";
      shape: "line" | "arrow" | "rect" | "ellipse" | "circle" | "triangle" | "polygon";
      x?: number; y?: number; width?: number; height?: number;
      points?: AiBoardPoint[];
      color?: string;
    }
  | { type: "add_text"; text: string; x?: number; y?: number; color?: string }
  | { type: "move_strokes"; indexes: number[]; dx: number; dy: number }
  | { type: "delete_strokes"; indexes: number[] }
  | { type: "clear" };

export type AiBoardArea = { x: number; y: number; width: number; height: number };

const GRAPH_COLORS = ["#4DA3FF", "#FF8FA3", "#5BE7C4", "#FFB86B", "#F6D365", "#A78BFA"];

const clampPercent = (value: number | undefined, fallback: number) =>
  Math.max(0, Math.min(100, Number.isFinite(value) ? Number(value) : fallback));

const pointInArea = (point: AiBoardPoint, area: AiBoardArea) => ({
  x: area.x + (clampPercent(point.x, 50) / 100) * area.width,
  y: area.y + (clampPercent(point.y, 50) / 100) * area.height,
});

const safeAxisRange = (
  minValue: number | undefined,
  maxValue: number | undefined,
  fallbackMin: number,
  fallbackMax: number,
) => {
  const min = Number.isFinite(minValue) ? Number(minValue) : fallbackMin;
  const max = Number.isFinite(maxValue) ? Number(maxValue) : fallbackMax;
  return min < max ? [min, max] as const : [fallbackMin, fallbackMax] as const;
};

const makeStroke = (
  points: AiBoardPoint[],
  color: string,
  width = 2.4,
): Stroke => ({ points, color, width, mode: "draw", source: "ai" });

export function buildAiBoardState(graphs: GraphElement[], strokes: Stroke[]) {
  const strokeSummaries = strokes.slice(0, 80).map((stroke, index) => {
    const xs = stroke.points.map((point) => point.x);
    const ys = stroke.points.map((point) => point.y);
    const left = xs.length ? Math.min(...xs) : 0;
    const top = ys.length ? Math.min(...ys) : 0;
    const right = xs.length ? Math.max(...xs) : left;
    const bottom = ys.length ? Math.max(...ys) : top;
    return {
      index,
      x: Math.round(left),
      y: Math.round(top),
      width: Math.round(Math.max(0, right - left)),
      height: Math.round(Math.max(0, bottom - top)),
      source: stroke.source ?? "user",
      color: stroke.color,
    };
  });
  return {
    stroke_count: strokes.length,
    strokes: strokeSummaries,
    graphs: graphs.slice(0, 16).map((graph) => ({
      id: graph.id,
      expressions: graph.expressions.filter((item) => item.visible).map((item) => item.expression),
      x_min: graph.xMin,
      x_max: graph.xMax,
      y_min: graph.yMin,
      y_max: graph.yMax,
      x: Math.round(graph.x),
      y: Math.round(graph.y),
      width: Math.round(graph.width),
      height: Math.round(graph.height),
    })),
  };
}

export function graphFromAiAction(
  action: Extract<AiBoardAction, { type: "add_graph" }>,
  area: AiBoardArea,
): GraphElement {
  const width = Math.max(280, Math.min(620, (clampPercent(action.width, 58) / 100) * area.width));
  const height = Math.max(220, Math.min(460, (clampPercent(action.height, 58) / 100) * area.height));
  const x = area.x + (clampPercent(action.x, 8) / 100) * Math.max(0, area.width - width);
  const y = area.y + (clampPercent(action.y, 8) / 100) * Math.max(0, area.height - height);
  const expressions = (action.expressions?.length ? action.expressions : ["x"]).slice(0, 8);
  const [xMin, xMax] = safeAxisRange(action.x_min, action.x_max, -10, 10);
  const [yMin, yMax] = safeAxisRange(action.y_min, action.y_max, -10, 10);

  return {
    id: crypto.randomUUID(),
    x, y, width, height,
    xLabel: "x",
    yLabel: "y",
    xMin,
    xMax,
    yMin,
    yMax,
    expressions: expressions.map((expression, index) => ({
      id: crypto.randomUUID(),
      expression,
      color: GRAPH_COLORS[index % GRAPH_COLORS.length],
      visible: true,
    })),
  };
}

export function updateGraphFromAiAction(
  graph: GraphElement,
  action: Extract<AiBoardAction, { type: "update_graph" }>,
  area?: AiBoardArea,
): GraphElement {
  const expressions = action.expressions?.length
    ? action.expressions.slice(0, 8).map((expression, index) => ({
        id: graph.expressions[index]?.id ?? crypto.randomUUID(),
        expression,
        color: graph.expressions[index]?.color ?? GRAPH_COLORS[index % GRAPH_COLORS.length],
        visible: true,
      }))
    : graph.expressions.map((item) => ({ ...item }));
  const [xMin, xMax] = safeAxisRange(action.x_min, action.x_max, graph.xMin, graph.xMax);
  const [yMin, yMax] = safeAxisRange(action.y_min, action.y_max, graph.yMin, graph.yMax);
  const width = area && action.width !== undefined
    ? Math.max(280, Math.min(620, (clampPercent(action.width, 58) / 100) * area.width))
    : graph.width;
  const height = area && action.height !== undefined
    ? Math.max(220, Math.min(460, (clampPercent(action.height, 58) / 100) * area.height))
    : graph.height;
  const x = area && action.x !== undefined
    ? area.x + (clampPercent(action.x, 8) / 100) * Math.max(0, area.width - width)
    : graph.x;
  const y = area && action.y !== undefined
    ? area.y + (clampPercent(action.y, 8) / 100) * Math.max(0, area.height - height)
    : graph.y;
  return {
    ...graph,
    x,
    y,
    width,
    height,
    xMin,
    xMax,
    yMin,
    yMax,
    expressions,
  };
}

function arrowHead(from: AiBoardPoint, to: AiBoardPoint, size: number) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  return [
    {
      x: to.x - Math.cos(angle - Math.PI / 6) * size,
      y: to.y - Math.sin(angle - Math.PI / 6) * size,
    },
    to,
    {
      x: to.x - Math.cos(angle + Math.PI / 6) * size,
      y: to.y - Math.sin(angle + Math.PI / 6) * size,
    },
  ];
}

export function shapeActionToStrokes(
  action: Extract<AiBoardAction, { type: "add_shape" }>,
  area: AiBoardArea,
  defaultColor: string,
): Stroke[] {
  const color = action.color ?? defaultColor;
  const x = clampPercent(action.x, 20);
  const y = clampPercent(action.y, 20);
  const w = Math.max(4, clampPercent(action.width, 35));
  const h = Math.max(4, clampPercent(action.height, 28));
  const p0 = pointInArea({ x, y }, area);
  const p1 = pointInArea({ x: Math.min(100, x + w), y: Math.min(100, y + h) }, area);

  if (action.shape === "line") return [makeStroke([p0, p1], color)];
  if (action.shape === "arrow") {
    return [
      makeStroke([p0, p1], color),
      makeStroke(arrowHead(p0, p1, Math.max(10, Math.min(24, Math.hypot(p1.x - p0.x, p1.y - p0.y) * 0.12))), color),
    ];
  }

  if (action.shape === "rect") {
    const a = p0;
    const b = { x: p1.x, y: p0.y };
    const c = p1;
    const d = { x: p0.x, y: p1.y };
    return [makeStroke([a, b, c, d, a], color)];
  }

  if (action.shape === "triangle") {
    const top = { x: (p0.x + p1.x) / 2, y: p0.y };
    const left = { x: p0.x, y: p1.y };
    const right = p1;
    return [makeStroke([top, right, left, top], color)];
  }
  if (action.shape === "polygon" && action.points && action.points.length >= 3) {
    const points = action.points.map((point) => pointInArea(point, area));
    return [makeStroke([...points, points[0]], color)];
  }

  const cx = (p0.x + p1.x) / 2;
  const cy = (p0.y + p1.y) / 2;
  const rx = Math.abs(p1.x - p0.x) / 2;
  const ry = action.shape === "circle" ? rx : Math.abs(p1.y - p0.y) / 2;
  const points: AiBoardPoint[] = [];
  for (let index = 0; index <= 48; index += 1) {
    const angle = (index / 48) * Math.PI * 2;
    points.push({ x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
  }
  return [makeStroke(points, color)];
}
