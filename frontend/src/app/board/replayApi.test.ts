import { describe, expect, it } from "vitest";
import { filterPendingBoardReplayOps, type BoardReplayOp } from "./replayApi";

const stroke = {
  points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  color: "#fff",
  width: 2,
  mode: "draw" as const,
};

describe("filterPendingBoardReplayOps", () => {
  it("drops local operations already present in the server journal", () => {
    const server: BoardReplayOp[] = [
      { op: "add", stroke, clientOperationId: "saved-1" },
    ];
    const local: BoardReplayOp[] = [
      { op: "add", stroke, client_operation_id: "saved-1" },
      { op: "undo", client_operation_id: "pending-2" },
    ];

    expect(filterPendingBoardReplayOps(server, local)).toEqual([
      { op: "undo", client_operation_id: "pending-2" },
    ]);
  });
});
