import { describe, expect, it } from "vitest";
import { pickAiInkColor } from "./aiInkColor";

describe("pickAiInkColor", () => {
  it("does not reuse the student's blue for a hint", () => {
    expect(pickAiInkColor({
      mode: "hint",
      studentColor: "#2563EB",
      boardBgColor: "#FFFFFF",
    })).not.toBe("#2563EB");
  });

  it("uses a green-family color for a correct check on light board", () => {
    expect(["#15803D", "#0F766E", "#1D4ED8"]).toContain(
      pickAiInkColor({
        mode: "check",
        studentColor: "#FF0000",
        boardBgColor: "#FFFFFF",
        checkCorrect: true,
      }),
    );
  });

  it("uses a bright error palette on dark board", () => {
    expect(["#FBBF24", "#FB7185", "#C084FC"]).toContain(
      pickAiInkColor({
        mode: "check",
        studentColor: "#4ADE80",
        boardBgColor: "#0A0E14",
        checkCorrect: false,
      }),
    );
  });
});
