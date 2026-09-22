import { describe, expect, it } from "vitest";
import { extractSafeHandwritingSteps, normalizeHandwritingText } from "./aiHandwriting";

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

it("extracts text fields from malformed JSON-like AI output instead of drawing metadata", () => {
  const raw =
    '"summary" "Решение", "steps" ["text" "$$x^2-4=0$$", "kind" "math", "text" "$$x=\\pm2$$", "kind" "result"]';

  expect(extractSafeHandwritingSteps([{ text: raw, kind: "text" }], raw)).toEqual([
    { text: "$$x^2-4=0$$", kind: "text" },
    { text: "$$x=\\pm2$$", kind: "text" },
  ]);
});

it("refuses to draw structured metadata when no text field can be recovered", () => {
  const raw = '{"summary":"broken","steps":[{"kind":"math"}]}';
  expect(extractSafeHandwritingSteps([{ text: raw, kind: "text" }], raw)).toEqual([]);
});
