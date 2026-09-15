import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useI18n } from "@/i18n";
import { compileExpression } from "./graphExpression";
import type { GraphElement } from "./boardDocument";

const GRAPH_COLORS = ["#4DA3FF", "#FF5A5F", "#5BE7C4", "#F6D365", "#C084FC", "#FF9F43", "#E7F2FF", "#111827"];

export default function GraphEditor({ graph, onPreview, onCommit }: {
  graph: GraphElement;
  onPreview: (graph: GraphElement) => void;
  onCommit: (before: GraphElement, after: GraphElement) => void;
}) {
  const { tl } = useI18n();
  const [draft, setDraft] = useState(graph);
  const draftRef = useRef(graph);
  const commitBaseRef = useRef(graph);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const current = draftRef.current;
    const isPreviewEcho = current.id === graph.id && JSON.stringify(current) === JSON.stringify(graph);
    if (isPreviewEcho) return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setDraft(graph);
    draftRef.current = graph;
    commitBaseRef.current = graph;
  }, [graph]);

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);
  const errors = useMemo(() => {
    const next = new Map<string, string>();
    for (const item of draft.expressions) {
      try {
        compileExpression(item.expression);
      } catch (error) {
        next.set(item.id, error instanceof Error ? error.message : tl("invalid_expression"));
      }
    }
    return next;
  }, [draft.expressions, tl]);

  const publishPreview = (next: GraphElement) => {
    draftRef.current = next;
    setDraft(next);
    onPreview(next);
  };

  const commitNow = (next = draftRef.current) => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    const before = commitBaseRef.current;
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    onCommit(before, next);
    commitBaseRef.current = next;
  };

  const scheduleCommit = (next: GraphElement) => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => commitNow(next), 450);
  };
  const updateExpression = (id: string, patch: Partial<GraphElement["expressions"][number]>, immediate = false) => {
    const next = {
      ...draftRef.current,
      expressions: draftRef.current.expressions.map((item) => item.id === id ? { ...item, ...patch } : item),
    };
    publishPreview(next);
    if (immediate) commitNow(next);
    else scheduleCommit(next);
  };

  const addExpression = () => {
    if (draftRef.current.expressions.length >= 8) return;
    const index = draftRef.current.expressions.length;
    const next = {
      ...draftRef.current,
      expressions: [
        ...draftRef.current.expressions,
        {
          id: crypto.randomUUID(),
          expression: "x",
          color: GRAPH_COLORS[index % GRAPH_COLORS.length],
          visible: true,
        },
      ],
    };
    publishPreview(next);
    commitNow(next);
  };

  const removeExpression = (id: string) => {
    if (draftRef.current.expressions.length <= 1) return;
    const next = { ...draftRef.current, expressions: draftRef.current.expressions.filter((item) => item.id !== id) };
    publishPreview(next);
    commitNow(next);
  };

  return (
    <div className="w-[250px] rounded-xl border border-white/15 bg-ink/95 p-2 shadow-glass backdrop-blur">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-frost/70">{tl("graph_functions")}</span>
        <button
          type="button"
          className="flex min-h-7 min-w-7 items-center justify-center rounded-lg border border-white/10 disabled:opacity-40"
          onClick={addExpression}
          disabled={draft.expressions.length >= 8}
          aria-label={tl("add_function")}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="space-y-2">
        {draft.expressions.map((item, index) => {
          const error = errors.get(item.id);
          const errorId = `graph-expression-error-${item.id}`;
          return (
            <div key={item.id} className="rounded-lg border border-white/10 bg-white/5 p-2">
              <div className="flex items-center gap-1.5">
                <span className="w-5 text-[10px] text-frost/50">{index + 1}</span>
                <input
                  value={item.expression}
                  maxLength={120}
                  onChange={(event) => updateExpression(item.id, { expression: event.target.value })}
                  onBlur={() => commitNow()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitNow();
                      event.currentTarget.blur();
                    }
                  }}
                  aria-label={`${tl("function")} ${index + 1}`}
                  aria-invalid={!!error}
                  aria-describedby={error ? errorId : undefined}
                  className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/20 px-2 py-1 text-xs text-frost outline-none focus:border-accent/70"
                />
                <input
                  type="color"
                  value={item.color}
                  onChange={(event) => updateExpression(item.id, { color: event.target.value })}
                  onBlur={() => commitNow()}
                  aria-label={`${tl("function_color")} ${index + 1}`}
                  className="h-7 w-7 cursor-pointer rounded border-0 bg-transparent p-0"
                />
                <button
                  type="button"
                  className="flex min-h-7 min-w-7 items-center justify-center rounded-md border border-white/10"
                  onClick={() => updateExpression(item.id, { visible: !item.visible }, true)}
                  aria-label={`${item.visible ? tl("hide_function") : tl("show_function")} ${index + 1}`}
                >
                  {item.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                </button>
                <button
                  type="button"
                  className="flex min-h-7 min-w-7 items-center justify-center rounded-md border border-white/10 disabled:opacity-35"
                  onClick={() => removeExpression(item.id)}
                  disabled={draft.expressions.length <= 1}
                  aria-label={`${tl("delete_function")} ${index + 1}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              {error && (
                <div id={errorId} role="alert" className="mt-1 pl-6 text-[10px] leading-tight text-red-300">
                  {error}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
