// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import GraphElementView from "./GraphElementView";
import type { GraphElement } from "./boardDocument";

const graph: GraphElement = {
  id: "g1", x: 20, y: 30, width: 420, height: 300,
  xLabel: "x", yLabel: "y", xMin: -10, xMax: 10, yMin: -10, yMax: 10,
  expressions: [{ id: "e1", expression: "x^2", color: "#4DA3FF", visible: true }],
};

const props = {
  graph,
  selected: true,
  backgroundColor: "#0A0E14",
  isDarkBackground: true,
  zoom: 1,
  visibleWorld: { left: 0, top: 0, right: 1000, bottom: 700 },
  onSelect: vi.fn(),
  onPreview: vi.fn(),
  onCommit: vi.fn(),
  onDelete: vi.fn(),
};

beforeEach(() => {
  class PointerEventStub extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: PointerEventStub });
  Object.defineProperty(globalThis, "PointerEvent", { configurable: true, value: PointerEventStub });
  const values = new Map<string, string>();
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear(), key: () => null, get length() { return values.size; } } as Storage;
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
});
afterEach(() => cleanup());

describe("GraphElementView", () => {
  it("renders the plotted curve and axis labels", () => {
    render(<I18nProvider><GraphElementView {...props} selected={false} /></I18nProvider>);
    const path = screen.getByTestId("graph-curve-e1");
    expect(path.getAttribute("d")).toMatch(/^M/);
    expect(screen.getByTestId("graph-x-label")).toHaveTextContent("x");
    expect(screen.getByTestId("graph-y-label")).toHaveTextContent("y");
    expect(screen.queryByRole("button", { name: /удалить график|графикті өшіру/i })).not.toBeInTheDocument();
  });

  it("shows selected controls and commits an inline axis label edit", () => {
    const onCommit = vi.fn();
    render(<I18nProvider><GraphElementView {...props} onCommit={onCommit} /></I18nProvider>);
    expect(screen.getByRole("button", { name: /удалить график|графикті өшіру/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /изменить размер графика|график өлшемін өзгерту/i })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("graph-x-label"));
    const input = screen.getByRole("textbox", { name: /подпись оси x|x осінің атауы/i });
    fireEvent.change(input, { target: { value: "t, с" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect((onCommit.mock.calls[0][1] as GraphElement).xLabel).toBe("t, с");
  });
});

it("edits an axis label using the on-screen text keyboard", () => {
  const onCommit = vi.fn();
  render(<I18nProvider><GraphElementView {...props} onCommit={onCommit} /></I18nProvider>);

  fireEvent.click(screen.getByTestId("graph-x-label"));
  expect(screen.getByRole("group", { name: /экранная клавиатура|экрандық пернетақта/i })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /очистить подпись|таңбаны тазарту/i }));
  fireEvent.click(screen.getByRole("button", { name: "v" }));
  fireEvent.click(screen.getByRole("button", { name: "comma" }));
  fireEvent.click(screen.getByRole("button", { name: "space" }));
  fireEvent.click(screen.getByRole("button", { name: /кириллица|кириллица/i }));
  fireEvent.click(screen.getByRole("button", { name: "м" }));
  fireEvent.click(screen.getByRole("button", { name: "slash" }));
  fireEvent.click(screen.getByRole("button", { name: "с" }));
  fireEvent.click(screen.getByRole("button", { name: /готово|дайын/i }));

  expect(onCommit).toHaveBeenCalledTimes(1);
  expect((onCommit.mock.calls[0][1] as GraphElement).xLabel).toBe("v, м/с");
});

it("docks the editor beside the graph instead of covering it", () => {
  render(<I18nProvider><GraphElementView {...props} /></I18nProvider>);
  const dock = screen.getByTestId("graph-dock-panel");
  expect(dock).toHaveAttribute("data-side", "right");
  expect(dock).toHaveStyle({ left: "432px" });

  fireEvent.click(screen.getByTestId("graph-x-label"));
  expect(screen.getByRole("group", { name: /экранная клавиатура|экрандық пернетақта/i })).toBeInTheDocument();
  expect(screen.getByTestId("graph-dock-panel")).toHaveAttribute("data-side", "right");
});

it("uses compositor transform for graph movement and avoids blur on the drag bar", () => {
  render(<I18nProvider><GraphElementView {...props} /></I18nProvider>);
  expect(screen.getByTestId("graph-element-g1")).toHaveStyle({ transform: "translate3d(20px, 30px, 0)" });
  expect(screen.getByLabelText(/перемещение|жылжыту/i).className).not.toContain("backdrop-blur");
});

it("keeps the side dock top aligned with a lower graph", () => {
  render(<I18nProvider><GraphElementView {...props} graph={{ ...graph, y: 200 }} /></I18nProvider>);
  const dock = screen.getByTestId("graph-dock-panel");
  expect(dock).toHaveAttribute("data-side", "right");
  expect(dock).toHaveStyle({ top: "0px" });
});

it("zooms the mathematical viewport around the wheel pointer and commits once", () => {
  vi.useFakeTimers();
  const onPreview = vi.fn();
  const onCommit = vi.fn();
  render(<I18nProvider><GraphElementView {...props} onPreview={onPreview} onCommit={onCommit} /></I18nProvider>);
  const plot = screen.getByTestId("graph-plot");
  vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 420, height: 300, right: 420, bottom: 300, x: 0, y: 0, toJSON: () => ({}),
  });

  fireEvent.wheel(plot, { deltaY: -120, clientX: 315, clientY: 75 });
  const next = onPreview.mock.calls[0][0] as GraphElement;
  expect(next.xMax - next.xMin).toBeLessThan(20);
  expect(next.xMin + 0.75 * (next.xMax - next.xMin)).toBeCloseTo(5, 5);
  expect(next.yMax - 0.25 * (next.yMax - next.yMin)).toBeCloseTo(5, 5);
  expect(onCommit).not.toHaveBeenCalled();
  vi.advanceTimersByTime(300);
  expect(onCommit).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

it("supports pinch zoom and commits when the gesture ends", () => {
  const onPreview = vi.fn();
  const onCommit = vi.fn();
  render(<I18nProvider><GraphElementView {...props} onPreview={onPreview} onCommit={onCommit} /></I18nProvider>);
  const plot = screen.getByTestId("graph-plot");
  vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 420, height: 300, right: 420, bottom: 300, x: 0, y: 0, toJSON: () => ({}),
  });

  fireEvent.pointerDown(plot, { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 150 });
  fireEvent.pointerDown(plot, { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 150 });
  fireEvent.pointerMove(plot, { pointerId: 2, pointerType: "touch", clientX: 350, clientY: 150 });
  expect(onPreview).toHaveBeenCalled();
  fireEvent.pointerUp(plot, { pointerId: 2, pointerType: "touch", clientX: 350, clientY: 150 });
  expect(onCommit).toHaveBeenCalledTimes(1);
});

