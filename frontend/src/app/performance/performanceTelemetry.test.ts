import { afterEach, describe, expect, it } from "vitest";
import {
  consumePendingInputTimestamp,
  consumePerformanceCounters,
  recordCanvasDraw,
  recordPointerSample,
  setPerformanceTelemetryEnabled,
} from "./performanceTelemetry";

afterEach(() => setPerformanceTelemetryEnabled(false));

describe("performance telemetry", () => {
  it("collects pointer and canvas samples only while enabled", () => {
    recordPointerSample(10);
    recordCanvasDraw(3);
    expect(consumePerformanceCounters().pointerEvents).toBe(0);

    setPerformanceTelemetryEnabled(true);
    recordPointerSample(12);
    recordPointerSample(13);
    recordCanvasDraw(2.5);
    recordCanvasDraw(4);

    expect(consumePendingInputTimestamp()).toBe(12);
    const sample = consumePerformanceCounters();
    expect(sample.pointerEvents).toBe(2);
    expect(sample.canvasDrawCount).toBe(2);
    expect(sample.canvasDrawTotalMs).toBe(6.5);
    expect(sample.canvasDrawMaxMs).toBe(4);

    expect(consumePerformanceCounters().pointerEvents).toBe(0);
  });
});
