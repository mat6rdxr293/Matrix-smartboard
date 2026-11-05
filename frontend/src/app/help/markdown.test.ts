import { describe, expect, it } from "vitest";
import { GUIDE_LANGUAGES, guideImage, guideLink, loadGuide, type GuideKind } from "./guides";
import { parseMarkdown, slugify, type Block } from "./markdown";

describe("guide markdown", () => {
  it("makes the anchors GitHub makes", () => {
    expect(slugify("1. Начало урока за одну минуту")).toBe("1-начало-урока-за-одну-минуту");
    expect(slugify("10. Экран «Сервер»: мониторинг, обновление, резервные копии")).toBe("10-экран-сервер-мониторинг-обновление-резервные-копии");
    expect(slugify("7. Server ID and the key **PIN**")).toBe("7-server-id-and-the-key-pin");
  });

  it("reads headings, lists with nested pictures and code, tables and quotes", () => {
    const blocks = parseMarkdown([
      "# Title",
      "",
      "Intro with **bold** and `code`.",
      "",
      "- **Ruler.** Draw along it.",
      "",
      "  ![Ruler](images/ruler.webp)",
      "",
      "- Second",
      "",
      "1. Step",
      "   ```bash",
      "   adb install -r app.apk",
      "   ```",
      "2. Next",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "> **Note.** Kept.",
      ">",
      "> ![Pic](images/pic.webp)",
    ].join("\n"));
    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "list", "list", "table", "quote"]);
    const bullets = blocks[2] as Extract<Block, { type: "list" }>;
    expect(bullets.items).toHaveLength(2);
    expect(bullets.items[0].map((block) => block.type)).toEqual(["paragraph", "image"]);
    const steps = blocks[3] as Extract<Block, { type: "list" }>;
    expect(steps.ordered).toBe(true);
    expect(steps.items[0][1]).toEqual({ type: "code", text: "adb install -r app.apk" });
    expect((blocks[4] as Extract<Block, { type: "table" }>).rows).toEqual([["1", "2"]]);
    expect((blocks[5] as Extract<Block, { type: "quote" }>).blocks.map((block) => block.type)).toEqual(["paragraph", "image"]);
  });

  it("recognises links between the guides", () => {
    expect(guideLink("admin.md#5-путь")).toEqual({ kind: "admin", anchor: "5-путь" });
    expect(guideLink("teacher.md")).toEqual({ kind: "teacher", anchor: null });
    expect(guideLink("https://example.com")).toBeNull();
  });
});

const collect = (blocks: Block[], out: { images: string[]; links: string[]; headings: string[]; numbers: string[] }) => {
  const inline = (text: string) => {
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) out.links.push(match[1]);
  };
  for (const block of blocks) {
    if (block.type === "heading") {
      out.headings.push(block.id);
      if (block.level === 2) out.numbers.push(block.text.split(".")[0]);
      inline(block.text);
    } else if (block.type === "paragraph") inline(block.text);
    else if (block.type === "image") out.images.push(block.src);
    else if (block.type === "quote") collect(block.blocks, out);
    else if (block.type === "list") block.items.forEach((item) => collect(item, out));
    else if (block.type === "table") [...block.head, ...block.rows.flat()].forEach(inline);
  }
  return out;
};

describe.each(GUIDE_LANGUAGES)("%s guides", (language) => {
  it.each<GuideKind>(["teacher", "admin"])("%s guide has every picture and every section it links to", async (kind) => {
    const guide = await loadGuide(kind, language);
    expect(guide.language).toBe(language);
    const found = collect(parseMarkdown(guide.text), { images: [], links: [], headings: [], numbers: [] });
    expect(found.images.length).toBeGreaterThan(5);
    for (const src of found.images) expect(guideImage(language, src), `${language}/${kind}: ${src}`).toMatch(/\.webp/);
    // Pictures are taken in the guide's own language.
    for (const src of found.images) expect(guideImage(language, src)).toContain(`/${language}/images/`);
    const others = collect(parseMarkdown((await loadGuide(kind === "admin" ? "teacher" : "admin", language)).text), { images: [], links: [], headings: [], numbers: [] });
    for (const href of found.links) {
      if (href.startsWith("#")) expect(found.headings, `${language}/${kind}: ${href}`).toContain(decodeURIComponent(href.slice(1)));
      const target = guideLink(href);
      if (target?.anchor) {
        const headings = target.kind === kind ? found.headings : others.headings;
        expect(headings, `${language}/${kind}: ${href}`).toContain(target.anchor);
      }
    }
    // The app opens sections by number, so every translation keeps the same numbering.
    const russian = collect(parseMarkdown((await loadGuide(kind, "ru")).text), { images: [], links: [], headings: [], numbers: [] });
    expect(found.numbers).toEqual(russian.numbers);
  });
});

