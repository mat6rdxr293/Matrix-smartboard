import type { Stroke } from "./boardEngine";
import type { BoardRect } from "./freeSpace";

export type OcrStrokeCluster = {
  strokes: Stroke[];
  indices: number[];
  bounds: BoardRect;
};

const isWorkedSolutionLine = (line: string) =>
  /^\s*(?:D|Δ|Д|д)\s*=/.test(line) ||
  /^\s*[xх]\s*(?:_?\{?\s*[12]\s*\}?|[₁₂])\s*=/.test(line);

const isStandaloneTaskEquation = (line: string) =>
  /[xх]/i.test(line) &&
  /=/.test(line) &&
  !isWorkedSolutionLine(line) &&
  !/^\s*y\s*=/i.test(line);

const splitLogicalTasksFromOcr = (value: string): string[] => {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];

  const equationIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => isStandaloneTaskEquation(line))
    .map(({ index }) => index);

  if (!equationIndexes.length) return [lines.join("\n")];

  if (equationIndexes.length === 1) {
    const start = equationIndexes[0];
    if (start > 0 && lines.slice(0, start).every(isWorkedSolutionLine)) {
      return [lines.slice(start).join("\n")];
    }
    return [lines.join("\n")];
  }

  const prefix = lines.slice(0, equationIndexes[0]);
  const keepPrefix = prefix.length > 0 && !prefix.every(isWorkedSolutionLine);
  const tasks: string[] = [];

  for (let index = 0; index < equationIndexes.length; index += 1) {
    const start = equationIndexes[index];
    const end = equationIndexes[index + 1] ?? lines.length;
    const segment = lines.slice(start, end);
    if (index === 0 && keepPrefix) segment.unshift(...prefix);
    if (segment.length) tasks.push(segment.join("\n"));
  }

  return tasks;
};

const isLikelyCompletedWork = (value: string) => {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const rootRows = lines.filter((line) =>
    /^\s*[xх]\s*(?:_?\{?\s*[12]\s*\}?|[₁₂])\s*=/.test(line)
  ).length;
  const hasDiscriminant = lines.some((line) =>
    /^\s*(?:D|Δ|Д|д)\s*=/.test(line)
  );
  const hasAnswer = lines.some((line) =>
    /^\s*(?:ответ|жауап|answer)\s*:/i.test(line)
  );
  return rootRows >= 2 || (hasDiscriminant && rootRows >= 1) || hasAnswer;
};

const isLikelyTaskText = (value: string) => {
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 3) return false;
  const hasMathSignal = /[=<>≤≥+\-*/^²³√∫Σ∑π\d]/.test(value);
  const hasEnoughText = value.replace(
    /[^A-Za-zА-Яа-яӘәҒғҚқҢңӨөҰұҮүҺһІі]/g,
    "",
  ).length >= 8;
  return hasMathSignal || hasEnoughText;
};

const taskStatementFromCompletedWork = (value: string) => {
  if (!isLikelyCompletedWork(value)) return value.trim();

  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstTaskLine = lines.find(isStandaloneTaskEquation);
  return firstTaskLine ?? value.trim();
};

export function sanitizeMultiTaskOcrTexts(values: string[]): string[] {
  const tasks = values
    .flatMap(splitLogicalTasksFromOcr)
    .map(taskStatementFromCompletedWork)
    .filter(isLikelyTaskText);

  return [...new Set(tasks.map((value) => value.trim()).filter(Boolean))];
}

