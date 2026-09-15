// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import BoardCanvas from "./BoardCanvas";

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

const mount = () => render(
  <I18nProvider><BoardCanvas
    onOcrText={vi.fn()} ocrEnabled={false} expanded={false} onTogglePanels={vi.fn()} onStartTimer={vi.fn()}
    initialStrokes={[]} onChangeStrokes={vi.fn()} initialGraphs={[graph]} onChangeGraphs={vi.fn()}
    canUndo={false} canRedo={false} initialPenColor="#FF0000" onChangePenColor={vi.fn()}
    initialBgColor="#0A0E14" onChangeBgColor={vi.fn()} onReplayOp={vi.fn()}
  /></I18nProvider>
);
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
