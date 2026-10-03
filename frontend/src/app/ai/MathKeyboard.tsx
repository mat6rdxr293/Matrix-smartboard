import { useState } from "react";
import { ArrowLeft, ArrowRight, Delete, Eraser, MoveRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

export type MathKeyboardAction =
  | { type: "insert"; latex: string }
  | { type: "template"; latex: string; selectKind: string }
  | { type: "backspace" }
  | { type: "clear" }
  | { type: "moveLeft" }
  | { type: "moveRight" }
  | { type: "nextField" };

type Props = {
  onAction: (action: MathKeyboardAction) => void;
  activeLabel: string;
  canNavigate: boolean;
  canNextField: boolean;
};

type KeyDef = {
  label: string;
  latex?: string;
  className?: string;
  selectKind?: string;
};

const BASIC_ROWS: KeyDef[][] = [
  [
    { label: "7", latex: "7" }, { label: "8", latex: "8" }, { label: "9", latex: "9" },
    { label: "+", latex: "+" }, { label: "−", latex: "-" }, { label: "×", latex: "\\times " },
  ],
  [
    { label: "4", latex: "4" }, { label: "5", latex: "5" }, { label: "6", latex: "6" },
    { label: "=", latex: "=" }, { label: "÷", latex: "\\div " }, { label: "(", latex: "(" },
  ],
  [
    { label: "1", latex: "1" }, { label: "2", latex: "2" }, { label: "3", latex: "3" },
    { label: ")", latex: ")" }, { label: "π", latex: "\\pi " }, { label: "∞", latex: "\\infty " },
  ],
  [
    { label: "0", latex: "0" }, { label: ".", latex: "." }, { label: ",", latex: "," },
    { label: "x", latex: "x" }, { label: "y", latex: "y" }, { label: "z", latex: "z" },
  ],
];

const STRUCTURE_ROWS: KeyDef[][] = [
  [
    { label: "xⁿ", latex: "^{}", selectKind: "exponent" },
    { label: "xₙ", latex: "_{}", selectKind: "subscript" },
    { label: "√x", latex: "\\sqrt{}", selectKind: "radicand" },
    { label: "ⁿ√x", latex: "\\sqrt[]{}", selectKind: "rootIndex" },
  ],
  [
    { label: "a⁄b", latex: "\\frac{}{}", selectKind: "numerator", className: "font-serif text-[18px]" },
    { label: "∫", latex: "\\int " },
    { label: "∫ₐᵇ", latex: "\\int_{}^{} {}\\,dx", selectKind: "integralLower", className: "text-[19px]" },
    { label: "dx", latex: "\\,dx" },
  ],
  [
    { label: "|x|", latex: "\\left|{}\\right|", selectKind: "groupArgument" },
    { label: "[ ]", latex: "\\left[{}\\right]", selectKind: "groupArgument" },
    { label: "{ }", latex: "\\left\\{{}\\right\\}", selectKind: "groupArgument" },
    { label: "Σ", latex: "\\sum_{}^{} {}", selectKind: "subscript" },
  ],
];

const FUNCTION_ROWS: KeyDef[][] = [
  [
    { label: "sin", latex: "\\sin\\left({}\\right)", selectKind: "functionArgument" },
    { label: "cos", latex: "\\cos\\left({}\\right)", selectKind: "functionArgument" },
    { label: "tan", latex: "\\tan\\left({}\\right)", selectKind: "functionArgument" },
    { label: "cot", latex: "\\cot\\left({}\\right)", selectKind: "functionArgument" },
  ],
  [
    { label: "ln", latex: "\\ln\\left({}\\right)", selectKind: "functionArgument" },
    { label: "log", latex: "\\log\\left({}\\right)", selectKind: "functionArgument" },
    { label: "eˣ", latex: "e^{}", selectKind: "exponent" },
    { label: "lim", latex: "\\lim_{} ", selectKind: "subscript" },
  ],
  [
    { label: "→", latex: "\\to " },
    { label: "≈", latex: "\\approx " },
    { label: "≠", latex: "\\ne " },
    { label: "±", latex: "\\pm " },
  ],
];


const SYMBOL_ROWS: KeyDef[][] = [
  [
    { label: "<", latex: "<" }, { label: ">", latex: ">" },
    { label: "≤", latex: "\\le " }, { label: "≥", latex: "\\ge " },
  ],
  [
    { label: "≠", latex: "\\ne " }, { label: "≈", latex: "\\approx " },
    { label: "±", latex: "\\pm " }, { label: "→", latex: "\\to " },
  ],
  [
    { label: "π", latex: "\\pi " }, { label: "∞", latex: "\\infty " },
    { label: "α", latex: "\\alpha " }, { label: "β", latex: "\\beta " },
  ],
  [
    { label: "θ", latex: "\\theta " }, { label: "Δ", latex: "\\Delta " },
    { label: "∂", latex: "\\partial " }, { label: "°", latex: "^{\\circ}", selectKind: "exponent" },
  ],
];
export default function MathKeyboard({ onAction, activeLabel, canNavigate, canNextField }: Props) {
  const { tl } = useI18n();
  const [tab, setTab] = useState<"basic" | "structures" | "functions" | "symbols">("basic");

  const rows =
    tab === "basic" ? BASIC_ROWS :
    tab === "structures" ? STRUCTURE_ROWS :
    tab === "functions" ? FUNCTION_ROWS :
    SYMBOL_ROWS;

  const pressKey = (key: KeyDef) => {
    if (!key.latex) return;
    if (key.selectKind) {
      onAction({ type: "template", latex: key.latex, selectKind: key.selectKind });
    } else {
      onAction({ type: "insert", latex: key.latex });
    }
  };

  return (
    <div className="math-keyboard mt-2 rounded-xl border border-white/10 bg-black/15 p-2.5" data-testid="math-keyboard">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0 truncate text-[10px] font-semibold text-frost/45">
          {tl("math_keyboard_editing")}: <span className="text-frost/75">{activeLabel}</span>
        </div>
        <div className="flex shrink-0 gap-1">
          {([
            ["basic", tl("math_keyboard_basic")],
            ["structures", tl("math_keyboard_structures")],
            ["functions", tl("math_keyboard_functions")],
            ["symbols", tl("math_keyboard_symbols")],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={cn(
                "h-7 rounded-lg px-2.5 text-[10px] font-semibold transition",
                tab === id
                  ? "bg-accent text-accentText"
                  : "bg-white/[0.045] text-frost/45 hover:bg-white/[0.07] hover:text-frost/70",
              )}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        {rows.map((row, rowIndex) => (
          <div
            key={rowIndex}
            className={cn(
              "grid gap-1.5",
              tab === "basic" ? "grid-cols-6" : "grid-cols-4",
            )}
          >
            {row.map((key) => (
              <button
                key={key.label}
                type="button"
                className={cn(
                  "math-key h-11 rounded-lg border border-white/[0.09] bg-white/[0.045] text-[15px] font-semibold text-frost/85",
                  "active:scale-[0.97] active:bg-accent/15",
                  "hover:border-white/15 hover:bg-white/[0.07]",
                  key.className,
                )}
                onClick={() => pressKey(key)}
              >
                {key.label}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="mt-2 grid grid-cols-[1fr_1fr_1.2fr_1.2fr_1.2fr] gap-1.5">
        <button
          type="button"
          className="math-key-control"
          disabled={!canNavigate}
          onClick={() => onAction({ type: "moveLeft" })}
          aria-label={tl("math_keyboard_previous")}
        >
          <ArrowLeft size={16} />
        </button>
        <button
          type="button"
          className="math-key-control"
          disabled={!canNavigate}
          onClick={() => onAction({ type: "moveRight" })}
          aria-label={tl("math_keyboard_next")}
        >
          <ArrowRight size={16} />
        </button>
        <button type="button" className="math-key-control" onClick={() => onAction({ type: "backspace" })}>
          <Delete size={15} />
          <span>{tl("math_keyboard_delete")}</span>
        </button>
        <button type="button" className="math-key-control" onClick={() => onAction({ type: "clear" })}>
          <Eraser size={15} />
          <span>{tl("math_keyboard_clear")}</span>
        </button>
        <button
          type="button"
          className="math-key-control border-accent/25 bg-accent/[0.08] text-accent"
          disabled={!canNextField}
          onClick={() => onAction({ type: "nextField" })}
        >
          <MoveRight size={15} />
          <span>{tl("math_keyboard_next_field")}</span>
        </button>
      </div>
    </div>
  );
}
