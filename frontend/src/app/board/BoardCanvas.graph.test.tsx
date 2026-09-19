// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import BoardCanvas from "./BoardCanvas";

vi.mock("./boardEngine", async () => {
  const actual = await vi.importActual<typeof import("./boardEngine")>("./boardEngine");
  return { ...actual, drawStrokes: vi.fn() };
});

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

const storage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
  key: () => null,
  length: 0,
} as Storage;
afterEach(() => cleanup());

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(16);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => ({
      save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), translate: vi.fn(), scale: vi.fn(),
      clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(),
      setLineDash: vi.fn(),
    })),
  });
});

describe("BoardCanvas graph tool", () => {
  it("creates one graph at the board click and returns to the pen", () => {
    const onReplayOp = vi.fn();
    const view = render(
      <I18nProvider>
        <BoardCanvas
          onOcrText={vi.fn()} ocrEnabled={false} expanded={false}
          onTogglePanels={vi.fn()} onStartTimer={vi.fn()}
          initialStrokes={[]} onChangeStrokes={vi.fn()}
          initialGraphs={[]} onChangeGraphs={vi.fn()} canUndo={false} canRedo={false}
          initialPenColor="#FF0000" onChangePenColor={vi.fn()}
          initialBgColor="#0A0E14" onChangeBgColor={vi.fn()}
          onReplayOp={onReplayOp}
          boardProfile="analytical"
        />
      </I18nProvider>,
    );

    const graphButton = screen.getByRole("button", { name: /график|график құралы/i });
    fireEvent.click(graphButton);
    const canvas = view.container.querySelector("canvas");
    expect(canvas).not.toBeNull();
    fireEvent.pointerDown(canvas!, { pointerId: 1, pointerType: "mouse", clientX: 210, clientY: 160 });

    const graphAdds = onReplayOp.mock.calls.filter(([op]) => op.op === "graph_add");
    expect(graphAdds).toHaveLength(1);
    expect(graphAdds[0][0].graph).toMatchObject({ width: 420, height: 300, xLabel: "x", yLabel: "y" });
    fireEvent.pointerDown(canvas!, { pointerId: 2, pointerType: "mouse", clientX: 260, clientY: 190 });
    expect(onReplayOp.mock.calls.filter(([op]) => op.op === "graph_add")).toHaveLength(1);
  });
});

describe("BoardCanvas mixed clear", () => {
  it("records clear before synchronizing strokes and graphs", () => {
    const events: string[] = [];
    const stroke = {
      points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], color: "#fff", width: 2, mode: "draw" as const,
    };
    const graph = {
      id: "g1", x: 0, y: 0, width: 420, height: 300,
      xLabel: "x", yLabel: "y", xMin: -10 as const, xMax: 10 as const,
      yMin: -10 as const, yMax: 10 as const,
      expressions: [{ id: "e1", expression: "x", color: "#4DA3FF", visible: true }],
    };

    render(
      <I18nProvider>
        <BoardCanvas
          onOcrText={vi.fn()} ocrEnabled={false} expanded={false}
          onTogglePanels={vi.fn()} onStartTimer={vi.fn()}
          initialStrokes={[stroke]} onChangeStrokes={() => events.push("strokes")}
          initialGraphs={[graph]} onChangeGraphs={() => events.push("graphs")}
          canUndo={true} canRedo={false}
          initialPenColor="#FF0000" onChangePenColor={vi.fn()}
          initialBgColor="#0A0E14" onChangeBgColor={vi.fn()}
          onReplayOp={(op) => events.push(`op:${op.op}`)}
          boardProfile="analytical"
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /очистить доску|тақтаны тазарту/i }));
    fireEvent.change(screen.getByRole("slider", { name: /сдвиньте|слайдерді/i }), {
      target: { value: "100" },
    });

    expect(events.slice(0, 3)).toEqual(["op:clear", "graphs", "strokes"]);
  });
});
