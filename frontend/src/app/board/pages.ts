import type { Point, Stroke } from "./boardEngine";

/**
 * Pages are bands of the one board document, stacked downwards in world units. Keeping a
 * single document leaves history, replay, sync and the native renderer untouched; a page
 * only decides where the view sits and what "the board" means for recognition.
 */
export const PAGE_HEIGHT = 1080;

export const pageAt = (worldY: number) => Math.max(0, Math.floor(worldY / PAGE_HEIGHT));

const centerY = (points: Point[]) => {
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.y < min) min = p.y;
    if (p.y > max) max = p.y;
  }
  return (min + max) / 2;
};

/** A stroke belongs to the page holding the middle of its bounding box. */
export const pageOfStroke = (stroke: Stroke) => (stroke.points.length ? pageAt(centerY(stroke.points)) : 0);

export const strokesOnPage = (strokes: Stroke[], page: number) => strokes.filter((stroke) => pageOfStroke(stroke) === page);

/** Pages up to the last one with ink, and never fewer than the page in view. */
export const pageCount = (strokes: Stroke[], currentPage: number) =>
  Math.max(currentPage + 1, ...strokes.filter((stroke) => stroke.mode === "draw").map((stroke) => pageOfStroke(stroke) + 1), 1);

/** The page whose band holds the middle of the view. */
export const pageInView = (pan: { x: number; y: number }, zoom: number, viewHeight: number) =>
  pageAt((viewHeight / 2 - pan.y) / zoom);

/** Pan that puts the top of `page` at the top of the view, keeping horizontal position and zoom. */
export const panForPage = (page: number, zoom: number, pan: { x: number; y: number }) => ({
  x: pan.x,
  y: -page * PAGE_HEIGHT * zoom,
});
