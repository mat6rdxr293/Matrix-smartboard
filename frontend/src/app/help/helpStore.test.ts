// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

describe("help and the Android back button", () => {
  it("closes help on back, and lets back through when help is closed", async () => {
    const { openHelp } = await import("./helpStore");
    openHelp("teacher");
    expect(window.__matrixBack?.()).toBe(true);
    expect(window.__matrixBack?.()).toBe(false);
  });
});
