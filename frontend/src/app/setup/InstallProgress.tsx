import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n";

/** The installers print `[n/total] What is happening` at the start of every stage. */
export function installStage(lines: string[]): { step: number; total: number; title: string } | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = /\[(\d+)\/(\d+)\]\s*(.*)$/.exec(lines[i]);
    if (match) return { step: Number(match[1]), total: Number(match[2]), title: match[3].trim() };
  }
  return null;
}

const clock = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

type Props = {
  lines: string[];
  /** The installation is running (not finished, not failed). */
  running: boolean;
  failed: boolean;
  /** Installation finished and the server answered. */
  done: boolean;
  /** When the last line of output arrived (ms since epoch). */
  lastOutputAt: number | null;
};

/**
 * One segment per installer stage, with how long the current stage has run and how long ago the
 * server last printed anything, so a long silent stage (a Python or model download) can be told
 * apart from a stuck one.
 */
export default function InstallProgress({ lines, running, failed, done, lastOutputAt }: Props) {
  const { tl } = useI18n();
  const stage = installStage(lines);
  const [now, setNow] = useState(() => Date.now());
  const stageStartRef = useRef<{ step: number; at: number } | null>(null);
  if (stage && stageStartRef.current?.step !== stage.step) stageStartRef.current = { step: stage.step, at: Date.now() };

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  if (!stage && !running && !done) return null;
  const total = stage?.total ?? 7;
  const step = stage?.step ?? 0;
  const silentMs = lastOutputAt ? now - lastOutputAt : 0;

  return (
    <div className="mt-3" data-testid="install-progress">
      <div className="flex gap-1" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done ? total : Math.max(0, step - 1)}>
        {Array.from({ length: total }, (_, index) => {
          const n = index + 1;
          const state = done || n < step ? "done" : n === step ? (failed ? "failed" : "current") : "pending";
          return (
            <div key={n} className="relative h-2 flex-1 overflow-hidden rounded-full bg-white/[0.07]">
              {state === "done" && <div className="absolute inset-0 bg-accent" />}
              {state === "failed" && <div className="absolute inset-0 bg-danger" />}
              {state === "current" && <div className="install-progress-current absolute inset-0" />}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[11px]">
        <span className="min-w-0 truncate font-medium text-frost/70">
          {done
            ? tl("setup_install_done")
            : stage
              ? tl("setup_install_stage", { step: stage.step, total: stage.total, title: stage.title })
              : tl("setup_install_starting")}
        </span>
        {running && stageStartRef.current && (
          <span className="shrink-0 font-mono text-frost/45">{tl("setup_install_stage_time", { time: clock(now - stageStartRef.current.at) })}</span>
        )}
      </div>
      {running && lastOutputAt && silentMs >= 15_000 && (
        <div className="mt-1 text-[10px] leading-4 text-frost/40">
          {tl("setup_install_silent", { time: clock(silentMs) })}
        </div>
      )}
    </div>
  );
}
