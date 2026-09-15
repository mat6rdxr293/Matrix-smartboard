/// <reference lib="webworker" />

import { drawStrokes, type Stroke } from "./boardEngine";

type RenderPayload = {
  grid: boolean;
  width: number;
  height: number;
  zoom: number;
  pan: { x: number; y: number };
  ratio: number;
  gridColor: string;
  gridStep: number;
  mode: "draw" | "erase" | "line" | "pan";
  eraserWidth: number;
  isDarkBg: boolean;
  lowPowerMode: boolean;
  strokes: Stroke[];
  linePreview: Stroke | null;
  eraserPreview: { x: number; y: number } | null;
};

type WorkerMessage =
  | { type: "init"; canvas: OffscreenCanvas }
  | { type: "render"; payload: RenderPayload };

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

const resizeIfNeeded = (width: number, height: number, ratio: number) => {
  if (!canvas) return;
  const nextW = Math.max(1, Math.floor(width * ratio));
  const nextH = Math.max(1, Math.floor(height * ratio));
  if (canvas.width !== nextW) canvas.width = nextW;
  if (canvas.height !== nextH) canvas.height = nextH;
};

const render = (payload: RenderPayload) => {
  if (!ctx) return;
  resizeIfNeeded(payload.width, payload.height, payload.ratio);

  const rendered = payload.linePreview ? [...payload.strokes, payload.linePreview] : payload.strokes;
  drawStrokes(ctx, rendered, {
    grid: payload.grid,
    width: payload.width,
    height: payload.height,
    zoom: payload.zoom,
    pan: payload.pan,
    ratio: payload.ratio,
    gridColor: payload.gridColor,
    gridStep: payload.gridStep,
  });

  if (!payload.lowPowerMode && payload.mode === "erase" && payload.eraserPreview) {
    const ratio = payload.ratio;
    ctx.save();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.translate(payload.pan.x, payload.pan.y);
    ctx.scale(payload.zoom, payload.zoom);
    ctx.globalCompositeOperation = "source-over";
    ctx.setLineDash([6 / payload.zoom, 4 / payload.zoom]);
    ctx.strokeStyle = payload.isDarkBg ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.6)";
    ctx.lineWidth = 1 / payload.zoom;
    ctx.beginPath();
    ctx.arc(payload.eraserPreview.x, payload.eraserPreview.y, payload.eraserWidth / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
};

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const data = event.data;
  if (data.type === "init") {
    canvas = data.canvas;
    ctx = canvas.getContext("2d");
    return;
  }
  if (data.type === "render") {
    render(data.payload);
  }
};
