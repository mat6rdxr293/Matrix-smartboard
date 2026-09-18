# Interactive Board Graphs and Themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent, movable and resizable multi-function coordinate graphs to the board, redesign the existing board tools into a two-level floating toolbar, and provide complete dark and light application themes.

**Architecture:** Pure TypeScript modules parse expressions, sample curves and reduce the unified board operation log into a `BoardDocument`. React renders graph elements as SVG overlays inside the board world transform, while FastAPI stores the new graph operations in the existing ordered lesson log after a transactional SQLite schema migration. A root theme provider applies semantic CSS variables to every application screen, and focused toolbar components replace the monolithic controls inside `BoardCanvas`.

**Tech Stack:** React 18, TypeScript 5.5, SVG, Canvas 2D, Vitest, React Testing Library, Tailwind CSS, FastAPI, SQLite, pytest.

**Spec:** `docs/superpowers/specs/2026-09-15-interactive-board-graphs-design.md`

## Global Constraints

- Do not use `eval`, `Function`, remote graph services, or runtime network assets.
- One graph contains 1–8 independently colored and visible expressions.
- Expression length is at most 120 characters; plotting samples at most 700 points per function.
- Default graph bounds are `x/y = -10…10`; first version has no internal graph pan or zoom.
- Graph element sizes are clamped to `260 × 190…1200 × 900` logical board pixels.
- Graph add/update/delete, strokes, undo, redo and clear share one ordered and idempotent operation log.
- Existing stroke-only lesson histories must remain readable after migration.
- Dark and light themes cover the whole route and persist under `practice.appearance.theme`.
- Toolbar assets are local SVG files and must work through `currentColor` or CSS variables.
- Shapes, text, stickers, stamps and sections from the visual reference are out of scope.

---

### Task 1: Safe expression parser and SVG plot sampling

**Files:**
- Create: `frontend/src/app/board/graphTypes.ts`
- Create: `frontend/src/app/board/graphExpression.ts`
- Create: `frontend/src/app/board/graphPlot.ts`
- Test: `frontend/src/app/board/graphExpression.test.ts`
- Test: `frontend/src/app/board/graphPlot.test.ts`

**Interfaces:**
- Produces `GraphExpression`, `GraphElement`, `createDefaultGraph(x, y)` in `graphTypes.ts`.
- Produces `compileExpression(source: string): { evaluate(x: number): number }` and `GraphExpressionError`.
- Produces `plotExpression(compiled, bounds, viewport): PlotSegment[]`, where `PlotSegment` is an array of `{x, y}` SVG coordinates.

- [ ] **Step 1: Add failing parser tests**

```ts
expect(compileExpression("2x + 1").evaluate(3)).toBe(7);
expect(compileExpression("sin(pi / 2)").evaluate(0)).toBeCloseTo(1);
expect(compileExpression("tg(pi / 4) + ctg(pi / 4)").evaluate(0)).toBeCloseTo(2);
expect(compileExpression("arcsin(1) + log2(8)").evaluate(0)).toBeCloseTo(Math.PI / 2 + 3);
expect(compileExpression("ln(e) + cbrt(27)").evaluate(0)).toBeCloseTo(4);
expect(() => compileExpression("window.alert(1)")).toThrow(GraphExpressionError);
expect(() => compileExpression("x".repeat(121))).toThrow(/120/);
```

- [ ] **Step 2: Run the parser test and confirm missing-module failure**

Run: `cd frontend && npm test -- --run src/app/board/graphExpression.test.ts`
Expected: FAIL because `graphExpression.ts` does not exist.

- [ ] **Step 3: Implement a tokenizer and recursive-descent parser**

Use grammar `expression → term (+|-) term`, `term → power ((*|/)|implicit) power`, `power → unary (^ power)?`, `unary → (+|-) unary | primary`, and `primary → number | x | constant | function(expression) | (expression)`. Map aliases `tg→tan`, `ctg→cot`, `arcsin→asin`, `arccos→acos`, `arctan→atan`, `arccot→acot`, and `lg→log`. Reject all unknown identifiers and trailing tokens.

- [ ] **Step 4: Add failing plot tests for normal and discontinuous curves**

```ts
const parabola = plotExpression(compileExpression("x^2"), bounds, viewport);
expect(parabola).toHaveLength(1);
expect(parabola[0].length).toBeGreaterThan(400);

const reciprocal = plotExpression(compileExpression("1/x"), bounds, viewport);
expect(reciprocal.length).toBeGreaterThan(1);
expect(reciprocal.flat().every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
```

