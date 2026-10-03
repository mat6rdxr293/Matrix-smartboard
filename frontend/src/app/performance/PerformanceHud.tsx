import { useEffect, useRef, useState } from "react";
import {
  consumePendingInputTimestamp,
  consumePerformanceCounters,
  setPerformanceTelemetryEnabled,
} from "./performanceTelemetry";

type HudSnapshot = {
  fps: number;
  frameMs: number;
  inputPaintMs: number;
  pointerHz: number;
  droppedPercent: number;
  canvasMs: number;
  canvasMaxMs: number;
  longTasks: number;
};

const EMPTY: HudSnapshot = {
  fps: 0,
  frameMs: 0,
  inputPaintMs: 0,
  pointerHz: 0,
  droppedPercent: 0,
  canvasMs: 0,
  canvasMaxMs: 0,
  longTasks: 0,
};

const round1 = (value: number) => Math.round(value * 10) / 10;

export default function PerformanceHud({ enabled }: { enabled: boolean }) {
  const [snapshot, setSnapshot] = useState<HudSnapshot>(EMPTY);
  const longTasksRef = useRef(0);

  useEffect(() => {
    setPerformanceTelemetryEnabled(enabled);
    if (!enabled) {
      setSnapshot(EMPTY);
      return;
    }

    let raf = 0;
    let disposed = false;
    longTasksRef.current = 0;
    let lastFrame = performance.now();
    let lastPublish = lastFrame;
    let frameCount = 0;
    let frameDurationTotal = 0;
    let droppedFrames = 0;
    let inputLatencyTotal = 0;
    let inputLatencyCount = 0;

    let observer: PerformanceObserver | null = null;
    try {
      if ("PerformanceObserver" in window) {
        observer = new PerformanceObserver((list) => {
          longTasksRef.current += list.getEntries().length;
        });
        observer.observe({ entryTypes: ["longtask"] });
      }
    } catch {
      observer = null;
    }

    const frame = (now: number) => {
      if (disposed) return;

      const delta = now - lastFrame;
      lastFrame = now;
      frameCount += 1;
      frameDurationTotal += delta;
      if (delta > 25) droppedFrames += Math.max(1, Math.round(delta / 16.67) - 1);

      const inputTimestamp = consumePendingInputTimestamp();
      if (inputTimestamp != null) {
        const latency = Math.max(0, now - inputTimestamp);
        if (latency < 1000) {
          inputLatencyTotal += latency;
          inputLatencyCount += 1;
        }
      }

      const elapsed = now - lastPublish;
      if (elapsed >= 1000) {
        const perf = consumePerformanceCounters();
        const estimatedFrames = frameCount + droppedFrames;
        setSnapshot({
          fps: Math.round((frameCount * 1000) / elapsed),
          frameMs: round1(frameCount ? frameDurationTotal / frameCount : 0),
          inputPaintMs: round1(inputLatencyCount ? inputLatencyTotal / inputLatencyCount : 0),
          pointerHz: Math.round((perf.pointerEvents * 1000) / elapsed),
          droppedPercent: round1(estimatedFrames ? (droppedFrames / estimatedFrames) * 100 : 0),
          canvasMs: round1(perf.canvasDrawCount ? perf.canvasDrawTotalMs / perf.canvasDrawCount : 0),
          canvasMaxMs: round1(perf.canvasDrawMaxMs),
          longTasks: longTasksRef.current,
        });

        lastPublish = now;
        frameCount = 0;
        frameDurationTotal = 0;
        droppedFrames = 0;
        inputLatencyTotal = 0;
        inputLatencyCount = 0;
        longTasksRef.current = 0;
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer?.disconnect();
      setPerformanceTelemetryEnabled(false);
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-3 right-3 z-[300] min-w-[214px] rounded-xl border border-white/10 bg-[#090d13]/95 p-3 font-mono text-[10px] leading-5 text-white/75 shadow-[0_16px_44px_rgba(0,0,0,0.38)]"
      data-testid="performance-hud"
    >
      <div className="mb-1.5 flex items-center justify-between gap-4 text-[10px] font-bold uppercase tracking-[0.11em] text-accent">
        <span>Performance HUD</span>
        <span className="text-white/35">live</span>
      </div>
      <Metric label="FPS" value={String(snapshot.fps)} />
      <Metric label="Frame" value={`${snapshot.frameMs} ms`} />
      <Metric label="Input → paint" value={`${snapshot.inputPaintMs} ms`} />
      <Metric label="Pointer" value={`${snapshot.pointerHz} Hz`} />
      <Metric label="Dropped" value={`${snapshot.droppedPercent}%`} />
      <Metric label="Canvas avg" value={`${snapshot.canvasMs} ms`} />
      <Metric label="Canvas max" value={`${snapshot.canvasMaxMs} ms`} />
      <Metric label="Long tasks" value={`${snapshot.longTasks}/s`} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-5">
      <span className="text-white/38">{label}</span>
      <span className="tabular-nums text-white/82">{value}</span>
    </div>
  );
}
