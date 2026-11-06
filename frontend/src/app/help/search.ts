import type { GuideKind } from "./guides";
import type { Block } from "./markdown";

/** One place in a guide where every word of the query was found. */
export type SearchHit = {
  kind: GuideKind;
  /** Title of the numbered section (h2) the hit is in. */
  section: string;
  /** Anchor of the nearest heading above the hit, to scroll to. */
  slug: string;
  /** Heading the hit sits under, when it is a subsection (h3). */
  subsection: string | null;
  /** Text around the hit; `match` is the first found word as it is written in the guide. */
  snippet: { before: string; match: string; after: string };
  score: number;
};

const SNIPPET_RADIUS = 70;
const MAX_HITS = 40;

/** Markdown inline marks are not part of what a reader sees, so they are not searched. */
export const plainText = (text: string) =>
  text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Same length as the input, so positions found in it point into the original text. */
const fold = (text: string) => text.toLowerCase().replace(/ё/g, "е");

export const queryWords = (query: string) =>
  Array.from(new Set(fold(query).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0)));

/** Every piece of text in a block with the heading it belongs to. */
function* texts(blocks: Block[]): Generator<{ text: string; heading?: Extract<Block, { type: "heading" }> }> {
  for (const block of blocks) {
    switch (block.type) {
      case "heading": yield { text: block.text, heading: block }; break;
      case "paragraph": case "code": yield { text: block.text }; break;
      case "image": if (block.alt) yield { text: block.alt }; break;
      case "quote": yield* texts(block.blocks); break;
      case "list": for (const item of block.items) yield* texts(item); break;
      case "table":
        yield { text: block.head.join(" · ") };
        for (const row of block.rows) yield { text: row.join(" · ") };
        break;
    }
  }
}

function snippetOf(text: string, start: number, length: number) {
  let from = Math.max(0, start - SNIPPET_RADIUS);
  let to = Math.min(text.length, start + length + SNIPPET_RADIUS);
  // Cut on spaces, not inside words.
  if (from > 0) { const space = text.indexOf(" ", from); if (space !== -1 && space < start) from = space + 1; }
  if (to < text.length) { const space = text.lastIndexOf(" ", to); if (space > start + length) to = space; }
  return {
    before: (from > 0 ? "…" : "") + text.slice(from, start),
    match: text.slice(start, start + length),
    after: text.slice(start + length, to) + (to < text.length ? "…" : ""),
  };
}

/**
 * Finds the query in a guide: a piece of text matches when it has every word of the query
 * (as the start of a word or inside one, ignoring case and ё/е). One hit per heading, the best one;
 * matches in headings come first.
 */
export function searchGuide(blocks: Block[], query: string, kind: GuideKind): SearchHit[] {
  const words = queryWords(query);
  if (!words.length) return [];
  const best = new Map<string, SearchHit>();
  let section: Extract<Block, { type: "heading" }> | null = null;
  let subsection: Extract<Block, { type: "heading" }> | null = null;

  for (const { text: raw, heading } of texts(blocks)) {
    if (heading) {
      if (heading.level === 2) { section = heading; subsection = null; }
      else if (heading.level >= 3) subsection = heading;
    }
    // The table of contents before the first section only repeats the headings.
    if (!section || heading?.level === 1) continue;
    const text = plainText(raw);
    const folded = fold(text);
    const positions = words.map((word) => folded.indexOf(word));
    if (positions.some((position) => position === -1)) continue;

    const wordStarts = words.filter((_, i) => positions[i] === 0 || !/[\p{L}\p{N}]/u.test(folded[positions[i] - 1])).length;
    const phrase = words.length > 1 && folded.includes(fold(query).trim());
    const score = (heading ? 100 : 10) + wordStarts * 5 + (phrase ? 20 : 0) - Math.min(text.length, 400) / 100;
    const first = positions.indexOf(Math.min(...positions));
    const anchor = (heading ?? subsection ?? section).id;
    const current = best.get(anchor);
    if (current && current.score >= score) continue;
    best.set(anchor, {
      kind,
      section: plainText(section.text),
      slug: anchor,
      subsection: subsection && subsection !== heading ? plainText(subsection.text) : heading && heading.level >= 3 ? plainText(heading.text) : null,
      snippet: snippetOf(text, positions[first], words[first].length),
      score,
    });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, MAX_HITS);
}

/** Search over several guides at once, best matches first. */
export function searchGuides(guides: Partial<Record<GuideKind, Block[]>>, query: string): SearchHit[] {
  return (Object.entries(guides) as [GuideKind, Block[]][])
    .flatMap(([kind, blocks]) => searchGuide(blocks, query, kind))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_HITS);
}
