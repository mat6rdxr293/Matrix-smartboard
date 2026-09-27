import type { AiMode } from "@/app/ai/api";

type RGB = { r: number; g: number; b: number };

const parseHex = (value?: string | null): RGB | null => {
  const raw = (value ?? "").trim().replace(/^#/, "");
  const hex = raw.length === 3
    ? raw.split("").map((part) => part + part).join("")
    : raw;
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
};

const distance = (a: RGB | null, b: RGB | null) => {
  if (!a || !b) return 255;
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
};

const luminance = (rgb: RGB | null) => {
  if (!rgb) return 1;
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
};

const PALETTES = {
  light: {
    hint: ["#2563EB", "#7C3AED", "#0891B2"],
    solution: ["#7C3AED", "#2563EB", "#0F766E"],
    checkOk: ["#15803D", "#0F766E", "#1D4ED8"],
    checkError: ["#D97706", "#DC2626", "#7C3AED"],
  },
  dark: {
    hint: ["#60A5FA", "#A78BFA", "#22D3EE"],
    solution: ["#A78BFA", "#60A5FA", "#2DD4BF"],
    checkOk: ["#4ADE80", "#2DD4BF", "#60A5FA"],
    checkError: ["#FBBF24", "#FB7185", "#C084FC"],
  },
} as const;

export function pickAiInkColor(params: {
  mode: AiMode;
  studentColor?: string | null;
  boardBgColor?: string | null;
  checkCorrect?: boolean;
}) {
  const dark = luminance(parseHex(params.boardBgColor)) < 0.34;
  const paletteSet = dark ? PALETTES.dark : PALETTES.light;
  const palette =
    params.mode === "hint"
      ? paletteSet.hint
      : params.mode === "solution"
        ? paletteSet.solution
        : params.checkCorrect
          ? paletteSet.checkOk
          : paletteSet.checkError;

  const student = parseHex(params.studentColor);
  return [...palette]
    .sort((a, b) =>
      distance(parseHex(b), student) - distance(parseHex(a), student)
    )[0];
}
