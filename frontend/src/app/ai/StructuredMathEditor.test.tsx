// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
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

function Harness({
  initial,
  onValue,
}: {
  initial: string;
  onValue?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <I18nProvider>
      <StructuredMathEditor
        value={value}
        onChange={(next) => {
          setValue(next);
          onValue?.(next);
        }}
      />
    </I18nProvider>
  );
}

describe("StructuredMathEditor visual keyboard", () => {
  it("edits an integral upper limit without opening the system keyboard", () => {
    const values: string[] = [];
    const formula = String.raw`\int_{1}^{\sqrt{3}} (x^3 + \frac{2x^2}{3})\,dx`;
    const { container } = render(<Harness initial={formula} onValue={(value) => values.push(value)} />);

    expect(screen.getByTestId("math-keyboard")).toBeInTheDocument();
    expect(container.querySelector(".katex")).toBeInTheDocument();

    const upper = container.querySelector<HTMLElement>('[data-edit-id="edit-1"]');
    expect(upper).toBeInTheDocument();
    fireEvent.pointerDown(upper!, { clientX: 0, clientY: 0 });

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText(/верхний предел интеграла/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /очистить/i }));
    fireEvent.click(screen.getByRole("button", { name: "4" }));

    expect(values.at(-1)).toBe(String.raw`\int_{1}^{4} (x^3 + \frac{2x^2}{3})\,dx`);
  });

  it("creates a power template and immediately edits the exponent", () => {
    const values: string[] = [];
    render(<Harness initial="x" onValue={(value) => values.push(value)} />);

    fireEvent.click(screen.getByRole("button", { name: /структуры/i }));
    fireEvent.click(screen.getByRole("button", { name: "xⁿ" }));
    expect(screen.getByText(/^Степень$/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /основная/i }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));

    expect(values.at(-1)).toBe("x^{2}");
  });

  it("builds a bounded integral by moving through structural fields", () => {
    const values: string[] = [];
    render(<Harness initial="" onValue={(value) => values.push(value)} />);

    fireEvent.click(screen.getByRole("button", { name: /структуры/i }));
    fireEvent.click(screen.getByRole("button", { name: "∫ₐᵇ" }));
    expect(screen.getByText(/нижний предел интеграла/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /основная/i }));
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    fireEvent.click(screen.getByRole("button", { name: /далее/i }));
    expect(screen.getByText(/верхний предел интеграла/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "3" }));
    fireEvent.click(screen.getByRole("button", { name: /далее/i }));
    expect(screen.getByText(/подынтегральное выражение/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "x" }));
    expect(values.at(-1)).toBe(String.raw`\int_{1}^{3} {x}\,dx`);
  });

  it("builds a fraction by switching from numerator to denominator", () => {
    const values: string[] = [];
    render(<Harness initial="" onValue={(value) => values.push(value)} />);

    fireEvent.click(screen.getByRole("button", { name: /структуры/i }));
    fireEvent.click(screen.getByRole("button", { name: "a⁄b" }));
    expect(screen.getByText(/числитель/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /основная/i }));
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    fireEvent.click(screen.getByRole("button", { name: /далее/i }));
    expect(screen.getByText(/знаменатель/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(values.at(-1)).toBe(String.raw`\frac{1}{2}`);
  });

  it("creates a function with an editable argument", () => {
    const values: string[] = [];
    render(<Harness initial="" onValue={(value) => values.push(value)} />);

    fireEvent.click(screen.getByRole("button", { name: /функции/i }));
    fireEvent.click(screen.getByRole("button", { name: "sin" }));
    expect(screen.getByText(/аргумент функции/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /основная/i }));
    fireEvent.click(screen.getByRole("button", { name: "x" }));
    expect(values.at(-1)).toBe(String.raw`\sin\left({x}\right)`);
  });

  it("moves the caret through ordinary symbols with the arrow buttons", () => {
    const values: string[] = [];
    render(<Harness initial="x+2" onValue={(value) => values.push(value)} />);

    fireEvent.click(screen.getByRole("button", { name: /предыдущая позиция/i }));
    fireEvent.click(screen.getByRole("button", { name: "y" }));

    expect(values.at(-1)).toBe("x+y2");

    fireEvent.click(screen.getByRole("button", { name: /следующая позиция/i }));
    fireEvent.click(screen.getByRole("button", { name: "z" }));

    expect(values.at(-1)).toBe("x+y2z");
  });

  it("places the caret by tapping either half of an ordinary rendered symbol", () => {
    const values: string[] = [];
    const { container } = render(<Harness initial="x+2" onValue={(value) => values.push(value)} />);

    const plus = container.querySelector<HTMLElement>('[data-cursor-before="1"][data-cursor-after="2"]');
    expect(plus).toBeInTheDocument();
    Object.defineProperty(plus!, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 100,
        right: 120,
        top: 10,
        bottom: 30,
        width: 20,
        height: 20,
        x: 100,
        y: 10,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(plus!, { clientX: 101, clientY: 20 });
    fireEvent.click(screen.getByRole("button", { name: "y" }));
    expect(values.at(-1)).toBe("xy+2");
  });

  it("keeps a distinct caret position after a bare exponent", () => {
    const values: string[] = [];
    render(<Harness initial="x^3" onValue={(value) => values.push(value)} />);

    fireEvent.click(screen.getByRole("button", { name: "+" }));
    expect(values.at(-1)).toBe("x^3+");
  });

  it("normalizes a bare exponent before editing inside it", () => {
    const values: string[] = [];
    const { container } = render(<Harness initial="x^3" onValue={(value) => values.push(value)} />);

    const exponent = container.querySelector<HTMLElement>('[data-edit-id="edit-0"]');
    expect(exponent).toBeInTheDocument();
    fireEvent.pointerDown(exponent!, { clientX: 0, clientY: 0 });
    fireEvent.click(screen.getByRole("button", { name: "2" }));

    expect(values.at(-1)).toBe("x^{23}");
  });

  it("keeps raw LaTeX only as an advanced fallback", () => {
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