it("shows zoom controls and resets the graph viewport", () => {
  const onCommit = vi.fn();
  const zoomed = { ...graph, xMin: -5, xMax: 5, yMin: -5, yMax: 5 };
  render(<I18nProvider><GraphElementView {...props} graph={zoomed} onCommit={onCommit} /></I18nProvider>);
  expect(screen.getByTestId("graph-zoom-in")).toBeInTheDocument();
  expect(screen.getByTestId("graph-zoom-out")).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("graph-zoom-reset"));
  const next = onCommit.mock.calls[0][1] as GraphElement;
  expect([next.xMin, next.xMax, next.yMin, next.yMax]).toEqual([-10, 10, -10, 10]);
});


it("pans inside the graph with a mouse drag and commits once", () => {
  const onPreview = vi.fn();
  const onCommit = vi.fn();
  render(<I18nProvider><GraphElementView {...props} onPreview={onPreview} onCommit={onCommit} /></I18nProvider>);
  const plot = screen.getByTestId("graph-plot");
  vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 420, height: 300, right: 420, bottom: 300, x: 0, y: 0, toJSON: () => ({}),
  });

  fireEvent.pointerDown(plot, { pointerId: 7, pointerType: "mouse", clientX: 210, clientY: 150, button: 0 });
  fireEvent.pointerMove(plot, { pointerId: 7, pointerType: "mouse", clientX: 252, clientY: 180, buttons: 1 });
  const next = onPreview.mock.calls[onPreview.mock.calls.length - 1][0] as GraphElement;
  expect([next.xMin, next.xMax, next.yMin, next.yMax]).toEqual([-12, 8, -8, 12]);
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.pointerUp(plot, { pointerId: 7, pointerType: "mouse", clientX: 252, clientY: 180 });
  expect(onCommit).toHaveBeenCalledTimes(1);
});

it("pans inside the graph with one touch", () => {
  const onPreview = vi.fn();
  const onCommit = vi.fn();
  render(<I18nProvider><GraphElementView {...props} onPreview={onPreview} onCommit={onCommit} /></I18nProvider>);
  const plot = screen.getByTestId("graph-plot");
  vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 420, height: 300, right: 420, bottom: 300, x: 0, y: 0, toJSON: () => ({}),
  });

  fireEvent.pointerDown(plot, { pointerId: 1, pointerType: "touch", clientX: 210, clientY: 150 });
  fireEvent.pointerMove(plot, { pointerId: 1, pointerType: "touch", clientX: 168, clientY: 120 });
  const next = onPreview.mock.calls[onPreview.mock.calls.length - 1][0] as GraphElement;
  expect([next.xMin, next.xMax, next.yMin, next.yMax]).toEqual([-8, 12, -12, 8]);
  fireEvent.pointerUp(plot, { pointerId: 1, pointerType: "touch", clientX: 168, clientY: 120 });
  expect(onCommit).toHaveBeenCalledTimes(1);
});

it("pans while pinch zooming when the gesture center moves", () => {
  const onPreview = vi.fn();
  const onCommit = vi.fn();
  render(<I18nProvider><GraphElementView {...props} onPreview={onPreview} onCommit={onCommit} /></I18nProvider>);
  const plot = screen.getByTestId("graph-plot");
  vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 420, height: 300, right: 420, bottom: 300, x: 0, y: 0, toJSON: () => ({}),
  });

  fireEvent.pointerDown(plot, { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 150 });
  fireEvent.pointerDown(plot, { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 150 });
  fireEvent.pointerMove(plot, { pointerId: 1, pointerType: "touch", clientX: 120, clientY: 180 });
  fireEvent.pointerMove(plot, { pointerId: 2, pointerType: "touch", clientX: 360, clientY: 180 });
  const next = onPreview.mock.calls[onPreview.mock.calls.length - 1][0] as GraphElement;
  expect(next.xMax - next.xMin).toBeLessThan(20);
  expect((next.xMin + next.xMax) / 2).toBeLessThan(0);
  expect((next.yMin + next.yMax) / 2).toBeGreaterThan(0);
  fireEvent.pointerUp(plot, { pointerId: 2, pointerType: "touch", clientX: 360, clientY: 180 });
  expect(onCommit).toHaveBeenCalledTimes(1);
});
