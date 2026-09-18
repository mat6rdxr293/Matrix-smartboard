// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme } from "./ThemeProvider";

function ThemeProbe() {
  const { theme, setTheme, toggleTheme } = useTheme();

  return (
    <div>
      <output aria-label="current theme">{theme}</output>
      <button onClick={toggleTheme}>toggle</button>
      <button onClick={() => setTheme("light")}>light</button>
    </div>
  );
}

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } as Storage;
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createStorage(),
    });
  });

  afterEach(() => cleanup());

  it("starts in dark theme and applies it to the root element", () => {
    render(<ThemeProvider><ThemeProbe /></ThemeProvider>);

    expect(screen.getByLabelText("current theme")).toHaveTextContent("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("restores a saved light theme before rendering children", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createStorage({ "practice.appearance.theme": "light" }),
    });

    render(<ThemeProvider><ThemeProbe /></ThemeProvider>);

    expect(screen.getByLabelText("current theme")).toHaveTextContent("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("persists explicit and toggled theme changes", () => {
    render(<ThemeProvider><ThemeProbe /></ThemeProvider>);

    fireEvent.click(screen.getByRole("button", { name: "light" }));
    expect(window.localStorage.getItem("practice.appearance.theme")).toBe("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");

    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    expect(window.localStorage.getItem("practice.appearance.theme")).toBe("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });
});
