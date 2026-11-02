import { apiFetch } from "@/lib/apiClient";
import type { AiBoardAction } from "@/app/board/aiBoardActions";

export type AiMode = "hint" | "check" | "solution";

export async function callAi(
  mode: AiMode,
  problem: string,
  studentAttempt?: string,
  assistantContext?: string,
  continueFrom?: boolean,
  subject?: string,
  lessonId?: string,
  clientMessageId?: string,
  boardContext?: boolean,
  boardOutput?: boolean,
  responseLocale?: "ru" | "kk" | "en",
  boardState?: Record<string, unknown>,
) {
  const res = await apiFetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode,
      problem,
      student_attempt: studentAttempt || null,
      assistant_context: assistantContext || null,
      continue_from: !!continueFrom,
      subject: subject || null,
      lesson_id: lessonId || null,
      client_message_id: clientMessageId || null,
      board_context: !!boardContext,
      board_output: !!boardOutput,
      board_state: boardState || null,
      response_locale: responseLocale || null,
    }),
  });
  if (!res.ok) {
    const cloned = res.clone();
    let detail = `AI request failed (${res.status})`;
    try {
      const data = await cloned.json();
      if (data?.detail) detail = String(data.detail);
      else if (data?.error?.message) detail = String(data.error.message);
    } catch {
      try {
        const text = await res.text();
        if (text) detail = text;
      } catch {}
    }
    throw new Error(detail);
  }
  return (await res.json()) as {
    text: string;
    steps?: Array<{ text: string; kind: "text" | "math" | "result" | "warning" }> | null;
    board_actions?: AiBoardAction[] | null;
  };
}

export type ProgressUpdate = {
  progress: number;
  stage: string;
  completed?: number | null;
  total?: number | null;
};

export async function callOcr(blob: Blob, onProgress?: (update: ProgressUpdate) => void) {
  const form = new FormData();
  form.append("file", blob, "board.png");
  const created = await apiFetch("/api/ocr/jobs", {
    method: "POST",
    body: form,
  });
  if (!created.ok) {
    throw new Error(`OCR request failed (${created.status})`);
  }
  const { jobId } = (await created.json()) as { jobId: string };
  if (!jobId) throw new Error("OCR job was not created");

  for (;;) {
    const res = await apiFetch(`/api/ocr/jobs/${encodeURIComponent(jobId)}?t=${Date.now()}`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`OCR progress failed (${res.status})`);
    const job = (await res.json()) as ProgressUpdate & {
      status: "queued" | "running" | "done" | "error";
      result?: { text?: string } | null;
      error?: string | null;
    };
    onProgress?.(job);
    if (job.status === "done") {
      return { text: String(job.result?.text ?? "") };
    }
    if (job.status === "error") {
      throw new Error(job.error || "OCR недоступен");
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
}

export async function getStatus() {
  const res = await apiFetch(`/api/status?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error("Status failed");
  }
  return (await res.json()) as { ok: boolean; ai: boolean; ocr: boolean };
}

export async function apiPost<T>(path: string, payload: unknown) {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`${path} failed`);
  }
  return (await res.json()) as T;
}