- [ ] **Step 5: Implement adaptive sample count and discontinuity splitting**

Clamp samples to `Math.min(700, Math.max(500, Math.round(width)))`; break a segment for non-finite results, values outside four viewport heights, or adjacent screen points whose vertical delta exceeds half the plot height.

- [ ] **Step 6: Run focused tests and commit**

Run: `cd frontend && npm test -- --run src/app/board/graphExpression.test.ts src/app/board/graphPlot.test.ts`
Expected: all new tests pass.

```bash
git add frontend/src/app/board/graphTypes.ts frontend/src/app/board/graphExpression.ts frontend/src/app/board/graphPlot.ts frontend/src/app/board/graphExpression.test.ts frontend/src/app/board/graphPlot.test.ts
git commit -m "feat: parse and sample graph expressions"
```

### Task 2: Unified board document reducer

**Files:**
- Create: `frontend/src/app/board/boardDocument.ts`
- Test: `frontend/src/app/board/boardDocument.test.ts`
- Modify: `frontend/src/app/board/replayApi.ts`
- Modify: `frontend/src/app/session/types.ts`

**Interfaces:**
- Consumes `Stroke` and `GraphElement`.
- Produces the full `BoardReplayOp` union, `BoardDocument`, `BoardReplayState`, `createBoardReplayState()`, `applyBoardOperation(state, op)` and `replayBoardOperations(ops)`.
- `BoardReplayState` contains `{ document, undoStack, redoStack }`; stacks contain internal inverse/apply commands rather than persisted operations.

- [ ] **Step 1: Write failing reducer tests**

Cover these exact sequences:

```ts
replay([graphAdd, graphUpdate, undo]).document.graphs[0] === graphAdd.graph;
replay([graphAdd, graphUpdate, undo, redo]).document.graphs[0] === graphUpdate.after;
replay([strokeAdd, graphAdd, clear, undo]).document has one stroke and one graph;
replay([graphAdd, undo, strokeAdd, redo]).document has only the stroke;
replay([graphAdd, graphDelete, undo]).document.graphs[0] === graphAdd.graph;
```

- [ ] **Step 2: Run the reducer test and confirm missing-module failure**

Run: `cd frontend && npm test -- --run src/app/board/boardDocument.test.ts`
Expected: FAIL because `boardDocument.ts` does not exist.

- [ ] **Step 3: Implement immutable command application**

Each mutating operation records an internal `{ apply(document), revert(document) }` command. `undo` moves the last command to redo, `redo` reapplies it, and any new mutating operation empties redo. `clear` captures the complete pre-clear document. Invalid updates for missing graph IDs are ignored without corrupting stacks.

- [ ] **Step 4: Move the operation union into `boardDocument.ts` and update API types**

`replayApi.ts` imports `BoardReplayOp`, posts `{operations}`, and returns the unified ordered list. `session/types.ts` re-exports or references the same union instead of defining a divergent graph operation shape.

- [ ] **Step 5: Run tests and commit**

Run: `cd frontend && npm test -- --run src/app/board/boardDocument.test.ts src/app/board/graphExpression.test.ts src/app/board/graphPlot.test.ts`
Expected: all pass.

```bash
git add frontend/src/app/board/boardDocument.ts frontend/src/app/board/boardDocument.test.ts frontend/src/app/board/replayApi.ts frontend/src/app/session/types.ts
git commit -m "feat: unify board stroke and graph history"
```

### Task 3: Backend graph operation migration and validation

**Files:**
- Modify: `backend/app/school_store.py`
- Modify: `backend/app/school_routes.py`
- Test: `backend/tests/test_graph_operations.py`

**Interfaces:**
- Extends `SchoolStore.append_board_operations` and `board_state` for `graph_add`, `graph_update`, and `graph_delete`.
- Adds schema metadata key `board_operations_version=2` and a transactional v1→v2 table rebuild.
- Keeps the existing `/api/lessons/{lesson_id}/board` and `/board/operations` routes.

- [ ] **Step 1: Add a failing migration test**

Create a SQLite database with the old `board_operations` `CHECK`, insert an `add` operation, initialize `SchoolStore`, then append `graph_add`. Assert both operations return in sequence and the original IDs remain unchanged.

- [ ] **Step 2: Add failing API validation tests**

