import { describe, expect, it } from "vitest";
import { getGraphDockPlacement } from "./graphDock";

const visible = { left: 0, top: 0, right: 1000, bottom: 700 };

describe("getGraphDockPlacement", () => {
  it("docks to the right when there is room", () => {
    const result = getGraphDockPlacement({ x: 80, y: 90, width: 420, height: 300 }, visible, 320, 360);
    expect(result.side).toBe("right");
    expect(result.left).toBe(432);
    expect(result.top).toBe(0);
  });

  it("flips to the left near the right edge", () => {
    const result = getGraphDockPlacement({ x: 520, y: 90, width: 420, height: 300 }, visible, 320, 360);
    expect(result.side).toBe("left");
    expect(result.left).toBe(-332);
  });

  it("falls below the graph when neither side fits", () => {
    const narrow = { left: 0, top: 0, right: 700, bottom: 900 };
    const result = getGraphDockPlacement({ x: 140, y: 80, width: 420, height: 300 }, narrow, 500, 320);
    expect(result.side).toBe("bottom");
    expect(result.top).toBe(312);
  });
});
