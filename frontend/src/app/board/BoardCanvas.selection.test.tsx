// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import BoardCanvas from "./BoardCanvas";
import { drawStrokes } from "./boardEngine";

vi.mock("./boardEngine", async () => {
  const actual = await vi.importActual<typeof import("./boardEngine")>("./boardEngine");
  return { ...actual, drawStrokes: vi.fn() };
});

class ResizeObserverStub { observe() {} disconnect() {} }
const graph = {
  id: "g1", x: 20, y: 30, width: 420, height: 300,
  xLabel: "x", yLabel: "y", xMin: -10 as const, xMax: 10 as const,
  yMin: -10 as const, yMax: 10 as const,
  expressions: [{ id: "e1", expression: "x", color: "#4DA3FF", visible: true }],
};
beforeEach(() => {
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined,
    clear: () => undefined, key: () => null, length: 0 } as Storage;
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(16); return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => ({ save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), translate: vi.fn(),
      scale: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
      stroke: vi.fn(), arc: vi.fn(), setLineDash: vi.fn() })),
  });
});
afterEach(() => cleanup());

const board = (initialStrokes: any[] = [], onChangeStrokes = vi.fn()) => (
  <I18nProvider><BoardCanvas
    onOcrText={vi.fn()} ocrEnabled={false} expanded={false} onTogglePanels={vi.fn()} onStartTimer={vi.fn()}
    initialStrokes={initialStrokes} onChangeStrokes={onChangeStrokes} initialGraphs={[graph]} onChangeGraphs={vi.fn()}
    canUndo={false} canRedo={false} initialPenColor="#FF0000" onChangePenColor={vi.fn()}
    initialBgColor="#0A0E14" onChangeBgColor={vi.fn()} onReplayOp={vi.fn()}
  /></I18nProvider>
);
const mount = (initialStrokes: any[] = [], onChangeStrokes = vi.fn()) => render(board(initialStrokes, onChangeStrokes));
it("hides graph HUD and editor when the board is pressed outside graph UI", () => {
  const view = mount();
  fireEvent.pointerDown(screen.getByTestId("graph-element-g1"), { pointerId: 1, pointerType: "mouse" });
  expect(screen.getByRole("button", { name: /удалить график|графикті өшіру/i })).toBeInTheDocument();

  const input = screen.getByRole("textbox", { name: /функц|function/i });
  fireEvent.focus(input);
  expect(screen.getByRole("group", { name: /математическая клавиатура|математикалық пернетақта/i })).toBeInTheDocument();

  const canvas = view.container.querySelector("canvas");
  fireEvent.pointerDown(canvas!, { pointerId: 2, pointerType: "mouse", clientX: 800, clientY: 600 });
  expect(screen.queryByRole("button", { name: /удалить график|графикті өшіру/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: /функц|function/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: /математическая клавиатура|математикалық пернетақта/i })).not.toBeInTheDocument();
});

it("keeps graph HUD open when pressing its editor or keyboard", () => {
  mount();
  fireEvent.pointerDown(screen.getByTestId("graph-element-g1"), { pointerId: 3, pointerType: "mouse" });
  const input = screen.getByRole("textbox", { name: /функц|function/i });
  fireEvent.focus(input);
  fireEvent.pointerDown(screen.getByRole("button", { name: "sin" }), { pointerId: 4, pointerType: "mouse" });
  expect(screen.getByRole("button", { name: /удалить график|графикті өшіру/i })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: /функц|function/i })).toBeInTheDocument();
});

it("hides graph UI when pressing elsewhere in the application, not only the canvas", () => {
  mount();
  fireEvent.pointerDown(screen.getByTestId("graph-element-g1"), { pointerId: 5, pointerType: "mouse" });
  expect(screen.getByRole("button", { name: /удалить график|графикті өшіру/i })).toBeInTheDocument();

  fireEvent.pointerDown(document.body, { pointerId: 6, pointerType: "mouse" });
  expect(screen.queryByRole("button", { name: /удалить график|графикті өшіру/i })).not.toBeInTheDocument();
});

it("lets pan mode drag the board even when the gesture starts over a graph", () => {
  const view = mount();
  const graphElement = screen.getByTestId("graph-element-g1");
  const graphOverlay = graphElement.parentElement as HTMLDivElement;
  fireEvent.click(screen.getByRole("button", { name: /перемещение|жылжыту/i }));

  expect(graphElement).toHaveClass("pointer-events-none");
  const canvas = view.container.querySelector("canvas")!;
  fireEvent.pointerDown(canvas, { pointerId: 20, pointerType: "mouse", clientX: 100, clientY: 100 });
  fireEvent.pointerMove(canvas, { pointerId: 20, pointerType: "mouse", clientX: 160, clientY: 135 });
  fireEvent.pointerUp(canvas, { pointerId: 20, pointerType: "mouse", clientX: 160, clientY: 135 });

  expect(graphOverlay.style.transform).toContain("translate(60px, 35px)");
});

