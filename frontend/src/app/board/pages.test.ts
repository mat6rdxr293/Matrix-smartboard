import { describe, expect, it } from "vitest";
import type { Stroke } from "./boardEngine";
import { PAGE_HEIGHT, pageCount, pageInView, pageOfStroke, panForPage, strokesOnPage } from "./pages";

const stroke = (y: number, mode: Stroke["mode"] = "draw"): Stroke => ({
  points: [{ x: 10, y }, { x: 50, y: y + 20 }],
  color: "#FFFFFF",
  width: 3,
  mode,
});

describe("board pages", () => {
  it("assigns strokes to the page that holds their middle", () => {
    expect(pageOfStroke(stroke(100))).toBe(0);
    expect(pageOfStroke(stroke(PAGE_HEIGHT + 5))).toBe(1);
    expect(pageOfStroke(stroke(PAGE_HEIGHT - 5))).toBe(1); // centre lies just past the border
    expect(pageOfStroke(stroke(-200))).toBe(0);
  });

  it("filters the document to one page", () => {
    const strokes = [stroke(100), stroke(PAGE_HEIGHT * 2 + 40), stroke(300)];
    expect(strokesOnPage(strokes, 0)).toEqual([strokes[0], strokes[2]]);
    expect(strokesOnPage(strokes, 1)).toEqual([]);
  });

  it("counts pages up to the last ink and the page in view", () => {
    expect(pageCount([], 0)).toBe(1);
    expect(pageCount([stroke(PAGE_HEIGHT * 2 + 40)], 0)).toBe(3);
    expect(pageCount([stroke(100)], 3)).toBe(4);
    expect(pageCount([stroke(PAGE_HEIGHT * 4, "erase")], 0)).toBe(1);
  });

  it("round-trips between a page and the pan that shows it", () => {
    for (const zoom of [0.5, 1, 2]) {
      const pan = panForPage(2, zoom, { x: 30, y: 0 });
      expect(pan.x).toBe(30);
      expect(pageInView(pan, zoom, 600)).toBe(2);
    }
  });
});
