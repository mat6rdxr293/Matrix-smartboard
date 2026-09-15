import type { Stroke } from "@/app/board/boardEngine";
import { withSubjectQuery } from "@/app/subjects/subjectConfig";

export type BoardReplayOp =
  | { op: "add"; stroke: Stroke; ts?: number }
  | { op: "undo"; ts?: number }
  | { op: "redo"; ts?: number }
  | { op: "clear"; ts?: number };

const withReplaySubject = (path: string, subjectId?: string) =>
  subjectId ? withSubjectQuery(path, subjectId) : path;

export async function loadBoardReplay(subjectId?: string) {
  const res = await fetch(withReplaySubject("/api/board/replay", subjectId), { cache: "no-store" });
  if (!res.ok) {
    throw new Error("board replay load failed");
  }
  return (await res.json()) as { strokes: Stroke[]; updatedAt?: number };
}

export async function appendBoardReplay(ops: BoardReplayOp[], subjectId?: string) {
  if (!ops.length) return { ok: true };
  const res = await fetch(withReplaySubject("/api/board/replay", subjectId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ops }),
  });
  if (!res.ok) {
    throw new Error("board replay append failed");
  }
  return (await res.json()) as { ok: boolean; updatedAt?: number };
}
