// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import StructuredMathEditor from "./StructuredMathEditor";

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

afterEach(() => cleanup());

describe("StructuredMathEditor", () => {
  it("renders valid LaTeX with KaTeX and lets the user edit the upper integral limit directly", () => {
    const onChange = vi.fn();
    const formula = String.raw`\int_{1}^{\sqrt{3}} (x^3 + \frac{2x^2}{3})\,dx`;

    const { container } = render(
      <I18nProvider>
        <StructuredMathEditor value={formula} onChange={onChange} />
      </I18nProvider>,
    );

    expect(container.querySelector(".katex")).toBeInTheDocument();
    const upper = container.querySelector<HTMLElement>('[data-edit-id="edit-1"]');
    expect(upper).toBeInTheDocument();

    fireEvent.click(upper!);
    const input = screen.getByRole("textbox", { name: /верхний предел интеграла|интегралдың жоғарғы шегі/i });
    expect(input).toHaveValue(String.raw`\sqrt{3}`);
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: /применить|қолдану/i }));

    expect(onChange).toHaveBeenCalledWith(
      String.raw`\int_{1}^{4} (x^3 + \frac{2x^2}{3})\,dx`,
    );
  });

  it("turns a bare exponent into a braced exponent when editing it", () => {
    const onChange = vi.fn();
    const { container } = render(
      <I18nProvider>
        <StructuredMathEditor value="x^3 + 1" onChange={onChange} />
      </I18nProvider>,
    );

    const exponent = container.querySelector<HTMLElement>('[data-edit-id="edit-0"]');
    expect(exponent).toBeInTheDocument();
    fireEvent.click(exponent!);

    const input = screen.getByRole("textbox", { name: /степень|дәреже/i });
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("x^{12} + 1");
  });

  it("falls back to raw text editing when LaTeX is invalid", () => {
    const onChange = vi.fn();
    render(
      <I18nProvider>
        <StructuredMathEditor value={String.raw`\frac{1{`} onChange={onChange} />
      </I18nProvider>,
    );

    const raw = screen.getByRole("textbox", { name: /распознано с доски|тақтадан танылған/i });
    expect(raw).toHaveValue(String.raw`\frac{1{`);
    fireEvent.change(raw, { target: { value: "x + 1" } });
    expect(onChange).toHaveBeenCalledWith("x + 1");
  });
});
