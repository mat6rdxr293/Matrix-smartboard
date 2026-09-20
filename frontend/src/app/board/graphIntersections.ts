import type { GraphExpression } from "./boardDocument";
import { compileExpression, type GraphExpressionProgram } from "./graphExpression";

export type GraphIntersection = {
  x: number;
  y: number;
  expressionAId: string;
  expressionBId: string;
};

export type GraphIntersectionBounds = {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
};

type CompiledExpression = {
  id: string;
  program: GraphExpressionProgram;
};

const X_AXIS_ID = "__x_axis__";
const Y_AXIS_ID = "__y_axis__";

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const safeEvaluate = (program: GraphExpressionProgram, x: number): number | null => {
  const value = program.evaluate(x);
  return Number.isFinite(value) ? value : null;
};

const refineSignChange = (
  left: number,
  right: number,
  difference: (x: number) => number | null,
  tolerance: number,
): number | null => {
  let a = left;
  let b = right;
  let fa = difference(a);
  let fb = difference(b);
  if (fa === null || fb === null) return null;
  if (Math.abs(fa) <= tolerance) return a;
  if (Math.abs(fb) <= tolerance) return b;
  if (fa * fb > 0) return null;

  for (let iteration = 0; iteration < 64; iteration += 1) {
    const mid = (a + b) / 2;
    const fm = difference(mid);
    if (fm === null) return null;
    if (Math.abs(fm) <= tolerance) return mid;
    if (fa * fm <= 0) {
      b = mid;
      fb = fm;
    } else {
      a = mid;
      fa = fm;
    }
  }

  const root = (a + b) / 2;
  const residual = difference(root);
  return residual !== null && Math.abs(residual) <= tolerance ? root : null;
};

const refineLocalMinimum = (
  left: number,
  right: number,
  difference: (x: number) => number | null,
): number | null => {
  let a = left;
  let b = right;
  const ratio = (Math.sqrt(5) - 1) / 2;
  let c = b - ratio * (b - a);
  let d = a + ratio * (b - a);
  let fc = Math.abs(difference(c) ?? Number.POSITIVE_INFINITY);
  let fd = Math.abs(difference(d) ?? Number.POSITIVE_INFINITY);

  for (let iteration = 0; iteration < 48; iteration += 1) {
    if (fc <= fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - ratio * (b - a);
      fc = Math.abs(difference(c) ?? Number.POSITIVE_INFINITY);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + ratio * (b - a);
      fd = Math.abs(difference(d) ?? Number.POSITIVE_INFINITY);
    }
  }

  const candidate = (a + b) / 2;
  return Number.isFinite(Math.abs(difference(candidate) ?? Number.POSITIVE_INFINITY)) ? candidate : null;
};

const compileVisibleExpressions = (expressions: GraphExpression[]): CompiledExpression[] =>
  expressions.flatMap((expression) => {
    if (!expression.visible) return [];
    try {
      return [{ id: expression.id, program: compileExpression(expression.expression) }];
    } catch {
      return [];
    }
  });

const findRoots = (
  difference: (x: number) => number | null,
  bounds: GraphIntersectionBounds,
  samples: number,
  valueTolerance: number,
): number[] => {
  const xSpan = bounds.xMax - bounds.xMin;
  const step = xSpan / samples;
  const xs: number[] = [];
  const diffs: Array<number | null> = [];
  let nearZeroCount = 0;

  for (let index = 0; index <= samples; index += 1) {
    const x = bounds.xMin + step * index;
    const diff = difference(x);
    xs.push(x);
    diffs.push(diff);
    if (diff !== null && Math.abs(diff) <= valueTolerance) nearZeroCount += 1;
  }

  // Equal functions have infinitely many common points.
  if (nearZeroCount > samples * 0.8) return [];

  const roots: number[] = [];
  const xTolerance = Math.max(1e-7, xSpan / 1500);
  const pushRoot = (root: number) => {
    if (!roots.some((value) => Math.abs(value - root) <= xTolerance)) roots.push(root);
  };

  for (let index = 0; index <= samples; index += 1) {
    const x = xs[index];
    const diff = diffs[index];
    if (diff === null) continue;

    let root: number | null = null;
    if (index > 0) {
      const previous = diffs[index - 1];
      if (previous !== null && previous * diff < 0) {
        root = refineSignChange(xs[index - 1], x, difference, valueTolerance);
      }
    }

    if (root === null && index > 0 && index < samples) {
      const previous = diffs[index - 1];
      const next = diffs[index + 1];
      if (
        previous !== null &&
        next !== null &&
        Math.abs(diff) <= Math.abs(previous) &&
        Math.abs(diff) <= Math.abs(next)
      ) {
        const minimum = refineLocalMinimum(xs[index - 1], xs[index + 1], difference);
        if (minimum !== null) {
          const residual = difference(minimum);
          if (residual !== null && Math.abs(residual) <= valueTolerance) root = minimum;
        }
      }
    }

    if (root === null && Math.abs(diff) <= valueTolerance) root = x;
    if (root === null) continue;

    const residual = difference(root);
    if (residual !== null && Math.abs(residual) <= valueTolerance * 4) pushRoot(root);
  }

  return roots;
};

