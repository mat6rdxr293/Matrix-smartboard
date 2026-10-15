import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { Stroke } from "./boardEngine";

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
  strokes?: Stroke[];
  preview?: Stroke | null;
};

export type BoardRect = { left: number; top: number; width: number; height: number };
export type NativeStrokeEvent = { stroke: Stroke };
export type NativeViewportEvent = { zoom: number; panX: number; panY: number };

export interface NativeBoardPlugin {
  enable(): Promise<void>;
  present(frame: NativeBoardFrame): Promise<void>;
  setBlockers(options: { rects: BoardRect[] }): Promise<void>;
  disable(): Promise<void>;
  addListener(eventName: "strokeStarted", listener: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "strokeCommitted", listener: (data: NativeStrokeEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "viewportChanged", listener: (data: NativeViewportEvent) => void): Promise<PluginListenerHandle>;
}

/** Explicit opt-out during rollout: localStorage.setItem("matrix.nativeBoard.enabled", "0"). */
export const nativeBoardRequested = (): boolean =>
  typeof window !== "undefined" &&
  window.localStorage.getItem("matrix.nativeBoard.enabled") !== "0";

export const NativeBoard = registerPlugin<NativeBoardPlugin>("NativeBoard");
