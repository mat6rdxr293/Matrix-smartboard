type PerfCounters = {
  pointerEvents: number;
  canvasDrawCount: number;
  canvasDrawTotalMs: number;
  canvasDrawMaxMs: number;
};

let enabled = false;
let counters: PerfCounters = {
  pointerEvents: 0,
  canvasDrawCount: 0,
  canvasDrawTotalMs: 0,
  canvasDrawMaxMs: 0,
};

let pendingInputTimestamp: number | null = null;

export function setPerformanceTelemetryEnabled(value: boolean) {
  enabled = value;
  if (!value) {
    counters = {
      pointerEvents: 0,
      canvasDrawCount: 0,
      canvasDrawTotalMs: 0,
      canvasDrawMaxMs: 0,
    };
    pendingInputTimestamp = null;
  }
}

export function isPerformanceTelemetryEnabled() {
  return enabled;
}

export function recordPointerSample(timestamp: number) {
  if (!enabled) return;
  counters.pointerEvents += 1;

  let normalized = timestamp;
  if (typeof performance !== "undefined") {
    const now = performance.now();
    if (timestamp > now + 60_000 && Number.isFinite(performance.timeOrigin)) {
      normalized = timestamp - performance.timeOrigin;
    }
  }

  if (pendingInputTimestamp == null) pendingInputTimestamp = normalized;
}

export function consumePendingInputTimestamp() {
  if (!enabled) return null;
  const value = pendingInputTimestamp;
  pendingInputTimestamp = null;
  return value;
}

export function recordCanvasDraw(durationMs: number) {
  if (!enabled || !Number.isFinite(durationMs)) return;
  counters.canvasDrawCount += 1;
  counters.canvasDrawTotalMs += durationMs;
  counters.canvasDrawMaxMs = Math.max(counters.canvasDrawMaxMs, durationMs);
}

export function consumePerformanceCounters(): PerfCounters {
  const snapshot = counters;
  counters = {
    pointerEvents: 0,
    canvasDrawCount: 0,
    canvasDrawTotalMs: 0,
    canvasDrawMaxMs: 0,
  };
  return snapshot;
}
