import { useRef, type PointerEvent } from "react";
import MathText from "@/components/MathText";
import { X } from "lucide-react";
import type { AiSolutionBlock } from "./boardDocument";

type Props = {
  solution: AiSolutionBlock;
  zoom: number;
  onCommitChange: (before: AiSolutionBlock, after: AiSolutionBlock) => void;
  onDelete: (solution: AiSolutionBlock) => void;
  onCancel?: (id: string) => void;
};

export default function AiSolutionBlockView({
  solution,
  zoom,
  onCommitChange,
  onDelete,
  onCancel,
}: Props) {
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    before: AiSolutionBlock;
  } | null>(null);

  const beginDrag = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      before: solution,
    };
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const dx = (event.clientX - drag.startX) / Math.max(zoom, 0.01);
    const dy = (event.clientY - drag.startY) / Math.max(zoom, 0.01);
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    onCommitChange(drag.before, { ...drag.before, x: drag.before.x + dx, y: drag.before.y + dy });
  };

  const isBusy = solution.status === "thinking" || solution.status === "streaming";

  return (
    <div
      data-testid="ai-solution-block"
      data-solution-id={solution.id}
      data-board-interactive="true"
      onPointerDown={beginDrag}
      onPointerUp={endDrag}
      onPointerCancel={() => { dragRef.current = null; }}
      className="pointer-events-auto absolute select-none rounded-2xl border border-white/10 bg-black/20 p-4 shadow-lg backdrop-blur-md"
      style={{
        left: solution.x,
        top: solution.y,
        width: solution.width,
        minHeight: solution.minHeight,
        color: "var(--text-primary, #f4f7fb)",
      }}
    >
      <div className="mb-3 flex items-center gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] opacity-55">AI solution</div>
        <div className="ml-auto flex items-center gap-1">
          {isBusy && onCancel && (
            <button
              type="button"
              className="rounded-md px-2 py-1 text-[11px] opacity-65 hover:bg-white/10 hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                onCancel(solution.id);
              }}
            >
              Stop
            </button>
          )}
          <button
            type="button"
            aria-label="Delete AI solution"
            className="grid h-7 w-7 place-items-center rounded-md opacity-45 hover:bg-white/10 hover:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onDelete(solution);
            }}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {solution.status === "thinking" && solution.steps.length === 0 && (
        <div className="thinking-shimmer text-sm opacity-60">Thinking…</div>
      )}

      <div className="flex flex-col gap-2.5">
        {solution.steps.map((step, index) => (
          <div
            key={step.id}
            data-testid="ai-solution-step"
            className={step.kind === "result" ? "font-semibold" : step.kind === "warning" ? "opacity-75" : ""}
          >
            <div className="flex items-start gap-2.5">
              <span className="mt-[2px] min-w-5 text-[11px] font-semibold opacity-35">{index + 1}</span>
              <MathText text={step.text} className="min-w-0 text-[15px] leading-6" />
            </div>
          </div>
        ))}
      </div>

      {solution.status === "error" && (
        <div className="mt-3 text-xs text-ember">Не удалось завершить решение.</div>
      )}
    </div>
  );
}
