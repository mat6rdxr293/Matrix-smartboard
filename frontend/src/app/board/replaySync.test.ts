import { describe, expect, it, vi } from "vitest";
import type { Stroke } from "@/app/board/boardEngine";
import { BoardReplayRejected, sendBoardReplayChunk, type BoardReplayOp } from "@/app/board/replayApi";
import { mergeContiguousStrokes } from "@/app/board/strokeMerge";

const piece = (x0: number, y0: number, x1: number, y1: number, color = "#2DD4BF"): Stroke => ({
  points: [{ x: x0, y: y0 }, { x: x1, y: y1 }],
  color,
  width: 2.15,
  mode: "draw",
  source: "ai",
});

describe("mergeContiguousStrokes", () => {
  it("joins pieces that continue one another", () => {
    const merged = mergeContiguousStrokes([piece(0, 0, 1, 0), piece(1.2, 0, 2, 0), piece(2.1, 0.3, 3, 0)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].points).toHaveLength(6);
  });

  it("keeps pieces apart when there is a gap or they look different", () => {
    expect(mergeContiguousStrokes([piece(0, 0, 1, 0), piece(10, 0, 11, 0)])).toHaveLength(2);
    expect(mergeContiguousStrokes([piece(0, 0, 1, 0), piece(1, 0, 2, 0, "#FF0000")])).toHaveLength(2);
  });

  it("brings 25 000 two-point pieces of handwriting far under the server limit of 20 000", () => {
    const pieces: Stroke[] = [];
    for (let line = 0; line < 250; line += 1) {
      for (let i = 0; i < 100; i += 1) pieces.push(piece(i, line * 10, i + 1, line * 10));
    }
    expect(mergeContiguousStrokes(pieces).length).toBe(250);
  });
});

describe("sendBoardReplayChunk", () => {
  const op = (id: string, extra: Partial<BoardReplayOp> = {}): BoardReplayOp =>
    ({ op: "undo", client_operation_id: id, ...extra }) as BoardReplayOp;

  it("drops only the operation the server refuses and sends the rest", async () => {
    const sent: string[] = [];
    const append = vi.fn(async (ops: BoardReplayOp[]) => {
      if (ops.some((item) => item.client_operation_id === "bad")) throw new BoardReplayRejected(422, "invalid");
      sent.push(...ops.map((item) => item.client_operation_id!));
      return { ok: true };
    });

    const dropped = await sendBoardReplayChunk([op("a"), op("bad"), op("c")], "lesson", append);

    expect(dropped).toEqual(["bad"]);
    expect(sent).toEqual(["a", "c"]);
  });

  it("keeps the queue when the server is unreachable", async () => {
    const append = vi.fn(async () => {
      throw new Error("network");
    });
    await expect(sendBoardReplayChunk([op("a")], "lesson", append)).rejects.toThrow("network");
  });

  it("sends AI handwriting batches with the pieces joined", async () => {
    const append = vi.fn(async (_ops: BoardReplayOp[]) => ({ ok: true }));
    const strokes = [piece(0, 0, 1, 0), piece(1, 0, 2, 0), piece(2, 0, 3, 0)];

    await sendBoardReplayChunk([op("ai", { op: "stroke_batch_add", strokes } as Partial<BoardReplayOp>)], "lesson", append);

    const sent = append.mock.calls[0][0][0] as Extract<BoardReplayOp, { op: "stroke_batch_add" }>;
    expect(sent.strokes).toHaveLength(1);
    expect(sent.client_operation_id).toBe("ai");
  });
});
