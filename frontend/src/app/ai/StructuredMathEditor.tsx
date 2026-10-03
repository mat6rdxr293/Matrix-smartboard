import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
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

type CursorAtom = {
  id: string;
  start: number;
  end: number;
  before: number;
  after: number;
};

type CaretAnchor = {
  atomId: string;
  side: "before" | "after";
} | null;

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

const CLICKABLE_COMMANDS = new Set([
  "pi", "infty", "times", "div", "approx", "ne", "pm", "to", "le", "ge",
  "alpha", "beta", "theta", "Delta", "partial", "circ",
  "sin", "cos", "tan", "cot", "ln", "log",
]);

function readCommandEnd(source: string, start: number) {
  if (source[start] !== "\\") return start + 1;
  let end = start + 1;
  if (isLetter(source[end] ?? "")) {
    while (end < source.length && isLetter(source[end])) end += 1;
    return end;
  }
  return Math.min(source.length, end + 1);
}

function consumeAttachedScripts(source: string, from: number) {
  let cursor = from;
  for (let pass = 0; pass < 2; pass += 1) {
    let probe = cursor;
    while (probe < source.length && /\s/.test(source[probe])) probe += 1;
    if (source[probe] !== "^" && source[probe] !== "_") break;
    const arg = readArgument(source, probe + 1);
    if (!arg) break;
    cursor = arg.replaceEnd;
  }
  return cursor;
}

function analyzeCursorAtoms(source: string): CursorAtom[] {
  const atoms: CursorAtom[] = [];
  let counter = 0;

  for (let i = 0; i < source.length;) {
    const char = source[i];

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (char === "\\") {
      const end = readCommandEnd(source, i);
      const command = source.slice(i + 1, end);
      if (command === "left" || command === "right") {
        if (source[end] === "\\") {
          i = readCommandEnd(source, end);
        } else {
          const delimiterCodePoint = source.codePointAt(end);
          i = delimiterCodePoint == null ? end : end + (delimiterCodePoint > 0xffff ? 2 : 1);
        }
        continue;
      }
      if (CLICKABLE_COMMANDS.has(command)) {
        let semanticEnd = end;
        while (semanticEnd < source.length && /\s/.test(source[semanticEnd])) semanticEnd += 1;
        atoms.push({
          id: "cursor-" + counter++,
          start: i,
          end,
          before: i,
          after: consumeAttachedScripts(source, semanticEnd),
        });
      }
      i = end;
      continue;
    }

    if (char === "{" || char === "}" || char === "[" || char === "]" || char === "^" || char === "_") {
      i += 1;
      continue;
    }

    const codePoint = source.codePointAt(i);
    if (codePoint == null) {
      i += 1;
      continue;
    }
    const width = codePoint > 0xffff ? 2 : 1;
    const end = i + width;
    atoms.push({
      id: "cursor-" + counter++,
      start: i,
      end,
      before: i,
      after: consumeAttachedScripts(source, end),
    });
    i = end;
  }

  return atoms;
}

function buildCursorStops(source: string, parts: EditablePart[], atoms: CursorAtom[]) {
  const stops = new Set<number>([0, source.length]);
  for (const atom of atoms) {
    stops.add(atom.before);
    stops.add(atom.after);
  }
  for (const part of parts) {
    stops.add(part.start);
    stops.add(part.end);
  }
  return [...stops]
    .filter((position) => position >= 0 && position <= source.length)
    .sort((a, b) => a - b);
}

function findCaretAnchor(atoms: CursorAtom[], caretPos: number): CaretAnchor {
  const before = atoms.find((atom) => atom.before === caretPos);
  if (before) return { atomId: before.id, side: "before" };

  const after = [...atoms].reverse().find((atom) => atom.after === caretPos);
  if (after) {
    if (after.after > after.end) {
      const nested = atoms
        .filter((atom) => atom.start >= after.end && atom.end <= after.after)
        .sort((a, b) => b.end - a.end)[0];
      if (nested) return { atomId: nested.id, side: "after" };
    }
    return { atomId: after.id, side: "after" };
  }

  const previous = atoms
    .filter((atom) => atom.end <= caretPos)
    .sort((a, b) => b.end - a.end)[0];
  return previous ? { atomId: previous.id, side: "after" } : null;
}

