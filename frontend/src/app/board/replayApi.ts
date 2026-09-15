import type { Stroke } from "@/app/board/boardEngine";

export type BoardReplayOp =
  | { client_operation_id?: string; op: "add"; stroke: Stroke; ts?: number }
  | { client_operation_id?: string; op: "undo"; ts?: number }
  | { client_operation_id?: string; op: "redo"; ts?: number }
  | { client_operation_id?: string; op: "clear"; ts?: number };

export async function loadBoardReplay(lessonId: string) {
  const res = await fetch(`/api/lessons/${lessonId}/board`, { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) {
    throw new Error("board replay load failed");
  }
  return (await res.json()) as { operations: BoardReplayOp[] };
}

export async function appendBoardReplay(ops: BoardReplayOp[], lessonId: string) {
  if (!ops.length) return { ok: true };
  const res = await fetch(`/api/lessons/${lessonId}/board/operations`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operations: ops }),
  });
  if (!res.ok) {
    throw new Error("board replay append failed");
  }
  return (await res.json()) as { ok: boolean; inserted?: number };
}
