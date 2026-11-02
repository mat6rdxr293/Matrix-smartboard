import { describe, expect, it } from "vitest";
import { encodeNativeStroke, nativeStrokeChunks } from "./nativeBoard";
import type { Stroke } from "./boardEngine";

const stroke = (x: number): Stroke => ({
  points: [{ x, y: 2.5 }, { x: x + 1, y: -3 }],
  color: "#FF0000",
  width: 4,
  mode: "draw",
});

describe("native board stroke encoding", () => {
  it("packs points as little-endian Float32 pairs", () => {
    const { p, c, w, e } = encodeNativeStroke(stroke(1));
    const bytes = Uint8Array.from(atob(p), (char) => char.charCodeAt(0));
    expect(Array.from(new Float32Array(bytes.buffer))).toEqual([1, 2.5, 2, -3]);
    expect({ c, w, e }).toEqual({ c: "#FF0000", w: 4, e: false });
  });

  it("marks the first and last chunks of a document", () => {
    const chunks = nativeStrokeChunks(Array.from({ length: 450 }, (_, i) => stroke(i)), 7);
    expect(chunks.map((chunk) => [chunk.strokes.length, chunk.first, chunk.last])).toEqual([
      [200, true, false],
      [200, false, false],
      [50, false, true],
    ]);
    expect(chunks.every((chunk) => chunk.revision === 7)).toBe(true);
  });

  it("still sends one chunk for an empty document", () => {
    expect(nativeStrokeChunks([], 1)).toEqual([{ revision: 1, first: true, last: true, strokes: [] }]);
  });
});
