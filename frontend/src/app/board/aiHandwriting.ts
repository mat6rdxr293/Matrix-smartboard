import type { Stroke } from "./boardEngine";

export type HandwritingStep = {
  text: string;
  kind: "text" | "math" | "result" | "warning";
};

export type HandwritingOptions = {
  x: number;
  y: number;
  maxWidth: number;
  color: string;
  strokeWidth?: number;
  fontSize?: number;
  lineGap?: number;
  stepGap?: number;
};

const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "-": "⁻",
  "+": "⁺",
};

const toSuperscript = (value: string) =>
  value.split("").map((char) => SUPERSCRIPT[char] ?? char).join("");

const CJK_SCRIPT_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;

const sanitizeLanguageText = (value: string, locale: "ru" | "kk" | "en") => {
  // Matrix Smartboard currently ships RU/KK/EN locales. None should emit CJK script
  // unless it was present in the source task itself; board solutions are normalized here.
  const withoutCjk = value.replace(CJK_SCRIPT_RE, " ");
  return withoutCjk.replace(/\s+([.,;:!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
};

const decodeLooseStructuredString = (value: string) =>
  value
    .replace(/\\(["\\/])/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");

export function extractSafeHandwritingSteps(
  steps: HandwritingStep[] | null | undefined,
  fallbackText: string,
  locale: "ru" | "kk" | "en" = "ru",
): HandwritingStep[] {
  const clean = (steps ?? []).filter(
    (step) => typeof step?.text === "string" && step.text.trim().length > 0,
  );

  const looksStructured = (value: string) =>
    /"(?:summary|steps|text|kind)"\s*:?/i.test(value) ||
    /^\s*[\[{]/.test(value);

  if (clean.length > 1 || (clean.length === 1 && !looksStructured(clean[0].text))) {
    return clean
      .map((step) => ({
        text: sanitizeLanguageText(step.text.trim(), locale),
        kind: step.kind,
      }))
      .filter((step) => step.text.length > 0);
  }

  const source = clean.length === 1 ? clean[0].text : fallbackText;
  if (!source.trim()) return [];
  if (!looksStructured(source)) {
    const safeText = sanitizeLanguageText(source.trim(), locale);
    return safeText ? [{ text: safeText, kind: "text" }] : [];
  }

  const extracted: HandwritingStep[] = [];
  const pattern = /"text"\s*:?\s*"((?:\\.|[^"\\])*)"/gi;
  for (const match of source.matchAll(pattern)) {
    const text = sanitizeLanguageText(decodeLooseStructuredString(match[1]).trim(), locale);
    if (!text) continue;
    extracted.push({ text, kind: "text" });
    if (extracted.length >= 40) break;
  }
  return extracted;
}

export function normalizeHandwritingText(source: string) {
  let text = (source || "").trim();
  text = text.replace(/\$\$/g, "").replace(/\$/g, "");
  text = text.replace(/\\[()[\]]/g, "");
  text = text.replace(/\\left|\\right/g, "");
  text = text.replace(/\\(?:,|;|!|quad|qquad)/g, " ");
  text = text.replace(/\\pm/g, "±");
  text = text.replace(/\\times/g, "×");
  text = text.replace(/\\cdot/g, "·");
  text = text.replace(/\\div/g, "÷");
  text = text.replace(/\\neq/g, "≠");
  text = text.replace(/\\leq?|\\le/g, "≤");
  text = text.replace(/\\geq?|\\ge/g, "≥");
  text = text.replace(/\\rightarrow|\\to/g, "→");
  text = text.replace(/\\infty/g, "∞");
  text = text.replace(/\\pi/g, "π");

  for (let pass = 0; pass < 4; pass += 1) {
    const previous = text;
    text = text.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1)/($2)");
    text = text.replace(/\\sqrt\{([^{}]+)\}/g, "√($1)");
    if (text === previous) break;
  }

  text = text.replace(/\^\{([0-9+-]+)\}/g, (_, value: string) => toSuperscript(value));
  text = text.replace(/\^([0-9])/g, (_, value: string) => toSuperscript(value));
  text = text.replace(/_\{([^{}]+)\}/g, "₍$1₎");
  text = text.replace(/\\([A-Za-z]+)/g, "$1");
  text = text.replace(/[{}]/g, "");
  text = text.replace(/\*\*/g, "");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function wrapLine(
  ctx: CanvasRenderingContext2D,
  source: string,
  maxWidth: number,
): string[] {
  const clean = source.trim();
  if (!clean) return [];
  if (ctx.measureText(clean).width <= maxWidth) return [clean];

  const words = clean.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines;
}

const indexOf = (x: number, y: number, width: number) => y * width + x;

function neighbors(mask: Uint8Array, width: number, height: number, index: number) {
  const x = index % width;
  const y = Math.floor(index / width);
  const result: number[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (!dx && !dy) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = indexOf(nx, ny, width);
      if (mask[next]) result.push(next);
    }
  }
  return result;
}

function transitionCount(values: number[]) {
  let count = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] === 0 && values[(i + 1) % values.length] === 1) count += 1;
  }
  return count;
}

