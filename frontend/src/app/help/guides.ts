import type { LocaleCode } from "@/i18n";

/**
 * The guides live in docs/guide/<language>/ so GitHub shows them as they are; the app bundles
 * the same files. Text loads on demand, pictures are plain URLs the browser fetches when shown.
 */
export type GuideKind = "teacher" | "admin";

const texts = import.meta.glob("../../../../docs/guide/*/*.md", { query: "?raw", import: "default" }) as Record<string, () => Promise<string>>;
const images = import.meta.glob("../../../../docs/guide/*/images/*.webp", { query: "?url", import: "default", eager: true }) as Record<string, string>;

const PREFIX = "../../../../docs/guide/";

export const GUIDE_LANGUAGES: LocaleCode[] = ["ru", "kk", "en"];

/** The guide in the asked language, falling back to Russian while a translation is missing. */
export async function loadGuide(kind: GuideKind, language: LocaleCode): Promise<{ text: string; language: LocaleCode }> {
  for (const candidate of [language, "ru" as LocaleCode]) {
    const load = texts[`${PREFIX}${candidate}/${kind}.md`];
    if (load) return { text: await load(), language: candidate };
  }
  throw new Error(`Guide ${kind} is missing`);
}

/** URL of a picture referenced from a guide as `images/<name>`. */
export function guideImage(language: LocaleCode, src: string): string | null {
  if (/^https?:/.test(src)) return src;
  return images[`${PREFIX}${language}/${src.replace(/^\.\//, "")}`] ?? images[`${PREFIX}ru/${src.replace(/^\.\//, "")}`] ?? null;
}

/** Which guide a link like `admin.md#5-...` points to, if it points to one. */
export function guideLink(href: string): { kind: GuideKind; anchor: string | null } | null {
  const match = /^(?:\.\/)?(?:\.\.\/[a-z]{2}\/)?(teacher|admin)\.md(?:#(.*))?$/.exec(href);
  return match ? { kind: match[1] as GuideKind, anchor: match[2] ? decodeURIComponent(match[2]) : null } : null;
}
