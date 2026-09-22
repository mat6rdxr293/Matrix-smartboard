import type { Stroke } from "./boardEngine";

export type MathHandwritingToken =
  | { type: "text"; value: string }
  | { type: "sqrt"; body: MathHandwritingToken[] }
  | { type: "integral"; lower?: string; upper?: string }
  | { type: "relation"; value: "<" | ">" | "≤" | "≥" };

type Point = { x: number; y: number };

type RenderOptions = {
  x: number;
  y: number;
  fontSize: number;
  color: string;
  strokeWidth: number;
  renderPlain: (text: string, x: number, y: number, fontSize: number) => Stroke[];
  measurePlain: (text: string, fontSize: number) => number;
};

type RenderResult = {
  strokes: Stroke[];
  width: number;
  height: number;
};

const SUPER_TO_NORMAL: Record<string, string> = {
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
  "⁺": "+",
  "⁻": "-",
};

const superscriptChars = new Set(Object.keys(SUPER_TO_NORMAL));

const stroke = (
  points: Point[],
  color: string,
  width: number,
): Stroke => ({
  points,
  color,
  width,
  mode: "draw",
  source: "ai",
});

function cubic(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  steps = 28,
): Point[] {
  const result: Point[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const mt = 1 - t;
    result.push({
      x:
        mt * mt * mt * p0.x +
        3 * mt * mt * t * p1.x +
        3 * mt * t * t * p2.x +
        t * t * t * p3.x,
      y:
        mt * mt * mt * p0.y +
        3 * mt * mt * t * p1.y +
        3 * mt * t * t * p2.y +
        t * t * t * p3.y,
    });
  }
  return result;
}

