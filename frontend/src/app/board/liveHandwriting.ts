import type { BoardCanvasHandle } from "@/app/board/BoardCanvas";
import type { Stroke } from "@/app/board/boardEngine";
import { normalizeHandwritingText, solutionStepsToHandwritingStrokes } from "@/app/board/aiHandwriting";

export type LiveStep = { text: string; kind?: "text" | "math" | "result" | "warning" };

export type LiveLayout = {
  width: number;
  /** Room asked of the board before the length of the answer is known. */
  estimatedHeight: number;
  color: string;
  strokeWidth: number;
  fontSize: number;
  lineGap: number;
  stepGap: number;
  lowMotion: boolean;
};

type Board = Pick<BoardCanvasHandle, "allocateSolutionPlacement" | "animateAiStrokes" | "holdAiInk" | "releaseAiInk">;

const stepKey = (step: LiveStep) => `${step.kind ?? "text"}|${normalizeHandwritingText(step.text)}`;

/**
 * Writes an AI answer on the board step by step while the model is still writing it.
 *
 * Steps go down one under another exactly as the whole answer would have been laid out, so when
 * the finished answer starts with the steps already written only the rest is added. If it does
 * not (the model was asked again, the server rewrote a step), the ink is taken off and the caller
 * writes the answer the usual way. Nothing is saved here: the caller saves all the strokes as one
 * operation, so one undo still removes the whole answer.
 */
export function createLiveBoardWriter(
  board: Board,
  layout: LiveLayout,
  title: LiveStep | null,
  isCancelled: () => boolean,
) {
  let placement: { x: number; y: number } | null = null;
  let cursorY = 10;
  let diverged = false;
  const planned: LiveStep[] = [];
  const written: Stroke[] = [];
  let queue: Promise<void> = Promise.resolve();

  const drawStep = async (step: LiveStep) => {
    if (!placement) {
      board.holdAiInk();
      placement = board.allocateSolutionPlacement(layout.width, layout.estimatedHeight);
    }
    const draft = solutionStepsToHandwritingStrokes([{ text: step.text, kind: step.kind ?? "text" }], {
      x: 12,
      y: cursorY,
      maxWidth: layout.width - 24,
      color: layout.color,
      strokeWidth: layout.strokeWidth,
      fontSize: layout.fontSize,
      lineGap: layout.lineGap,
      stepGap: layout.stepGap,
    });
    cursorY += draft.height;
    if (!draft.strokes.length) return;
    const origin = placement;
    const strokes = draft.strokes.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({ x: point.x + origin.x, y: point.y + origin.y })),
    }));
    written.push(...(await board.animateAiStrokes(strokes, isCancelled, layout.lowMotion)));
  };

  const enqueue = (steps: LiveStep[]) => {
    queue = queue.then(async () => {
      for (const step of steps) {
        if (diverged || isCancelled()) return;
        await drawStep(step);
      }
    });
    return queue;
  };

  const matchesPlanned = (steps: LiveStep[]) =>
    planned.every((step, index) => index < steps.length && stepKey(step) === stepKey(steps[index]));

  return {
    /** True once ink is on the board (or about to be): the text card is no longer needed. */
    get writing() {
      return planned.length > 0 && !diverged;
    },

    /** The steps the model has finished so far; new ones are written, in order. */
    update(finished: LiveStep[]) {
      if (diverged || isCancelled()) return;
      const wanted = title ? [title, ...finished] : finished;
      // Fewer steps than written is a fresh model call writing the answer again: wait for it to
      // catch up. A different step is a different answer: stop writing.
      for (let index = 0; index < Math.min(planned.length, wanted.length); index += 1) {
        if (stepKey(planned[index]) !== stepKey(wanted[index])) {
          diverged = true;
          return;
        }
      }
      if (wanted.length <= planned.length) return;
      const fresh = wanted.slice(planned.length);
      planned.push(...fresh);
      void enqueue(fresh);
    },

    /**
     * Completes the answer with its final steps. Returns every stroke written, to be saved as one
     * operation, or null when the ink already on the board did not fit the answer and was taken
     * off (or nothing was written): the caller then writes the answer as usual.
     */
    async finish(finalSteps: LiveStep[]): Promise<Stroke[] | null> {
      await queue;
      if (!placement) {
        planned.length = 0;
        return null;
      }
      if (diverged || isCancelled() || !matchesPlanned(finalSteps)) {
        board.releaseAiInk(true);
        placement = null;
        return null;
      }
      const rest = finalSteps.slice(planned.length);
      planned.push(...rest);
      await enqueue(rest);
      if (isCancelled()) {
        board.releaseAiInk(true);
        placement = null;
        return null;
      }
      return written;
    },

    /** After the strokes are saved (keep them), or when the answer is abandoned (take them off). */
    release(discard: boolean) {
      if (!placement) return;
      board.releaseAiInk(discard);
      placement = null;
    },
  };
}
