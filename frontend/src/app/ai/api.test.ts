// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/apiClient", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const { callAiStreaming } = await import("./api");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const args = ["solution", "5^(x-1) < 25"] as unknown as Parameters<typeof callAiStreaming>[0];

afterEach(() => apiFetch.mockReset());

describe("callAiStreaming", () => {
  it("passes on the text as it is written and returns the finished answer", async () => {
    const result = { text: "x < 3", steps: [{ text: "x < 3", kind: "result" }] };
    apiFetch
      .mockResolvedValueOnce(json({ jobId: "j1" }))
      .mockResolvedValueOnce(json({ status: "running", partial: "1. Заметим" }))
      .mockResolvedValueOnce(json({ status: "running", partial: "1. Заметим" }))
      .mockResolvedValueOnce(json({ status: "running", partial: "1. Заметим, что 25 = 5^2" }))
      .mockResolvedValueOnce(json({ status: "done", partial: "1. Заметим, что 25 = 5^2", result }));
    const seen: string[] = [];

    const answer = await callAiStreaming(args, (text) => seen.push(text), 0);

    expect(answer).toEqual(result);
    expect(seen).toEqual(["1. Заметим", "1. Заметим, что 25 = 5^2"]);
    expect(apiFetch.mock.calls[0][0]).toBe("/api/ai/jobs");
  });

  it("asks an older server without AI jobs the usual way", async () => {
    const result = { text: "x < 3" };
    apiFetch.mockResolvedValueOnce(new Response("", { status: 404 })).mockResolvedValueOnce(json(result));

    const answer = await callAiStreaming(args, () => undefined, 0);

    expect(answer).toEqual(result);
    expect(apiFetch.mock.calls[1][0]).toBe("/api/ai");
  });

  it("reports the server's error", async () => {
    apiFetch
      .mockResolvedValueOnce(json({ jobId: "j1" }))
      .mockResolvedValueOnce(json({ status: "error", error: "AI недоступен: timeout" }));

    await expect(callAiStreaming(args, () => undefined, 0)).rejects.toThrow("AI недоступен: timeout");
  });
});
