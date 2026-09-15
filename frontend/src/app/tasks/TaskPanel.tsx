import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import type { Task } from "@/app/tasks/tasks";
import type { AssistantMessage } from "@/app/ai/AIAssistant";
import { callAi } from "@/app/ai/api";
import MathText from "@/components/MathText";
import { useI18n } from "@/i18n";
import { X } from "lucide-react";

export type TaskPanelProps = {
  task: Task;
  subjectName: string;
  attempt: string;
  setAttempt: (value: string) => void;
  addMessage: (msg: AssistantMessage) => void;
  updateMessage: (id: string, text: string) => void;
  appendStudentAttempt: (text: string) => void;
  onStopTimer: () => void;
  onShowCheckScore?: (percent: number) => void;
};

function nowLabel(locale: "ru" | "kk") {
  const d = new Date();
  return d.toLocaleTimeString(locale === "kk" ? "kk-KZ" : "ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function typeText(
  text: string,
  onUpdate: (partial: string) => void,
  shouldCancel: () => boolean,
  prefix = ""
) {
  return new Promise<void>((resolve) => {
    let index = 0;
    let last = 0;
    const charsPerSecond = 140;
    const step = (ts: number) => {
      if (shouldCancel()) return resolve();
      if (!last) last = ts;
      const delta = ts - last;
      last = ts;
      const add = Math.max(1, Math.floor((delta * charsPerSecond) / 1000));
      index = Math.min(text.length, index + add);
      onUpdate(prefix + text.slice(0, index));
      if (index >= text.length) return resolve();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

const shouldContinue = (text: string) => {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (t.endsWith("...") || t.endsWith("…")) return true;
  if (t.includes("обрыв") || t.includes("нет итогов")) return true;
  return false;
};

export default function TaskPanel({
  task,
  subjectName,
  attempt,
  setAttempt,
  addMessage,
  updateMessage,
  appendStudentAttempt,
  onStopTimer,
  onShowCheckScore,
}: TaskPanelProps) {
  const { locale, tl } = useI18n();
  const [loading, setLoading] = useState<null | "hint" | "check" | "solution">(null);
  const [error, setError] = useState<string | null>(null);
  const typingTokenRef = useRef(0);

  const extractCheckPercent = (text: string): number | null => {
    const normalized = text.replace(",", ".");
    const strict = /(?:^|\n)\s*\**\s*выполнено\s*:\s*(\d{1,3}(?:\.\d+)?)\s*%\s*\**\s*(?:\n|$)/i;
    const strictMatch = normalized.match(strict);
    if (strictMatch) {
      const value = Number(strictMatch[1]);
      if (Number.isFinite(value)) return Math.max(0, Math.min(100, Math.round(value)));
    }

    const contextual = /(?:выполн(?:ено|ен[ао])|процент(?: выполнения)?|итог|оценка)\D{0,24}(\d{1,3}(?:\.\d+)?)\s*%/gi;
    const contextualMatches = Array.from(normalized.matchAll(contextual));
    if (contextualMatches.length > 0) {
      const value = Number(contextualMatches[contextualMatches.length - 1][1]);
      if (Number.isFinite(value)) return Math.max(0, Math.min(100, Math.round(value)));
    }

    const generic = /(\d{1,3}(?:\.\d+)?)\s*%/g;
    const genericMatches = Array.from(normalized.matchAll(generic))
      .map((m) => Number(m[1]))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
    if (genericMatches.length > 0) {
      return Math.round(genericMatches[genericMatches.length - 1]);
    }
    return null;
  };

  const handleAsk = async (mode: "hint" | "check" | "solution") => {
    setError(null);
    setLoading(mode);
    typingTokenRef.current += 1;
    const token = typingTokenRef.current;
    if (mode !== "hint") {
      onStopTimer();
    }
    if (attempt.trim()) {
      appendStudentAttempt(attempt.trim());
    }
    const id = `${Date.now()}-${Math.random()}`;
    addMessage({
      id,
      role: "assistant",
      text: tl("thinking"),
      mode,
      timestamp: nowLabel(locale),
    });

    try {
      let fullText = "";
      const res = await callAi(mode, task.problem, attempt.trim() || undefined, undefined, false, subjectName);
      fullText = res.text || "";
      await typeText(
        fullText,
        (partial) => updateMessage(id, partial),
        () => typingTokenRef.current !== token
      );
      let guard = 0;
      while (guard < 2 && shouldContinue(fullText) && typingTokenRef.current === token) {
        guard += 1;
        const cont = await callAi(
          mode,
          task.problem,
          attempt.trim() || undefined,
          fullText,
          true,
          subjectName
        );
        const next = cont.text || "";
        if (!next.trim()) break;
        await typeText(
          next,
          (partial) => updateMessage(id, partial),
          () => typingTokenRef.current !== token,
          `${fullText}\n`
        );
        fullText = `${fullText}\n${next}`;
      }
      if (mode === "check" && onShowCheckScore) {
        const percent = extractCheckPercent(fullText);
        if (percent !== null) onShowCheckScore(percent);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : tl("unknown_error");
      updateMessage(id, `${tl("error")}: ${message}`);
      setError(`${tl("error")}: ${message}`);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="glass flex h-full flex-col rounded-2xl p-4 shadow-soft">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-frost/50">{tl("task_id", { id: task.id })}</div>
          <div className="text-lg font-semibold">
            <MathText text={task.title} />
          </div>
        </div>
        <Badge className="bg-accent/20 text-accent">{tl("active")}</Badge>
      </div>
      <div className="mb-3 text-sm text-frost/80">
        <MathText text={task.problem} className="text-frost/90" />
      </div>
      <div className="flex flex-1 flex-col space-y-2 min-h-0">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wider text-frost/50">{tl("student_solution")}</div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setAttempt("")}
            disabled={!attempt.trim() || loading !== null}
          >
            <X size={14} className="mr-1" />
            {tl("clear_field")}
          </Button>
        </div>
        <Textarea
          value={attempt}
          onChange={(e) => setAttempt(e.target.value)}
          placeholder={tl("enter_solution_or_ideas")}
          className="flex-1 min-h-[120px]"
        />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <Button
          variant="outline"
          onClick={() => handleAsk("hint")}
          disabled={loading !== null}
        >
          {tl("hint")}
        </Button>
        <Button
          variant="default"
          onClick={() => handleAsk("check")}
          disabled={loading !== null}
        >
          {tl("check_solution")}
        </Button>
        <Button
          variant="accent"
          onClick={() => handleAsk("solution")}
          disabled={loading !== null}
        >
          {tl("full_solution")}
        </Button>
      </div>
      <div className="mt-2 min-h-[16px] text-xs">
        {loading && <div className="thinking-shimmer">{tl("thinking")}</div>}
        {error && <div className="text-ember">{error}</div>}
      </div>
    </div>
  );
}
