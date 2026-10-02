import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import katex from "katex";
import { Braces, Code2, MousePointer2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";

type EditableKind =
  | "integralLower"
  | "integralUpper"
  | "exponent"
  | "subscript"
  | "numerator"
  | "denominator"
  | "radicand"
  | "rootIndex";

type EditablePart = {
  id: string;
  kind: EditableKind;
  content: string;
  start: number;
  end: number;
  bare: boolean;
};

type Arg = {
  start: number;
  end: number;
  replaceEnd: number;
  bare: boolean;
};

const isLetter = (value: string) => /[A-Za-z]/.test(value);

function findMatching(source: string, start: number, open: string, close: string) {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === open) depth += 1;
    else if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function readArgument(source: string, from: number): Arg | null {
  let cursor = from;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  if (cursor >= source.length) return null;

  if (source[cursor] === "{") {
    const close = findMatching(source, cursor, "{", "}");
    if (close < 0) return null;
    return { start: cursor + 1, end: close, replaceEnd: close + 1, bare: false };
  }

  if (source[cursor] === "\\") {
    let end = cursor + 1;
    if (isLetter(source[end] ?? "")) {
      while (end < source.length && isLetter(source[end])) end += 1;
    } else {
      end = Math.min(source.length, end + 1);
    }
    return { start: cursor, end, replaceEnd: end, bare: true };
  }

  const codePoint = source.codePointAt(cursor);
  if (codePoint == null) return null;
  const width = codePoint > 0xffff ? 2 : 1;
  return { start: cursor, end: cursor + width, replaceEnd: cursor + width, bare: true };
}

function readOptionalBracket(source: string, from: number): Arg | null {
  let cursor = from;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  if (source[cursor] !== "[") return null;
  const close = findMatching(source, cursor, "[", "]");
  if (close < 0) return null;
  return { start: cursor + 1, end: close, replaceEnd: close + 1, bare: false };
}

function analyzeLatex(source: string): EditablePart[] {
  const parts: EditablePart[] = [];
  const consumedScripts = new Set<number>();
  let counter = 0;

  const add = (kind: EditableKind, arg: Arg | null) => {
    if (!arg || arg.end <= arg.start) return;
    parts.push({
      id: `edit-${counter++}`,
      kind,
      content: source.slice(arg.start, arg.end),
      start: arg.start,
      end: arg.end,
      bare: arg.bare,
    });
  };

  for (let i = 0; i < source.length; i += 1) {
    if (source.startsWith("\\int", i) && !isLetter(source[i + 4] ?? "")) {
      let cursor = i + 4;
      for (let pass = 0; pass < 2; pass += 1) {
        while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
        const op = source[cursor];
        if (op !== "_" && op !== "^") break;
        consumedScripts.add(cursor);
        const arg = readArgument(source, cursor + 1);
        add(op === "_" ? "integralLower" : "integralUpper", arg);
        if (!arg) break;
        cursor = arg.replaceEnd;
      }
      continue;
    }

    if (source.startsWith("\\frac", i) && !isLetter(source[i + 5] ?? "")) {
      const numerator = readArgument(source, i + 5);
      add("numerator", numerator);
      if (numerator) add("denominator", readArgument(source, numerator.replaceEnd));
      continue;
    }

    if (source.startsWith("\\sqrt", i) && !isLetter(source[i + 5] ?? "")) {
      const rootIndex = readOptionalBracket(source, i + 5);
      add("rootIndex", rootIndex);
      const radicand = readArgument(source, rootIndex ? rootIndex.replaceEnd : i + 5);
      add("radicand", radicand);
      continue;
    }

    if ((source[i] === "^" || source[i] === "_") && !consumedScripts.has(i)) {
      add(source[i] === "^" ? "exponent" : "subscript", readArgument(source, i + 1));
    }
  }

  return parts;
}

function renderInteractiveLatex(source: string, parts: EditablePart[]) {
  const opens = new Map<number, EditablePart[]>();
  const closes = new Map<number, EditablePart[]>();

  for (const part of parts) {
    const open = opens.get(part.start) ?? [];
    open.push(part);
    opens.set(part.start, open);

    const close = closes.get(part.end) ?? [];
    close.push(part);
    closes.set(part.end, close);
  }

  for (const group of opens.values()) group.sort((a, b) => b.end - a.end);
  for (const group of closes.values()) group.sort((a, b) => b.start - a.start);

  let marked = "";
  for (let i = 0; i <= source.length; i += 1) {
    const closing = closes.get(i);
    if (closing) {
      for (const part of closing) marked += part.bare ? "}}" : "}";
    }
    const opening = opens.get(i);
    if (opening) {
      for (const part of opening) {
        marked += part.bare
          ? `{\\htmlData{edit-id=${part.id}}{`
          : `\\htmlData{edit-id=${part.id}}{`;
      }
    }
    if (i < source.length) marked += source[i];
  }

  return katex.renderToString(marked, {
    displayMode: true,
    throwOnError: true,
    strict: "ignore",
    trust: (context) => context.command === "\\htmlData",
  });
}

function validateLatex(source: string) {
  const trimmed = source.trim();
  if (!trimmed) return false;
  try {
    katex.renderToString(trimmed, {
      displayMode: true,
      throwOnError: true,
      strict: "ignore",
      trust: false,
    });
    return true;
  } catch {
    return false;
  }
}

function replacePart(source: string, part: EditablePart, nextValue: string) {
  const normalized = nextValue.trim();
  if (!normalized) return source;
  const replacement = part.bare ? `{${normalized}}` : normalized;
  return source.slice(0, part.start) + replacement + source.slice(part.end);
}

export default function StructuredMathEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { tl } = useI18n();
  const validLatex = useMemo(() => validateLatex(value), [value]);
  const parts = useMemo(() => validLatex ? analyzeLatex(value) : [], [validLatex, value]);
  const [rawMode, setRawMode] = useState(!validLatex);
  const [selected, setSelected] = useState<EditablePart | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!validLatex) {
      setRawMode(true);
      setSelected(null);
    }
  }, [validLatex]);

  useEffect(() => {
    if (!selected) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [selected]);

  const html = useMemo(() => {
    if (!validLatex || rawMode) return "";
    try {
      return renderInteractiveLatex(value.trim(), parts);
    } catch {
      return "";
    }
  }, [parts, rawMode, validLatex, value]);

  const partLabel = (kind: EditableKind) => {
    switch (kind) {
      case "integralLower": return tl("math_edit_integral_lower");
      case "integralUpper": return tl("math_edit_integral_upper");
      case "exponent": return tl("math_edit_exponent");
      case "subscript": return tl("math_edit_subscript");
      case "numerator": return tl("math_edit_numerator");
      case "denominator": return tl("math_edit_denominator");
      case "radicand": return tl("math_edit_radicand");
      case "rootIndex": return tl("math_edit_root_index");
    }
  };

  const pickPart = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const editable = target.closest<HTMLElement>("[data-edit-id]");
    if (!editable) return;
    event.preventDefault();
    const id = editable.dataset.editId;
    const part = parts.find((candidate) => candidate.id === id);
    if (!part) return;
    setSelected(part);
    setDraft(part.content);
  };

  const applySelected = () => {
    if (!selected || !draft.trim()) return;
    onChange(replacePart(value, selected, draft));
    setSelected(null);
  };

  if (!validLatex || rawMode || !html) {
    return (
      <div className="mt-2">
        {validLatex && (
          <div className="mb-2 flex justify-end">
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[10px] font-semibold text-frost/45 hover:bg-white/[0.05] hover:text-frost/70"
              onClick={() => setRawMode(false)}
            >
              <Braces size={13} />
              {tl("math_visual_mode")}
            </button>
          </div>
        )}
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="min-h-[112px] w-full resize-none rounded-xl border border-white/10 bg-white/[0.025] p-3 font-mono text-[12px] leading-5 text-frost outline-none focus:border-accent/55"
          aria-label={tl("recognized_board_title")}
        />
        {!validLatex && (
          <div className="mt-1.5 text-[10px] leading-4 text-frost/35">{tl("math_invalid_latex_hint")}</div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2" data-testid="structured-math-editor">
      <div
        className="structured-math-preview min-h-[112px] overflow-x-auto rounded-xl border border-white/10 bg-white/[0.025] px-4 py-3 text-[17px] text-frost"
        onClick={pickPart}
        dangerouslySetInnerHTML={{ __html: html }}
        aria-label={tl("math_visual_formula")}
      />

      <div className="mt-1.5 flex items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1.5 text-[10px] text-frost/35">
          <MousePointer2 size={12} />
          {parts.length > 0 ? tl("math_click_part_hint") : tl("math_formula_preview_hint")}
        </div>
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[10px] font-semibold text-frost/45 hover:bg-white/[0.05] hover:text-frost/70"
          onClick={() => {
            setSelected(null);
            setRawMode(true);
          }}
        >
          <Code2 size={12} />
          {tl("math_edit_latex")}
        </button>
      </div>

      {selected && (
        <div className="mt-2 rounded-xl border border-accent/20 bg-accent/[0.055] p-2.5">
          <div className="mb-1.5 text-[10px] font-semibold text-frost/55">{partLabel(selected.kind)}</div>
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applySelected();
                } else if (event.key === "Escape") {
                  setSelected(null);
                }
              }}
              className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-black/15 px-2.5 font-mono text-[12px] text-frost outline-none focus:border-accent/55"
              aria-label={partLabel(selected.kind)}
            />
            <Button size="sm" className="h-9 px-3 text-[11px]" onClick={applySelected} disabled={!draft.trim()}>
              {tl("math_apply")}
            </Button>
            <Button size="sm" variant="ghost" className="h-9 px-2.5 text-[11px]" onClick={() => setSelected(null)}>
              {tl("cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
