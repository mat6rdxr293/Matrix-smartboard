import { apiFetch } from "@/lib/apiClient";
import type { Stroke } from "@/app/board/boardEngine";
import type { AiSolutionBlock, BoardImage, GraphElement } from "@/app/board/boardDocument";
import { mergeContiguousStrokes } from "@/app/board/strokeMerge";

type BoardReplayMeta = {
  client_operation_id?: string;
  device_id?: string;
  client_seq?: number;
  clientOperationId?: string;
  ts?: number;
};

export type BoardReplayOp = BoardReplayMeta & (
  | { op: "add"; stroke: Stroke }
  | { op: "stroke_batch_add"; strokes: Stroke[] }
  | { op: "graph_add"; graph: GraphElement }
  | { op: "graph_update"; before: GraphElement; after: GraphElement }
  | { op: "graph_delete"; graph: GraphElement }
  | { op: "solution_add"; solution: AiSolutionBlock }
  | { op: "solution_update"; before: AiSolutionBlock; after: AiSolutionBlock }
  | { op: "solution_delete"; solution: AiSolutionBlock }
  | { op: "image_add"; image: BoardImage }
  | { op: "image_update"; before: BoardImage; after: BoardImage }
  | { op: "image_delete"; image: BoardImage }
  | { op: "stroke_move"; indexes: number[]; dx: number; dy: number }
  | { op: "stroke_delete"; indexes: number[]; strokes: Stroke[] }
  | { op: "undo" | "redo" | "clear" }
);

const replayOperationId = (operation: BoardReplayOp) =>
  operation.client_operation_id ?? operation.clientOperationId;

export function filterPendingBoardReplayOps(server: BoardReplayOp[], local: BoardReplayOp[]) {
  const savedIds = new Set(server.map(replayOperationId).filter((id): id is string => Boolean(id)));
  return local.filter((operation) => {
    const id = replayOperationId(operation);
    return !id || !savedIds.has(id);
  });
}

export async function loadBoardReplay(lessonId: string) {
  const res = await apiFetch(`/api/lessons/${lessonId}/board`, { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) {
    throw new Error("board replay load failed");
  }
  return (await res.json()) as { operations: BoardReplayOp[] };
}

export async function appendBoardReplay(ops: BoardReplayOp[], lessonId: string) {
  if (!ops.length) return { ok: true };
  const res = await apiFetch(`/api/lessons/${lessonId}/board/operations`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operations: ops }),
  });
  if (res.status === 413 || res.status === 422) {
    throw new BoardReplayRejected(res.status, await res.text().catch(() => ""));
  }
  if (!res.ok) {
    throw new Error("board replay append failed");
  }
  return (await res.json()) as { ok: boolean; inserted?: number };
}

/** The server refused the operations themselves: sending them again will never succeed. */
export class BoardReplayRejected extends Error {
  constructor(public status: number, public detail: string) {
    super(`board replay rejected (${status}): ${detail}`);
    this.name = "BoardReplayRejected";
  }
}

/** Joins the pieces of AI handwriting so the batch stays within what the server accepts. */
export function compactBoardReplayOp<T extends BoardReplayOp>(operation: T): T {
  if (operation.op !== "stroke_batch_add") return operation;
  return { ...operation, strokes: mergeContiguousStrokes(operation.strokes) };
}

/**
 * Sends one chunk of the queue. A chunk the server refuses is resent one operation at a time,
 * and an operation refused on its own is dropped from sync (it stays on this board): one bad
 * operation must not hold back everything drawn after it, which it did for a whole lesson.
 * Returns the ids of the operations that were dropped. Network and server errors still throw,
 * so the queue is kept and retried.
 */
export async function sendBoardReplayChunk(
  chunk: BoardReplayOp[],
  lessonId: string,
  append: typeof appendBoardReplay = appendBoardReplay,
): Promise<string[]> {
  const prepared = chunk.map(compactBoardReplayOp);
  try {
    await append(prepared, lessonId);
    return [];
  } catch (error) {
    if (!(error instanceof BoardReplayRejected) || prepared.length === 1) {
      if (error instanceof BoardReplayRejected) {
        console.warn("Board operation refused by the server and left out of sync", error.detail);
        return prepared.map(replayOperationId).filter((id): id is string => Boolean(id));
      }
      throw error;
    }
  }
  const dropped: string[] = [];
  for (const operation of prepared) {
    dropped.push(...(await sendBoardReplayChunk([operation], lessonId, append)));
  }
  return dropped;
}