export function composeOcrText(
  recognized: string,
  graphLines: string[],
  hasHandwritingTarget: boolean,
): string {
  const primary = recognized.trim();
  if (hasHandwritingTarget) return primary;
  return [primary, ...graphLines.map((line) => line.trim())]
    .filter(Boolean)
    .join("\n")
    .trim();
}

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

  const rawClusters = [...groups.values()]
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
    .sort((a, b) => a.bounds.left - b.bounds.left);

  // A trailing handwritten digit can sit farther from the previous glyph than
  // the normal same-line threshold (for example the final 5 in "... = 35").
  // Attach only small right-hand satellites to a much larger row, so a whole
  // side-by-side equation still remains a separate OCR task.
  const consumed = new Set<number>();
  const merged: OcrStrokeCluster[] = [];

  for (let i = 0; i < rawClusters.length; i += 1) {
    if (consumed.has(i)) continue;
    let current = rawClusters[i];
    let changed = true;

    while (changed) {
      changed = false;
      for (let j = 0; j < rawClusters.length; j += 1) {
        if (i === j || consumed.has(j)) continue;
        const candidate = rawClusters[j];
        const currentWidth = current.bounds.right - current.bounds.left;
        const candidateWidth = candidate.bounds.right - candidate.bounds.left;
        const candidateHeight = candidate.bounds.bottom - candidate.bounds.top;
        const xGap = candidate.bounds.left - current.bounds.right;
        const yOverlap = overlapLength(
          current.bounds.top,
          current.bounds.bottom,
          candidate.bounds.top,
          candidate.bounds.bottom,
        );
        const overlapRatio =
          yOverlap /
          Math.max(
            1,
            Math.min(
              current.bounds.bottom - current.bounds.top,
              candidateHeight,
            ),
          );

        const smallTrailingFragment =
          currentWidth >= typicalHeight * 2.2 &&
          candidate.bounds.left >= current.bounds.right &&
          candidateWidth <= Math.max(typicalHeight * 0.95, 86) &&
          candidateHeight <= Math.max(typicalHeight * 1.45, 138) &&
          candidate.strokes.length <= 5 &&
          xGap >= 0 &&
          xGap <= clamp(typicalHeight * 2.6, 110, 230) &&
          overlapRatio >= 0.34;

        if (!smallTrailingFragment) continue;
        current = {
          strokes: [...current.strokes, ...candidate.strokes],
          indices: [...current.indices, ...candidate.indices].sort((a, b) => a - b),
          bounds: unionRects([current.bounds, candidate.bounds]),
        };
        consumed.add(j);
        changed = true;
      }
    }

    merged.push(current);
  }

  return merged.sort((a, b) => {
    const aLast = Math.max(...a.indices);
    const bLast = Math.max(...b.indices);
    return aLast - bLast;
  });
}

const clusterInkLength = (cluster: OcrStrokeCluster) => {
  let total = 0;
  for (const stroke of cluster.strokes) {
    for (let index = 1; index < stroke.points.length; index += 1) {
      const previous = stroke.points[index - 1];
      const current = stroke.points[index];
      total += Math.hypot(current.x - previous.x, current.y - previous.y);
    }
  }
  return total;
};

const clusterContentScore = (cluster: OcrStrokeCluster) => {
  const width = Math.max(0, cluster.bounds.right - cluster.bounds.left);
  const height = Math.max(0, cluster.bounds.bottom - cluster.bounds.top);
  return (
    clusterInkLength(cluster) +
    cluster.strokes.length * 18 +
    Math.min(360, width) * 0.45 +
    Math.min(180, height) * 0.2
  );
};

const clusterWidth = (cluster: OcrStrokeCluster) =>
  Math.max(1, cluster.bounds.right - cluster.bounds.left);

const clusterHeight = (cluster: OcrStrokeCluster) =>
  Math.max(1, cluster.bounds.bottom - cluster.bounds.top);

const likelySameVerticalWork = (
  block: OcrStrokeCluster,
  candidate: OcrStrokeCluster,
) => {
  const verticalGap = axisGap(
    block.bounds.top,
    block.bounds.bottom,
    candidate.bounds.top,
    candidate.bounds.bottom,
  );
  // Only join stacked rows here. Side-by-side equations can have overlapping
  // y ranges and must stay separate OCR targets.
  if (verticalGap <= 0) return false;

  const maxRowHeight = Math.max(clusterHeight(block), clusterHeight(candidate));
  const allowedGap = clamp(maxRowHeight * 1.9, 72, 220);
  if (verticalGap > allowedGap) return false;

  const overlap = overlapLength(
    block.bounds.left,
    block.bounds.right,
    candidate.bounds.left,
    candidate.bounds.right,
  );
  const overlapRatio = overlap / Math.min(clusterWidth(block), clusterWidth(candidate));
  const leftDelta = Math.abs(block.bounds.left - candidate.bounds.left);
  const leftAligned = leftDelta <= clamp(Math.min(clusterWidth(block), clusterWidth(candidate)) * 0.45, 58, 150);

  const blockCenter = (block.bounds.left + block.bounds.right) / 2;
  const candidateCenter = (candidate.bounds.left + candidate.bounds.right) / 2;
  const centerDelta = Math.abs(blockCenter - candidateCenter);
  const centerAligned = centerDelta <= Math.max(clusterWidth(block), clusterWidth(candidate)) * 0.48;

  return overlapRatio >= 0.16 || leftAligned || centerAligned;
};

const mergeClusters = (clusters: OcrStrokeCluster[]): OcrStrokeCluster => ({
  strokes: clusters.flatMap((cluster) => cluster.strokes),
  indices: clusters.flatMap((cluster) => cluster.indices).sort((a, b) => a - b),
  bounds: unionRects(clusters.map((cluster) => cluster.bounds)),
});

