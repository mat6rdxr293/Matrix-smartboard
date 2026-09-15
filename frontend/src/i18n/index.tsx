import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import ru from "@/i18n/locales/ru.json";
import kk from "@/i18n/locales/kk.json";
import type { Slide } from "@/app/presentation/Slides";

export type LocaleCode = "ru" | "kk";

type LocaleDict = {
  meta?: { name?: string };
  literal?: Record<string, string>;
  defaults?: { slides?: Slide[] };
};

const LOCALES: Record<LocaleCode, LocaleDict> = {
  ru,
  kk,
};

const STORAGE_KEY = "algebra.locale";

const interpolate = (template: string, vars?: Record<string, string | number>) => {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? `{${key}}`));
};

const normalizeLocale = (value: string | null | undefined): LocaleCode =>
  value === "kk" ? "kk" : "ru";

const localeFromUrl = (): LocaleCode | null => {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("lang");
  if (!raw) return null;
  return raw === "kk" || raw === "ru" ? raw : null;
};

const translateTextNode = (node: Text, literal: Record<string, string>) => {
  const raw = node.nodeValue ?? "";
  const trimmed = raw.trim();
  if (!trimmed) return;
  const translated = literal[trimmed];
  if (!translated || translated === trimmed) return;
  const start = raw.indexOf(trimmed);
  if (start < 0) return;
  node.nodeValue = `${raw.slice(0, start)}${translated}${raw.slice(start + trimmed.length)}`;
};

const translateElementNode = (element: Element, literal: Record<string, string>) => {
  const tag = element.tagName;
  if (tag === "SCRIPT" || tag === "STYLE") return;
  for (const attr of ["title", "placeholder", "aria-label"]) {
    const value = element.getAttribute(attr);
    if (!value) continue;
    const translated = literal[value];
    if (translated && translated !== value) {
      element.setAttribute(attr, translated);
    }
  }
};

const translateTree = (root: Node, literal: Record<string, string>) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
  let current: Node | null = walker.currentNode;
  while (current) {
    if (current.nodeType === Node.TEXT_NODE) {
      translateTextNode(current as Text, literal);
    } else if (current.nodeType === Node.ELEMENT_NODE) {
      translateElementNode(current as Element, literal);
    }
    current = walker.nextNode();
  }
};

type I18nContextValue = {
  locale: LocaleCode;
  setLocale: (next: LocaleCode) => void;
  tl: (source: string, vars?: Record<string, string | number>) => string;
  defaultSlides: Slide[];
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LocaleCode>(() => {
    if (typeof window === "undefined") return "ru";
    const fromUrl = localeFromUrl();
    if (fromUrl) return fromUrl;
    return normalizeLocale(window.localStorage.getItem(STORAGE_KEY));
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, locale);
  }, [locale]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const literal = LOCALES[locale].literal ?? {};
    if (!literal || Object.keys(literal).length === 0) return;
    const run = () => translateTree(document.body, literal);
    const id = window.setTimeout(run, 0);
    return () => window.clearTimeout(id);
  }, [locale]);

  const value = useMemo<I18nContextValue>(() => {
    const dict = LOCALES[locale] ?? LOCALES.ru;
    const literal = dict.literal ?? {};
    const tl = (source: string, vars?: Record<string, string | number>) =>
      interpolate(literal[source] ?? source, vars);
    const defaultSlides = (dict.defaults?.slides ?? LOCALES.ru.defaults?.slides ?? []).map((slide) => ({ ...slide }));
    return {
      locale,
      setLocale: setLocaleState,
      tl,
      defaultSlides,
    };
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside I18nProvider");
  return ctx;
}
