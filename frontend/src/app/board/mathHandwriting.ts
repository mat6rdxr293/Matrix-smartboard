import type { Stroke } from "./boardEngine";

export type MathHandwritingToken =
  | { type: "text"; value: string }
  | { type: "sqrt"; body: MathHandwritingToken[] }
  | { type: "fraction"; numerator: MathHandwritingToken[]; denominator: MathHandwritingToken[] }
  | { type: "integral"; lower?: MathHandwritingToken[]; upper?: MathHandwritingToken[] }
  | { type: "relation"; value: "<" | ">" | "≤" | "≥" | "≈" | "≃" | "∼" | "≠" | "≡" }
  | { type: "decimal"; value: "." | "," }
  | { type: "operator"; value: "·" | "•" | "×" | "÷" | "±" | "∓" | "°" | "∞" | "′" | "″" | "‴" }
  | { type: "arrow"; value: "→" | "←" | "↔" | "⇒" | "⇐" | "⇔" | "↦" }
  | { type: "pi" };

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

const SUB_TO_NORMAL: Record<string, string> = {
  "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4",
  "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
  "₊": "+", "₋": "-",
};
const subscriptChars = new Set(Object.keys(SUB_TO_NORMAL));

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
    let compactSubscript = "";
    while (index < source.length && subscriptChars.has(source[index])) {
      compactSubscript += SUB_TO_NORMAL[source[index]];
      index += 1;
    }
    if (compactSubscript) {
      lower = compactSubscript;
      return true;
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
    if (source[index] === "⁽") {
      const end = source.indexOf("⁾", index + 1);
      if (end > index) {
        upper = source.slice(index + 1, end);
        index = end + 1;
        return true;
      }
    }

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

    if (source[index] === "(") {
      const numeratorEnd = matchingParen(source, index);
      if (
        numeratorEnd > index &&
        source.slice(numeratorEnd + 1, numeratorEnd + 3) === "/("
      ) {
        const denominatorStart = numeratorEnd + 2;
        const denominatorEnd = matchingParen(source, denominatorStart);
        if (denominatorEnd > denominatorStart) {
          flushPlain();
          tokens.push({
            type: "fraction",
            numerator: parseMathHandwritingTokens(source.slice(index + 1, numeratorEnd)),
            denominator: parseMathHandwritingTokens(
              source.slice(denominatorStart + 1, denominatorEnd),
            ),
          });
          index = denominatorEnd + 1;
          continue;
        }
      }
    }

    if (source[index] === "π") {
      flushPlain();
      tokens.push({ type: "pi" });
      index += 1;
      continue;
    }

    if (source[index] === "∫") {
      flushPlain();
      const limits = readIntegralLimits(source, index + 1);
      tokens.push({
        type: "integral",
        lower: limits.lower
          ? parseMathHandwritingTokens(limits.lower)
          : undefined,
        upper: limits.upper
          ? parseMathHandwritingTokens(limits.upper)
          : undefined,
      });
      index = limits.next;
      continue;
    }

    if (
      (source[index] === "." || source[index] === ",") &&
      /[0-9]/.test(source[index - 1] ?? "") &&
      /[0-9]/.test(source[index + 1] ?? "")
    ) {
      flushPlain();
      tokens.push({
        type: "decimal",
        value: source[index] as "." | ",",
      });
      index += 1;
      continue;
    }

    if ("·•×÷±∓°∞′″‴".includes(source[index])) {
      flushPlain();
      tokens.push({
        type: "operator",
        value: source[index] as "·" | "•" | "×" | "÷" | "±" | "∓" | "°" | "∞" | "′" | "″" | "‴",
      });
      index += 1;
      continue;
    }

    if ("→←↔⇒⇐⇔↦".includes(source[index])) {
      flushPlain();
      tokens.push({
        type: "arrow",
        value: source[index] as "→" | "←" | "↔" | "⇒" | "⇐" | "⇔" | "↦",
      });
      index += 1;
      continue;
    }

    if ("<>≤≥≈≃∼≠≡".includes(source[index])) {
      flushPlain();
      tokens.push({
        type: "relation",
        value: source[index] as "<" | ">" | "≤" | "≥" | "≈" | "≃" | "∼" | "≠" | "≡",
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

function renderDecimalSeparator(
  value: "." | ",",
  x: number,
  y: number,
  fontSize: number,
  color: string,
  strokeWidth: number,
): RenderResult {
  const width = fontSize * 0.24;
  const dotY = y + fontSize * 0.86;
  const dotX = x + width * 0.46;
  const radius = Math.max(1.6, strokeWidth * 0.9);

  const strokes: Stroke[] = [
    stroke(
      [
        { x: dotX - radius, y: dotY },
        { x: dotX, y: dotY + radius * 0.25 },
        { x: dotX + radius, y: dotY },
      ],
      color,
      Math.max(strokeWidth, 2.2),
    ),
  ];

  if (value === ",") {
    strokes.push(
      stroke(
        [
          { x: dotX + radius * 0.55, y: dotY + radius * 0.25 },
          { x: dotX + radius * 0.15, y: dotY + fontSize * 0.16 },
          { x: dotX - radius * 0.35, y: dotY + fontSize * 0.24 },
        ],
        color,
        Math.max(strokeWidth, 2.0),
      ),
    );
  }

  return {
    strokes,
    width,
    height: value === "," ? fontSize * 1.16 : fontSize,
  };
}

function renderOperator(
  value: "·" | "•" | "×" | "÷" | "±" | "∓" | "°" | "∞" | "′" | "″" | "‴",
  x: number,
  y: number,
  fontSize: number,
  color: string,
  strokeWidth: number,
): RenderResult {
  const centerY = y + fontSize * 0.58;
  const dot = (cx: number, cy: number, radius = Math.max(1.7, strokeWidth * 0.9)) =>
    stroke([
      { x: cx - radius, y: cy },
      { x: cx, y: cy + radius * 0.22 },
      { x: cx + radius, y: cy },
    ], color, Math.max(strokeWidth, 2.1));

  if (value === "·" || value === "•") {
    const width = fontSize * 0.34;
    return {
      strokes: [dot(x + width * 0.5, centerY, value === "•" ? Math.max(2.2, strokeWidth) : undefined)],
      width,
      height: fontSize,
    };
  }

  if (value === "×") {
    const width = fontSize * 0.62;
    const left = x + fontSize * 0.08;
    const right = x + width - fontSize * 0.08;
    const dy = fontSize * 0.22;
    return {
      strokes: [
        stroke([{ x: left, y: centerY - dy }, { x: right, y: centerY + dy }], color, strokeWidth),
        stroke([{ x: left, y: centerY + dy }, { x: right, y: centerY - dy }], color, strokeWidth),
      ],
      width,
      height: fontSize,
    };
  }

  if (value === "÷") {
    const width = fontSize * 0.68;
    const left = x + fontSize * 0.08;
    const right = x + width - fontSize * 0.08;
    const cx = (left + right) / 2;
    return {
      strokes: [
        stroke([{ x: left, y: centerY }, { x: right, y: centerY }], color, strokeWidth),
        dot(cx, centerY - fontSize * 0.25),
        dot(cx, centerY + fontSize * 0.25),
      ],
      width,
      height: fontSize,
    };
  }

  if (value === "±" || value === "∓") {
    const width = fontSize * 0.68;
    const left = x + fontSize * 0.08;
    const right = x + width - fontSize * 0.08;
    const upperY = centerY - fontSize * 0.17;
    const lowerY = centerY + fontSize * 0.20;
    const plusY = value === "±" ? upperY : lowerY;
    const minusY = value === "±" ? lowerY : upperY;
    return {
      strokes: [
        stroke([{ x: left, y: plusY }, { x: right, y: plusY }], color, strokeWidth),
        stroke([
          { x: (left + right) / 2, y: plusY - fontSize * 0.18 },
          { x: (left + right) / 2, y: plusY + fontSize * 0.18 },
        ], color, strokeWidth),
        stroke([{ x: left, y: minusY }, { x: right, y: minusY }], color, strokeWidth),
      ],
      width,
      height: fontSize,
    };
  }

  if (value === "°") {
    const width = fontSize * 0.36;
    const cx = x + width * 0.50;
    const cy = y + fontSize * 0.24;
    const radius = fontSize * 0.12;
    const points: Point[] = [];
    for (let index = 0; index <= 16; index += 1) {
      const angle = (index / 16) * Math.PI * 2;
      points.push({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
    }
    return { strokes: [stroke(points, color, strokeWidth)], width, height: fontSize };
  }

  if (value === "′" || value === "″" || value === "‴") {
    const count = value === "′" ? 1 : value === "″" ? 2 : 3;
    const gap = fontSize * 0.13;
    const width = fontSize * (0.18 + count * 0.14);
    const strokes: Stroke[] = [];
    for (let index = 0; index < count; index += 1) {
      const px = x + fontSize * 0.08 + index * gap;
      strokes.push(stroke([
        { x: px + fontSize * 0.08, y: y + fontSize * 0.08 },
        { x: px, y: y + fontSize * 0.32 },
      ], color, strokeWidth));
    }
    return { strokes, width, height: fontSize };
  }

  const width = fontSize * 0.90;
  const cx = x + width * 0.5;
  const cy = centerY;
  const rx = width * 0.42;
  const ry = fontSize * 0.20;
  const points: Point[] = [];
  for (let index = 0; index <= 36; index += 1) {
    const t = (index / 36) * Math.PI * 2;
    points.push({
      x: cx + Math.cos(t) * rx,
      y: cy + Math.sin(t * 2) * ry,
    });
  }
  return { strokes: [stroke(points, color, strokeWidth)], width, height: fontSize };
}

function renderArrow(
  value: "→" | "←" | "↔" | "⇒" | "⇐" | "⇔" | "↦",
  x: number,
  y: number,
  fontSize: number,
  color: string,
  strokeWidth: number,
): RenderResult {
  const width = fontSize * 1.08;
  const centerY = y + fontSize * 0.58;
  const leftX = x + fontSize * 0.08;
  const rightX = x + width - fontSize * 0.08;
  const head = fontSize * 0.24;
  const isDouble = value === "⇒" || value === "⇐" || value === "⇔";
  const pointsRight = value === "→" || value === "↔" || value === "⇒" || value === "⇔" || value === "↦";
  const pointsLeft = value === "←" || value === "↔" || value === "⇐" || value === "⇔";
  const offsets = isDouble ? [-fontSize * 0.09, fontSize * 0.09] : [0];
  const strokes: Stroke[] = offsets.map((offset) =>
    stroke([{ x: leftX, y: centerY + offset }, { x: rightX, y: centerY + offset }], color, strokeWidth),
  );

  if (pointsRight) {
    strokes.push(stroke([
      { x: rightX - head, y: centerY - head * 0.68 },
      { x: rightX, y: centerY },
      { x: rightX - head, y: centerY + head * 0.68 },
    ], color, strokeWidth));
  }
  if (pointsLeft) {
    strokes.push(stroke([
      { x: leftX + head, y: centerY - head * 0.68 },
      { x: leftX, y: centerY },
      { x: leftX + head, y: centerY + head * 0.68 },
    ], color, strokeWidth));
  }
  if (value === "↦") {
    strokes.push(stroke([
      { x: leftX, y: centerY - fontSize * 0.22 },
      { x: leftX, y: centerY + fontSize * 0.22 },
    ], color, strokeWidth));
  }
  return { strokes, width, height: fontSize };
}

function renderRelation(
  value: "<" | ">" | "≤" | "≥" | "≈" | "≃" | "∼" | "≠" | "≡",
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

  if (value === "∼" || value === "≈" || value === "≃") {
    const wave = (waveY: number) => {
      const points: Point[] = [];
      for (let index = 0; index <= 12; index += 1) {
        const t = index / 12;
        points.push({
          x: left + (right - left) * t,
          y: waveY + Math.sin(t * Math.PI * 2) * fontSize * 0.055,
        });
      }
      return stroke(points, color, strokeWidth);
    };
    const strokes = [wave(value === "∼" ? centerY : centerY - fontSize * 0.12)];
    if (value === "≈") strokes.push(wave(centerY + fontSize * 0.16));
    if (value === "≃") {
      strokes.push(stroke([
        { x: left, y: centerY + fontSize * 0.18 },
        { x: right, y: centerY + fontSize * 0.18 },
      ], color, strokeWidth));
    }
    return { strokes, width, height: fontSize };
  }

  if (value === "≠" || value === "≡") {
    const offsets = value === "≡" ? [-0.18, 0, 0.18] : [-0.11, 0.11];
    const strokes = offsets.map((offset) =>
      stroke([
        { x: left, y: centerY + fontSize * offset },
        { x: right, y: centerY + fontSize * offset },
      ], color, strokeWidth),
    );
    if (value === "≠") {
      strokes.push(stroke([
        { x: left + fontSize * 0.08, y: centerY + fontSize * 0.28 },
        { x: right - fontSize * 0.08, y: centerY - fontSize * 0.28 },
      ], color, strokeWidth));
    }
    return { strokes, width, height: fontSize };
  }
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

function renderPi(
  x: number,
  y: number,
  fontSize: number,
  color: string,
  strokeWidth: number,
): RenderResult {
  const width = fontSize * 0.82;
  const topY = y + fontSize * 0.18;
  const bottomY = y + fontSize * 0.92;
  const leftX = x + fontSize * 0.16;
  const rightX = x + width - fontSize * 0.10;

  const strokes: Stroke[] = [
    stroke(
      [
        { x: x + fontSize * 0.04, y: topY + fontSize * 0.04 },
        { x: x + width * 0.48, y: topY },
        { x: x + width, y: topY + fontSize * 0.03 },
      ],
      color,
      strokeWidth,
    ),
    stroke(
      [
        { x: leftX, y: topY + fontSize * 0.05 },
        { x: leftX - fontSize * 0.02, y: y + fontSize * 0.56 },
        { x: leftX - fontSize * 0.10, y: bottomY },
      ],
      color,
      strokeWidth,
    ),
    stroke(
      [
        { x: rightX, y: topY + fontSize * 0.05 },
        { x: rightX - fontSize * 0.02, y: y + fontSize * 0.58 },
        { x: rightX + fontSize * 0.08, y: bottomY },
      ],
      color,
      strokeWidth,
    ),
  ];

  return {
    strokes,
    width: width + fontSize * 0.08,
    height: fontSize * 1.02,
  };
}

function translateStrokes(strokes: Stroke[], dx: number, dy: number): Stroke[] {
  if (!dx && !dy) return strokes;
  return strokes.map((item) => ({
    ...item,
    points: item.points.map((point) => ({
      x: point.x + dx,
      y: point.y + dy,
    })),
  }));
}

function renderFraction(
  token: Extract<MathHandwritingToken, { type: "fraction" }>,
  options: RenderOptions,
): RenderResult {
  const childSize = options.fontSize * 0.68;
  const paddingX = options.fontSize * 0.16;
  const verticalGap = options.fontSize * 0.09;
  const numeratorY = options.y - options.fontSize * 0.08;

  const numerator = renderTokens(token.numerator, {
    ...options,
    x: options.x,
    y: numeratorY,
    fontSize: childSize,
  });

  // A nested fraction/root can be much taller than ordinary text. Put this
  // fraction bar below the *actual* rendered numerator instead of at a fixed
  // baseline; otherwise nested denominators collide with the outer bar.
  const barY = Math.max(
    options.y + options.fontSize * 0.68,
    numeratorY + numerator.height + verticalGap,
  );
  const denominatorY = barY + verticalGap;
  const denominator = renderTokens(token.denominator, {
    ...options,
    x: options.x,
    y: denominatorY,
    fontSize: childSize,
  });

  const innerWidth = Math.max(
    numerator.width,
    denominator.width,
    options.fontSize * 0.42,
  );
  const totalWidth = innerWidth + paddingX * 2;
  const numeratorDx = paddingX + (innerWidth - numerator.width) / 2;
  const denominatorDx = paddingX + (innerWidth - denominator.width) / 2;

  return {
    strokes: [
      ...translateStrokes(numerator.strokes, numeratorDx, 0),
      stroke(
        [
          { x: options.x + paddingX * 0.35, y: barY },
          { x: options.x + totalWidth - paddingX * 0.35, y: barY },
        ],
        options.color,
        options.strokeWidth,
      ),
      ...translateStrokes(denominator.strokes, denominatorDx, 0),
    ],
    width: totalWidth + options.fontSize * 0.06,
    height: Math.max(
      options.fontSize * 1.58,
      denominatorY - options.y + denominator.height,
    ),
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
  if (token.upper?.length) {
    const upperX = x + glyphWidth * 0.72;
    const upperY = top - limitSize * 0.58;
    const upper = renderTokens(token.upper, {
      ...options,
      x: upperX,
      y: upperY,
      fontSize: limitSize,
    });
    strokes.push(...upper.strokes);
    occupied = Math.max(occupied, upperX - x + upper.width);
  }
  if (token.lower?.length) {
    const lowerX = x + glyphWidth * 0.48;
    const lowerY = mid + fontSize * 0.46;
    const lower = renderTokens(token.lower, {
      ...options,
      x: lowerX,
      y: lowerY,
      fontSize: limitSize,
    });
    strokes.push(...lower.strokes);
    occupied = Math.max(occupied, lowerX - x + lower.width);
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

    if (token.type === "decimal") {
      const rendered = renderDecimalSeparator(
        token.value,
        cursorX,
        options.y,
        options.fontSize,
        options.color,
        options.strokeWidth,
      );
      strokes.push(...rendered.strokes);
      cursorX += rendered.width;
      maxHeight = Math.max(maxHeight, rendered.height);
      continue;
    }

    if (token.type === "operator") {
      const rendered = renderOperator(
        token.value,
        cursorX,
        options.y,
        options.fontSize,
        options.color,
        options.strokeWidth,
      );
      strokes.push(...rendered.strokes);
      cursorX += rendered.width + options.fontSize * 0.04;
      maxHeight = Math.max(maxHeight, rendered.height);
      continue;
    }

    if (token.type === "arrow") {
      const rendered = renderArrow(
        token.value,
        cursorX,
        options.y,
        options.fontSize,
        options.color,
        options.strokeWidth,
      );
      strokes.push(...rendered.strokes);
      cursorX += rendered.width + options.fontSize * 0.06;
      maxHeight = Math.max(maxHeight, rendered.height);
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

    if (token.type === "pi") {
      const rendered = renderPi(
        cursorX,
        options.y,
        options.fontSize,
        options.color,
        options.strokeWidth,
      );
      strokes.push(...rendered.strokes);
      cursorX += rendered.width;
      maxHeight = Math.max(maxHeight, rendered.height);
      continue;
    }

    if (token.type === "fraction") {
      const rendered = renderFraction(token, { ...options, x: cursorX });
      strokes.push(...rendered.strokes);
      cursorX += rendered.width;
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
