import { describe, expect, it, vi } from "vitest";
import type { Stroke } from "@/app/board/boardEngine";

// One stroke per step, 40 units high, so positions are easy to check.
vi.mock("@/app/board/aiHandwriting", () => ({
  normalizeHandwritingText: (text: string) => text.trim(),
  solutionStepsToHandwritingStrokes: (steps: Array<{ text: string }>, options: { x: number; y: number; color: string }) => ({
    strokes: steps.map((step) => ({
      points: [{ x: options.x, y: options.y }, { x: options.x + step.text.length, y: options.y }],
      color: options.color,
      width: 2,
      mode: "draw",
      source: "ai",
    })),
    height: steps.length * 40,
  }),
}));

const { createLiveBoardWriter } = await import("./liveHandwriting");

const layout = {
  width: 560,
  estimatedHeight: 520,
  color: "#2DD4BF",
  strokeWidth: 2,
  fontSize: 29,
  lineGap: 11,
  stepGap: 16,
  lowMotion: true,
};

function fakeBoard() {
  const board = {
    drawn: [] as Stroke[],
    holdAiInk: vi.fn(),
    releaseAiInk: vi.fn(),
    allocateSolutionPlacement: vi.fn(() => ({ x: 100, y: 200, width: 560, minHeight: 520 })),
    animateAiStrokes: vi.fn(async (strokes: Stroke[]) => {
      board.drawn.push(...strokes);
      return strokes;
    }),
  };
  return board;
}

const step = (text: string) => ({ text, kind: "text" as const });
const drawn = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createLiveBoardWriter", () => {
  it("writes finished steps one under another and completes them with the final answer", async () => {
    const board = fakeBoard();
    const live = createLiveBoardWriter(board, layout, null, () => false);

    live.update([step("Заметим, что 25 = 5^2")]);
    live.update([step("Заметим, что 25 = 5^2"), step("x - 1 < 2")]);
    expect(live.writing).toBe(true);

    const strokes = await live.finish([step("Заметим, что 25 = 5^2"), step("x - 1 < 2"), step("x < 3")]);

    expect(strokes).toHaveLength(3);
    expect(board.drawn.map((stroke) => stroke.points[0].y)).toEqual([210, 250, 290]);
    expect(board.drawn.every((stroke) => stroke.points[0].x === 112)).toBe(true);
    expect(board.allocateSolutionPlacement).toHaveBeenCalledTimes(1);
    expect(board.holdAiInk).toHaveBeenCalledTimes(1);
    expect(board.releaseAiInk).not.toHaveBeenCalled();

    live.release(false);
    expect(board.releaseAiInk).toHaveBeenCalledWith(false);
  });

  it("writes the title first, as the whole answer would", async () => {
    const board = fakeBoard();
    const live = createLiveBoardWriter(board, layout, step("Подсказка:"), () => false);

    live.update([step("Вспомни, что 9 = 3^2")]);
    const strokes = await live.finish([step("Подсказка:"), step("Вспомни, что 9 = 3^2")]);

    expect(strokes).toHaveLength(2);
    expect(board.drawn[0].points[1].x - board.drawn[0].points[0].x).toBe("Подсказка:".length);
  });

  it("waits while a fresh model call catches up with the steps already written", async () => {
    const board = fakeBoard();
    const live = createLiveBoardWriter(board, layout, null, () => false);

    live.update([step("a"), step("b")]);
    live.update([step("a")]);
    live.update([step("a"), step("b"), step("c")]);

    expect(await live.finish([step("a"), step("b"), step("c")])).toHaveLength(3);
    expect(board.releaseAiInk).not.toHaveBeenCalled();
  });

  it("takes the ink off when the final answer is not what was written", async () => {
    const board = fakeBoard();
    const live = createLiveBoardWriter(board, layout, null, () => false);

    live.update([step("a"), step("b")]);
    expect(await live.finish([step("a"), step("другой шаг")])).toBeNull();
    expect(board.releaseAiInk).toHaveBeenCalledWith(true);
  });

  it("stops at a step that changed while streaming", async () => {
    const board = fakeBoard();
    const live = createLiveBoardWriter(board, layout, null, () => false);

    live.update([step("a")]);
    await drawn();
    live.update([step("другое"), step("b")]);

    expect(live.writing).toBe(false);
    expect(await live.finish([step("a"), step("b")])).toBeNull();
    expect(board.releaseAiInk).toHaveBeenCalledWith(true);
  });

  it("leaves nothing behind when the request is cancelled", async () => {
    const board = fakeBoard();
    let cancelled = false;
    const live = createLiveBoardWriter(board, layout, null, () => cancelled);

    live.update([step("a")]);
    await drawn();
    cancelled = true;
    expect(await live.finish([step("a"), step("b")])).toBeNull();
    expect(board.releaseAiInk).toHaveBeenCalledWith(true);
  });

  it("does nothing when no step came before the answer", async () => {
    const board = fakeBoard();
    const live = createLiveBoardWriter(board, layout, null, () => false);

    expect(await live.finish([step("a")])).toBeNull();
    expect(board.holdAiInk).not.toHaveBeenCalled();
  });
});