export function findGraphIntersections(
  expressions: GraphExpression[],
  bounds: GraphIntersectionBounds,
  requestedSamples = 900,
): GraphIntersection[] {
  const compiled = compileVisibleExpressions(expressions);
  if (!compiled.length) return [];

  const xSpan = bounds.xMax - bounds.xMin;
  const ySpan = bounds.yMax - bounds.yMin;
  if (!(xSpan > 0) || !(ySpan > 0)) return [];

  const samples = clamp(Math.round(requestedSamples), 320, 1600);
  const valueTolerance = Math.max(1e-8, ySpan * 1e-6);
  const pointXTolerance = Math.max(1e-7, xSpan / 1500);
  const pointYTolerance = Math.max(1e-7, ySpan / 1500);
  const result: GraphIntersection[] = [];

  const addPoint = (candidate: GraphIntersection) => {
    if (candidate.x < bounds.xMin - pointXTolerance || candidate.x > bounds.xMax + pointXTolerance) return;
    if (candidate.y < bounds.yMin - valueTolerance || candidate.y > bounds.yMax + valueTolerance) return;
    const duplicate = result.some(
      (point) =>
        Math.abs(point.x - candidate.x) <= pointXTolerance &&
        Math.abs(point.y - candidate.y) <= pointYTolerance,
    );
    if (!duplicate) result.push(candidate);
  };

  for (const current of compiled) {
    // Intersections with the X axis are roots of f(x) = 0.
    const roots = findRoots(
      (x) => safeEvaluate(current.program, x),
      bounds,
      samples,
      valueTolerance,
    );
    for (const root of roots) {
      addPoint({
        x: root,
        y: 0,
        expressionAId: current.id,
        expressionBId: X_AXIS_ID,
      });
    }

    // Intersection with the Y axis is the value at x = 0.
    if (bounds.xMin <= 0 && bounds.xMax >= 0) {
      const y = safeEvaluate(current.program, 0);
      if (y !== null) {
        addPoint({
          x: 0,
          y,
          expressionAId: current.id,
          expressionBId: Y_AXIS_ID,
        });
      }
    }
  }

  // Intersections between every pair of visible, valid functions.
  for (let aIndex = 0; aIndex < compiled.length - 1; aIndex += 1) {
    for (let bIndex = aIndex + 1; bIndex < compiled.length; bIndex += 1) {
      const a = compiled[aIndex];
      const b = compiled[bIndex];
      const difference = (x: number): number | null => {
        const aValue = safeEvaluate(a.program, x);
        const bValue = safeEvaluate(b.program, x);
        return aValue === null || bValue === null ? null : aValue - bValue;
      };

      const roots = findRoots(difference, bounds, samples, valueTolerance);
      for (const root of roots) {
        const aValue = safeEvaluate(a.program, root);
        const bValue = safeEvaluate(b.program, root);
        if (aValue === null || bValue === null) continue;
        addPoint({
          x: root,
          y: (aValue + bValue) / 2,
          expressionAId: a.id,
          expressionBId: b.id,
        });
      }
    }
  }

  return result.sort((left, right) => left.x - right.x || left.y - right.y);
}

export function formatIntersectionCoordinate(value: number): string {
  if (Math.abs(value) < 1e-9) return "0";
  const rounded = Number(value.toFixed(3));
  return String(rounded);
}

