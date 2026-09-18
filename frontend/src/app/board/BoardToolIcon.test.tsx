// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import BoardToolIcon from "./BoardToolIcon";

afterEach(() => cleanup());

describe("BoardToolIcon", () => {
  it.each(["pen", "line", "eraser", "graph"] as const)("renders the local %s asset", (tool) => {
    render(<BoardToolIcon tool={tool} />);
    const icon = screen.getByTestId(`board-tool-icon-${tool}`);
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon.getAttribute("style")).toContain(`${tool}.svg`);
  });
});
