import type { Point } from "./boardEngine";

/** Holding the pen this still, this long, snaps the stroke to a clean shape. */
export const SHAPE_HOLD_MS = 500;
/** Movement below this many board units still counts as holding still. */
export const SHAPE_HOLD_TOLERANCE = 6;

export type ShapeKind = "line" | "circle" | "ellipse" | "triangle" | "rectangle" | "quadrilateral";
export type RecognizedShape = { kind: ShapeKind; points: Point[] };

const MIN_SIZE = 24;
const LINE_DEVIATION = 0.06;
const CLOSED_GAP = 0.22;
const POLYGON_DEVIATION = 0.06;
const ELLIPSE_ERROR = 0.12;
const CIRCLE_RATIO = 0.85;
const RIGHT_ANGLE_SLACK = 15;
const AXIS_SLACK = 10;
const DENSIFY_STEP = 4;

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

const pathLength = (points: Point[]) => {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += dist(points[i - 1], points[i]);
  return length;
};

const distanceToSegment = (p: Point, a: Point, b: Point) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/** Ramer-Douglas-Peucker on an open polyline. */
const simplify = (points: Point[], epsilon: number): Point[] => {
  if (points.length < 3) return points;
  let index = 0;
  let maxDistance = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = distanceToSegment(points[i], points[0], points[points.length - 1]);
    if (d > maxDistance) {
      maxDistance = d;
      index = i;
    }
  }
  if (maxDistance <= epsilon) return [points[0], points[points.length - 1]];
  const left = simplify(points.slice(0, index + 1), epsilon);
  const right = simplify(points.slice(index), epsilon);
  return [...left.slice(0, -1), ...right];
};

/** Evenly spaced points keep erasing, lasso and OCR working on a snapped shape. */
const densify = (vertices: Point[]): Point[] => {
  const out: Point[] = [{ ...vertices[0] }];
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1];
    const b = vertices[i];
    const steps = Math.max(1, Math.ceil(dist(a, b) / DENSIFY_STEP));
    for (let s = 1; s <= steps; s++) out.push({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps });
  }
  return out;
};

const maxDeviationFromPolygon = (points: Point[], vertices: Point[]) => {
  let worst = 0;
  for (const p of points) {
    let best = Infinity;
    for (let i = 1; i < vertices.length; i++) best = Math.min(best, distanceToSegment(p, vertices[i - 1], vertices[i]));
    worst = Math.max(worst, best);
  }
  return worst;
};

const angleAt = (prev: Point, at: Point, next: Point) => {
  const a = Math.atan2(prev.y - at.y, prev.x - at.x);
  const b = Math.atan2(next.y - at.y, next.x - at.x);
  let degrees = Math.abs(((a - b) * 180) / Math.PI) % 360;
  if (degrees > 180) degrees = 360 - degrees;
  return degrees;
};

/** Corners of a closed stroke, starting from the point farthest from the centroid so RDP has a real corner as anchor. */
const closedCorners = (points: Point[], epsilon: number): Point[] => {
  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  let start = 0;
  for (let i = 1; i < points.length; i++) {
    if (Math.hypot(points[i].x - cx, points[i].y - cy) > Math.hypot(points[start].x - cx, points[start].y - cy)) start = i;
  }
  const rotated = [...points.slice(start), ...points.slice(0, start), points[start]];
  const simplified = simplify(rotated, epsilon);
  const corners = simplified.slice(0, -1);
  // Drop near-straight joints that RDP keeps on wobbly sides.
  return corners.filter((corner, i) => {
    const prev = corners[(i - 1 + corners.length) % corners.length];
    const next = corners[(i + 1) % corners.length];
    return angleAt(prev, corner, next) < 160;
  });
};

const snapRectangle = (corners: Point[]): { kind: ShapeKind; vertices: Point[] } => {
  const rightAngles = corners.every((corner, i) => {
    const prev = corners[(i + 3) % 4];
    const next = corners[(i + 1) % 4];
    return Math.abs(angleAt(prev, corner, next) - 90) <= RIGHT_ANGLE_SLACK;
  });
  if (!rightAngles) return { kind: "quadrilateral", vertices: corners };
  const edge = Math.atan2(corners[1].y - corners[0].y, corners[1].x - corners[0].x) * (180 / Math.PI);
  const offAxis = Math.abs(((edge % 90) + 90) % 90);
  if (Math.min(offAxis, 90 - offAxis) <= AXIS_SLACK) {
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    return {
      kind: "rectangle",
      vertices: [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }],
    };
  }
  // A tilted rectangle: keep the first edge's direction and square up the rest.
  const ux = (corners[1].x - corners[0].x) / dist(corners[0], corners[1]);
  const uy = (corners[1].y - corners[0].y) / dist(corners[0], corners[1]);
  const width = (dist(corners[0], corners[1]) + dist(corners[2], corners[3])) / 2;
  const height = (dist(corners[1], corners[2]) + dist(corners[3], corners[0])) / 2;
  const side = Math.sign((corners[2].x - corners[1].x) * -uy + (corners[2].y - corners[1].y) * ux) || 1;
  const vx = -uy * side;
  const vy = ux * side;
  const o = corners[0];
  return {
    kind: "rectangle",
    vertices: [
      { x: o.x, y: o.y },
      { x: o.x + ux * width, y: o.y + uy * width },
      { x: o.x + ux * width + vx * height, y: o.y + uy * width + vy * height },
      { x: o.x + vx * height, y: o.y + vy * height },
    ],
  };
};

const fitEllipse = (points: Point[]): RecognizedShape | null => {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  let rx = (Math.max(...xs) - Math.min(...xs)) / 2;
  let ry = (Math.max(...ys) - Math.min(...ys)) / 2;
  if (rx <= 0 || ry <= 0) return null;
  const error = points.reduce((sum, p) => sum + Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1), 0) / points.length;
  if (error > ELLIPSE_ERROR) return null;
  const isCircle = Math.min(rx, ry) / Math.max(rx, ry) >= CIRCLE_RATIO;
  if (isCircle) rx = ry = (rx + ry) / 2;
  const steps = Math.max(24, Math.ceil((2 * Math.PI * Math.max(rx, ry)) / DENSIFY_STEP));
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    out.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return { kind: isCircle ? "circle" : "ellipse", points: out };
};

/** Returns a clean version of a hand-drawn shape, or null when the stroke should stay as drawn. */
export function recognizeShape(points: Point[]): RecognizedShape | null {
  if (points.length < 8) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const size = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (size < MIN_SIZE) return null;

  const first = points[0];
  const last = points[points.length - 1];
  const chord = dist(first, last);

  // Compared with the bounding box, not path length: pen jitter inflates length on a straight line.
  if (chord >= size * 0.8) {
    const deviation = Math.max(...points.map((p) => distanceToSegment(p, first, last)));
    return deviation <= chord * LINE_DEVIATION ? { kind: "line", points: densify([first, last]) } : null;
  }
  if (chord > size * CLOSED_GAP || pathLength(points) < size * 2) return null;

  const corners = closedCorners(points, size * POLYGON_DEVIATION);
  if (corners.length === 3 || corners.length === 4) {
    const polygon = corners.length === 4 ? snapRectangle(corners) : { kind: "triangle" as const, vertices: corners };
    const closed = [...polygon.vertices, polygon.vertices[0]];
    if (maxDeviationFromPolygon(points, closed) <= size * POLYGON_DEVIATION * 1.5) {
      return { kind: polygon.kind, points: densify(closed) };
    }
  }
  return fitEllipse(points);
}
