import { describe, expect, it } from "vitest";
import { GUIDE_LANGUAGES, loadGuide } from "./guides";
import { parseMarkdown } from "./markdown";
import { plainText, searchGuide, searchGuides } from "./search";

const guide = parseMarkdown([
  "# Руководство",
  "",
  "1. [Начало](#1-начало)",
  "",
  "## 1. Начало",
  "",
  "Откройте **Ёлку** и нажмите `Старт`.",
  "",
  "## 2. Линейка и циркуль",
  "",
  "### Циркуль",
  "",
  "- Поставьте иглу циркуля в центр окружности.",
  "",
  "| Инструмент | Где |",
  "|---|---|",
  "| Транспортир | В меню геометрии |",
].join("\n"));

describe("help search", () => {
  it("finds words regardless of case, ё and markdown marks", () => {
    const [hit] = searchGuide(guide, "елку старт", "teacher");
    expect(hit.section).toBe("1. Начало");
    expect(hit.slug).toBe("1-начало");
    expect(`${hit.snippet.before}${hit.snippet.match}${hit.snippet.after}`).toBe("Откройте Ёлку и нажмите Старт.");
    expect(hit.snippet.match).toBe("Ёлку");
  });

  it("needs every word of the query", () => {
    expect(searchGuide(guide, "ёлку циркуль", "teacher")).toEqual([]);
  });

  it("points at the subsection and ranks headings first", () => {
    const hits = searchGuide(guide, "циркул", "teacher");
    expect(hits.slice(0, 2).map((hit) => hit.slug).sort()).toEqual(["2-линейка-и-циркуль", "циркуль"]);
    expect(hits.find((hit) => hit.slug === "циркуль")?.subsection).toBe("Циркуль");
    // One hit per heading.
    expect(new Set(hits.map((hit) => hit.slug)).size).toBe(hits.length);
  });

  it("looks into tables and skips the contents list", () => {
    expect(searchGuide(guide, "транспортир", "teacher")[0].section).toBe("2. Линейка и циркуль");
    expect(searchGuide(guide, "начало", "teacher")).toHaveLength(1);
  });

  it("strips links and pictures to their text", () => {
    expect(plainText("См. [раздел 3](#3-x) и ![схема](images/a.webp) **жирно**")).toBe("См. раздел 3 и схема жирно");
  });

  it("finds common words in both real guides in every language", async () => {
    const words = { ru: "сервер", kk: "сервер", en: "server" } as const;
    for (const language of GUIDE_LANGUAGES) {
      const guides = Object.fromEntries(await Promise.all((["teacher", "admin"] as const).map(async (kind) => [kind, parseMarkdown((await loadGuide(kind, language)).text)])));
      const hits = searchGuides(guides, words[language]);
      expect(new Set(hits.map((hit) => hit.kind))).toEqual(new Set(["teacher", "admin"]));
      expect(hits.every((hit) => /^\d+\./.test(hit.section))).toBe(true);
    }
  });
});
