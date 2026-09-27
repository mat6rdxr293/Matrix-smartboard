# AI Full Solution on Board + Playwright Implementation Plan

**Goal:** When the user presses "Полное решение", the assistant should solve the recognized task directly on the board, placing a persistent solution block in free board space and revealing steps progressively. Playwright will verify the complete browser workflow.

**Important distinction:** Playwright is used for end-to-end verification. The production feature must not simulate mouse drawing through Playwright. The application writes solution content through normal board operations so it works offline and outside tests.

**Current foundation:**
- `AIAssistant` already triggers OCR and `mode="solution"`.
- `App.tsx` already owns AI requests, board history and replay queue.
- `BoardCanvas` already has world coordinates, zoom/pan, graph overlays and replay operations.
- `boardDocument.ts` already persists strokes and graph elements with undo/redo.
- Local STEM tool calling is available in the backend, so math/physics/chemistry steps can be verified before presentation.

## Target flow

1. User presses **Полное решение**.
2. Current board is recognized once.
3. The app creates an empty AI solution block immediately with a "thinking" state.
4. Free-space allocator finds a visible non-overlapping board rectangle.
5. Backend returns structured solution steps.
6. Steps appear in the solution block one by one.
7. Every update goes through the board operation log.
8. Undo removes the AI solution like any other board object.
9. Reload/history restores it in the same position.
10. Snapshot/export includes the solution block.

## Data model

Add `AiSolutionBlock` to `frontend/src/app/board/boardDocument.ts`:

```ts
export type AiSolutionStep = {
  id: string;
  text: string;
  kind: "text" | "math" | "result" | "warning";
};

export type AiSolutionBlock = {
  id: string;
  x: number;
  y: number;
  width: number;
  minHeight: number;
  steps: AiSolutionStep[];
  status: "thinking" | "streaming" | "done" | "error";
  source: "ai";
  createdAt: number;
};
```

Extend `BoardDocument` with `solutions: AiSolutionBlock[]`.

Add replay operations:
- `solution_add`
- `solution_update`
- `solution_delete`

`clear`, `undo`, `redo`, persistence and lesson history must include solution blocks.

## Structured AI response

Do not parse numbered Markdown heuristically in the browser.

Add a board-solution response shape:

```ts
type BoardSolutionResponse = {
  summary: string;
  steps: Array<{
    text: string;
    kind: "text" | "math" | "result" | "warning";
  }>;
};
```

For local models, request strict JSON for `mode="solution"` with board context. The backend validates the shape before returning it.

If structured generation fails:
- keep the chat text response;
- create one safe `text` step from the final answer;
- never discard the result.

STEM generation should keep using the deterministic tools from `backend/app/ai_tools.py`.

## Free-space allocator

Create `frontend/src/app/board/freeSpace.ts`.

Inputs:
- visible board world rectangle;
- stroke bounds;
- graph rectangles;
- existing solution rectangles;
- requested solution size;
- padding.

Algorithm:
1. Convert visible viewport to world coordinates using current `pan` and `zoom`.
2. Expand every occupied rectangle by 20–28 logical pixels.
3. Build candidate positions on a coarse 32 px grid.
4. Score candidates by zero overlap first, then distance from content and viewport center, with a preference for right/below existing work.
5. Pick the best fitting rectangle.
6. If none fits, allocate the nearest free area just outside the current viewport and smoothly pan there.

The allocator must be deterministic for the same board state.

## Board rendering

Create:
- `frontend/src/app/board/AiSolutionBlockView.tsx`
- `frontend/src/app/board/freeSpace.ts`

Rendering rules:
- use `MathText` for each step;
- no chat bubble styling;
- use board-native typography and a quiet transparent surface;
- width around 420–560 logical px;
- solution can be moved after generation;
- visible cancel button while streaming;
- pointer events must not start drawing underneath the block.

Animation:
- reveal by complete step, not character-by-character;
- 120–250 ms between steps;
- respect reduced-motion;
- cancellation stops future updates without deleting already written steps.

## App integration

Modify `handleRecognizedAi` in `frontend/src/app/App.tsx`.

For `mode !== "solution"` keep current chat behavior.