```python
valid = [
    {"client_operation_id": "g1", "op": "graph_add", "graph": graph, "ts": 1},
    {"client_operation_id": "g2", "op": "graph_update", "before": graph, "after": moved_graph, "ts": 2},
    {"client_operation_id": "g3", "op": "graph_delete", "graph": moved_graph, "ts": 3},
]
assert post(valid).status_code == 200
assert [op["op"] for op in get_board()] == ["graph_add", "graph_update", "graph_delete"]
assert post([valid[0]]).json()["inserted"] == 0
assert post([{"client_operation_id": "bad", "op": "graph_update", "before": graph, "after": other_id_graph}]).status_code == 422
```

- [ ] **Step 3: Run the backend test and confirm rejection of new operation types**

Run: `.venv-mac/bin/python -m pytest backend/tests/test_graph_operations.py -q`
Expected: FAIL with request validation or SQLite check error.

- [ ] **Step 4: Implement the transactional schema migration**

Add a `schema_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)` table. If the stored version is below 2, create `board_operations_v2`, copy all columns, drop the old table, rename v2, recreate both unique indexes, and store version 2 in the same transaction. New databases create the v2 check directly.

- [ ] **Step 5: Extend Pydantic and store validation**

Allow the seven operation types. Validate graph ID, finite numeric geometry, size limits, labels no longer than 32 characters, 1–8 expressions, expression text no longer than 120 characters, valid CSS hex colors, matching before/after IDs, and a serialized payload below 128 KB.

- [ ] **Step 6: Run backend tests and commit**

Run: `.venv-mac/bin/python -m pytest backend/tests -q`
Expected: existing and new tests pass.

```bash
git add backend/app/school_store.py backend/app/school_routes.py backend/tests/test_graph_operations.py
git commit -m "feat: persist interactive graph operations"
```

### Task 4: SVG graph element and editor

**Files:**
- Create: `frontend/src/app/board/GraphElementView.tsx`
- Create: `frontend/src/app/board/GraphEditor.tsx`
- Test: `frontend/src/app/board/GraphElementView.test.tsx`
- Modify: `frontend/src/i18n/locales/ru.json`
- Modify: `frontend/src/i18n/locales/kk.json`

**Interfaces:**
- `GraphElementView({ graph, selected, theme, onSelect, onCommitChange, onDelete })` renders the plot and interactions.
- `GraphEditor({ graph, onCommitChange, onClose })` edits expressions, colors, visibility and axis labels.
- Drag and resize call `onCommitChange(before, after)` once on pointer release.

- [ ] **Step 1: Write failing component tests**

Render one graph and assert axis lines and the `x` path exist. Click the x-axis label, change it to `t, с`, press Enter and assert `onCommitChange` receives the new label. Add a second expression, choose `#ff5c5c`, hide it and delete it. Assert the callback never returns zero or more than eight expressions.

- [ ] **Step 2: Run the focused test and confirm missing-component failure**

Run: `cd frontend && npm test -- --run src/app/board/GraphElementView.test.tsx`
Expected: FAIL because the graph components do not exist.

- [ ] **Step 3: Implement SVG axes, grid, labels and curve paths**

Use a clipped plot rectangle, semantic theme colors and `plotExpression`. Cache compiled expressions by source. Render invalid rows without a path and connect the error message with `aria-describedby`.

- [ ] **Step 4: Implement editor interactions and local draft state**

Expression edits render immediately from draft state and commit after 350 ms idle, Enter or blur. Axis label Escape restores the prior value. The native color input and preset swatches both update the row. All controls stop propagation so drawing never starts underneath them.

- [ ] **Step 5: Implement pointer drag and resize**

Convert screen deltas through board zoom. Clamp sizes and keep 48 logical pixels visible. Capture the pre-gesture graph at pointer down and emit one update at pointer up.

- [ ] **Step 6: Add Russian and Kazakh copy, run tests and commit**

Run: `cd frontend && npm test -- --run src/app/board/GraphElementView.test.tsx src/app/board/graphExpression.test.ts src/app/board/graphPlot.test.ts`
Expected: all pass.

```bash
git add frontend/src/app/board/GraphElementView.tsx frontend/src/app/board/GraphEditor.tsx frontend/src/app/board/GraphElementView.test.tsx frontend/src/i18n/locales/ru.json frontend/src/i18n/locales/kk.json
git commit -m "feat: render editable SVG graph elements"
```

### Task 5: Two-level board toolbar and local assets

**Files:**
- Create: `frontend/src/app/board/BoardToolbar.tsx`
- Create: `frontend/src/app/board/BoardToolOptions.tsx`
- Create: `frontend/src/assets/board-tools/pen.svg`
- Create: `frontend/src/assets/board-tools/line.svg`
- Create: `frontend/src/assets/board-tools/eraser.svg`
- Create: `frontend/src/assets/board-tools/graph.svg`
- Test: `frontend/src/app/board/BoardToolbar.test.tsx`
- Modify: `frontend/src/app/board/BoardCanvas.tsx`

