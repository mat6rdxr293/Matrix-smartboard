import { memo, useMemo } from "react";
import { BlockMath, InlineMath } from "react-katex";

function parseMath(text: string) {
  const parts: Array<{ type: "text" | "math"; value: string; display?: boolean }> = [];
  let i = 0;

  while (i < text.length) {
    const nextDollar = text.indexOf("$", i);
    if (nextDollar === -1) {
      parts.push({ type: "text", value: text.slice(i) });
      break;
    }
    if (nextDollar > i) {
      parts.push({ type: "text", value: text.slice(i, nextDollar) });
    }
    if (text[nextDollar + 1] === "$") {
      const end = text.indexOf("$$", nextDollar + 2);
      if (end === -1) {
        parts.push({ type: "text", value: text.slice(nextDollar) });
        break;
      }
      parts.push({ type: "math", value: text.slice(nextDollar + 2, end), display: true });
      i = end + 2;
    } else {
      const end = text.indexOf("$", nextDollar + 1);
      if (end === -1) {
        parts.push({ type: "text", value: text.slice(nextDollar) });
        break;
      }
      parts.push({ type: "math", value: text.slice(nextDollar + 1, end), display: false });
      i = end + 1;
    }
  }

  return parts;
}

function MathText({ text, className }: { text: string; className?: string }) {
  const parts = useMemo(() => parseMath(text), [text]);
  return (
    <div className={className}>
      {parts.map((part, idx) => {
        if (part.type === "math") {
          return part.display ? (
            <div key={idx} className="my-2">
              <BlockMath math={part.value} errorColor="#FFB86B" />
            </div>
          ) : (
            <InlineMath key={idx} math={part.value} errorColor="#FFB86B" />
          );
        }
        return (
          <span key={idx} className="whitespace-pre-wrap">
            {part.value}
          </span>
        );
      })}
    </div>
  );
}

export default memo(MathText);
