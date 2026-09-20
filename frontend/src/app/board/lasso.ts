import type { GraphElement } from "./boardDocument";
import type { Point, Stroke } from "./boardEngine";

export type LassoBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export function pointInPolygon(point: Point, polygon: Point[]) {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects =
      (a.y > point.y) !== (b.y > point.y) &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || Number.EPSILON) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

const strokeCenter = (stroke: Stroke): Point | null => {
  if (!stroke.points.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of stroke.points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
};

export function selectStrokeIndices(strokes: Stroke[], polygon: Point[]) {
  if (polygon.length < 3) return [];
  const result: number[] = [];

  strokes.forEach((stroke, index) => {
    const center = strokeCenter(stroke);
    if (center && pointInPolygon(center, polygon)) {
      result.push(index);
      return;
    }
    const step = Math.max(1, Math.floor(stroke.points.length / 24));
    let sampled = 0;
    let inside = 0;
    for (let i = 0; i < stroke.points.length; i += step) {
      sampled += 1;
      if (pointInPolygon(stroke.points[i], polygon)) inside += 1;
    }
    if (sampled > 0 && inside / sampled >= 0.3) result.push(index);
  });

  return result;
}

export function selectGraphIds(graphs: GraphElement[], polygon: Point[]) {
  if (polygon.length < 3) return [];
  return graphs
    .filter((graph) =>
      pointInPolygon(
        { x: graph.x + graph.width / 2, y: graph.y + graph.height / 2 },
        polygon,
      ),
    )
    .map((graph) => graph.id);
}

export function getSelectionBounds(
  strokes: Stroke[],
  strokeIndices: number[],
  graphs: GraphElement[],
  graphIds: string[],
): LassoBounds | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const index of strokeIndices) {
    const stroke = strokes[index];
    if (!stroke) continue;
    const pad = Math.max(2, stroke.width / 2);
    for (const point of stroke.points) {
      left = Math.min(left, point.x - pad);
      top = Math.min(top, point.y - pad);
      right = Math.max(right, point.x + pad);
      bottom = Math.max(bottom, point.y + pad);
    }
  }

  const graphIdSet = new Set(graphIds);
  for (const graph of graphs) {
    if (!graphIdSet.has(graph.id)) continue;
    left = Math.min(left, graph.x);
    top = Math.min(top, graph.y);
    right = Math.max(right, graph.x + graph.width);
    bottom = Math.max(bottom, graph.y + graph.height);
  }

  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return { left, top, right, bottom };
}

export function translateStroke(stroke: Stroke, dx: number, dy: number): Stroke {
  return {
    ...stroke,
    points: stroke.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
  };
}

export function translateBounds(bounds: LassoBounds, dx: number, dy: number): LassoBounds {
  return {
    left: bounds.left + dx,
    top: bounds.top + dy,
    right: bounds.right + dx,
    bottom: bounds.bottom + dy,
  };
}

