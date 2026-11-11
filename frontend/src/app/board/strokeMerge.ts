import type { Stroke } from "@/app/board/boardEngine";

// The server keeps at most this many points in one stroke.
const MAX_POINTS_PER_STROKE = 5000;

const sameLook = (a: Stroke, b: Stroke) =>
  a.color === b.color && a.width === b.width && a.mode === b.mode && a.source === b.source;

/**
 * Joins strokes that continue one another (the next starts where the previous ends) into one.
 *
 * Handwriting traced from a glyph skeleton comes out as thousands of two-point pieces: one AI
 * solution reached 25 000 strokes and 4.7 MB, over what the server accepts in one operation,
 * and the board's sync queue stalled on it. Joined, the same writing is a few thousand strokes
 * and looks the same: the gap closed is at most `tolerance` board units, under a stroke width.
 */
export function mergeContiguousStrokes(strokes: Stroke[], tolerance = 1.5): Stroke[] {
  const merged: Stroke[] = [];
  for (const stroke of strokes) {
    const previous = merged[merged.length - 1];
    const end = previous?.points[previous.points.length - 1];
    const start = stroke.points[0];
    if (
      previous &&
      end &&
      start &&
      sameLook(previous, stroke) &&
      Math.hypot(start.x - end.x, start.y - end.y) <= tolerance &&
      previous.points.length + stroke.points.length <= MAX_POINTS_PER_STROKE
    ) {
      merged[merged.length - 1] = { ...previous, points: [...previous.points, ...stroke.points] };
    } else {
      merged.push(stroke);
    }
  }
  return merged;
}