function thinMask(input: Uint8Array, width: number, height: number) {
  const mask = input.slice();
  const remove: number[] = [];

  for (let iteration = 0; iteration < 40; iteration += 1) {
    let changed = false;

    for (let phase = 0; phase < 2; phase += 1) {
      remove.length = 0;

      for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
          const i = indexOf(x, y, width);
          if (!mask[i]) continue;

          const p2 = mask[indexOf(x, y - 1, width)];
          const p3 = mask[indexOf(x + 1, y - 1, width)];
          const p4 = mask[indexOf(x + 1, y, width)];
          const p5 = mask[indexOf(x + 1, y + 1, width)];
          const p6 = mask[indexOf(x, y + 1, width)];
          const p7 = mask[indexOf(x - 1, y + 1, width)];
          const p8 = mask[indexOf(x - 1, y, width)];
          const p9 = mask[indexOf(x - 1, y - 1, width)];
          const ring = [p2, p3, p4, p5, p6, p7, p8, p9];
          const total = ring.reduce((sum, value) => sum + value, 0);
          if (total < 2 || total > 6 || transitionCount(ring) !== 1) continue;

          const a = phase === 0 ? p2 * p4 * p6 : p2 * p4 * p8;
          const b = phase === 0 ? p4 * p6 * p8 : p2 * p6 * p8;
          if (a || b) continue;
          remove.push(i);
        }
      }

      if (remove.length) {
        changed = true;
        for (const index of remove) mask[index] = 0;
      }
    }

    if (!changed) break;
  }

  return mask;
}

const edgeKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;

function traceSkeleton(mask: Uint8Array, width: number, height: number) {
  const visited = new Set<string>();
  const paths: number[][] = [];
  const active: number[] = [];

  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index]) active.push(index);
  }

  const walk = (start: number, first: number) => {
    const path = [start, first];
    visited.add(edgeKey(start, first));
    let previous = start;
    let current = first;

    for (let guard = 0; guard < 5000; guard += 1) {
      const nextOptions = neighbors(mask, width, height, current)
        .filter((candidate) => candidate !== previous && !visited.has(edgeKey(current, candidate)));
      if (!nextOptions.length) break;
      if (neighbors(mask, width, height, current).length !== 2 && path.length > 1) break;
      const next = nextOptions[0];
      visited.add(edgeKey(current, next));
      path.push(next);
      previous = current;
      current = next;
      if (current === start) break;
    }
    if (path.length > 1) paths.push(path);
  };

  for (const index of active) {
    const around = neighbors(mask, width, height, index);
    if (around.length === 2) continue;
    for (const next of around) {
      if (!visited.has(edgeKey(index, next))) walk(index, next);
    }
  }

  for (const index of active) {
    for (const next of neighbors(mask, width, height, index)) {
      if (!visited.has(edgeKey(index, next))) walk(index, next);
    }
  }

  return paths;
}

type Point = { x: number; y: number };

const pointDistanceToSegment = (point: Point, start: Point, end: Point) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (!dx && !dy) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
};

