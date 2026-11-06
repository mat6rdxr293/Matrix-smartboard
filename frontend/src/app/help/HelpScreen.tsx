import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BookOpen, LoaderCircle, Search, Wrench, X } from "lucide-react";
import { useI18n, type LocaleCode } from "@/i18n";
import { cn } from "@/lib/utils";
import { GUIDE_LANGUAGES, guideImage, guideLink, loadGuide, type GuideKind } from "./guides";
import { closeHelp, openHelp, useHelpState } from "./helpStore";
import { parseMarkdown, renderInline, type Block } from "./markdown";
import { queryWords, searchGuides, type SearchHit } from "./search";

const LANGUAGE_LABELS: Record<LocaleCode, string> = { ru: "RU", kk: "ҚАЗ", en: "EN" };
const anchorId = (slug: string) => `help-${slug}`;
const HIGHLIGHT = "help-search";
/** Shorter queries match almost everything. */
const MIN_QUERY = 2;

/** Marks the searched words in the open guide without touching its elements (CSS Custom Highlight API). */
function highlightWords(root: HTMLElement | null, words: string[]) {
  const registry = (globalThis.CSS as unknown as { highlights?: Map<string, unknown> } | undefined)?.highlights;
  const HighlightClass = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry || !HighlightClass) return;
  registry.delete(HIGHLIGHT);
  if (!root || !words.length) return;
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const folded = (node.textContent ?? "").toLowerCase().replace(/ё/g, "е");
    for (const word of words) {
      for (let at = folded.indexOf(word); at !== -1; at = folded.indexOf(word, at + word.length)) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + word.length);
        ranges.push(range);
      }
    }
  }
  if (ranges.length) registry.set(HIGHLIGHT, new HighlightClass(...ranges));
}

/** Mounted once at the root: shows the guide that openHelp() asked for, over everything. */
export function HelpHost() {
  const help = useHelpState();
  if (!help) return null;
  return <HelpScreen kind={help.kind} anchor={help.anchor} />;
}