function matchingParen(source: string, start: number) {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function readIntegralLimits(source: string, start: number) {
  let index = start;
  let lower: string | undefined;
  let upper: string | undefined;

  const readLower = () => {
    if (source[index] === "₍") {
      const end = source.indexOf("₎", index + 1);
      if (end > index) {
        lower = source.slice(index + 1, end);
        index = end + 1;
        return true;
      }
    }
    if (source[index] !== "_") return false;
    index += 1;
    if (source[index] === "[") {
      const end = source.indexOf("]", index + 1);
      if (end > index) {
        lower = source.slice(index + 1, end);
        index = end + 1;
        return true;
      }
    }
    if (source[index] === "(") {
      const end = source.indexOf(")", index + 1);
      if (end > index) {
        lower = source.slice(index + 1, end);
        index = end + 1;
        return true;
      }
    }
    const begin = index;
    while (
      index < source.length &&
      !/\s/.test(source[index]) &&
      source[index] !== "^" &&
      !superscriptChars.has(source[index])
    ) {
      index += 1;
    }
    lower = source.slice(begin, index) || undefined;
    return Boolean(lower);
  };

  const readUpper = () => {
    let superscript = "";
    while (index < source.length && superscriptChars.has(source[index])) {
      superscript += SUPER_TO_NORMAL[source[index]];
      index += 1;
    }
    if (superscript) {
      upper = superscript;
      return true;
    }
    if (source[index] !== "^") return false;
    index += 1;
    if (source[index] === "[") {
      const end = source.indexOf("]", index + 1);
      if (end > index) {
        upper = source.slice(index + 1, end);
        index = end + 1;
        return true;
      }
    }
    if (source[index] === "(") {
      const end = source.indexOf(")", index + 1);
      if (end > index) {
        upper = source.slice(index + 1, end);
        index = end + 1;
        return true;
      }
    }
    const begin = index;
    while (
      index < source.length &&
      !/\s/.test(source[index]) &&
      source[index] !== "_"
    ) {
      index += 1;
    }
    upper = source.slice(begin, index) || undefined;
    return Boolean(upper);
  };

  // Accept both conventional _lower^upper and model-emitted ^upper_lower.
  for (let pass = 0; pass < 2; pass += 1) {
    const before = index;
    if (!lower) readLower();
    if (!upper) readUpper();
    if (index === before) break;
  }

  return { lower, upper, next: index };
}


export function parseMathHandwritingTokens(source: string): MathHandwritingToken[] {
  const tokens: MathHandwritingToken[] = [];
  let plain = "";

  const flushPlain = () => {
    if (!plain) return;
    tokens.push({ type: "text", value: plain });
    plain = "";
  };

  for (let index = 0; index < source.length;) {
    if (source[index] === "√" && source[index + 1] === "(") {
      const end = matchingParen(source, index + 1);
      if (end > index + 1) {
        flushPlain();
        tokens.push({
          type: "sqrt",
          body: parseMathHandwritingTokens(source.slice(index + 2, end)),
        });
        index = end + 1;
        continue;
      }
    }

    if (source[index] === "∫") {
      flushPlain();
      const limits = readIntegralLimits(source, index + 1);
      tokens.push({
        type: "integral",
        lower: limits.lower,
        upper: limits.upper,
      });
      index = limits.next;
      continue;
    }

    if (
      source[index] === "<" ||
      source[index] === ">" ||
      source[index] === "≤" ||
      source[index] === "≥"
    ) {
      flushPlain();
      tokens.push({
        type: "relation",
        value: source[index] as "<" | ">" | "≤" | "≥",
      });
      index += 1;
      continue;
    }

    plain += source[index];
    index += 1;
  }

  flushPlain();
  return tokens;
}

function renderRelation(
  value: "<" | ">" | "≤" | "≥",
  x: number,
  y: number,
  fontSize: number,
  color: string,
  strokeWidth: number,
): RenderResult {
  const width = fontSize * 0.82;
  const height = fontSize * 0.72;
  const centerY = y + fontSize * 0.58;
  const left = x + fontSize * 0.08;
  const right = x + width - fontSize * 0.08;
  const top = centerY - height * 0.42;
  const bottom = centerY + height * 0.42;
  const isLess = value === "<" || value === "≤";
  const apexX = isLess ? left : right;
  const outerX = isLess ? right : left;

  const strokes = [
    stroke(
      [
        { x: outerX, y: top },
        { x: apexX, y: centerY },
      ],
      color,
      strokeWidth,
    ),
    stroke(
      [
        { x: apexX, y: centerY },
        { x: outerX, y: bottom },
      ],
      color,
      strokeWidth,
    ),
  ];

  if (value === "≤" || value === "≥") {
    const underlineY = bottom + fontSize * 0.17;
    strokes.push(
      stroke(
        [
          { x: left + fontSize * 0.04, y: underlineY },
          { x: right - fontSize * 0.02, y: underlineY },
        ],
        color,
        strokeWidth,
      ),
    );
  }

  return {
    strokes,
    width,
    height: value === "≤" || value === "≥" ? fontSize * 1.05 : fontSize,
  };
}

function renderIntegral(
  token: Extract<MathHandwritingToken, { type: "integral" }>,
  options: RenderOptions,
): RenderResult {
  const { x, y, fontSize, color, strokeWidth, renderPlain, measurePlain } = options;
  const glyphWidth = fontSize * 0.52;
  const top = y - fontSize * 0.16;
  const bottom = y + fontSize * 1.28;
  const mid = (top + bottom) / 2;

  const main = cubic(
    { x: x + glyphWidth * 0.86, y: top },
    { x: x - glyphWidth * 0.10, y: top + fontSize * 0.18 },
    { x: x + glyphWidth * 0.95, y: bottom - fontSize * 0.20 },
    { x: x + glyphWidth * 0.04, y: bottom },
    34,
  );

  const strokes: Stroke[] = [stroke(main, color, strokeWidth)];
  const hook = fontSize * 0.20;
  strokes.push(
    stroke(
      [
        { x: x + glyphWidth * 0.84, y: top },
        { x: x + glyphWidth + hook, y: top + fontSize * 0.02 },
      ],
      color,
      strokeWidth,
    ),
  );
  strokes.push(
    stroke(
      [
        { x: x + glyphWidth * 0.05, y: bottom },
        { x: x - hook * 0.65, y: bottom - fontSize * 0.01 },
      ],
      color,
      strokeWidth,
    ),
  );

  const limitSize = fontSize * 0.50;
  let occupied = glyphWidth + hook;
  if (token.upper) {
    const upperX = x + glyphWidth * 0.72;
    const upperY = top - limitSize * 0.58;
    strokes.push(...renderPlain(token.upper, upperX, upperY, limitSize));
    occupied = Math.max(
      occupied,
      upperX - x + measurePlain(token.upper, limitSize),
    );
  }
  if (token.lower) {
    const lowerX = x + glyphWidth * 0.48;
    const lowerY = mid + fontSize * 0.46;
    strokes.push(...renderPlain(token.lower, lowerX, lowerY, limitSize));
    occupied = Math.max(
      occupied,
      lowerX - x + measurePlain(token.lower, limitSize),
    );
  }

  return {
    strokes,
    width: occupied + fontSize * 0.14,
    height: fontSize * 1.62,
  };
}

function renderTokens(
  tokens: MathHandwritingToken[],
  options: RenderOptions,
): RenderResult {
  let cursorX = options.x;
  let maxHeight = options.fontSize * 1.15;
  const strokes: Stroke[] = [];

  for (const token of tokens) {
    if (token.type === "text") {
      if (!token.value) continue;
      strokes.push(
        ...options.renderPlain(
          token.value,
          cursorX,
          options.y,
          options.fontSize,
        ),
      );
      cursorX += options.measurePlain(token.value, options.fontSize);
      continue;
    }

    if (token.type === "relation") {
      const rendered = renderRelation(
        token.value,
        cursorX,
        options.y,
        options.fontSize,
        options.color,
        options.strokeWidth,
      );
      strokes.push(...rendered.strokes);
      cursorX += rendered.width + options.fontSize * 0.08;
      maxHeight = Math.max(maxHeight, rendered.height);
      continue;
    }

    if (token.type === "integral") {
      const rendered = renderIntegral(token, { ...options, x: cursorX });
      strokes.push(...rendered.strokes);
      cursorX += rendered.width;
      maxHeight = Math.max(maxHeight, rendered.height);
      continue;
    }

    if (token.type === "sqrt") {
      const radicalWidth = options.fontSize * 0.62;
      const bodyX = cursorX + radicalWidth;
      const bodyY = options.y + options.fontSize * 0.16;
      const body = renderTokens(token.body, {
        ...options,
        x: bodyX,
        y: bodyY,
      });
      const barY = options.y + options.fontSize * 0.12;
      const barEnd =
        bodyX + Math.max(body.width, options.fontSize * 0.34) + options.fontSize * 0.08;

      strokes.push(
        stroke(
          [
            { x: cursorX + options.fontSize * 0.02, y: options.y + options.fontSize * 0.62 },
            { x: cursorX + options.fontSize * 0.16, y: options.y + options.fontSize * 0.82 },
            { x: cursorX + options.fontSize * 0.34, y: options.y + options.fontSize * 0.20 },
            { x: cursorX + options.fontSize * 0.50, y: barY },
          ],
          options.color,
          options.strokeWidth,
        ),
      );
      strokes.push(
        stroke(
          [
            { x: cursorX + options.fontSize * 0.50, y: barY },
            { x: barEnd, y: barY },
          ],
          options.color,
          options.strokeWidth,
        ),
      );
      strokes.push(...body.strokes);

      const width = barEnd - cursorX + options.fontSize * 0.06;
      cursorX += width;
      maxHeight = Math.max(
        maxHeight,
        options.fontSize * 1.18,
        body.height + options.fontSize * 0.16,
      );
    }
  }

  return {
    strokes,
    width: Math.max(0, cursorX - options.x),
    height: maxHeight,
  };
}

export function renderMathAwareLine(
  source: string,
  options: RenderOptions,
): RenderResult {
  return renderTokens(parseMathHandwritingTokens(source), options);
}
