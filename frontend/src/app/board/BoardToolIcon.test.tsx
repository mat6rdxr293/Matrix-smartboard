// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import BoardToolIcon from "./BoardToolIcon";

afterEach(() => cleanup());

describe("BoardToolIcon", () => {
  it.each(["pen", "line", "eraser", "graph"] as const)("renders visible inline %s artwork", (tool) => {
    render(<BoardToolIcon tool={tool} />);
    const icon = screen.getByTestId(`board-tool-icon-${tool}`);
    expect(icon.tagName).toBe("svg");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).not.toHaveAttribute("src");
    expect(icon).not.toHaveAttribute("data-parallax-art");
    expect(icon.querySelector("filter")).not.toBeInTheDocument();
    expect(icon.querySelectorAll("path, rect, circle, line, polyline").length).toBeGreaterThan(2);
    expect(icon).toHaveClass("h-16", "w-16");
    expect(icon.parentElement).toHaveAttribute("data-tool-artwork", tool);
    expect(icon.parentElement).toHaveClass("board-tool-art", "h-16", "w-16");
  });
});
