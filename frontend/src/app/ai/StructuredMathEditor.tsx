import { useEffect, useMemo, useState, type MouseEvent } from "react";
import katex from "katex";
import { Code2, MousePointer2 } from "lucide-react";
import { useI18n } from "@/i18n";
import MathKeyboard, { type MathKeyboardAction } from "./MathKeyboard";

type EditableKind =
  | "integralLower"
  | "integralUpper"
  | "integrand"
  | "exponent"
  | "subscript"
  | "numerator"
  | "denominator"
  | "radicand"
  | "rootIndex"
  | "functionArgument"
  | "groupArgument"
  | "summand";

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

function readBracedArgument(source: string, from: number): Arg | null {
  let cursor = from;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  if (source[cursor] !== "{") return null;
  return readArgument(source, cursor);
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
    if (!arg) return;
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

      const explicitIntegrand = readBracedArgument(source, cursor);
      add("integrand", explicitIntegrand);
      continue;
    }

    if (source.startsWith("\\sum", i) && !isLetter(source[i + 4] ?? "")) {
      let cursor = i + 4;
      for (let pass = 0; pass < 2; pass += 1) {
        while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
        const op = source[cursor];
        if (op !== "_" && op !== "^") break;
        consumedScripts.add(cursor);
        const arg = readArgument(source, cursor + 1);
        add(op === "_" ? "subscript" : "exponent", arg);
        if (!arg) break;
        cursor = arg.replaceEnd;
      }

      add("summand", readBracedArgument(source, cursor));
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

    const functionCommand = ["\\sin", "\\cos", "\\tan", "\\cot", "\\ln", "\\log"].find(
      (command) => source.startsWith(command + "\\left(", i),
    );
    if (functionCommand) {
      const argumentStart = i + functionCommand.length + "\\left(".length;
      add("functionArgument", readBracedArgument(source, argumentStart));
      continue;
    }

    const groupPrefix = ["\\left|", "\\left[", "\\left\\{"].find(
      (prefix) => source.startsWith(prefix, i),
    );
    if (groupPrefix) {
      add("groupArgument", readBracedArgument(source, i + groupPrefix.length));
      continue;
    }

    if ((source[i] === "^" || source[i] === "_") && !consumedScripts.has(i)) {
      add(source[i] === "^" ? "exponent" : "subscript", readArgument(source, i + 1));
    }
  }

  return parts;
}

function interactiveWrapper(part: EditablePart, body: string, active: boolean) {
  const marked = `\\htmlData{edit-id=${part.id}}{${body}}`;
  return active ? `\\htmlClass{math-edit-active}{${marked}}` : marked;
}

function renderInteractiveLatex(source: string, parts: EditablePart[], selectedId: string | null) {
  const opens = new Map<number, EditablePart[]>();
  const closes = new Map<number, EditablePart[]>();
  const empties = new Map<number, EditablePart[]>();

  for (const part of parts) {
    if (part.start === part.end) {
      const list = empties.get(part.start) ?? [];
      list.push(part);
      empties.set(part.start, list);
      continue;
    }

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
      for (const part of closing) {
        marked += part.bare ? (selectedId === part.id ? "}}}" : "}}") : (selectedId === part.id ? "}}" : "}");
      }
    }

    const empty = empties.get(i);
    if (empty) {
      for (const part of empty) {
        marked += interactiveWrapper(part, "\\vphantom{0}\\kern0.42em", selectedId === part.id);
      }
    }

    const opening = opens.get(i);
    if (opening) {
      for (const part of opening) {
        const prefix = part.bare ? "{" : "";
        const activePrefix = selectedId === part.id ? "\\htmlClass{math-edit-active}{" : "";
        marked += `${prefix}${activePrefix}\\htmlData{edit-id=${part.id}}{`;
      }
    }

    if (i < source.length) marked += source[i];
  }

  return katex.renderToString(marked, {
    displayMode: true,
    throwOnError: true,
    strict: "ignore",
    trust: (context) => context.command === "\\htmlData" || context.command === "\\htmlClass",
  });
}

function renderPlainLatex(source: string) {
  return katex.renderToString(source || "\\vphantom{0}\\kern1em", {
    displayMode: true,
    throwOnError: true,
    strict: "ignore",
    trust: false,
  });
}

function validateLatex(source: string) {
  if (!source.trim()) return true;
  try {
    renderPlainLatex(source.trim());
    return true;
  } catch {
    return false;
  }
}

function replacePart(source: string, part: EditablePart, nextValue: string) {
  const replacement = part.bare && nextValue ? `{${nextValue}}` : nextValue;
  return source.slice(0, part.start) + replacement + source.slice(part.end);
}