function HelpScreen({ kind, anchor }: { kind: GuideKind; anchor: string | null }) {
  const { tl, locale } = useI18n();
  const [language, setLanguage] = useState<LocaleCode>(locale);
  const [guide, setGuide] = useState<{ blocks: Block[]; language: LocaleCode } | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingAnchor = useRef<string | null>(anchor);
  const articleRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [showResults, setShowResults] = useState(false);
  const [marked, setMarked] = useState<string[]>([]);
  const [index, setIndex] = useState<{ language: LocaleCode; guides: Partial<Record<GuideKind, Block[]>> } | null>(null);
  const searching = query.trim().length >= MIN_QUERY;

  useEffect(() => { pendingAnchor.current = anchor; }, [anchor]);

  useEffect(() => {
    let cancelled = false;
    setGuide(null);
    setFailed(false);
    loadGuide(kind, language)
      .then(({ text, language: shown }) => { if (!cancelled) setGuide({ blocks: parseMarkdown(text), language: shown }); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [kind, language]);

  // Jump to the asked section once the text is in, otherwise start from the top.
  useEffect(() => {
    if (!guide) return;
    const target = pendingAnchor.current;
    pendingAnchor.current = null;
    // A bare number names a section by its number, which is the same in every translation.
    const numbered = target && /^\d+$/.test(target)
      ? guide.blocks.find((block) => block.type === "heading" && block.level === 2 && block.text.startsWith(`${target}.`))
      : null;
    const slug = numbered && numbered.type === "heading" ? numbered.id : target;
    const element = slug ? document.getElementById(anchorId(slug)) : null;
    if (element) element.scrollIntoView({ block: "start" });
    else scrollRef.current?.scrollTo({ top: 0 });
  }, [guide]);

  // Search covers both guides in the shown language; they are read once a search starts.
  useEffect(() => {
    if (!searching || index?.language === language) return;
    let cancelled = false;
    Promise.all((["teacher", "admin"] as const).map(async (value) => [value, parseMarkdown((await loadGuide(value, language)).text)] as const))
      .then((entries) => { if (!cancelled) setIndex({ language, guides: Object.fromEntries(entries) }); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [searching, language, index]);

  const hits = useMemo(() => (searching && index ? searchGuides(index.guides, query) : []), [searching, index, query]);
  const resultsOpen = searching && showResults;

  useEffect(() => {
    highlightWords(resultsOpen ? null : articleRef.current, marked);
  }, [marked, guide, resultsOpen]);
  useEffect(() => () => highlightWords(null, []), []);
  useEffect(() => { if (resultsOpen) scrollRef.current?.scrollTo({ top: 0 }); }, [resultsOpen, query]);

  const escape = useRef(() => closeHelp());
  escape.current = () => {
    if (query) { setQuery(""); setMarked([]); }
    else closeHelp();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") escape.current(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openHit = (hit: SearchHit) => {
    setShowResults(false);
    setMarked(queryWords(query));
    searchRef.current?.blur();
    if (hit.kind === kind) requestAnimationFrame(() => goTo(hit.slug, "auto"));
    else openHelp(hit.kind, hit.slug);
  };

  const goTo = (slug: string, behavior: ScrollBehavior = "smooth") => document.getElementById(anchorId(slug))?.scrollIntoView({ behavior, block: "start" });

  const link = (href: string, children: ReactNode, key: string) => {
    const className = "font-medium text-accent underline decoration-accent/40 underline-offset-2";
    if (href.startsWith("#")) {
      return <a key={key} href={href} className={className} onClick={(event) => { event.preventDefault(); goTo(decodeURIComponent(href.slice(1))); }}>{children}</a>;
    }
    const target = guideLink(href);
    if (target) {
      return (
        <a key={key} href={href} className={className} onClick={(event) => {
          event.preventDefault();
          if (target.kind === kind) { if (target.anchor) goTo(target.anchor); }
          else openHelp(target.kind, target.anchor);
        }}>{children}</a>
      );
    }
    if (/^https?:\/\//.test(href)) return <a key={key} href={href} target="_blank" rel="noreferrer" className={className}>{children}</a>;
    // Links to repository files mean nothing inside the app.
    return <span key={key}>{children}</span>;
  };

  const contents = useMemo(() => guide?.blocks.filter((block): block is Extract<Block, { type: "heading" }> => block.type === "heading" && block.level === 2) ?? [], [guide]);
  const title = guide?.blocks.find((block): block is Extract<Block, { type: "heading" }> => block.type === "heading" && block.level === 1);

  const renderBlocks = (blocks: Block[], prefix: string): ReactNode[] => blocks.map((block, index) => {
    const key = `${prefix}-${index}`;
    const inline = (text: string) => renderInline(text, { link }, key);
    switch (block.type) {
      case "heading": {
        if (block.level === 1) return null;
        const Tag = block.level === 2 ? "h2" : "h3";
        return (
          <Tag key={key} id={anchorId(block.id)} className={cn(
            "scroll-mt-4 font-semibold tracking-[-0.01em] text-frost",
            block.level === 2 ? "mt-10 border-t border-white/10 pt-8 text-2xl first:mt-0 first:border-0 first:pt-0" : "mt-7 text-lg",
          )}>{inline(block.text)}</Tag>
        );
      }
      case "paragraph":
        return <p key={key} className="mt-3 text-[15px] leading-7 text-frost/75">{inline(block.text)}</p>;
      case "image": {
        const src = guideImage(guide?.language ?? language, block.src);
        if (!src) return null;
        return (
          <button key={key} type="button" className="mt-4 block w-full overflow-hidden rounded-xl border border-white/10 bg-black/20 text-left"
            onClick={() => setZoomed({ src, alt: block.alt })} aria-label={block.alt}>
            <img src={src} alt={block.alt} loading="lazy" className="block h-auto w-full" />
          </button>
        );
      }
      case "code":
        return <pre key={key} className="mt-3 overflow-x-auto rounded-xl border border-white/10 bg-black/30 p-3 font-mono text-[13px] leading-6 text-frost/85">{block.text}</pre>;
      case "rule":
        return null;
      case "quote":
        return <div key={key} className="mt-4 rounded-xl border border-accent/25 bg-accent/[0.06] px-4 py-1 pb-3">{renderBlocks(block.blocks, key)}</div>;
      case "list": {
        const List = block.ordered ? "ol" : "ul";
        return (
          <List key={key} className={cn("mt-3 space-y-1.5 pl-6 text-[15px] leading-7 text-frost/75 marker:text-frost/40", block.ordered ? "list-decimal" : "list-disc")}>
            {block.items.map((item, itemIndex) => (
              <li key={`${key}-${itemIndex}`} className="[&>p:first-child]:mt-0">{renderBlocks(item, `${key}-${itemIndex}`)}</li>
            ))}
          </List>
        );
      }
      case "table":
        return (
          <div key={key} className="mt-4 overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full border-collapse text-left text-[14px] leading-6">
              <thead className="bg-white/[0.04] text-frost">
                <tr>{block.head.map((cell, cellIndex) => <th key={cellIndex} className="px-3 py-2 font-semibold">{renderInline(cell, { link }, `${key}-h${cellIndex}`)}</th>)}</tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex} className="border-t border-white/[0.07] text-frost/75">
                    {row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2 align-top">{renderInline(cell, { link }, `${key}-${rowIndex}-${cellIndex}`)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });

  // The table of contents at the top of each guide is replaced by the side column.
  const bodyBlocks = useMemo(() => {
    if (!guide) return [];
    const firstSection = guide.blocks.findIndex((block) => block.type === "heading" && block.level === 2);
    const intro = guide.blocks.slice(0, Math.max(0, firstSection)).filter((block) => !(block.type === "list" && block.ordered) && !(block.type === "paragraph" && /^\*\*[^*]+\*\*$/.test(block.text)));
    return [...intro, ...guide.blocks.slice(Math.max(0, firstSection))];
  }, [guide]);

  return (
    // data-floating-panel keeps the native ink layer from taking touches anywhere under help.
    <div data-floating-panel data-testid="help-screen" className="fixed inset-0 z-[200] flex flex-col bg-ink text-frost" role="dialog" aria-modal="true" aria-label={tl("help")}>
      <style>{`::highlight(${HIGHLIGHT}) { background-color: rgb(250 204 21 / 0.35); color: inherit; }`}</style>
      <header className="flex flex-wrap items-center gap-3 border-b border-white/10 px-4 py-3 sm:px-6">
        <div className="mr-auto flex min-w-0 items-center gap-2">
          <BookOpen size={20} className="shrink-0 text-accent" />
          <div className="truncate text-lg font-semibold">{tl("help")}</div>
        </div>
        <label className="order-last flex h-11 w-full items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 focus-within:border-accent/50 md:order-none md:w-72">
          <Search size={16} className="shrink-0 text-frost/40" />
          <input ref={searchRef} type="search" value={query} placeholder={tl("help_search")} aria-label={tl("help_search")}
            data-testid="help-search"
            onChange={(event) => { setQuery(event.target.value); setShowResults(true); setMarked([]); }}
            onFocus={() => setShowResults(true)}
            onKeyDown={(event) => { if (event.key === "Enter" && hits[0]) openHit(hits[0]); }}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-frost outline-none placeholder:text-frost/35 [&::-webkit-search-cancel-button]:hidden" />
          {query && (
            <button type="button" onClick={() => { setQuery(""); setMarked([]); searchRef.current?.focus(); }} aria-label={tl("help_search_clear")}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-frost/50 hover:text-frost">
              <X size={16} />
            </button>
          )}
        </label>
        <div className="flex rounded-xl border border-white/10 bg-white/[0.03] p-1">
          {([["teacher", tl("help_for_teacher"), BookOpen], ["admin", tl("help_for_admin"), Wrench]] as const).map(([value, label, Icon]) => (
            <button key={value} type="button" aria-pressed={kind === value} onClick={() => kind !== value && openHelp(value)}
              className={cn("flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] font-semibold transition", kind === value ? "bg-accent text-accentText" : "text-frost/60 hover:text-frost")}>
              <Icon size={15} />{label}
            </button>
          ))}
        </div>
        <div className="flex rounded-xl border border-white/10 bg-white/[0.03] p-1">
          {GUIDE_LANGUAGES.map((code) => (
            <button key={code} type="button" aria-pressed={language === code} onClick={() => setLanguage(code)}
              className={cn("h-9 min-w-[46px] rounded-lg px-2 text-[12px] font-semibold transition", language === code ? "bg-white/[0.12] text-frost" : "text-frost/50 hover:text-frost")}>
              {LANGUAGE_LABELS[code]}
            </button>
          ))}
        </div>
        <button type="button" onClick={closeHelp} aria-label={tl("close")} title={tl("close")}
          className="grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-white/[0.03] text-frost/70 hover:text-frost">
          <X size={20} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {contents.length > 0 && (
          <nav className="hidden w-72 shrink-0 overflow-y-auto border-r border-white/10 px-3 py-4 lg:block" aria-label={tl("help_contents")}>
            <div className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-frost/40">{tl("help_contents")}</div>
            {contents.map((heading) => (
              <button key={heading.id} type="button" onClick={() => goTo(heading.id)}
                className="block w-full rounded-lg px-2 py-1.5 text-left text-[13px] leading-5 text-frost/65 hover:bg-white/[0.05] hover:text-frost">
                {heading.text.replace(/\*\*|`/g, "")}
              </button>
            ))}
          </nav>
        )}
        <div ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-8">
          {resultsOpen && (
            <div className="mx-auto max-w-3xl pb-16" data-testid="help-search-results">
              {!index && <LoaderCircle size={22} className="mx-auto mt-16 animate-spin text-accent" />}
              {index && !hits.length && <p className="mt-10 text-center text-[15px] text-frost/50">{tl("help_search_empty")}</p>}
              {hits.length > 0 && <div className="pb-2 text-[12px] text-frost/40">{tl("help_search_found", { count: hits.length })}</div>}
              <div className="space-y-2">
                {hits.map((hit) => (
                  <button key={`${hit.kind}-${hit.slug}`} type="button" onClick={() => openHit(hit)}
                    className="block w-full rounded-xl border border-white/10 bg-white/[0.025] px-4 py-3 text-left transition hover:border-accent/40 hover:bg-white/[0.05]">
                    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-frost/40">
                      {hit.kind === "teacher" ? <BookOpen size={12} /> : <Wrench size={12} />}
                      {hit.kind === "teacher" ? tl("help_for_teacher") : tl("help_for_admin")}
                    </div>
                    <div className="mt-1 text-[15px] font-semibold leading-6 text-frost">
                      {hit.section}{hit.subsection && <span className="font-normal text-frost/55"> › {hit.subsection}</span>}
                    </div>
                    {![hit.section, hit.subsection].includes(hit.snippet.before + hit.snippet.match + hit.snippet.after) && (
                      <div className="mt-1 text-[14px] leading-6 text-frost/60">
                        {hit.snippet.before}<mark className="rounded bg-accent/25 px-0.5 text-frost">{hit.snippet.match}</mark>{hit.snippet.after}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
          <article ref={articleRef} className={cn("mx-auto max-w-3xl pb-16", resultsOpen && "hidden")}>
            {failed && <p className="text-sm text-danger">{tl("help_load_failed")}</p>}
            {!guide && !failed && <LoaderCircle size={22} className="mx-auto mt-16 animate-spin text-accent" />}
            {guide && (
              <>
                {title && <h1 className="text-3xl font-bold tracking-[-0.03em]">{renderInline(title.text, { link }, "title")}</h1>}
                {guide.language !== language && <p className="mt-3 rounded-lg bg-white/[0.04] px-3 py-2 text-[13px] text-frost/55">{tl("help_translation_missing")}</p>}
                {renderBlocks(bodyBlocks, "b")}
              </>
            )}
          </article>
        </div>
      </div>

      {zoomed && (
        <button type="button" className="fixed inset-0 z-[210] grid place-items-center bg-black/90 p-4" onClick={() => setZoomed(null)} aria-label={tl("close")}>
          <img src={zoomed.src} alt={zoomed.alt} className="max-h-full max-w-full rounded-lg object-contain" />
        </button>
      )}
    </div>
  );
}
