import { useState } from "react";
import { useI18n } from "@/i18n";

export type VirtualKeyboardAction =
  | { type: "insert"; value: string; cursorBack?: number }
  | { type: "backspace" | "left" | "right" | "clear" | "done" | "cancel" };

type TouchKeyProps = {
  label: string;
  ariaLabel?: string;
  onPress: () => void;
  className?: string;
};

function TouchKey({ label, ariaLabel, onPress, className = "" }: TouchKeyProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel ?? label}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onPress}
      className={`flex h-11 min-w-11 select-none items-center justify-center rounded-lg border border-white/20 bg-graphite px-2 text-sm font-semibold text-frost active:bg-accent active:text-accentText ${className}`}
    >
      {label}
    </button>
  );
}

const mathFunctionKeys = [
  ["sin", "sin()"], ["cos", "cos()"], ["tan", "tan()"], ["tg", "tg()"], ["ln", "ln()"], ["sqrt", "sqrt()"],
  ["abs", "abs()"], ["log", "log()"], ["log2", "log2()"], ["exp", "exp()"], ["asin", "asin()"], ["atan", "atan()"],
] as const;

const mathValueKeys = [
  ["7", "7"], ["8", "8"], ["9", "9"], ["(", "("], [")", ")"], ["^", "^"],
  ["4", "4"], ["5", "5"], ["6", "6"], ["×", "*"], ["÷", "/"], ["π", "π"],
  ["1", "1"], ["2", "2"], ["3", "3"], ["+", "+"], ["−", "-"], ["e", "e"],
  ["0", "0"], [".", "."], [",", ","], ["x", "x"], ["x²", "^2"], ["x³", "^3"],
] as const;

export function MathOnScreenKeyboard({ onAction }: { onAction: (action: VirtualKeyboardAction) => void }) {
  const { tl } = useI18n();
  return (
    <div role="group" aria-label={tl("math_keyboard")} className="mt-2 w-[304px] rounded-xl border border-white/15 bg-ink p-2 shadow-glass">
      <div className="grid grid-cols-6 gap-1">
        {mathFunctionKeys.map(([label, value]) => (
          <TouchKey key={label} label={label} onPress={() => onAction({ type: "insert", value, cursorBack: 1 })} />
        ))}
      </div>
      <div className="mt-1 grid grid-cols-6 gap-1">
        {mathValueKeys.map(([label, value]) => (
          <TouchKey key={`${label}-${value}`} label={label} onPress={() => onAction({ type: "insert", value })} />
        ))}
      </div>
      <div className="mt-1 grid grid-cols-6 gap-1">
        <TouchKey label="←" ariaLabel={tl("cursor_left")} onPress={() => onAction({ type: "left" })} />
        <TouchKey label="→" ariaLabel={tl("cursor_right")} onPress={() => onAction({ type: "right" })} />
        <TouchKey label="⌫" ariaLabel={tl("backspace")} onPress={() => onAction({ type: "backspace" })} />
        <TouchKey label="C" ariaLabel={tl("clear_expression")} onPress={() => onAction({ type: "clear" })} />
        <TouchKey label={tl("cancel")} onPress={() => onAction({ type: "cancel" })} className="col-span-1" />
        <TouchKey label={tl("done")} onPress={() => onAction({ type: "done" })} className="bg-accent text-accentText" />
      </div>
    </div>
  );
}

const LATIN_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const CYRILLIC_ROWS = ["йцукенгшщз", "хъфывапрол", "джэячсмить", "бюёәғқңөұү", "һі"];

export function TextOnScreenKeyboard({ onAction }: { onAction: (action: VirtualKeyboardAction) => void }) {
  const { tl } = useI18n();
  const [layout, setLayout] = useState<"latin" | "cyrillic">("latin");
  const [upper, setUpper] = useState(false);
  const rows = layout === "latin" ? LATIN_ROWS : CYRILLIC_ROWS;

  return (
    <div role="group" aria-label={tl("screen_keyboard")} className="w-[500px] rounded-xl border border-white/15 bg-ink p-2 shadow-glass">
      <div className="grid grid-cols-10 gap-1">
        {"1234567890".split("").map((key) => (
          <TouchKey key={key} label={key} onPress={() => onAction({ type: "insert", value: key })} />
        ))}
      </div>
      <div className="mt-1 space-y-1">
        {rows.map((row, rowIndex) => (
          <div key={`${layout}-${rowIndex}`} className="flex flex-wrap justify-center gap-1">
            {row.split("").map((key) => {
              const value = upper ? key.toUpperCase() : key;
              return <TouchKey key={key} label={value} ariaLabel={value} onPress={() => onAction({ type: "insert", value })} />;
            })}
          </div>
        ))}
      </div>
      <div className="mt-1 flex flex-wrap justify-center gap-1">
        <TouchKey label="⇧" ariaLabel={tl("shift")} onPress={() => setUpper((value) => !value)} />
        <TouchKey
          label={layout === "latin" ? "АБВ" : "ABC"}
          ariaLabel={layout === "latin" ? tl("cyrillic") : tl("latin")}
          onPress={() => setLayout((value) => value === "latin" ? "cyrillic" : "latin")}
        />
        <TouchKey label="," ariaLabel="comma" onPress={() => onAction({ type: "insert", value: "," })} />
        <TouchKey label="/" ariaLabel="slash" onPress={() => onAction({ type: "insert", value: "/" })} />
        <TouchKey label="°" onPress={() => onAction({ type: "insert", value: "°" })} />
        <TouchKey label="²" onPress={() => onAction({ type: "insert", value: "²" })} />
        <TouchKey label="³" onPress={() => onAction({ type: "insert", value: "³" })} />
        <TouchKey label={tl("space")} ariaLabel="space" onPress={() => onAction({ type: "insert", value: " " })} className="min-w-[88px]" />
        <TouchKey label="⌫" ariaLabel={tl("backspace")} onPress={() => onAction({ type: "backspace" })} />
        <TouchKey label="C" ariaLabel={tl("clear_label")} onPress={() => onAction({ type: "clear" })} />
      </div>
      <div className="mt-1 flex justify-end gap-1">
        <TouchKey label={tl("cancel")} onPress={() => onAction({ type: "cancel" })} className="min-w-[92px]" />
        <TouchKey label={tl("done")} onPress={() => onAction({ type: "done" })} className="min-w-[92px] bg-accent text-accentText" />
      </div>
    </div>
  );
}
