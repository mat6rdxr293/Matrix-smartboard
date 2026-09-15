import type { Stroke } from "@/app/board/boardEngine";
import type { GraphElement } from "@/app/board/boardDocument";

type BoardReplayMeta = {
  client_operation_id?: string;
  clientOperationId?: string;
  ts?: number;
};

export type BoardReplayOp = BoardReplayMeta & (
  | { op: "add"; stroke: Stroke }
  | { op: "graph_add"; graph: GraphElement }
  | { op: "graph_update"; before: GraphElement; after: GraphElement }
  | { op: "graph_delete"; graph: GraphElement }
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
