export type Point = { x: number; y: number };
export type Stroke = {
  points: Point[];
  color: string;
  width: number;
  mode: "draw" | "erase";
};

export function drawStrokes(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  strokes: Stroke[],
  options: {
    grid: boolean;
    width: number;
    height: number;
    zoom?: number;
    pan?: { x: number; y: number };
    ratio?: number;
    gridColor?: string;
    gridStep?: number;
  }
) {
  const {
    grid,
    width,
    height,
    zoom = 1,
    pan = { x: 0, y: 0 },
    ratio = 1,
    gridColor = "rgba(255,255,255,0.06)",
    gridStep = 28,
  } =
    options;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  ctx.save();
  ctx.translate(pan.x, pan.y);
  ctx.scale(zoom, zoom);

  for (let s = 0; s < strokes.length; s += 1) {
    const stroke = strokes[s];
    if (stroke.points.length < 2) continue;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = stroke.width;
    ctx.strokeStyle = stroke.color;
    ctx.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over";
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i += 1) {
      const point = stroke.points[i];
      ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
  }

  if (grid) {
    const step = gridStep;
    const left = -pan.x / zoom;
    const top = -pan.y / zoom;
    const right = left + width / zoom;
    const bottom = top + height / zoom;
    const startX = Math.floor(left / step) * step;
    const startY = Math.floor(top / step) * step;

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    for (let x = startX; x <= right; x += step) {
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    ctx.stroke();
    ctx.beginPath();
    for (let y = startY; y <= bottom; y += step) {
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}