function simplify(points: Point[], epsilon = 0.8): Point[] {
  if (points.length <= 2) return points;
  let maxDistance = 0;
  let maxIndex = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = pointDistanceToSegment(points[i], points[0], points[points.length - 1]);
    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = i;
    }
  }
  if (maxDistance <= epsilon) return [points[0], points[points.length - 1]];
  const left = simplify(points.slice(0, maxIndex + 1), epsilon);
  const right = simplify(points.slice(maxIndex), epsilon);
  return [...left.slice(0, -1), ...right];
}

function renderTextLine(
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  color: string,
  strokeWidth: number,
  fontSize: number,
) {
  const scale = 1.65;
  const padding = 10;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(32, Math.ceil((maxWidth + padding * 2) * scale));
  canvas.height = Math.max(32, Math.ceil((fontSize * 1.55 + padding * 2) * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [] as Stroke[];

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "alphabetic";
  ctx.font = `${fontSize * scale}px "Comic Sans MS", "Marker Felt", "Bradley Hand", cursive`;
  ctx.fillText(text, padding * scale, (padding + fontSize) * scale);

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const mask = new Uint8Array(canvas.width * canvas.height);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    mask[pixel] = image.data[pixel * 4 + 3] >= 96 ? 1 : 0;
  }

  const skeleton = thinMask(mask, canvas.width, canvas.height);
  const paths = traceSkeleton(skeleton, canvas.width, canvas.height);
  const offsetX = x - padding;
  const offsetY = y - padding;

  const rendered = paths
    .map((path, pathIndex): Stroke | null => {
      const points = simplify(
        path.map((index, pointIndex) => {
          const px = (index % canvas.width) / scale + offsetX;
          const py = Math.floor(index / canvas.width) / scale + offsetY;
          const wobble = Math.sin((px + pathIndex * 13) * 0.11 + pointIndex * 0.07) * 0.18;
          return { x: px, y: py + wobble };
        }),
        0.65,
      );
      if (points.length < 2) return null;
      return { points, color, width: strokeWidth, mode: "draw" };
    })
    .filter((stroke): stroke is Stroke => Boolean(stroke));

  const anchor = (stroke: Stroke) => {
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    for (const point of stroke.points) {
      left = Math.min(left, point.x);
      top = Math.min(top, point.y);
    }
    return { left, top };
  };

  return rendered.sort((a, b) => {
    const aa = anchor(a);
    const bb = anchor(b);
    if (Math.abs(aa.left - bb.left) > 3) return aa.left - bb.left;
    return aa.top - bb.top;
  });
}

export function solutionStepsToHandwritingStrokes(
  steps: HandwritingStep[],
  options: HandwritingOptions,
) {
  if (typeof document === "undefined") return { strokes: [] as Stroke[], height: 0 };

  const strokeWidth = options.strokeWidth ?? 2.2;
  const baseFontSize = options.fontSize ?? 28;
  const lineGap = options.lineGap ?? 12;
  const stepGap = options.stepGap ?? 18;
  const measureCanvas = document.createElement("canvas");
  const measure = measureCanvas.getContext("2d");
  if (!measure) return { strokes: [] as Stroke[], height: 0 };

  const strokes: Stroke[] = [];
  let cursorY = options.y;

  for (const step of steps) {
    const text = normalizeHandwritingText(step.text);
    if (!text) continue;
    const fontSize = step.kind === "result" ? baseFontSize + 3 : step.kind === "math" ? baseFontSize + 1 : baseFontSize;
    measure.font = `${fontSize}px "Comic Sans MS", "Marker Felt", "Bradley Hand", cursive`;
    const sourceLines = text.split(/\n+/);
    const lines = sourceLines.flatMap((line) => wrapLine(measure, line, options.maxWidth));

    for (const line of lines) {
      strokes.push(...renderTextLine(
        line,
        options.x,
        cursorY,
        options.maxWidth,
        options.color,
        step.kind === "result" ? strokeWidth + 0.3 : strokeWidth,
        fontSize,
      ));
      cursorY += fontSize + lineGap;
    }
    cursorY += stepGap;
  }

  return { strokes, height: Math.max(0, cursorY - options.y) };
}
