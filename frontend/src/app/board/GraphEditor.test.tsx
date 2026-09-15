// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import GraphEditor from "./GraphEditor";
import type { GraphElement } from "./boardDocument";

const graph: GraphElement = {
  id: "g1", x: 10, y: 10, width: 420, height: 300,
  xLabel: "x", yLabel: "y", xMin: -10, xMax: 10, yMin: -10, yMax: 10,
  expressions: [{ id: "e1", expression: "x", color: "#4DA3FF", visible: true }],
};

const mount = (onPreview = vi.fn(), onCommit = vi.fn()) =>
  render(<I18nProvider><GraphEditor graph={graph} onPreview={onPreview} onCommit={onCommit} /></I18nProvider>);

afterEach(() => cleanup());

beforeEach(() => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as Storage;
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
});

describe("GraphEditor", () => {
  it("keeps an invalid expression editable and shows an inline error", () => {
    mount();
    const input = screen.getByRole("textbox", { name: /функц|function/i });
    fireEvent.change(input, { target: { value: "evil(x)" } });
    expect(input).toHaveValue("evil(x)");
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("can add functions up to the eight-function limit", () => {
    const onCommit = vi.fn();
    mount(vi.fn(), onCommit);
    const add = screen.getByRole("button", { name: /добавить функцию|функция қосу|add function/i });
    for (let index = 0; index < 7; index += 1) fireEvent.click(add);
    expect(onCommit).toHaveBeenCalledTimes(7);
    const lastAfter = onCommit.mock.calls[onCommit.mock.calls.length - 1]?.[1] as GraphElement;
    expect(lastAfter.expressions).toHaveLength(8);
    expect(add).toBeDisabled();
  });
});

// Parent echoes previews immediately so the plotted curve can update while typing.
it("keeps the pre-edit state when a preview is echoed back before debounce commit", () => {
  vi.useFakeTimers();
  const onCommit = vi.fn();
  let view: ReturnType<typeof render>;
  const onPreview = vi.fn((next: GraphElement) => {
    view.rerender(<I18nProvider><GraphEditor graph={next} onPreview={onPreview} onCommit={onCommit} /></I18nProvider>);
  });
  view = render(<I18nProvider><GraphEditor graph={graph} onPreview={onPreview} onCommit={onCommit} /></I18nProvider>);
  const input = screen.getByRole("textbox", { name: /функц|function/i });
  fireEvent.change(input, { target: { value: "x^2" } });
  vi.advanceTimersByTime(500);
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect((onCommit.mock.calls[0][0] as GraphElement).expressions[0].expression).toBe("x");
  expect((onCommit.mock.calls[0][1] as GraphElement).expressions[0].expression).toBe("x^2");
  vi.useRealTimers();
});

it("enters a function using only the on-screen math keyboard", () => {
  const onCommit = vi.fn();
  mount(vi.fn(), onCommit);
  const input = screen.getByRole("textbox", { name: /функц|function/i });

  fireEvent.focus(input);
  expect(screen.getByRole("group", { name: /математическая клавиатура|математикалық пернетақта/i })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /очистить выражение|өрнекті тазарту/i }));
  fireEvent.click(screen.getByRole("button", { name: "sin" }));
  expect(input).toHaveValue("sin()");
  expect((input as HTMLInputElement).selectionStart).toBe(4);
  fireEvent.click(screen.getByRole("button", { name: "x" }));

  expect(input).toHaveValue("sin(x)");
  fireEvent.click(screen.getByRole("button", { name: /готово|дайын/i }));
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect((onCommit.mock.calls[0][1] as GraphElement).expressions[0].expression).toBe("sin(x)");
});

it("uses opaque touch keys for the math keyboard", () => {
  mount();
  const input = screen.getByRole("textbox", { name: /функц|function/i });
  fireEvent.focus(input);
  const sin = screen.getByRole("button", { name: "sin" });
  expect(sin.className).toContain("bg-[#151b24]");
  expect(sin.className).not.toContain("bg-white/5");
});