**Interfaces:**
- Defines `BoardTool = "draw" | "line" | "pan" | "erase" | "graph"`.
- `BoardToolbar` receives active tool, board actions and state flags; it does not own board data.
- `BoardToolOptions` receives the active tool and emits pen, line, eraser, grid, background and input-mode changes.

- [ ] **Step 1: Add failing toolbar interaction tests**

Assert selecting `График` calls `onChangeTool("graph")`; pen options expose colors and thickness; eraser options expose size; utility actions call undo/redo/clear; all icon-only buttons have accessible names.

- [ ] **Step 2: Run the focused test and confirm missing-component failure**

Run: `cd frontend && npm test -- --run src/app/board/BoardToolbar.test.tsx`
Expected: FAIL because the toolbar components do not exist.

- [ ] **Step 3: Create four local SVG assets**

Use viewBox `0 0 64 64`, no embedded raster images, no hard-coded theme backgrounds, `fill="currentColor"`/`stroke="currentColor"`, and simple shapes readable at 32 px. Graph asset shows crossing axes and a curved function.

- [ ] **Step 4: Extract existing controls from `BoardCanvas`**

Move existing pen palette, line width, eraser size, grid/background, input mode, undo, redo, clear, snapshot and OCR actions into the two focused components. Keep clear-slide confirmation and disabled OCR behavior unchanged.

- [ ] **Step 5: Implement responsive floating layout**

Use a bottom-centered wrapper with a context row above the primary row. Give the primary row `overflow-x-auto`, fixed 44 px minimum targets and edge masks; switch secondary labels to visually hidden below 1280 px. Add canvas bottom padding equal to the measured toolbar height.

- [ ] **Step 6: Run tests and commit**

Run: `cd frontend && npm test -- --run src/app/board/BoardToolbar.test.tsx && npm run build`
Expected: test and build pass.

```bash
git add frontend/src/app/board/BoardToolbar.tsx frontend/src/app/board/BoardToolOptions.tsx frontend/src/app/board/BoardToolbar.test.tsx frontend/src/app/board/BoardCanvas.tsx frontend/src/assets/board-tools
git commit -m "feat: redesign board tool controls"
```

### Task 6: Application-wide light and dark themes