function renderInteractiveLatex(
  source: string,
  parts: EditablePart[],
  atoms: CursorAtom[],
  caretPos: number,
  activePartId: string | null,
) {
  type Wrapper = { start: number; end: number; open: string; close: string };
  const wrappers: Wrapper[] = [];
  const empties = new Map<number, EditablePart[]>();
  const anchor = findCaretAnchor(atoms, caretPos);

  for (const part of parts) {
    if (part.start === part.end) {
      const list = empties.get(part.start) ?? [];
      list.push(part);
      empties.set(part.start, list);
      continue;
    }

    const active = activePartId === part.id;
    const prefix = part.bare ? "{" : "";
    const activePrefix = active ? "\\htmlClass{math-edit-active}{" : "";
    wrappers.push({
      start: part.start,
      end: part.end,
      open: prefix + activePrefix + "\\htmlData{edit-id=" + part.id + "}{",
      close: part.bare ? (active ? "}}}" : "}}") : (active ? "}}" : "}"),
    });
  }

  for (const atom of atoms) {
    const caretClass =
      anchor?.atomId === atom.id
        ? (anchor.side === "before" ? "math-caret-before" : "math-caret-after")
        : null;
    const classPrefix = caretClass ? "\\htmlClass{" + caretClass + "}{" : "";
    wrappers.push({
      start: atom.start,
      end: atom.end,
      open:
        classPrefix +
        "\\htmlData{cursor-atom=" + atom.id +
        ",cursor-before=" + atom.before +
        ",cursor-after=" + atom.after + "}{",
      close: caretClass ? "}}" : "}",
    });
  }

  const opens = new Map<number, Wrapper[]>();
  const closes = new Map<number, Wrapper[]>();
  for (const wrapper of wrappers) {
    const open = opens.get(wrapper.start) ?? [];
    open.push(wrapper);
    opens.set(wrapper.start, open);
    const close = closes.get(wrapper.end) ?? [];
    close.push(wrapper);
    closes.set(wrapper.end, close);
  }
  for (const group of opens.values()) group.sort((a, b) => b.end - a.end);
  for (const group of closes.values()) group.sort((a, b) => b.start - a.start);

  let marked = "";
  for (let i = 0; i <= source.length; i += 1) {
    const closing = closes.get(i);
    if (closing) for (const wrapper of closing) marked += wrapper.close;

    const empty = empties.get(i);
    if (empty) {
      for (const part of empty) {
        const active = activePartId === part.id;
        const caret = caretPos === part.start ? "\\htmlClass{math-caret-empty}{" : "";
        const activePrefix = active ? "\\htmlClass{math-edit-active}{" : "";
        const body = "\\htmlData{edit-id=" + part.id + ",cursor-pos=" + part.start + "}{\\vphantom{0}\\kern0.42em}";
        marked += caret + activePrefix + body + (active ? "}" : "") + (caret ? "}" : "");
      }
    }

    const opening = opens.get(i);
    if (opening) for (const wrapper of opening) marked += wrapper.open;

    if (i < source.length) marked += source[i];
  }

  if (!source.length) {
    marked = "\\htmlClass{math-caret-empty}{\\htmlData{cursor-pos=0}{\\vphantom{0}\\kern1em}}";
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
  const replacement = part.bare ? `{${nextValue}}` : nextValue;
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
  const atoms = useMemo(() => validLatex ? analyzeCursorAtoms(value) : [], [validLatex, value]);
  const cursorStops = useMemo(
    () => validLatex ? buildCursorStops(value, parts, atoms) : [0],
    [atoms, parts, validLatex, value],
  );
  const [rawMode, setRawMode] = useState(!validLatex);
  const [caretPos, setCaretPos] = useState(() => value.length);
  const [pendingCaretTarget, setPendingCaretTarget] = useState<{
    kind: string;
    from: number;
    to: number;
  } | null>(null);

  const activePart = useMemo(() => {
    const matches = parts.filter((part) =>
      part.start === part.end
        ? caretPos === part.start
        : part.bare
          ? caretPos >= part.start && caretPos < part.end
          : caretPos >= part.start && caretPos <= part.end,
    );
    return matches.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] ?? null;
  }, [caretPos, parts]);

  useEffect(() => {
    if (!validLatex) {
      setRawMode(true);
      setCaretPos(0);
      setPendingCaretTarget(null);
    }
  }, [validLatex]);


  useEffect(() => {
    if (!validLatex) return;
    setCaretPos((current) => Math.max(0, Math.min(value.length, current)));
  }, [validLatex, value.length]);

  useEffect(() => {
    if (!pendingCaretTarget) return;
    const matches = parts
      .filter(
        (part) =>
          part.kind === pendingCaretTarget.kind &&
          part.start >= pendingCaretTarget.from &&
          part.start <= pendingCaretTarget.to + 2,
      )
      .sort((a, b) => a.start - b.start);
    const target = matches[0];
    if (!target) return;
    setCaretPos(target.start);
    setPendingCaretTarget(null);
  }, [parts, pendingCaretTarget]);

  const html = useMemo(() => {
    if (!validLatex || rawMode) return "";
    try {
      return renderInteractiveLatex(value, parts, atoms, caretPos, activePart?.id ?? null);
    } catch {
      return "";
    }
  }, [activePart?.id, atoms, caretPos, parts, rawMode, validLatex, value]);

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

  const activeLabel = activePart ? partLabel(activePart.kind) : tl("math_edit_cursor");

  const placeCaretInBarePart = (part: EditablePart, localOffset: number) => {
    const offset = Math.max(0, Math.min(part.content.length, localOffset));
    const nextValue = replacePart(value, part, part.content);
    setCaretPos(part.start + 1 + offset);
    onChange(nextValue);
  };

  const pickCaret = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const target = event.target as HTMLElement;

    const atomElement = target.closest<HTMLElement>("[data-cursor-atom]");
    if (atomElement) {
      const before = Number(atomElement.dataset.cursorBefore);
      const after = Number(atomElement.dataset.cursorAfter);
      const rect = atomElement.getBoundingClientRect();
      const useAfter = rect.width <= 0 || event.clientX >= rect.left + rect.width / 2;
      const atom = atoms.find((item) => item.id === atomElement.dataset.cursorAtom);
      const barePart = atom
        ? parts.find(
            (part) =>
              part.bare &&
              atom.start >= part.start &&
              atom.end <= part.end,
          )
        : null;
      if (barePart) {
        placeCaretInBarePart(barePart, useAfter ? barePart.content.length : 0);
      } else {
        setCaretPos(useAfter ? after : before);
      }
      return;
    }

    const directCursor = target.closest<HTMLElement>("[data-cursor-pos]");
    if (directCursor) {
      const position = Number(directCursor.dataset.cursorPos);
      if (Number.isFinite(position)) setCaretPos(position);
      return;
    }

    const editable = target.closest<HTMLElement>("[data-edit-id]");
    if (editable) {
      const part = parts.find((item) => item.id === editable.dataset.editId);
      if (part) {
        const rect = editable.getBoundingClientRect();
        const useAfter = rect.width > 0 && event.clientX >= rect.left + rect.width / 2;
        if (part.bare) {
          placeCaretInBarePart(part, useAfter ? part.content.length : 0);
        } else {
          setCaretPos(useAfter ? part.end : part.start);
        }
        return;
      }
    }

    const root = event.currentTarget;
    const candidates = [...root.querySelectorAll<HTMLElement>("[data-cursor-atom]")];
    let best: { distance: number; position: number } | null = null;
    for (const candidate of candidates) {
      const rect = candidate.getBoundingClientRect();
      const before = Number(candidate.dataset.cursorBefore);
      const after = Number(candidate.dataset.cursorAfter);
      const x = Math.max(rect.left, Math.min(event.clientX, rect.right));
      const y = Math.max(rect.top, Math.min(event.clientY, rect.bottom));
      const dx = event.clientX - x;
      const dy = event.clientY - y;
      const distance = dx * dx + dy * dy;
      const position = event.clientX >= rect.left + rect.width / 2 ? after : before;
      if (!best || distance < best.distance) best = { distance, position };
    }
    if (best) setCaretPos(best.position);
  };

  const insertAtCaret = (latex: string, selectKind?: string) => {
    const position = Math.max(0, Math.min(value.length, caretPos));

    if (activePart?.bare && position >= activePart.start && position <= activePart.end) {
      const localOffset = Math.max(0, Math.min(activePart.content.length, position - activePart.start));
      const nextContent =
        activePart.content.slice(0, localOffset) + latex + activePart.content.slice(localOffset);
      const nextValue = replacePart(value, activePart, nextContent);
      const insertionStart = activePart.start + 1 + localOffset;
      if (selectKind) {
        setPendingCaretTarget({ kind: selectKind, from: insertionStart, to: insertionStart + latex.length });
      } else {
        setCaretPos(insertionStart + latex.length);
      }
      onChange(nextValue);
      return;
    }

    const nextValue = value.slice(0, position) + latex + value.slice(position);
    if (selectKind) {
      setPendingCaretTarget({ kind: selectKind, from: position, to: position + latex.length });
    } else {
      setCaretPos(position + latex.length);
    }
    onChange(nextValue);
  };

  const moveCaret = (direction: 1 | -1) => {
    if (cursorStops.length <= 1) return;
    const exact = cursorStops.indexOf(caretPos);
    if (exact >= 0) {
      const next = Math.max(0, Math.min(cursorStops.length - 1, exact + direction));
      const nextPosition = cursorStops[next];
      if (
        direction > 0 &&
        activePart?.bare &&
        caretPos >= activePart.start &&
        caretPos < activePart.end &&
        nextPosition >= activePart.end
      ) {
        placeCaretInBarePart(activePart, activePart.content.length);
        return;
      }
      setCaretPos(nextPosition);
      return;
    }

    if (direction > 0) {
      setCaretPos(cursorStops.find((position) => position > caretPos) ?? cursorStops[cursorStops.length - 1]);
    } else {
      setCaretPos([...cursorStops].reverse().find((position) => position < caretPos) ?? cursorStops[0]);
    }
  };

  const moveToNextField = () => {
    if (!parts.length) return;
    const ordered = [...parts].sort((a, b) => a.start - b.start || a.end - b.end);
    const currentIndex = activePart ? ordered.findIndex((part) => part.id === activePart.id) : -1;
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % ordered.length;
    setCaretPos(ordered[nextIndex].start);
  };

  const clearActive = () => {
    if (!activePart) {
      setCaretPos(0);
      onChange("");
      return;
    }
    const nextValue = replacePart(value, activePart, "");
    setCaretPos(activePart.start + (activePart.bare ? 1 : 0));
    onChange(nextValue);
  };

  const backspaceAtCaret = () => {
    const position = Math.max(0, Math.min(value.length, caretPos));
    if (position <= 0) return;

    if (activePart && position >= activePart.start && position <= activePart.end) {
      const localOffset = Math.max(0, Math.min(activePart.content.length, position - activePart.start));
      if (localOffset <= 0) return;
      const before = activePart.content.slice(0, localOffset);
      const nextBefore = removeLastMathAtom(before);
      const removed = before.length - nextBefore.length;
      const nextContent = nextBefore + activePart.content.slice(localOffset);
      const nextValue = replacePart(value, activePart, nextContent);
      const contentStart = activePart.start + (activePart.bare ? 1 : 0);
      setCaretPos(contentStart + Math.max(0, localOffset - removed));
      onChange(nextValue);
      return;
    }

    const before = value.slice(0, position);
    const nextBefore = removeLastMathAtom(before);
    if (nextBefore === before) return;
    setCaretPos(nextBefore.length);
    onChange(nextBefore + value.slice(position));
  };

  const handleKeyboard = (action: MathKeyboardAction) => {
    switch (action.type) {
      case "insert":
        insertAtCaret(action.latex);
        break;
      case "template":
        insertAtCaret(action.latex, action.selectKind);
        break;
      case "backspace":
        backspaceAtCaret();
        break;
      case "clear":
        clearActive();
        break;
      case "moveLeft":
        moveCaret(-1);
        break;
      case "moveRight":
        moveCaret(1);
        break;
      case "nextField":
        moveToNextField();
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
        className="structured-math-preview min-h-[108px] cursor-text overflow-x-auto rounded-xl border border-white/10 bg-white/[0.025] px-4 py-3 text-[18px] text-frost"
        onPointerDown={pickCaret}
        dangerouslySetInnerHTML={{ __html: html }}
        aria-label={tl("math_visual_formula")}
      />

      <div className="mt-1.5 flex items-center justify-between gap-3">
        <div className="inline-flex min-w-0 items-center gap-1.5 text-[10px] text-frost/35">
          <MousePointer2 size={12} className="shrink-0" />
          <span className="truncate">{tl("math_keyboard_caret_hint")}</span>
        </div>
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[10px] font-semibold text-frost/35 hover:bg-white/[0.05] hover:text-frost/60"
          onClick={() => setRawMode(true)}
        >
          <Code2 size={12} />
          {tl("math_advanced")}
        </button>
      </div>

      <MathKeyboard
        activeLabel={activeLabel}
        canNavigate={cursorStops.length > 1}
        canNextField={parts.length > 0}
        onAction={handleKeyboard}
      />
    </div>
  );
}