const expandOcrWorkBlock = (
  clusters: OcrStrokeCluster[],
  anchor: OcrStrokeCluster,
  maxScore: number,
): OcrStrokeCluster => {
  const selected = new Set<OcrStrokeCluster>([anchor]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const candidate of clusters) {
      if (selected.has(candidate)) continue;
      const score = clusterContentScore(candidate);
      const candidateWidth = clusterWidth(candidate);
      const candidateHeight = clusterHeight(candidate);
      const substantial =
        score >= maxScore * 0.12 ||
        candidate.strokes.length >= 3 ||
        candidateWidth >= 54 ||
        candidateHeight >= 38;
      const touchesSelectedRow = [...selected].some((row) =>
        likelySameVerticalWork(row, candidate)
      );
      if (!substantial || !touchesSelectedRow) continue;
      selected.add(candidate);
      changed = true;
    }
  }

  return mergeClusters([...selected]);
};

export function chooseOcrTaskClusters(
  clusters: OcrStrokeCluster[],
  maxTasks = 8,
): OcrStrokeCluster[] {
  if (!clusters.length) return [];
  if (clusters.length === 1) return [clusters[0]];

  const scored = clusters.map((cluster) => ({
    cluster,
    score: clusterContentScore(cluster),
  }));
  const maxScore = Math.max(...scored.map((item) => item.score));

  const candidateAnchors = scored
    .filter((item) => {
      const width = clusterWidth(item.cluster);
      const height = clusterHeight(item.cluster);
      return (
        item.score >= maxScore * 0.22 ||
        item.cluster.strokes.length >= 4 ||
        width >= 72 ||
        height >= 42
      );
    })
    .map((item) => item.cluster);

  const unique = new Map<string, OcrStrokeCluster>();
  for (const anchor of candidateAnchors) {
    const block = expandOcrWorkBlock(clusters, anchor, maxScore);
    const signature = [...block.indices].sort((a, b) => a - b).join(",");
    unique.set(signature, block);
  }

  return [...unique.values()]
    .sort((a, b) => {
      const aCenterY = (a.bounds.top + a.bounds.bottom) / 2;
      const bCenterY = (b.bounds.top + b.bounds.bottom) / 2;
      const rowTolerance = Math.max(
        48,
        Math.min(clusterHeight(a), clusterHeight(b)) * 0.55,
      );
      if (Math.abs(aCenterY - bCenterY) <= rowTolerance) {
        return a.bounds.left - b.bounds.left;
      }
      return a.bounds.top - b.bounds.top;
    })
    .slice(0, Math.max(1, maxTasks));
}

export function chooseActiveOcrCluster(
  clusters: OcrStrokeCluster[],
): OcrStrokeCluster | null {
  if (!clusters.length) return null;
  if (clusters.length === 1) return clusters[0];

  const scored = clusters.map((cluster) => ({
    cluster,
    score: clusterContentScore(cluster),
    lastIndex: Math.max(...cluster.indices),
  }));
  const maxScore = Math.max(...scored.map((item) => item.score));

  // Prefer the newest meaningful handwritten block, but do not let a tiny
  // accidental scribble/dot drawn later replace a substantially larger
  // equation as the OCR target.
  const meaningful = scored.filter((item) => item.score >= maxScore * 0.34);
  const anchor = meaningful.reduce((latest, item) =>
    item.lastIndex > latest.lastIndex ? item : latest
  );

  const selected = new Set<OcrStrokeCluster>([anchor.cluster]);
  let changed = true;

  // A worked solution is usually several vertically stacked rows. Expand from
  // the anchor through nearby aligned rows while keeping unrelated side-by-side
  // tasks and distant scribbles out of the OCR crop. Compare against individual
  // selected rows rather than the union bounds: a missing middle row may sit
  // inside the union of an upper and lower row and would otherwise look like
  // zero vertical gap.
  while (changed) {
    changed = false;
    for (const item of scored) {
      if (selected.has(item.cluster)) continue;
      const candidateWidth = clusterWidth(item.cluster);
      const candidateHeight = clusterHeight(item.cluster);
      const substantial =
        item.score >= maxScore * 0.12 ||
        item.cluster.strokes.length >= 3 ||
        candidateWidth >= 54 ||
        candidateHeight >= 38;
      const touchesSelectedRow = [...selected].some((row) =>
        likelySameVerticalWork(row, item.cluster)
      );
      if (!substantial || !touchesSelectedRow) continue;
      selected.add(item.cluster);
      changed = true;
    }
  }

  return mergeClusters([...selected]);
}