**Files:**
- Create: `frontend/src/app/theme/ThemeProvider.tsx`
- Test: `frontend/src/app/theme/ThemeProvider.test.tsx`
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/app/layout/TopBar.tsx`
- Modify: `frontend/src/app/styles/globals.css`
- Modify: `frontend/tailwind.config.ts`
- Modify: session screen components under `frontend/src/app/session/`

**Interfaces:**
- Produces `useTheme(): { theme: "dark" | "light"; setTheme(theme); toggleTheme() }`.
- Applies `data-theme` and `color-scheme` on `document.documentElement`.
- Reads and writes exactly `practice.appearance.theme`.

- [ ] **Step 1: Add failing provider tests**

Test default dark theme, stored light theme, toggle behavior, root attribute and storage persistence using an in-memory `localStorage` stub.

- [ ] **Step 2: Run the focused test and confirm missing-provider failure**

Run: `cd frontend && npm test -- --run src/app/theme/ThemeProvider.test.tsx`
Expected: FAIL because `ThemeProvider.tsx` does not exist.

- [ ] **Step 3: Implement provider and mount it above `I18nProvider`**

Keep theme state synchronous on first render to avoid a flash. Expose a two-button selector in the existing settings popover with Sun and Moon icons and accessible selected state.

- [ ] **Step 4: Define semantic CSS tokens for both themes**

Add variables for app background, board surface, card surface, raised surface, border, text, muted text, accent, accent text, danger and shadows. Update `.glass`, `.session-shell`, body background and toolbar/graph styles to use them. Extend Tailwind colors to reference CSS variables while keeping existing utility names compatible.

- [ ] **Step 5: Replace blocking hard-coded theme colors in route screens**

Update auth, room, grade, subject, history and resume screens plus TopBar so light theme has readable surfaces and no white-on-white text. Do not rewrite subject accent colors or user-selected board colors.

- [ ] **Step 6: Run tests and commit**

Run: `cd frontend && npm test -- --run src/app/theme/ThemeProvider.test.tsx src/app/session/flow.test.tsx src/app/AppRoot.test.tsx && npm run build`
Expected: all pass.

```bash
git add frontend/src/app/theme frontend/src/main.tsx frontend/src/app/layout/TopBar.tsx frontend/src/app/styles/globals.css frontend/tailwind.config.ts frontend/src/app/session
git commit -m "feat: add light and dark application themes"
```

### Task 7: Integrate graph placement and lesson restoration

**Files:**
- Modify: `frontend/src/app/board/BoardCanvas.tsx`
- Modify: `frontend/src/app/App.tsx`
- Modify: `frontend/src/app/board/replayApi.ts`
- Test: `frontend/src/app/board/BoardCanvas.test.tsx`
- Test: `frontend/src/app/board/replayApi.test.ts`

**Interfaces:**
- `App` loads operations and uses `replayBoardOperations` to produce `{strokes, graphs}`.
- `BoardCanvas` receives `initialDocument`, emits operations through the existing `onReplayOp`, and exposes the same stroke change callback temporarily for OCR compatibility.
- Graph placement emits `graph_add`; committed edits emit `graph_update`; deletion emits `graph_delete`; toolbar undo/redo/clear emit the existing generic operations.

- [ ] **Step 1: Add failing placement and replay API tests**

Select graph tool, pointer-down at a known transformed position and assert one default graph is added there and tool returns to draw. Load a server response containing stroke and graph operations and assert the reconstructed document. Verify the POST body preserves `before` and `after` payloads.

- [ ] **Step 2: Run focused tests and confirm failures against the current stroke-only integration**

Run: `cd frontend && npm test -- --run src/app/board/BoardCanvas.test.tsx src/app/board/replayApi.test.ts`
Expected: FAIL because graph placement and unified replay are absent.

- [ ] **Step 3: Add graph state and overlay to `BoardCanvas`**

Render graph elements in a world-transformed absolute SVG/HTML layer above the drawing canvas and below floating panels. A click in graph mode converts screen to world coordinates, clamps the default element and emits `graph_add`. Existing graph hit targets stop canvas drawing.

- [ ] **Step 4: Connect unified undo/redo/clear**

Make toolbar actions apply the same reducer operation locally before emitting it. Synchronize `strokesRef`, graph state and parent callbacks from the resulting document. Ensure OCR and snapshot still use the stroke canvas only.

- [ ] **Step 5: Replace the old App replay helper**

Delete the stroke-only `applyBoardReplayOps`; load server and local queued operations through `replayBoardOperations`, pass the reconstructed document into both rendered `BoardCanvas` instances, and keep client UUID assignment and flush-on-leave behavior.

- [ ] **Step 6: Run all frontend tests and commit**

Run: `cd frontend && npm test -- --run && npm run build`
Expected: all tests and the production build pass.

```bash
git add frontend/src/app/board/BoardCanvas.tsx frontend/src/app/board/BoardCanvas.test.tsx frontend/src/app/board/replayApi.ts frontend/src/app/board/replayApi.test.ts frontend/src/app/App.tsx
git commit -m "feat: integrate graphs with lesson board history"
```

### Task 8: Documentation and end-to-end verification

**Files:**
- Modify: `README.md`
- Modify: `backend/README.md`
- Modify: `docs/superpowers/specs/2026-09-15-interactive-board-graphs-design.md` only if verification exposes a factual mismatch

**Interfaces:**
- Documents graph syntax, themes, toolbar behavior, persistence and known first-version range limits.

- [ ] **Step 1: Document the visible workflow and supported syntax**

Add examples for polynomial, trigonometric, inverse trigonometric, hyperbolic, logarithmic and root functions. State that trig arguments use radians and arbitrary log bases use `ln(x)/ln(b)`.

- [ ] **Step 2: Run the complete verification script**

Run: `./scripts/test.sh`
Expected: every backend pytest, every frontend Vitest and the Vite production build exit successfully.

- [ ] **Step 3: Run a browser smoke test**

Verify registration/login, open or create a lesson, create two graph elements, add three differently colored functions, rename axes, drag, resize, undo, redo, reload, reopen history, toggle both themes, and inspect browser console for errors at 1024 and 1920 px widths.

- [ ] **Step 4: Inspect migration and repository state**

Run: `git diff --check`, verify a pre-v2 temporary database migration test is green, confirm runtime databases and generated `dist` remain ignored, and confirm the worktree is clean after the documentation commit.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md backend/README.md docs/superpowers/specs/2026-09-15-interactive-board-graphs-design.md
git commit -m "docs: explain interactive board graphs"
```
