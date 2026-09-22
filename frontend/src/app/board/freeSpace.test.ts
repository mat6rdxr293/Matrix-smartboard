import { describe, expect, it } from "vitest";
import { findFreeBoardSpace, type BoardRect } from "./freeSpace";

const viewport: BoardRect = { left: 0, top: 0, right: 1200, bottom: 800 };

describe("findFreeBoardSpace", () => {
  it("finds a visible rectangle without overlap", () => {
    const occupied = [
      { left: 0, top: 0, right: 520, bottom: 620 },
      { left: 760, top: 80, right: 1180, bottom: 420 },
    ];
    const result = findFreeBoardSpace(viewport, occupied, 360, 260, 16);
    expect(result.insideViewport).toBe(true);
    const rect = { left: result.x, top: result.y, right: result.x + result.width, bottom: result.y + result.height };
    for (const item of occupied) {
      expect(rect.left >= item.right || rect.right <= item.left || rect.top >= item.bottom || rect.bottom <= item.top).toBe(true);
    }
  });

  it("allocates outside viewport when the visible area is dense", () => {
    const occupied = [{ left: -100, top: -100, right: 1400, bottom: 1000 }];
    const result = findFreeBoardSpace(viewport, occupied, 500, 320, 24);
    expect(result.insideViewport).toBe(false);
    expect(result.y).toBeGreaterThan(viewport.bottom);
  });
});
