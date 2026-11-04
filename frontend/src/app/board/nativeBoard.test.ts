import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  disableNativeBoardAutomatically,
  encodeNativeStroke,
  nativeBoardAutoDisabledReason,
  nativeBoardRequested,
  nativeStrokeChunks,
  setNativeBoardEnabled,
} from "./nativeBoard";
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

describe("native board fallback preference", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
  });

  it("stays on the web canvas after an automatic fallback", () => {
    disableNativeBoardAutomatically("repeated-crash");
    expect(nativeBoardRequested()).toBe(false);
    expect(nativeBoardAutoDisabledReason()).toBe("repeated-crash");
  });

  it("lets the teacher turn native back on after an automatic fallback", () => {
    disableNativeBoardAutomatically("bridge-failure");
    setNativeBoardEnabled(true);
    expect(nativeBoardRequested()).toBe(true);
    expect(nativeBoardAutoDisabledReason()).toBeNull();
  });

  it("keeps an explicit opt-out", () => {
    setNativeBoardEnabled(false);
    expect(nativeBoardRequested()).toBe(false);
  });
});
