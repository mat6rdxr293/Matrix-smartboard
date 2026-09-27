import { describe, expect, it } from "vitest";
import { extractSafeHandwritingSteps, normalizeHandwritingText } from "./aiHandwriting";

describe("normalizeHandwritingText", () => {
  it("converts common school LaTeX into board-friendly unicode", () => {
    expect(normalizeHandwritingText("$$x^2 = \\frac{4}{2} \\pm \\sqrt{9}$$"))
      .toBe("x² = (4)/(2) ± √(9)");
  });

  it("preserves fractional radical integral limits for math layout", () => {
    expect(
      normalizeHandwritingText(
        String.raw`$$\int_{-\sqrt{\pi}}^{\frac{4\sqrt{\pi}}{11}} \sqrt{x+1} \, dx$$`,
      ),
    ).toBe("∫₍-√(π)₎⁽(4√(π))/(11)⁾ √(x+1) dx");
  });

  it("preserves math layout markers for integrals, roots and inequalities", () => {
    expect(
      normalizeHandwritingText(
        "$$\\int_{0}^{4} \\sqrt{x+1} \\le 7,\\quad y \\ge 2$$",
      ),
    ).toBe("∫₍0₎⁴ √(x+1) ≤ 7, y ≥ 2");
  });

  it("normalizes tends-to notation to a real arrow", () => {
    expect(normalizeHandwritingText("x \\to 0")).toBe("x → 0");
    expect(normalizeHandwritingText("x -> 0")).toBe("x → 0");
    expect(normalizeHandwritingText("x arrow 0")).toBe("x → 0");
  });

  it("renders approximation commands as mathematical symbols", () => {
    expect(normalizeHandwritingText("x \\approx 1.41")).toBe("x ≈ 1.41");
    expect(normalizeHandwritingText("a \\simeq b")).toBe("a ≃ b");
    expect(normalizeHandwritingText("x \\sim y")).toBe("x ∼ y");
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

it("removes unexpected CJK text from Russian board solutions", () => {
  const steps = extractSafeHandwritingSteps(
    [{ text: "Уравнение не имеет 实数根.", kind: "result" }],
    "",
    "ru",
  );
  expect(steps).toEqual([{ text: "Уравнение не имеет.", kind: "result" }]);
});

it("removes inline LaTeX delimiters before handwriting", () => {
  expect(normalizeHandwritingText("\\(5x^2 - 4x + 5 = 0\\)"))
    .toBe("5x² - 4x + 5 = 0");
});
