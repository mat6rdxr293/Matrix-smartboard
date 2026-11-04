import { describe, expect, it } from "vitest";
import {
  GEOMETRY_SNAP,
  RULER_LENGTH,
  RULER_WIDTH,
  applyConstraint,
  constraintForStroke,
  createGeometryTool,
  hitsGeometryTool,
  rotateHandle,
  snapAngle,
  type GeometryTool,
} from "./geometry";

const ruler: GeometryTool = { kind: "ruler", x: 500, y: 300, angle: 0 };

describe("geometry tools", () => {
  it("constrains strokes that start just outside a ruler edge", () => {
    const below = constraintForStroke(ruler, { x: 520, y: 300 + RULER_WIDTH / 2 + 10 });
    expect(below).toMatchObject({ kind: "line", ay: 300 + RULER_WIDTH / 2, by: 300 + RULER_WIDTH / 2 });
    expect(applyConstraint(below!, { x: 610, y: 371 })).toEqual({ x: 610, y: 300 + RULER_WIDTH / 2 });
    expect(constraintForStroke(ruler, { x: 520, y: 300 - RULER_WIDTH / 2 - 5 })).toMatchObject({ ay: 300 - RULER_WIDTH / 2 });
  });

  it("leaves strokes far from the ruler, past its ends, or on its body alone", () => {
    expect(constraintForStroke(ruler, { x: 520, y: 300 + RULER_WIDTH / 2 + GEOMETRY_SNAP + 5 })).toBeNull();
    expect(constraintForStroke(ruler, { x: 500 + RULER_LENGTH, y: 340 })).toBeNull();
    expect(constraintForStroke(ruler, { x: 520, y: 300 })).toBeNull();
    expect(constraintForStroke(null, { x: 0, y: 0 })).toBeNull();
  });

  it("follows a rotated ruler", () => {
    const tilted: GeometryTool = { ...ruler, angle: Math.PI / 4 };
    const c = constraintForStroke(tilted, { x: 500 - 30, y: 300 + 30 });
    expect(c?.kind).toBe("line");
    const p = applyConstraint(c!, { x: 700, y: 520 });
    // Projected points stay on a 45° line.
    expect(Math.abs((p.y - (c as { ay: number }).ay) - (p.x - (c as { ax: number }).ax))).toBeLessThan(1e-9);
  });

  it("turns strokes started at the compass pencil into arcs of its radius", () => {
    const compass = createGeometryTool("compass", { x: 400, y: 400 });
    if (compass.kind !== "compass") throw new Error("unexpected tool");
    const c = constraintForStroke(compass, { x: compass.px + 5, y: compass.py - 5 });
    expect(c).toEqual({ kind: "circle", cx: 280, cy: 400, r: 240 });
    const p = applyConstraint(c!, { x: 280, y: 100 });
    expect(p.x).toBeCloseTo(280);
    expect(p.y).toBeCloseTo(160);
    expect(constraintForStroke(compass, { x: 400, y: 600 })).toBeNull();
  });

  it("knows which touches grab a tool", () => {
    expect(hitsGeometryTool(ruler, { x: 500, y: 300 })).toBe(true);
    expect(hitsGeometryTool(ruler, rotateHandle(ruler as Extract<GeometryTool, { kind: "ruler" }>))).toBe(true);
    expect(hitsGeometryTool(ruler, { x: 500, y: 300 + RULER_WIDTH })).toBe(false);
    const compass = createGeometryTool("compass", { x: 400, y: 400 });
    if (compass.kind !== "compass") throw new Error("unexpected tool");
    expect(hitsGeometryTool(compass, { x: 400, y: 400 })).toBe(true); // hinge halfway along the legs
    expect(hitsGeometryTool(compass, { x: compass.px, y: compass.py })).toBe(false); // the pencil draws
    const protractor: GeometryTool = { kind: "protractor", x: 300, y: 300, angle: 0 };
    expect(hitsGeometryTool(protractor, { x: 300, y: 200 })).toBe(true);
    expect(hitsGeometryTool(protractor, { x: 300, y: 320 })).toBe(false);
  });

  it("settles rotations near multiples of 15 degrees", () => {
    expect(snapAngle((44 * Math.PI) / 180)).toBeCloseTo(Math.PI / 4);
    expect(snapAngle((40 * Math.PI) / 180)).toBeCloseTo((40 * Math.PI) / 180);
  });
});
