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
