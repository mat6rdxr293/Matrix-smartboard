import { memo, useMemo, type ReactNode } from "react";
import { BlockMath, InlineMath } from "react-katex";

type MathPart = {
  type: "text" | "math";
  value: string;
  display?: boolean;
};

const MATH_DELIMITERS = [
  { open: "$$", close: "$$", display: true },
  { open: "\\[", close: "\\]", display: true },
  { open: "\\(", close: "\\)", display: false },
  { open: "$", close: "$", display: false },
] as const;

function findNextMath(text: string, from: number) {
  let best: { index: number; open: string; close: string; display: boolean } | null = null;

  for (const delimiter of MATH_DELIMITERS) {
    let index = text.indexOf(delimiter.open, from);
    while (index !== -1) {
      if (delimiter.open === "$" && text[index + 1] === "$") {
        index = text.indexOf(delimiter.open, index + 2);
        continue;
      }
      if (!best || index < best.index || (index === best.index && delimiter.open.length > best.open.length)) {
        best = { index, ...delimiter };
      }
      break;
    }
  }

  return best;
}

function parseMath(text: string): MathPart[] {
  const parts: MathPart[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const next = findNextMath(text, cursor);
    if (!next) {
      parts.push({ type: "text", value: text.slice(cursor) });
      break;
    }

    if (next.index > cursor) {
      parts.push({ type: "text", value: text.slice(cursor, next.index) });
    }

    const contentStart = next.index + next.open.length;
    const end = text.indexOf(next.close, contentStart);
    if (end === -1) {
      parts.push({ type: "text", value: text.slice(next.index) });
      break;
    }

    parts.push({
      type: "math",
      value: text.slice(contentStart, end),
      display: next.display,
    });
    cursor = end + next.close.length;
  }

  if (text.length === 0) parts.push({ type: "text", value: "" });
  return parts;
}

const INLINE_MARKDOWN_RE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\x60[^\x60\n]+\x60|\*[^*\n]+\*|_[^_\n]+_)/g;

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(INLINE_MARKDOWN_RE)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(text.slice(cursor, index));

    const token = match[0];
    if ((token.startsWith("**") && token.endsWith("**")) || (token.startsWith("__") && token.endsWith("__"))) {
      nodes.push(<strong key={"strong-" + index} className="font-semibold text-inherit">{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("\x60") && token.endsWith("\x60")) {
      nodes.push(
        <code
          key={"code-" + index}
          className="rounded bg-black/10 px-1 py-0.5 font-mono text-[0.92em] dark:bg-white/10"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else {
      nodes.push(<em key={"em-" + index}>{token.slice(1, -1)}</em>);
    }

    cursor = index + token.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function MathText({ text, className }: { text: string; className?: string }) {
  const parts = useMemo(() => parseMath(text), [text]);

  return (
    <div className={className}>
      {parts.map((part, idx) => {
        if (part.type === "math") {
          return part.display ? (
            <div key={idx} className="my-2 overflow-x-auto">
              <BlockMath math={part.value} errorColor="#FFB86B" />
            </div>
          ) : (
            <InlineMath key={idx} math={part.value} errorColor="#FFB86B" />
          );
        }

        return (
          <span key={idx} className="whitespace-pre-wrap">
            {renderInlineMarkdown(part.value)}
          </span>
        );
      })}
    </div>
  );
}

export default memo(MathText);
