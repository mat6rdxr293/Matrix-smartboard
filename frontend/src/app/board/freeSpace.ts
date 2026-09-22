export type BoardRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type Placement = {
  x: number;
  y: number;
  width: number;
  height: number;
  insideViewport: boolean;
};

const overlaps = (a: BoardRect, b: BoardRect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

const expand = (rect: BoardRect, padding: number): BoardRect => ({
  left: rect.left - padding,
  top: rect.top - padding,
  right: rect.right + padding,
  bottom: rect.bottom + padding,
});

const rectAt = (x: number, y: number, width: number, height: number): BoardRect => ({
  left: x,
  top: y,
  right: x + width,
  bottom: y + height,
});

const fitsInside = (rect: BoardRect, viewport: BoardRect) =>
  rect.left >= viewport.left &&
  rect.top >= viewport.top &&
  rect.right <= viewport.right &&
  rect.bottom <= viewport.bottom;

export function findFreeBoardSpace(
  viewport: BoardRect,
  occupied: BoardRect[],
  width = 500,
  height = 320,
  padding = 24,
): Placement {
  const safeWidth = Math.max(280, width);
  const safeHeight = Math.max(180, height);
  const padded = occupied.map((rect) => expand(rect, padding));
  const step = 32;

  const candidates: Array<{ x: number; y: number }> = [];
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const key = `${Math.round(x * 10)}:${Math.round(y * 10)}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ x, y });
  };
  const seen = new Set<string>();

  const minX = viewport.left + padding;
  const minY = viewport.top + padding;
  const maxX = viewport.right - safeWidth - padding;
  const maxY = viewport.bottom - safeHeight - padding;

  if (maxX >= minX && maxY >= minY) {
    for (let y = minY; y <= maxY + 0.1; y += step) {
      for (let x = minX; x <= maxX + 0.1; x += step) add(x, y);
    }
    add(maxX, minY);
    add(minX, maxY);
    add(maxX, maxY);
  }

  for (const rect of padded) {
    add(rect.right, rect.top);
    add(rect.left - safeWidth, rect.top);
    add(rect.left, rect.bottom);
    add(rect.left, rect.top - safeHeight);
  }

  const centerX = (viewport.left + viewport.right) / 2;
  const centerY = (viewport.top + viewport.bottom) / 2;

  const valid = candidates
    .map((candidate) => {
      const rect = rectAt(candidate.x, candidate.y, safeWidth, safeHeight);
      if (!fitsInside(rect, viewport)) return null;
      if (padded.some((item) => overlaps(rect, item))) return null;
      const rectCenterX = candidate.x + safeWidth / 2;
      const rectCenterY = candidate.y + safeHeight / 2;
      const centerDistance = Math.hypot(rectCenterX - centerX, rectCenterY - centerY);
      const lowerRightBias = Math.max(0, centerX - rectCenterX) * 0.06 + Math.max(0, centerY - rectCenterY) * 0.04;
      return { ...candidate, score: centerDistance + lowerRightBias };
    })
    .filter((item): item is { x: number; y: number; score: number } => Boolean(item))
    .sort((a, b) => a.score - b.score || a.y - b.y || a.x - b.x);

  if (valid.length) {
    return { x: valid[0].x, y: valid[0].y, width: safeWidth, height: safeHeight, insideViewport: true };
  }

  const contentRight = padded.length ? Math.max(...padded.map((rect) => rect.right)) : viewport.right;
  const contentBottom = padded.length ? Math.max(...padded.map((rect) => rect.bottom)) : viewport.bottom;
  const x = Math.max(viewport.left + padding, Math.min(contentRight + padding, viewport.right + padding));
  const y = Math.max(viewport.top + padding, contentBottom + padding);
  return { x, y, width: safeWidth, height: safeHeight, insideViewport: false };
}
