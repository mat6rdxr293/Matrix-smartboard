import type { Point } from "./boardEngine";

/**
 * On-screen geometry tools in board (world) units. Their shape and snapping rules are mirrored in
 * NativeBoardView.java so Android can constrain the pen at touch-down without a JS round trip.
 */
export type GeometryTool =
  | { kind: "ruler"; x: number; y: number; angle: number }
  | { kind: "protractor"; x: number; y: number; angle: number }
  | { kind: "compass"; x: number; y: number; px: number; py: number };

export type StrokeConstraint =
  | { kind: "line"; ax: number; ay: number; bx: number; by: number }
  | { kind: "circle"; cx: number; cy: number; r: number };

/** One centimetre on the tools' scales. */
export const GEOMETRY_CM = 40;
export const RULER_LENGTH = 15 * GEOMETRY_CM;
export const RULER_WIDTH = 64;
export const PROTRACTOR_RADIUS = 220;
export const COMPASS_HANDLE_RADIUS = 22;
/** A stroke that starts this close to a ruler edge or the compass pencil is constrained. */
export const GEOMETRY_SNAP = 24;

export function createGeometryTool(kind: GeometryTool["kind"], center: Point): GeometryTool {
  if (kind === "compass") return { kind, x: center.x - 120, y: center.y, px: center.x + 120, py: center.y };
  return { kind, x: center.x, y: center.y, angle: 0 };
}

const rotate = (x: number, y: number, angle: number) => ({
  x: x * Math.cos(angle) - y * Math.sin(angle),
  y: x * Math.sin(angle) + y * Math.cos(angle),
});

/** Point in the tool's own frame: origin at its centre, x along its length. */
const toLocal = (tool: { x: number; y: number; angle: number }, p: Point) => rotate(p.x - tool.x, p.y - tool.y, -tool.angle);
const toWorld = (tool: { x: number; y: number; angle: number }, x: number, y: number) => {
  const r = rotate(x, y, tool.angle);
  return { x: tool.x + r.x, y: tool.y + r.y };
};

/** World position of the handle that rotates a ruler or protractor. */
export const rotateHandle = (tool: Extract<GeometryTool, { kind: "ruler" | "protractor" }>) =>
  tool.kind === "ruler" ? toWorld(tool, RULER_LENGTH / 2 + 34, 0) : toWorld(tool, 0, -PROTRACTOR_RADIUS - 30);

/** Midpoint of the compass legs: dragging it changes the radius, since the pencil itself draws. */
export const compassHinge = (tool: Extract<GeometryTool, { kind: "compass" }>) => ({
  x: (tool.x + tool.px) / 2,
  y: (tool.y + tool.py) / 2,
});

/** True when a touch should move or turn the tool rather than draw. */
export function hitsGeometryTool(tool: GeometryTool, p: Point): boolean {
  if (tool.kind === "compass") {
    const hinge = compassHinge(tool);
    return Math.hypot(p.x - tool.x, p.y - tool.y) <= COMPASS_HANDLE_RADIUS ||
      Math.hypot(p.x - hinge.x, p.y - hinge.y) <= COMPASS_HANDLE_RADIUS;
  }
  const handle = rotateHandle(tool);
  if (Math.hypot(p.x - handle.x, p.y - handle.y) <= COMPASS_HANDLE_RADIUS) return true;
  const local = toLocal(tool, p);
  if (tool.kind === "ruler") return Math.abs(local.x) <= RULER_LENGTH / 2 && Math.abs(local.y) <= RULER_WIDTH / 2;
  return local.y <= 0 && Math.hypot(local.x, local.y) <= PROTRACTOR_RADIUS;
}

/** The constraint for a stroke starting at `p`, or null when it should be drawn freely. */
export function constraintForStroke(tool: GeometryTool | null, p: Point): StrokeConstraint | null {
  if (!tool) return null;
  if (tool.kind === "compass") {
    if (Math.hypot(p.x - tool.px, p.y - tool.py) > GEOMETRY_SNAP * 1.5) return null;
    return { kind: "circle", cx: tool.x, cy: tool.y, r: Math.hypot(tool.px - tool.x, tool.py - tool.y) };
  }
  if (tool.kind !== "ruler") return null;
  const local = toLocal(tool, p);
  if (Math.abs(local.x) > RULER_LENGTH / 2 + GEOMETRY_SNAP) return null;
  const edge = local.y < 0 ? -RULER_WIDTH / 2 : RULER_WIDTH / 2;
  if (Math.abs(local.y - edge) > GEOMETRY_SNAP || Math.abs(local.y) < RULER_WIDTH / 2) return null;
  const a = toWorld(tool, -RULER_LENGTH / 2, edge);
  const b = toWorld(tool, RULER_LENGTH / 2, edge);
  return { kind: "line", ax: a.x, ay: a.y, bx: b.x, by: b.y };
}

export function applyConstraint(constraint: StrokeConstraint, p: Point): Point {
  if (constraint.kind === "circle") {
    const dx = p.x - constraint.cx;
    const dy = p.y - constraint.cy;
    const length = Math.hypot(dx, dy) || 1;
    return { x: constraint.cx + (dx / length) * constraint.r, y: constraint.cy + (dy / length) * constraint.r };
  }
  const dx = constraint.bx - constraint.ax;
  const dy = constraint.by - constraint.ay;
  const t = ((p.x - constraint.ax) * dx + (p.y - constraint.ay) * dy) / (dx * dx + dy * dy);
  return { x: constraint.ax + t * dx, y: constraint.ay + t * dy };
}

/** Rotations within this many degrees of a multiple of 15° settle on it. */
export const snapAngle = (angle: number) => {
  const step = Math.PI / 12;
  const nearest = Math.round(angle / step) * step;
  return Math.abs(angle - nearest) <= (3 * Math.PI) / 180 ? nearest : angle;
};
