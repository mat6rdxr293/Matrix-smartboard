import type { Stroke } from "./boardEngine";
import type { BoardRect } from "./freeSpace";

export type OcrStrokeCluster = {
  strokes: Stroke[];
  indices: number[];
  bounds: BoardRect;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function getStrokeBounds(stroke: Stroke): BoardRect | null {
  if (!stroke.points.length) return null;
  const half = Math.max(1, stroke.width / 2);
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const point of stroke.points) {
    left = Math.min(left, point.x - half);
    top = Math.min(top, point.y - half);
    right = Math.max(right, point.x + half);
    bottom = Math.max(bottom, point.y + half);
  }
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return { left, top, right, bottom };
}

export const unionRects = (rects: BoardRect[]): BoardRect => ({
  left: Math.min(...rects.map((rect) => rect.left)),
  top: Math.min(...rects.map((rect) => rect.top)),
  right: Math.max(...rects.map((rect) => rect.right)),
  bottom: Math.max(...rects.map((rect) => rect.bottom)),
});

const axisGap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.max(0, Math.max(a0 - b1, b0 - a1));

const overlapLength = (a0: number, a1: number, b0: number, b1: number) =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

const median = (values: number[]) => {
  if (!values.length) return 48;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function clusterOcrStrokes(
  strokes: Stroke[],
  selectedIndices?: number[],
): OcrStrokeCluster[] {
  const selected = selectedIndices?.length ? new Set(selectedIndices) : null;
  const entries = strokes
    .map((stroke, index) => ({ stroke, index, bounds: getStrokeBounds(stroke) }))
    .filter(
      (entry): entry is { stroke: Stroke; index: number; bounds: BoardRect } =>
        Boolean(entry.bounds) &&
        entry.stroke.mode === "draw" &&
        entry.stroke.source !== "ai" &&
        (!selected || selected.has(entry.index)),
    );

  if (!entries.length) return [];
  if (selected) {
    return [{
      strokes: entries.map((entry) => entry.stroke),
      indices: entries.map((entry) => entry.index),
      bounds: unionRects(entries.map((entry) => entry.bounds)),
    }];
  }

  const heights = entries
    .map((entry) => entry.bounds.bottom - entry.bounds.top)
    .filter((height) => height >= 4 && height <= 240);
  const typicalHeight = clamp(median(heights), 28, 100);
  // Handwritten math often contains intentionally wider gaps around operators,
  // integral terms and function arguments. 0.72× split a single real integral
  // into two OCR blocks when the gap was only ~0.83× the median stroke height.
  const horizontalGap = clamp(typicalHeight * 0.95, 30, 84);
  const verticalGap = clamp(typicalHeight * 0.62, 20, 62);
  const stackedGap = clamp(typicalHeight * 1.05, 36, 104);

  const parent = entries.map((_, index) => index);
  const find = (value: number): number => {
    let current = value;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]];
      current = parent[current];
    }
    return current;
  };
  const unite = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i].bounds;
      const b = entries[j].bounds;
      const xGap = axisGap(a.left, a.right, b.left, b.right);
      const yGap = axisGap(a.top, a.bottom, b.top, b.bottom);
      const yOverlap = overlapLength(a.top, a.bottom, b.top, b.bottom);
      const xOverlap = overlapLength(a.left, a.right, b.left, b.right);
      const minHeight = Math.max(1, Math.min(a.bottom - a.top, b.bottom - b.top));
      const minWidth = Math.max(1, Math.min(a.right - a.left, b.right - b.left));

      const sameLine =
        xGap <= horizontalGap &&
        (yGap <= verticalGap || yOverlap / minHeight >= 0.18);
      const stackedLine =
        yGap <= stackedGap &&
        xOverlap / minWidth >= 0.18;

      if (sameLine || stackedLine) unite(i, j);
    }
  }

  const groups = new Map<number, typeof entries>();
  entries.forEach((entry, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(entry);
    groups.set(root, group);
  });

  return [...groups.values()]
    .map((group) => ({
      strokes: group.map((entry) => entry.stroke),
      indices: group.map((entry) => entry.index),
      bounds: unionRects(group.map((entry) => entry.bounds)),
    }))
    .filter((cluster) => {
      const width = cluster.bounds.right - cluster.bounds.left;
      const height = cluster.bounds.bottom - cluster.bounds.top;
      return cluster.strokes.length >= 2 || width >= 24 || height >= 24;
    })
    .sort((a, b) => {
      const aLast = Math.max(...a.indices);
      const bLast = Math.max(...b.indices);
      return aLast - bLast;
    });
}

export function chooseActiveOcrCluster(
  clusters: OcrStrokeCluster[],
): OcrStrokeCluster | null {
  if (!clusters.length) return null;
  return clusters.reduce((latest, cluster) =>
    Math.max(...cluster.indices) > Math.max(...latest.indices) ? cluster : latest
  );
}