function findOpeningBrace(source: string, closeIndex: number) {
  let depth = 0;
  for (let i = closeIndex; i >= 0; i -= 1) {
    if (source[i] === "}") depth += 1;
    else if (source[i] === "{") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function removeLastMathAtom(source: string) {
  let end = source.length;
  while (end > 0 && /\s/.test(source[end - 1])) end -= 1;
  if (end === 0) return "";

  if (source[end - 1] === "}") {
    const open = findOpeningBrace(source, end - 1);
    if (open >= 0) {
      let commandStart = open;
      while (commandStart > 0 && /[A-Za-z]/.test(source[commandStart - 1])) commandStart -= 1;
      if (commandStart > 0 && source[commandStart - 1] === "\\") commandStart -= 1;
      if (commandStart > 0 && (source[commandStart - 1] === "^" || source[commandStart - 1] === "_")) commandStart -= 1;
      return source.slice(0, commandStart) + source.slice(end);
    }
  }

  const command = source.slice(0, end).match(/\\[A-Za-z]+\s*$/);
  if (command?.index != null) return source.slice(0, command.index);

  const chars = Array.from(source.slice(0, end));
  chars.pop();
  return chars.join("") + source.slice(end);
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingSelectKind, setPendingSelectKind] = useState<string | null>(null);

  const selectedPart = selectedId ? parts.find((part) => part.id === selectedId) ?? null : null;

  useEffect(() => {
    if (!validLatex) {
      setRawMode(true);
      setSelectedId(null);
    }
  }, [validLatex]);

  useEffect(() => {
    if (!pendingSelectKind) return;
    const matches = parts.filter((part) => part.kind === pendingSelectKind);
    if (!matches.length) return;
    setSelectedId(matches[matches.length - 1].id);
    setPendingSelectKind(null);
  }, [parts, pendingSelectKind]);

  useEffect(() => {
    if (selectedId && !selectedPart) setSelectedId(null);
  }, [selectedId, selectedPart]);

  const html = useMemo(() => {
    if (!validLatex || rawMode) return "";
    try {
      return renderInteractiveLatex(value.trim(), parts, selectedId);
    } catch {
      return "";
    }
  }, [parts, rawMode, selectedId, validLatex, value]);

  const partLabel = (kind: EditableKind) => {
    switch (kind) {
      case "integralLower": return tl("math_edit_integral_lower");
      case "integralUpper": return tl("math_edit_integral_upper");
      case "integrand": return tl("math_edit_integrand");
      case "exponent": return tl("math_edit_exponent");
      case "subscript": return tl("math_edit_subscript");
      case "numerator": return tl("math_edit_numerator");
      case "denominator": return tl("math_edit_denominator");
      case "radicand": return tl("math_edit_radicand");
      case "rootIndex": return tl("math_edit_root_index");
      case "functionArgument": return tl("math_edit_function_argument");
      case "groupArgument": return tl("math_edit_group_argument");
      case "summand": return tl("math_edit_summand");
    }
  };

  const activeLabel = selectedPart ? partLabel(selectedPart.kind) : tl("math_edit_whole_formula");

  const pickPart = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const editable = target.closest<HTMLElement>("[data-edit-id]");
    event.preventDefault();

    if (!editable) {
      setSelectedId(null);
      return;
    }

    const id = editable.dataset.editId ?? null;
    setSelectedId(id);
  };

  const updateActive = (transform: (current: string) => string, selectKind?: string) => {
    const current = selectedPart ? selectedPart.content : value;
    const nextContent = transform(current);
    const nextValue = selectedPart ? replacePart(value, selectedPart, nextContent) : nextContent;
    if (selectKind) setPendingSelectKind(selectKind);
    onChange(nextValue);
  };

  const moveSelection = (direction: 1 | -1) => {
    if (!parts.length) return;
    const currentIndex = selectedId ? parts.findIndex((part) => part.id === selectedId) : -1;
    const nextIndex =
      currentIndex < 0
        ? (direction > 0 ? 0 : parts.length - 1)
        : (currentIndex + direction + parts.length) % parts.length;
    setSelectedId(parts[nextIndex].id);
  };

  const handleKeyboard = (action: MathKeyboardAction) => {
    switch (action.type) {
      case "insert":
        updateActive((current) => current + action.latex);
        break;
      case "template":
        updateActive((current) => current + action.latex, action.selectKind);
        break;
      case "backspace":
        updateActive(removeLastMathAtom);
        break;
      case "clear":
        updateActive(() => "");
        break;
      case "previous":
        moveSelection(-1);
        break;
      case "next":
        moveSelection(1);
        break;
    }
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
        className="structured-math-preview min-h-[108px] overflow-x-auto rounded-xl border border-white/10 bg-white/[0.025] px-4 py-3 text-[18px] text-frost"
        onClick={pickPart}
        dangerouslySetInnerHTML={{ __html: html }}
        aria-label={tl("math_visual_formula")}
      />

      <div className="mt-1.5 flex items-center justify-between gap-3">
        <div className="inline-flex min-w-0 items-center gap-1.5 text-[10px] text-frost/35">
          <MousePointer2 size={12} className="shrink-0" />
          <span className="truncate">
            {parts.length > 0 ? tl("math_keyboard_tap_hint") : tl("math_keyboard_formula_hint")}
          </span>
        </div>
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[10px] font-semibold text-frost/35 hover:bg-white/[0.05] hover:text-frost/60"
          onClick={() => {
            setSelectedId(null);
            setRawMode(true);
          }}
        >
          <Code2 size={12} />
          {tl("math_advanced")}
        </button>
      </div>

      <MathKeyboard
        activeLabel={activeLabel}
        canNavigate={parts.length > 0}
        onAction={handleKeyboard}
      />
    </div>
  );
}
