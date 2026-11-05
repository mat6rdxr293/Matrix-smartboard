import { Fragment, type ReactNode } from "react";

/**
 * Renders the subset of Markdown the guides in docs/guide use: headings, paragraphs, bold,
 * inline code, links, images, lists, tables, quotes, code blocks and rules. Everything becomes
 * React elements, so nothing in a guide is ever injected as HTML.
 */

export type Block =
  | { type: "heading"; level: number; text: string; id: string }
  | { type: "paragraph"; text: string }
  | { type: "image"; alt: string; src: string }
  | { type: "code"; text: string }
  | { type: "rule" }
  | { type: "quote"; blocks: Block[] }
  | { type: "list"; ordered: boolean; items: Block[][] }
  | { type: "table"; head: string[]; rows: string[][] };

/** The anchor GitHub gives a heading, so links written for GitHub work in the app too. */
export const slugify = (text: string) =>
  text
    .replace(/\*\*|`/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");

const LIST_ITEM = /^(\s*)(?:[-*]|(\d+)\.)\s+(.*)$/;
const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;

const splitRow = (line: string) =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

const dedent = (lines: string[], width: number) =>
  lines.map((line) => (line.slice(0, width).trim() === "" ? line.slice(width) : line.trimStart()));

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) body.push(lines[i++]);
      i += 1;
      const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), 99);
      blocks.push({ type: "code", text: body.map((l) => l.slice(indent === 99 ? 0 : indent)).join("\n") });
      continue;
    }
    if (!trimmed) { flush(); i += 1; continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2], id: slugify(heading[2]) });
      i += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) { flush(); blocks.push({ type: "rule" }); i += 1; continue; }

    const image = IMAGE_LINE.exec(trimmed);
    if (image) { flush(); blocks.push({ type: "image", alt: image[1], src: image[2] }); i += 1; continue; }

    if (trimmed.startsWith(">")) {
      flush();
      const body: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) body.push(lines[i++].trim().replace(/^>\s?/, ""));
      blocks.push({ type: "quote", blocks: parseMarkdown(body.join("\n")) });
      continue;
    }

    if (trimmed.startsWith("|") && i + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim())) {
      flush();
      const head = splitRow(trimmed);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(splitRow(lines[i++]));
      blocks.push({ type: "table", head, rows });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item && !paragraph.length) {
      const ordered = item[2] !== undefined;
      const baseIndent = item[1].length;
      const items: Block[][] = [];
      while (i < lines.length) {
        const current = LIST_ITEM.exec(lines[i]);
        if (!current || current[1].length !== baseIndent || (current[2] !== undefined) !== ordered) break;
        const contentIndent = lines[i].length - current[3].length;
        const body = [current[3]];
        i += 1;
        // Lines indented under the item, including blank lines between them, belong to it.
        while (i < lines.length) {
          const next = lines[i];
          if (!next.trim()) {
            const following = lines.slice(i + 1).find((l) => l.trim());
            if (following && following.length - following.trimStart().length > baseIndent) { body.push(""); i += 1; continue; }
            break;
          }
          const indent = next.length - next.trimStart().length;
          if (indent <= baseIndent) break;
          body.push(next);
          i += 1;
        }
        items.push(parseMarkdown([body[0], ...dedent(body.slice(1), contentIndent)].join("\n")));
        // A blank line between items keeps the list going.
        if (i < lines.length && !lines[i].trim()) {
          const following = lines.slice(i + 1).find((l) => l.trim());
          const nextItem = following ? LIST_ITEM.exec(following) : null;
          if (nextItem && nextItem[1].length === baseIndent && (nextItem[2] !== undefined) === ordered) {
            while (i < lines.length && !lines[i].trim()) i += 1;
          }
        }
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    paragraph.push(trimmed);
    i += 1;
  }
  flush();
  return blocks;
}

export type InlineHandlers = {
  /** Renders a link; the guide decides whether it scrolls, switches guide or opens a page. */
  link: (href: string, children: ReactNode, key: string) => ReactNode;
};

const INLINE = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g;

export function renderInline(text: string, handlers: InlineHandlers, keyPrefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyPrefix}-${n++}`;
    if (match[2] !== undefined) out.push(<strong key={key} className="font-semibold text-frost">{renderInline(match[2], handlers, key)}</strong>);
    else if (match[3] !== undefined) out.push(<code key={key} className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[0.88em] text-frost">{match[3]}</code>);
    else out.push(handlers.link(match[5], renderInline(match[4], handlers, key), key));
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.map((part, index) => (typeof part === "string" ? <Fragment key={`${keyPrefix}-t${index}`}>{part}</Fragment> : part));
}
