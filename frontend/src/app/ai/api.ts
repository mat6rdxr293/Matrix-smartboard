export type AiMode = "hint" | "check" | "solution";

export async function callAi(
  mode: AiMode,
  problem: string,
  studentAttempt?: string,
  assistantContext?: string,
  continueFrom?: boolean,
  subject?: string
) {
  const res = await fetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode,
      problem,
      student_attempt: studentAttempt || null,
      assistant_context: assistantContext || null,
      continue_from: !!continueFrom,
      subject: subject || null,
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
  return (await res.json()) as { text: string };
}

export async function callOcr(blob: Blob) {
  const form = new FormData();
  form.append("file", blob, "board.png");
  const res = await fetch("/api/ocr", {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error("OCR request failed");
  }
  return (await res.json()) as { text: string };
}

export async function getStatus() {
  const res = await fetch(`/api/status?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error("Status failed");
  }
  return (await res.json()) as { ok: boolean; ai: boolean; ocr: boolean };
}

export async function apiPost<T>(path: string, payload: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`${path} failed`);
  }
  return (await res.json()) as T;
}
