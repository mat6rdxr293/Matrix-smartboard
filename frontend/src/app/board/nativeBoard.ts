import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { Stroke } from "./boardEngine";
import type { GeometryTool } from "./geometry";

/** Shared document stays in React; Android is only an ink rendering/input backend. */
export type NativeBoardFrame = {
  viewport: {
    left: number; top: number; width: number; height: number;
    screenWidth: number; screenHeight: number;
  };
  mode: "draw" | "erase" | "line" | "pan" | "graph" | "lasso";
  inputMode: "auto" | "mouse" | "touch";
  zoomPanLocked: boolean;
  color: string;
  width: number;
  eraserWidth: number;
  bg: string;
  appBg: string;
  grid: boolean;
  gridColor: string;
  gridStep: number;
  pattern: "grid" | "lines";
  zoom: number;
  pan: { x: number; y: number };
  documentRevision: number;
  strokeCount: number;
  appendStrokes?: NativeEncodedStroke[];
  preview?: Stroke | null;
  geometry: GeometryTool | null;
  /** Placements of pictures sent earlier with loadImage, keyed by their source. */
  images: { key: string; x: number; y: number; width: number; height: number }[];
};

/** `p` is base64 of little-endian Float32 x,y pairs: one JSON object per point exhausts Android's heap. */
export type NativeEncodedStroke = { c: string; w: number; e: boolean; p: string };
export type NativeStrokeChunk = { revision: number; first: boolean; last: boolean; strokes: NativeEncodedStroke[] };

export type BoardRect = { left: number; top: number; width: number; height: number };
export type NativeStrokeEvent = { stroke: Stroke };
/** The pen has rested mid-stroke; `seq` ties a replaceLiveStroke reply to this very stroke. */
export type NativeStrokeHoldEvent = { seq: number; stroke: Stroke };
export type NativeViewportEvent = { zoom: number; panX: number; panY: number };

export interface NativeBoardPlugin {
  enable(): Promise<void>;
  present(frame: NativeBoardFrame): Promise<void>;
  loadStrokes(chunk: NativeStrokeChunk): Promise<void>;
  /** `data` is base64 JPEG; decoded off the UI thread and kept for frames that place `key`. */
  loadImage(options: { key: string; data: string }): Promise<void>;
  replaceLiveStroke(options: { seq: number; points: { x: number; y: number }[] }): Promise<void>;
  setBlockers(options: { rects: BoardRect[] }): Promise<void>;
  disable(): Promise<void>;
  /** Clears Android's count of starts that never settled; see NATIVE_HEALTHY_AFTER_MS. */
  markHealthy(): Promise<void>;
  addListener(eventName: "strokeStarted", listener: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "strokeCommitted", listener: (data: NativeStrokeEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "viewportChanged", listener: (data: NativeViewportEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "resyncNeeded", listener: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "strokeHold", listener: (data: NativeStrokeHoldEvent) => void): Promise<PluginListenerHandle>;
}

const NATIVE_CHUNK_STROKES = 200;
const encodedStrokes = new WeakMap<Stroke, NativeEncodedStroke>();

export function encodeNativeStroke(stroke: Stroke): NativeEncodedStroke {
  const cached = encodedStrokes.get(stroke);
  if (cached) return cached;
  const xy = new Float32Array(stroke.points.length * 2);
  stroke.points.forEach((point, index) => {
    xy[index * 2] = point.x;
    xy[index * 2 + 1] = point.y;
  });
  const bytes = new Uint8Array(xy.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const encoded = { c: stroke.color, w: stroke.width, e: stroke.mode === "erase", p: btoa(binary) };
  encodedStrokes.set(stroke, encoded);
  return encoded;
}

export function nativeStrokeChunks(strokes: Stroke[], revision: number): NativeStrokeChunk[] {
  const chunks: NativeStrokeChunk[] = [];
  for (let start = 0; start === 0 || start < strokes.length; start += NATIVE_CHUNK_STROKES) {
    chunks.push({
      revision,
      first: start === 0,
      last: start + NATIVE_CHUNK_STROKES >= strokes.length,
      strokes: strokes.slice(start, start + NATIVE_CHUNK_STROKES).map(encodeNativeStroke),
    });
  }
  return chunks;
}

const ENABLED_KEY = "matrix.nativeBoard.enabled";
const AUTO_DISABLED_KEY = "matrix.nativeBoard.autoDisabled";
/** A start that survives this long is healthy; Android counts the ones that crash before it. */
export const NATIVE_HEALTHY_AFTER_MS = 15000;

const readStorage = (key: string) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStorage = (key: string, value: string | null) => {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Without storage the renderer simply falls back to the default each launch.
  }
};

/** "0" is the teacher's explicit opt-out; an automatic fallback is kept apart so the toggle can undo it. */
export const nativeBoardRequested = (): boolean =>
  typeof window !== "undefined" &&
  readStorage(ENABLED_KEY) !== "0" &&
  readStorage(AUTO_DISABLED_KEY) === null;

export const setNativeBoardEnabled = (enabled: boolean) => {
  writeStorage(ENABLED_KEY, enabled ? "1" : "0");
  writeStorage(AUTO_DISABLED_KEY, null);
};

export const disableNativeBoardAutomatically = (reason: string) => writeStorage(AUTO_DISABLED_KEY, reason);

export const nativeBoardAutoDisabledReason = () => readStorage(AUTO_DISABLED_KEY);

export const NativeBoard = registerPlugin<NativeBoardPlugin>("NativeBoard");
