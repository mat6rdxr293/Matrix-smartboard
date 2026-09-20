// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import MathText from "./MathText";

afterEach(() => cleanup());

describe("MathText", () => {
  it("renders markdown emphasis instead of raw markers", () => {
    render(<MathText text={"**Первая ошибка:** не обнаружена. *Важно*"} />);
    expect(screen.getByText("Первая ошибка:").tagName).toBe("STRONG");
    expect(screen.getByText("Важно").tagName).toBe("EM");
    expect(screen.queryByText("**Первая ошибка:**")).not.toBeInTheDocument();
  });

  it("supports parenthesis and bracket LaTeX delimiters", () => {
    const { container } = render(<MathText text={"График: \\(y=x^2\\)\\n\\[x=2\\]"} />);
    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.textContent).not.toContain("\\(");
    expect(container.textContent).not.toContain("\\[");
  });
});
