import { describe, expect, it } from "vitest";
import { normalizeHandwritingText } from "./aiHandwriting";

describe("normalizeHandwritingText", () => {
  it("converts common school LaTeX into board-friendly unicode", () => {
    expect(normalizeHandwritingText("$$x^2 = \\frac{4}{2} \\pm \\sqrt{9}$$"))
      .toBe("x² = (4)/(2) ± √(9)");
  });

  it("keeps Cyrillic explanations readable", () => {
    expect(normalizeHandwritingText("Переносим **4** вправо"))
      .toBe("Переносим 4 вправо");
  });
});