it("renders the latest pan on canvas when an older animation frame was already queued", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  const view = mount();
  while (frames.length) frames.shift()!(100);
  vi.mocked(drawStrokes).mockClear();

  fireEvent.click(screen.getByRole("button", { name: /перемещение|жылжыту/i }));
  const canvas = view.container.querySelector("canvas")!;
  fireEvent.pointerDown(canvas, { pointerId: 30, pointerType: "mouse", clientX: 100, clientY: 100 });
  fireEvent.pointerMove(canvas, { pointerId: 30, pointerType: "mouse", clientX: 160, clientY: 135 });
  fireEvent.pointerUp(canvas, { pointerId: 30, pointerType: "mouse", clientX: 160, clientY: 135 });

  expect(frames.length).toBeGreaterThan(0);
  while (frames.length) frames.shift()!(220);
  expect(vi.mocked(drawStrokes)).toHaveBeenLastCalledWith(
    expect.anything(), expect.any(Array), expect.objectContaining({ pan: { x: 60, y: 35 } }),
  );
});

it("redraws persisted handwriting when the browser tab becomes visible again", () => {
  const stroke = { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], color: "#fff", width: 2, mode: "draw" as const };
  mount([stroke]);
  vi.mocked(drawStrokes).mockClear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });

  document.dispatchEvent(new Event("visibilitychange"));

  expect(vi.mocked(drawStrokes)).toHaveBeenLastCalledWith(
    expect.anything(), [stroke], expect.any(Object),
  );
});


it("rehydrates server handwriting even when the parent callback identity changes", () => {
  const stroke = { points: [{ x: 10, y: 20 }, { x: 30, y: 40 }], color: "#fff", width: 3, mode: "draw" as const };
  const view = mount([], vi.fn());
  vi.mocked(drawStrokes).mockClear();

  view.rerender(board([stroke], vi.fn()));

  expect(vi.mocked(drawStrokes)).toHaveBeenLastCalledWith(
    expect.anything(), [stroke], expect.any(Object),
  );
});


it("renders toolbar settings outside the horizontally scrolling toolbar", () => {
  mount();
  const toolbar = screen.getByTestId("board-toolbar");

  const cases: Array<[RegExp, string]> = [
    [/ручка|қалам/i, "pen"],
    [/линия|сызық/i, "line"],
    [/ластик|өшіргіш/i, "eraser"],
    [/^доска$|^тақта$/i, "board"],
    [/очистить доску|тақтаны тазарту/i, "clear"],
  ];

  for (const [buttonName, popoverName] of cases) {
    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    const popover = screen.getByTestId(`board-toolbar-popover-${popoverName}`);
    expect(toolbar).not.toContainElement(popover);
    expect(popover.parentElement).toBe(document.body);
  }
});

it("auto-hides the board toolbar after inactivity and reveals it at the bottom edge", () => {
  vi.useFakeTimers();
  try {
    mount();
    const root = screen.getByTestId("board-canvas-root");
    const toolbar = screen.getByTestId("board-toolbar");
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    });

    expect(toolbar).toHaveAttribute("data-visible", "true");
    act(() => vi.advanceTimersByTime(2600));
    expect(toolbar).toHaveAttribute("data-visible", "false");

    fireEvent.pointerMove(root, { pointerId: 90, pointerType: "mouse", clientY: 585 });
    expect(toolbar).toHaveAttribute("data-visible", "true");
  } finally {
    vi.useRealTimers();
  }
});

it("restarts toolbar auto-hide when a tool changes and keeps it visible while settings are open", () => {
  vi.useFakeTimers();
  try {
    mount();
    const toolbar = screen.getByTestId("board-toolbar");

    act(() => vi.advanceTimersByTime(2000));
    fireEvent.click(screen.getByRole("button", { name: /график/i }));
    act(() => vi.advanceTimersByTime(1000));
    expect(toolbar).toHaveAttribute("data-visible", "true");
    act(() => vi.advanceTimersByTime(1600));
    expect(toolbar).toHaveAttribute("data-visible", "false");

    fireEvent.pointerMove(screen.getByTestId("board-canvas-root"), { pointerId: 91, pointerType: "mouse", clientY: 0 });
    fireEvent.click(screen.getByRole("button", { name: /ручка|қалам/i }));
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.getByTestId("board-toolbar-popover-pen")).toBeInTheDocument();
    expect(toolbar).toHaveAttribute("data-visible", "true");
  } finally {
    vi.useRealTimers();
  }
});

it("overlays the toolbar at the bottom without reserving a bottom chin", () => {
  mount();
  expect(screen.getByTestId("board-canvas-root")).toHaveClass("pb-0");
  expect(screen.getByTestId("board-toolbar")).toHaveClass("absolute", "bottom-0");
});

it("uses a bottom-edge tap only to reveal a hidden toolbar, without drawing", () => {
  vi.useFakeTimers();
  try {
    const onChangeStrokes = vi.fn();
    const view = mount([], onChangeStrokes);
    const root = screen.getByTestId("board-canvas-root");
    const toolbar = screen.getByTestId("board-toolbar");
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    });
    act(() => vi.advanceTimersByTime(2600));
    onChangeStrokes.mockClear();

    const canvas = view.container.querySelector("canvas")!;
    fireEvent.pointerDown(canvas, { pointerId: 92, pointerType: "touch", clientX: 500, clientY: 590 });
    fireEvent.pointerUp(canvas, { pointerId: 92, pointerType: "touch", clientX: 500, clientY: 590 });

    expect(toolbar).toHaveAttribute("data-visible", "true");
    expect(onChangeStrokes).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
