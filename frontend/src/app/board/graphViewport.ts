export type GraphViewport = {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
};

export const DEFAULT_GRAPH_VIEWPORT: GraphViewport = {
  xMin: -10,
  xMax: 10,
  yMin: -10,
  yMax: 10,
};

const MIN_GRAPH_SPAN = 0.0025;
const MAX_GRAPH_SPAN = 1_000_000;
const NICE_STEPS = [1, 2, 2.5, 5, 10];

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function getGraphTickStep(min: number, max: number, targetDivisions = 10): number {
  const span = Math.abs(max - min);
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / Math.max(2, targetDivisions);
  const exponent = Math.floor(Math.log10(raw));
  const scale = 10 ** exponent;
  const normalized = raw / scale;
  let best = NICE_STEPS[0];
  for (const candidate of NICE_STEPS) {
    if (Math.abs(candidate - normalized) < Math.abs(best - normalized)) best = candidate;
  }
  return best * scale;
}

export function zoomGraphViewport(
  viewport: GraphViewport,
  factor: number,
  anchor: { x: number; y: number } = { x: 0.5, y: 0.5 },
): GraphViewport {
  const xSpan = viewport.xMax - viewport.xMin;
  const ySpan = viewport.yMax - viewport.yMin;
  if (!(xSpan > 0) || !(ySpan > 0) || !Number.isFinite(factor) || factor <= 0) return viewport;
  const nextXSpan = clamp(xSpan * factor, MIN_GRAPH_SPAN, MAX_GRAPH_SPAN);
  const nextYSpan = clamp(ySpan * factor, MIN_GRAPH_SPAN, MAX_GRAPH_SPAN);
  const xFactor = nextXSpan / xSpan;
  const yFactor = nextYSpan / ySpan;
  const ax = clamp(anchor.x, 0, 1);
  const ay = clamp(anchor.y, 0, 1);
  const anchorX = viewport.xMin + xSpan * ax;
  const anchorY = viewport.yMax - ySpan * ay;
  return {
    xMin: anchorX + (viewport.xMin - anchorX) * xFactor,
    xMax: anchorX + (viewport.xMax - anchorX) * xFactor,
    yMin: anchorY + (viewport.yMin - anchorY) * yFactor,
    yMax: anchorY + (viewport.yMax - anchorY) * yFactor,
  };
}

export function getGraphTicks(min: number, max: number, step: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min) || !(step > 0)) return [];
  const first = Math.ceil((min - step * 1e-9) / step) * step;
  const ticks: number[] = [];
  for (let index = 0; index < 200; index += 1) {
    const value = first + index * step;
    if (value > max + step * 1e-9) break;
    ticks.push(Number(value.toPrecision(12)));
  }
  return ticks;
}

export function formatGraphTick(value: number, step: number): string {
  const safe = Math.abs(value) < Math.abs(step) * 1e-9 ? 0 : value;
  if (!Number.isFinite(safe)) return "";
  const decimals = Math.min(8, Math.max(0, Math.ceil(-Math.log10(Math.abs(step))) + 2));
  return Number(safe.toFixed(decimals)).toString();
}
