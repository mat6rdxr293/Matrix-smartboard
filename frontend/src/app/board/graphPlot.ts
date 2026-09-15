import { compileExpression } from "./graphExpression";

export type GraphPlotBounds = {
  width: number;
  height: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
};

export type GraphPlotPoint = { x: number; y: number };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function buildGraphPathSegments(expression: string, bounds: GraphPlotBounds): GraphPlotPoint[][] {
  const program = compileExpression(expression);
  const samples = clamp(Math.round(bounds.width * 1.25), 500, 700);
  const xSpan = bounds.xMax - bounds.xMin;
  const ySpan = bounds.yMax - bounds.yMin;
  const maxReasonableY = Math.max(Math.abs(bounds.yMin), Math.abs(bounds.yMax), ySpan) * 8;
  const jumpThreshold = Math.max(4, ySpan * 0.8);
  const segments: GraphPlotPoint[][] = [];
  let current: GraphPlotPoint[] = [];
  let previousMathY: number | null = null;

  const flush = () => {
    if (current.length > 1) segments.push(current);
    current = [];
    previousMathY = null;
  };

  for (let index = 0; index < samples; index += 1) {
    const ratio = samples <= 1 ? 0 : index / (samples - 1);
    const mathX = bounds.xMin + ratio * xSpan;
    const mathY = program.evaluate(mathX);
    const invalid = !Number.isFinite(mathY) || Math.abs(mathY) > maxReasonableY;
    const jump = previousMathY !== null && Number.isFinite(mathY) && Math.abs(mathY - previousMathY) > jumpThreshold;
    if (invalid || jump) {
      flush();
      if (invalid) continue;
    }

    const x = ratio * bounds.width;
    const y = ((bounds.yMax - mathY) / ySpan) * bounds.height;
    current.push({ x, y });
    previousMathY = mathY;
  }
  flush();
  return segments;
}

export function segmentsToSvgPath(segments: GraphPlotPoint[][]): string {
  return segments
    .filter((segment) => segment.length > 1)
    .map((segment) => segment.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" "))
    .join(" ");
}
