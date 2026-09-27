import { describe, expect, it } from "vitest";
import { findFreeBoardSpace, findFreeBoardSpaceNearTarget, type BoardRect } from "./freeSpace";

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


describe("findFreeBoardSpaceNearTarget", () => {
  it("prefers the space directly beside the target", () => {
    const target = { left: 100, top: 120, right: 360, bottom: 250 };
    const result = findFreeBoardSpaceNearTarget(
      viewport,
      [target],
      target,
      360,
      220,
      36,
      12,
    );
    expect(result).not.toBeNull();
    expect(result?.x).toBe(396);
    expect(result?.y).toBe(120);
    expect(result?.insideViewport).toBe(true);
  });

  it("falls below when the right side is occupied", () => {
    const target = { left: 100, top: 120, right: 360, bottom: 250 };
    const blocker = { left: 380, top: 80, right: 900, bottom: 420 };
    const result = findFreeBoardSpaceNearTarget(
      viewport,
      [target, blocker],
      target,
      360,
      220,
      36,
      12,
    );
    expect(result).not.toBeNull();
    const rect = {
      left: result!.x,
      top: result!.y,
      right: result!.x + result!.width,
      bottom: result!.y + result!.height,
    };
    const overlapsBlocker =
      rect.left < blocker.right &&
      rect.right > blocker.left &&
      rect.top < blocker.bottom &&
      rect.bottom > blocker.top;
    const overlapsTarget =
      rect.left < target.right &&
      rect.right > target.left &&
      rect.top < target.bottom &&
      rect.bottom > target.top;
    expect(overlapsBlocker).toBe(false);
    expect(overlapsTarget).toBe(false);
  });
});
