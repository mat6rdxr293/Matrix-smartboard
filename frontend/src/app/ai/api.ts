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
    body: aiRequestBody(
      mode, problem, studentAttempt, assistantContext, continueFrom, subject, lessonId,
      clientMessageId, boardContext, boardOutput, responseLocale, boardState,
    ),
  });
  if (!res.ok) throw new Error(await aiErrorDetail(res));
  return (await res.json()) as AiResult;
}

export type AiStep = { text: string; kind: "text" | "math" | "result" | "warning" };

export type AiResult = {
  text: string;
  steps?: AiStep[] | null;
  board_actions?: AiBoardAction[] | null;
};

function aiRequestBody(...args: Parameters<typeof callAi>) {
  const [
    mode, problem, studentAttempt, assistantContext, continueFrom, subject, lessonId,
    clientMessageId, boardContext, boardOutput, responseLocale, boardState,
  ] = args;
  return JSON.stringify({
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
  });
}

async function aiErrorDetail(res: Response) {
  let detail = `AI request failed (${res.status})`;
  try {
    const data = await res.clone().json();
    if (data?.detail) detail = String(data.detail);
    else if (data?.error?.message) detail = String(data.error.message);
  } catch {
    try {
      const text = await res.text();
      if (text) detail = text;
    } catch {}
  }
  return detail;
}

/**
 * The same answer as callAi, with the text shown while the model writes it: the server runs the
 * request as a job and `onPartial` gets what is written so far: the readable text and the steps
 * the model has finished (cleaned like the steps of the answer). A server without AI jobs (an
 * older version) is asked the usual way.
 */
export async function callAiStreaming(
  args: Parameters<typeof callAi>,
  onPartial: (text: string, finishedSteps: AiStep[]) => void,
  pollMs = 400,
): Promise<AiResult> {
  const created = await apiFetch("/api/ai/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: aiRequestBody(...args),
  });
  if (created.status === 404 || created.status === 405) return callAi(...args);
  if (!created.ok) throw new Error(await aiErrorDetail(created));
  const { jobId } = (await created.json()) as { jobId: string };
  if (!jobId) throw new Error("AI job was not created");

  let shown = "";
  for (;;) {
    await new Promise((resolve) => window.setTimeout(resolve, pollMs));
    const res = await apiFetch(`/api/ai/jobs/${encodeURIComponent(jobId)}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(await aiErrorDetail(res));
    const job = (await res.json()) as {
      status: "queued" | "running" | "done" | "error";
      partial?: string | null;
      partialSteps?: AiStep[] | null;
      result?: AiResult | null;
      error?: string | null;
    };
    if (job.partial && job.partial !== shown) {
      shown = job.partial;
      onPartial(shown, job.partialSteps ?? []);
    }
    if (job.status === "done" && job.result) return job.result;
    if (job.status === "error") throw new Error(job.error || "AI недоступен");
  }
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