For `mode === "solution"`:
1. recognize board;
2. create `solution_add` with `status="thinking"`;
3. call structured solution API;
4. update the same block after each step with `solution_update`;
5. mirror final answer to assistant history;
6. set `status="done"`;
7. on failure set `status="error"` without losing existing steps.

The board block is the primary output; the assistant panel remains a secondary history view.

## Snapshot/export

Do not repeat the old "graphs disappear from downloaded board image" class of bug.

The solution block must participate in the same board export pipeline as graphs:
- add `renderAiSolutionBlockToCanvas(...)`, or
- render all non-stroke board elements through one shared export compositor.

Add a regression test that snapshot/export contains both a graph and an AI solution block.

## Backend persistence

Extend the existing board operation validation/storage to accept:
- `solution_add`
- `solution_update`
- `solution_delete`

Validation:
- block ID length limit;
- finite geometry;
- width/height clamps;
- max 40 steps;
- max 2000 chars per step;
- total serialized block size limit;
- `before.id === after.id` for updates.

Old lesson histories must remain readable.

## Playwright setup

Add:
- `@playwright/test`
- `frontend/playwright.config.ts`
- `frontend/e2e/ai-full-solution.spec.ts`
- npm script: `test:e2e`

Use stable selectors:
- `data-testid="ai-full-solution"`
- `data-testid="ocr-confirm"`
- `data-testid="ai-solution-block"`
- `data-testid="ai-solution-step"`
- `data-testid="board-canvas-root"`

Tests should mock only network responses, not board geometry or DOM behavior.

## Playwright scenarios

### 1. Full solution appears on the board
- Open a lesson.
- Put existing content in the center.
- Mock OCR text.
- Mock structured AI steps.
- Press "Полное решение".
- Confirm recognized content.
- Assert a solution block appears.
- Assert all steps appear in order.

### 2. Free-space placement
- Create a graph on the right side.
- Draw strokes on the left/center.
- Request full solution.
- Read bounding boxes.
- Assert solution block does not intersect the graph or occupied stroke bounds beyond tolerance.

### 3. Zoom/pan correctness
Run at 50%, 100% and 175% zoom plus non-zero pan. Assert the solution is placed in correct world coordinates and remains attached to board content while zooming.

### 4. Undo/redo
Generate solution, undo it, verify disappearance, redo it, and verify the same content/position returns.

### 5. Reload persistence
Generate solution, wait for replay flush, reload, and assert the same solution block is restored.

### 6. Cancellation
Delay mocked AI response, start full solution, cancel after step 2, and assert no later steps appear.

### 7. Error recovery
Test malformed structured response fallback and backend error state without corrupting existing board elements.

### 8. Export regression
Add graph + AI solution, trigger board image export, and assert export compositor receives both element types.

## Implementation order

### Task 1 — Board data model
- Add solution block types and operations.
- Extend reducer and tests.
- Extend backend replay validation/storage.

### Task 2 — Free-space allocator
- Implement deterministic rectangle search.
- Unit test empty board, dense board, graphs, strokes, pan and zoom.

### Task 3 — Solution block renderer
- Add board overlay component.
- Add move/delete/cancel behavior.
- Integrate with undo/redo.

### Task 4 — Structured AI response
- Add backend schema.
- Keep chat fallback.
- Use deterministic STEM tools before final response.

### Task 5 — "Полное решение" integration
- Route only solution mode to board output.
- Preserve hint/check behavior.
- Add step-by-step reveal.

### Task 6 — Export support
- Composite solution blocks into board snapshots.
- Add regression tests.

### Task 7 — Playwright
- Install and configure Playwright.
- Add deterministic mocked E2E tests.
- Run Chromium first; add WebKit because the target Mac workflow uses Safari.

## Acceptance criteria

- Full solution is visibly written on the board, not only in chat.
- Placement avoids existing board content when usable space exists.
- Dense boards pan to a nearby free area instead of overlapping work.
- AI content is persisted, undoable and reloadable.
- Math/physics/chemistry answers can use deterministic local tools.
- Export includes strokes, graphs and AI solution blocks.
- Unit tests, backend tests, Vitest and Playwright are green.
- No cloud service is required for the board-writing path when local OCR/LLM are configured.
