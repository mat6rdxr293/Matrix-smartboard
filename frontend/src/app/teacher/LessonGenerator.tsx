import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, BookOpen, CheckCircle2, ChevronRight, Eye, FileText, LayoutTemplate, Plus, RefreshCw, Search, TriangleAlert, Upload } from "lucide-react";
import type { Task } from "@/app/tasks/tasks";
import type { Slide } from "@/app/presentation/Slides";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/apiClient";
import { cn } from "@/lib/utils";
import MathFormula from "@/components/MathFormula";
import { useI18n } from "@/i18n";

type SourceSection = {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
};

type SourceBook = {
  id: string;
  label: string;
  filename?: string | null;
  status?: "queued" | "processing" | "ready" | "partial" | "error" | string;
  stage?: string;
  progress?: number;
  totalPages?: number;
  processedPages?: number;
  indexedPages?: number;
  ocrPages?: number;
  needsOcrPages?: number;
  searchReady?: boolean;
  error?: string | null;
  sections: SourceSection[];
};

type SearchResult = {
  page: number;
  section: string;
  sectionTitle: string;
  excerpt: string;
  rank: number;
};

type SourceCatalog = {
  mlDataAvailable: boolean;
  books: SourceBook[];
};

type GenerationProgress = {
  progress: number;
  stage: string;
  completed?: number | null;
  total?: number | null;
};

type GenerationResult = {
  workspace: {
    tasks: Task[];
    slides: Slide[];
  };
  meta: {
    title?: string;
    language?: "ru" | "kk" | "en";
    textSource?: string;
    textChars?: number;
    textCut?: boolean;
    checks?: Record<string, number>;
    timings?: Record<string, { totalSeconds?: number; attempts?: number }>;
  };
};

type Copy = {
  title: string;
  subtitle: string;
  textSource: string;
  textbookSource: string;
  material: string;
  materialHint: string;
  noBooks: string;
  book: string;
  section: string;
  lessonTitle: string;
  optional: string;
  language: string;
  auto: string;
  slides: string;
  tasks: string;
  generate: string;
  generating: string;
  replaceAll: string;
  addAll: string;
  replaceTasks: string;
  replaceSlides: string;
  preview: string;
  emptyPreview: string;
  source: string;
  verified: string;
  fixed: string;
  warning: string;
  generationError: string;
  addBook: string;
  addBookHint: string;
  indexing: string;
  indexedPages: string;
  sectionMode: string;
  searchMode: string;
  searchPlaceholder: string;
  noBooksTitle: string;
  noBooksBody: string;
  searchEmpty: string;
  searchPages: string;
  processingReady: string;
  reprocess: string;
  chooseTitle: string;
  chooseSubtitle: string;
  textSourceDescription: string;
  textbookSourceDescription: string;
  changeMethod: string;
  readyTitle: string;
  readyBody: string;
  showPreview: string;
  backToResult: string;
  backToSettings: string;
};

const COPY: Record<"ru" | "kk" | "en", Copy> = {
  ru: {
    title: "Создать урок с ИИ",
    subtitle: "Локальная модель подготовит задания и слайды, backend проверит формат и математику.",
    textSource: "Вставить материал",
    textbookSource: "Учебник",
    material: "Исходный материал",
    materialHint: "Вставьте параграф, конспект или текст темы. Минимум 80 символов.",
    noBooks: "На этом сервере ml/data не найден. Генерация по вставленному тексту доступна всегда.",
    book: "Учебник",
    section: "Параграф",
    lessonTitle: "Название урока",
    optional: "необязательно",
    language: "Язык",
    auto: "Авто",
    slides: "Слайды",
    tasks: "Задания",
    generate: "Сгенерировать урок",
    generating: "Генерация урока…",
    replaceAll: "Заменить урок",
    addAll: "Добавить к уроку",
    replaceTasks: "Только задания",
    replaceSlides: "Только слайды",
    preview: "Предпросмотр",
    emptyPreview: "После генерации здесь появятся слайды, задания и результаты проверки.",
    source: "Источник",
    verified: "проверено",
    fixed: "исправлено",
    warning: "нужна проверка",
    generationError: "Не удалось сгенерировать урок",
    addBook: "Добавить PDF учебника",
    addBookHint: "Smartboard сам извлечёт текст, распознает сканы и построит индекс страниц.",
    indexing: "Подготовка учебника",
    indexedPages: "проиндексировано",
    sectionMode: "По параграфу",
    searchMode: "По теме",
    searchPlaceholder: "Например: логарифмы, электромагнитная индукция…",
    noBooksTitle: "Учебники пока не добавлены",
    noBooksBody: "Загрузите PDF. После обработки его можно будет искать по теме или открывать по §.",
    searchEmpty: "Совпадений пока нет",
    searchPages: "Найденные страницы",
    processingReady: "Поиск уже доступен по обработанным страницам",
    reprocess: "Повторить обработку",
    chooseTitle: "Как создать урок?",
    chooseSubtitle: "Выберите источник материала. Остальные параметры появятся после выбора.",
    textSourceDescription: "Вставить параграф, конспект или текст темы вручную.",
    textbookSourceDescription: "Взять материал из учебника и создать задания и презентацию по параграфу.",
    changeMethod: "Изменить способ",
    readyTitle: "Урок сгенерирован",
    readyBody: "Материалы готовы. Можно сначала посмотреть результат или сразу применить его к уроку.",
    showPreview: "Показать предпросмотр",
    backToResult: "Назад к результату",
    backToSettings: "Изменить параметры",
  },
  kk: {
    title: "ЖИ арқылы сабақ құру",
    subtitle: "Жергілікті модель тапсырмалар мен слайдтар жасайды, backend формат пен математиканы тексереді.",
    textSource: "Мәтін енгізу",
    textbookSource: "Оқулық",
    material: "Бастапқы материал",
    materialHint: "Параграфты, конспектті немесе тақырып мәтінін енгізіңіз. Кемінде 80 таңба.",
    noBooks: "Бұл серверде ml/data табылмады. Енгізілген мәтін бойынша генерация әрқашан қолжетімді.",
    book: "Оқулық",
    section: "Параграф",
    lessonTitle: "Сабақ атауы",
    optional: "міндетті емес",
    language: "Тіл",
    auto: "Авто",
    slides: "Слайдтар",
    tasks: "Тапсырмалар",
    generate: "Сабақты құру",
    generating: "Сабақ жасалуда…",
    replaceAll: "Сабақты ауыстыру",
    addAll: "Сабаққа қосу",
    replaceTasks: "Тек тапсырмалар",
    replaceSlides: "Тек слайдтар",
    preview: "Алдын ала қарау",
    emptyPreview: "Генерациядан кейін мұнда слайдтар, тапсырмалар және тексеру нәтижелері шығады.",
    source: "Дереккөз",
    verified: "тексерілді",
    fixed: "түзетілді",
    warning: "тексеру керек",
    generationError: "Сабақты құру мүмкін болмады",
    addBook: "PDF оқулық қосу",
    addBookHint: "Smartboard мәтінді өзі шығарып, скандарды танып, беттер индексін жасайды.",
    indexing: "Оқулық дайындалуда",
    indexedPages: "индекстелді",
    sectionMode: "Параграф бойынша",
    searchMode: "Тақырып бойынша",
    searchPlaceholder: "Мысалы: логарифмдер, электромагниттік индукция…",
    noBooksTitle: "Оқулықтар әлі қосылмаған",
    noBooksBody: "PDF жүктеңіз. Өңдеуден кейін тақырыппен іздеуге немесе § бойынша таңдауға болады.",
    searchEmpty: "Сәйкестік табылмады",
    searchPages: "Табылған беттер",
    processingReady: "Өңделген беттер бойынша іздеу қазірдің өзінде қолжетімді",
    reprocess: "Қайта өңдеу",
    chooseTitle: "Сабақты қалай құру керек?",
    chooseSubtitle: "Материал көзін таңдаңыз. Қалған параметрлер таңдаудан кейін көрсетіледі.",
    textSourceDescription: "Параграфты, конспектті немесе тақырып мәтінін қолмен енгізу.",
    textbookSourceDescription: "Оқулықтан материал алып, параграф бойынша тапсырмалар мен презентация жасау.",
    changeMethod: "Тәсілді өзгерту",
    readyTitle: "Сабақ дайын",
    readyBody: "Материалдар дайын. Нәтижені алдын ала қарап немесе бірден сабаққа қолдануға болады.",
    showPreview: "Алдын ала қарау",
    backToResult: "Нәтижеге оралу",
    backToSettings: "Параметрлерді өзгерту",
  },
  en: {
    title: "Generate lesson with AI",
    subtitle: "The local model creates tasks and slides; the backend validates layout and math.",
    textSource: "Paste material",
    textbookSource: "Textbook",
    material: "Source material",
    materialHint: "Paste a paragraph, notes, or topic text. Minimum 80 characters.",
    noBooks: "No ml/data is available on this server. Pasted-text generation is always available.",
    book: "Textbook",
    section: "Section",
    lessonTitle: "Lesson title",
    optional: "optional",
    language: "Language",
    auto: "Auto",
    slides: "Slides",
    tasks: "Tasks",
    generate: "Generate lesson",
    generating: "Generating lesson…",
    replaceAll: "Replace lesson",
    addAll: "Add to lesson",
    replaceTasks: "Tasks only",
    replaceSlides: "Slides only",
    preview: "Preview",
    emptyPreview: "Generated slides, tasks, and verification results will appear here.",
    source: "Source",
    verified: "verified",
    fixed: "fixed",
    warning: "review needed",
    generationError: "Could not generate lesson",
    addBook: "Add textbook PDF",
    addBookHint: "Smartboard extracts text, OCRs scanned pages, and builds a page index automatically.",
    indexing: "Preparing textbook",
    indexedPages: "indexed",
    sectionMode: "By section",
    searchMode: "By topic",
    searchPlaceholder: "For example: logarithms, electromagnetic induction…",
    noBooksTitle: "No textbooks yet",
    noBooksBody: "Upload a PDF. Once processed, you can search it by topic or select a section.",
    searchEmpty: "No matches yet",
    searchPages: "Matching pages",
    processingReady: "Search is already available for processed pages",
    reprocess: "Process again",
    chooseTitle: "How do you want to create the lesson?",
    chooseSubtitle: "Choose the material source. Other settings appear after you choose.",
    textSourceDescription: "Paste a paragraph, notes, or topic text manually.",
    textbookSourceDescription: "Use a textbook section to create tasks and a presentation.",
    changeMethod: "Change method",
    readyTitle: "Lesson generated",
    readyBody: "The materials are ready. Preview them first or apply them to the lesson now.",
    showPreview: "Show preview",
    backToResult: "Back to result",
    backToSettings: "Change settings",
  },
};

const renumberTasks = (items: Task[], start: number) =>
  items.map((item, index) => ({ ...item, id: start + index }));

const renumberSlides = (items: Slide[], start: number) =>
  items.map((item, index) => ({ ...item, id: start + index }));

function SlideThumbnail({ slide }: { slide: Slide }) {
  return (
    <div
      className="relative aspect-video w-full overflow-hidden rounded-lg border border-white/[0.08]"
      style={{ backgroundColor: slide.backgroundColor ?? "#0A0E14" }}
    >
      {slide.elements?.map((element) => {
        const common = {
          left: `${(element.x / 960) * 100}%`,
          top: `${(element.y / 540) * 100}%`,
          width: `${(element.w / 960) * 100}%`,
          height: `${(element.h / 540) * 100}%`,
          transform: element.rotation ? `rotate(${element.rotation}deg)` : undefined,
          transformOrigin: "center",
        };
        if (element.type === "shape") {
          return (
            <div
              key={element.id}
              className="absolute"
              style={{
                ...common,
                backgroundColor: element.fill ?? "transparent",
                borderColor: element.strokeColor ?? "transparent",
                borderWidth: element.strokeWidth ?? 0,
                borderStyle: "solid",
                borderRadius:
                  element.shape === "ellipse" ? "999px" : element.shape === "round" ? "8px" : 0,
              }}
            />
          );
        }
        if (element.type === "text") {
          return (
            <div
              key={element.id}
              className="absolute overflow-hidden"
              style={{
                ...common,
                color: element.color ?? "#F4F7FB",
                fontSize: Math.max(5, (element.fontSize ?? 20) * 0.27),
                lineHeight: 1.2,
                fontFamily: element.fontFamily,
                fontWeight:
                  element.fontWeight === "bold"
                    ? 700
                    : element.fontWeight === "semibold"
                      ? 600
                      : element.fontWeight === "medium"
                        ? 500
                        : 400,
                textAlign: element.align ?? "left",
              }}
            >
              {element.text}
            </div>
          );
        }
        if (element.type === "math") {
          return (
            <div
              key={element.id}
              className="absolute flex items-center overflow-hidden"
              style={{
                ...common,
                color: element.color ?? "#F4F7FB",
                fontSize: Math.max(5, (element.fontSize ?? 26) * 0.27),
                textAlign: element.align ?? "center",
                justifyContent:
                  element.align === "left" ? "flex-start" : element.align === "right" ? "flex-end" : "center",
              }}
            >
              <MathFormula
                latex={element.latex}
                fallbackText={element.fallbackText}
                display={element.display ?? true}
                className="w-full"
              />
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

export default function LessonGenerator({
  currentTasks,
  currentSlides,
  onChangeTasks,
  onChangeSlides,
  onApplied,
}: {
  currentTasks: Task[];
  currentSlides: Slide[];
  onChangeTasks: (next: Task[]) => void;
  onChangeSlides: (next: Slide[]) => void;
  onApplied?: (mode: "replace" | "append" | "tasks" | "slides") => void;
}) {
  const { locale } = useI18n();
  const c = COPY[locale];
  const [catalog, setCatalog] = useState<SourceCatalog>({ mlDataAvailable: false, books: [] });
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [sourceType, setSourceType] = useState<"text" | "textbook" | null>(null);
  const [screen, setScreen] = useState<"choose" | "form" | "ready" | "preview">("choose");
  const [textbookMode, setTextbookMode] = useState<"section" | "search">("section");
  const [sourceText, setSourceText] = useState("");
  const [book, setBook] = useState("");
  const [section, setSection] = useState("");
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [lessonTitle, setLessonTitle] = useState("");
  const [language, setLanguage] = useState<"auto" | "ru" | "kk" | "en">("auto");
  const [slideCount, setSlideCount] = useState(6);
  const [taskCount, setTaskCount] = useState(6);
  const [loading, setLoading] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<GenerationProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerationResult | null>(null);

  const generationProgressLabel = (stage?: string) => {
    const labels = {
      ru: {
        queued: "Подготовка", source: "Готовим материал", source_ready: "Материал готов",
        tasks_generating: "Генерируем задания", tasks_generated: "Задания готовы",
        slides_generating: "Генерируем слайды", slides_generated: "Слайды готовы",
        tasks_checking: "Проверяем задания", tasks_checked: "Задания проверены",
        contract: "Собираем урок", finalizing: "Финальная проверка", done: "Урок готов",
      },
      kk: {
        queued: "Дайындау", source: "Материалды дайындау", source_ready: "Материал дайын",
        tasks_generating: "Тапсырмаларды жасау", tasks_generated: "Тапсырмалар дайын",
        slides_generating: "Слайдтарды жасау", slides_generated: "Слайдтар дайын",
        tasks_checking: "Тапсырмаларды тексеру", tasks_checked: "Тапсырмалар тексерілді",
        contract: "Сабақты жинау", finalizing: "Соңғы тексеру", done: "Сабақ дайын",
      },
      en: {
        queued: "Preparing", source: "Preparing source", source_ready: "Source ready",
        tasks_generating: "Generating tasks", tasks_generated: "Tasks ready",
        slides_generating: "Generating slides", slides_generated: "Slides ready",
        tasks_checking: "Checking tasks", tasks_checked: "Tasks checked",
        contract: "Building lesson", finalizing: "Final validation", done: "Lesson ready",
      },
    } as const;
    const lang = locale === "kk" ? "kk" : locale === "en" ? "en" : "ru";
    return labels[lang][stage as keyof typeof labels.ru] ?? labels[lang].queued;
  };

  const refreshCatalog = useCallback(async () => {
    try {
      const res = await apiFetch("/api/lesson-generation/sources", { cache: "no-store" });
      if (!res.ok) throw new Error("sources");
      const data = (await res.json()) as SourceCatalog;
      const next: SourceCatalog = {
        mlDataAvailable: Boolean(data.mlDataAvailable),
        books: Array.isArray(data.books) ? data.books : [],
      };
      setCatalog(next);
      setBook((current) => {
        if (current && next.books.some((item) => item.id === current)) return current;
        return next.books[0]?.id ?? "";
      });
    } catch {
      setCatalog({ mlDataAvailable: false, books: [] });
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  const hasProcessingBooks = catalog.books.some(
    (item) => item.status === "queued" || item.status === "processing",
  );

  useEffect(() => {
    if (!hasProcessingBooks) return;
    const timer = window.setInterval(() => {
      void refreshCatalog();
    }, 1200);
    return () => window.clearInterval(timer);
  }, [hasProcessingBooks, refreshCatalog]);

  const selectedBook = useMemo(
    () => catalog.books.find((item) => item.id === book) ?? null,
    [book, catalog.books],
  );

  useEffect(() => {
    if (!selectedBook) {
      setSection("");
      return;
    }
    if (!selectedBook.sections.some((item) => item.id === section)) {
      setSection(selectedBook.sections[0]?.id ?? "");
    }
    if (selectedBook.sections.length === 0 && selectedBook.searchReady) {
      setTextbookMode("search");
    }
  }, [section, selectedBook]);

  useEffect(() => {
    if (
      sourceType !== "textbook" ||
      textbookMode !== "search" ||
      !book ||
      !selectedBook?.searchReady ||
      query.trim().length < 2
    ) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void apiFetch(
        `/api/textbooks/${encodeURIComponent(book)}/search?q=${encodeURIComponent(query.trim())}&limit=6`,
        { cache: "no-store" },
      )
        .then(async (res) => {
          if (!res.ok) throw new Error("search");
          const payload = (await res.json()) as { items?: SearchResult[] };
          if (!cancelled) setSearchResults(Array.isArray(payload.items) ? payload.items : []);
        })
        .catch(() => {
          if (!cancelled) setSearchResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [book, query, selectedBook?.searchReady, sourceType, textbookMode]);

  const uploadBook = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch("/api/textbooks/upload", { method: "POST", body: form });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(String(payload?.detail || c.generationError));
      }
      const payload = (await res.json()) as { book?: SourceBook };
      if (payload.book?.id) {
        setBook(payload.book.id);
        setSourceType("textbook");
        setTextbookMode("search");
      }
      await refreshCatalog();
    } catch (err) {
      setError(err instanceof Error ? err.message : c.generationError);
    } finally {
      setUploading(false);
    }
  };

  const retryBook = async () => {
    if (!book) return;
    setError(null);
    try {
      const res = await apiFetch(`/api/textbooks/${encodeURIComponent(book)}/reindex`, { method: "POST" });
      if (!res.ok) throw new Error(c.generationError);
      await refreshCatalog();
    } catch (err) {
      setError(err instanceof Error ? err.message : c.generationError);
    }
  };

  const generatedSourceType =
    sourceType === "text" ? "text" : textbookMode === "search" ? "search" : "textbook";

  const canGenerate =
    !loading &&
    (sourceType === "text"
      ? sourceText.trim().length >= 80
      : textbookMode === "search"
        ? Boolean(book && selectedBook?.searchReady && query.trim().length >= 2)
        : Boolean(book && section && selectedBook?.sections.length));

  const generate = async () => {
    if (!canGenerate) return;
    setLoading(true);
    setError(null);
    setGenerationProgress({ progress: 0, stage: "queued" });
    try {
      const created = await apiFetch("/api/lesson-generation/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceType: generatedSourceType,
          text: sourceType === "text" ? sourceText : null,
          book: sourceType === "textbook" ? book : null,
          section: generatedSourceType === "textbook" ? section : null,
          query: generatedSourceType === "search" ? query.trim() : null,
          language,
          slideCount,
          taskCount,
          title: lessonTitle.trim() || null,
        }),
      });
      if (!created.ok) {
        let detail = c.generationError;
        try {
          const payload = await created.json();
          if (payload?.detail) detail = String(payload.detail);
        } catch {
          // keep generic message
        }
        throw new Error(detail);
      }
      const { jobId } = (await created.json()) as { jobId?: string };
      if (!jobId) throw new Error(c.generationError);

      let payload: GenerationResult | null = null;
      for (;;) {
        const res = await apiFetch(
          `/api/lesson-generation/jobs/${encodeURIComponent(jobId)}?t=${Date.now()}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(c.generationError);
        const job = (await res.json()) as GenerationProgress & {
          status: "queued" | "running" | "done" | "error";
          result?: GenerationResult | null;
          error?: string | null;
        };
        setGenerationProgress({
          progress: Number(job.progress ?? 0),
          stage: String(job.stage ?? "queued"),
          completed: job.completed,
          total: job.total,
        });
        if (job.status === "done") {
          payload = job.result ?? null;
          break;
        }
        if (job.status === "error") {
          throw new Error(job.error || c.generationError);
        }
        await new Promise((resolve) => window.setTimeout(resolve, 300));
      }

      if (!payload?.workspace?.tasks || !payload.workspace?.slides) {
        throw new Error(c.generationError);
      }
      setResult(payload);
      setGenerationProgress({ progress: 100, stage: "done" });
      setScreen("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : c.generationError);
    } finally {
      setLoading(false);
    }
  };

  const applyReplaceAll = () => {
    if (!result) return;
    onChangeTasks(renumberTasks(result.workspace.tasks, 1));
    onChangeSlides(renumberSlides(result.workspace.slides, 1));
    onApplied?.("replace");
  };

  const applyAppendAll = () => {
    if (!result) return;
    const taskStart = Math.max(0, ...currentTasks.map((item) => item.id)) + 1;
    const slideStart = Math.max(0, ...currentSlides.map((item) => item.id)) + 1;
    onChangeTasks([...currentTasks, ...renumberTasks(result.workspace.tasks, taskStart)]);
    onChangeSlides([...currentSlides, ...renumberSlides(result.workspace.slides, slideStart)]);
    onApplied?.("append");
  };

  const applyTasks = () => {
    if (!result) return;
    onChangeTasks(renumberTasks(result.workspace.tasks, 1));
    onApplied?.("tasks");
  };

  const applySlides = () => {
    if (!result) return;
    onChangeSlides(renumberSlides(result.workspace.slides, 1));
    onApplied?.("slides");
  };

  const checks = result?.meta.checks ?? {};
  const reviewCount = (checks.wrong ?? 0) + (checks.unverified ?? 0);

  return (
    <div className="min-h-full w-full">
      {screen === "choose" && (
        <div className="flex min-h-full items-center justify-center px-5 py-10 sm:px-8">
          <div className="w-full max-w-[980px]">
            <div className="text-center">
              <h2 className="text-[30px] font-semibold tracking-[-0.025em] text-frost">{c.chooseTitle}</h2>
              <p className="mx-auto mt-2 max-w-[620px] text-[13px] leading-5 text-frost/40">{c.chooseSubtitle}</p>
            </div>

            <div className="mt-8 grid gap-5 md:grid-cols-2">
              <button
                type="button"
                className="group min-h-[220px] rounded-[22px] border border-white/10 bg-white/[0.025] p-7 text-left transition hover:border-accent/30 hover:bg-white/[0.045]"
                onClick={() => {
                  setSourceType("text");
                  setScreen("form");
                  setError(null);
                }}
              >
                <div className="flex items-start justify-between">
                  <div className="flex h-14 w-14 items-center justify-center rounded-[16px] bg-accent/10 text-accent">
                    <FileText size={24} />
                  </div>
                  <ChevronRight size={20} className="mt-1 text-frost/25 transition group-hover:translate-x-0.5 group-hover:text-frost/55" />
                </div>
                <div className="mt-7 text-[19px] font-semibold text-frost">{c.textSource}</div>
                <div className="mt-2 max-w-[360px] text-[13px] leading-6 text-frost/45">{c.textSourceDescription}</div>
              </button>

              <button
                type="button"
                className="group min-h-[220px] rounded-[22px] border border-white/10 bg-white/[0.025] p-7 text-left transition hover:border-accent/30 hover:bg-white/[0.045]"
                onClick={() => {
                  setSourceType("textbook");
                  setScreen("form");
                  setError(null);
                }}
              >
                <div className="flex items-start justify-between">
                  <div className="flex h-14 w-14 items-center justify-center rounded-[16px] bg-accent/10 text-accent">
                    <BookOpen size={24} />
                  </div>
                  <ChevronRight size={20} className="mt-1 text-frost/25 transition group-hover:translate-x-0.5 group-hover:text-frost/55" />
                </div>
                <div className="mt-7 text-[19px] font-semibold text-frost">{c.textbookSource}</div>
                <div className="mt-2 max-w-[380px] text-[13px] leading-6 text-frost/45">{c.textbookSourceDescription}</div>
              </button>
            </div>
          </div>
        </div>
      )}

      {screen === "form" && sourceType && (
        <div className="mx-auto w-full max-w-[760px] px-5 py-7 sm:px-8 sm:py-9">
          <button
            type="button"
            className="flex items-center gap-2 text-[11px] font-medium text-frost/40 transition hover:text-frost/70"
            onClick={() => {
              setScreen("choose");
              setError(null);
            }}
          >
            <ArrowLeft size={14} />
            {c.changeMethod}
          </button>

          <div className="mt-5">
            <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-frost">
              {sourceType === "text" ? c.textSource : c.textbookSource}
            </h2>
            <p className="mt-1.5 text-[12px] leading-5 text-frost/40">
              {sourceType === "text" ? c.textSourceDescription : c.textbookSourceDescription}
            </p>
          </div>

          <section className="mt-6 rounded-[22px] border border-white/10 bg-white/[0.025] p-5 sm:p-6">
            {sourceType === "text" ? (
              <label className="block">
                <span className="text-[11px] font-medium text-frost/55">{c.material}</span>
                <textarea
                  value={sourceText}
                  onChange={(event) => setSourceText(event.target.value)}
                  placeholder={c.materialHint}
                  className="mt-2 min-h-[220px] w-full resize-y rounded-xl border border-white/10 bg-black/10 px-3.5 py-3 text-[12px] leading-5 text-frost outline-none transition placeholder:text-frost/25 focus:border-accent/40"
                />
                <div className="mt-1 text-right text-[10px] text-frost/28">{sourceText.trim().length} / 9000</div>
              </label>
            ) : (
              <div className="grid gap-3">
                {catalog.books.length === 0 && !catalogLoading ? (
                  <div className="rounded-2xl border border-dashed border-white/[0.12] bg-black/10 p-5">
                    <div className="flex h-11 w-11 items-center justify-center rounded-[13px] bg-accent/10 text-accent">
                      <BookOpen size={19} />
                    </div>
                    <div className="mt-3 text-[14px] font-semibold text-frost">{c.noBooksTitle}</div>
                    <div className="mt-1 text-[11px] leading-5 text-frost/40">{c.noBooksBody}</div>
                    <label className="mt-4 flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl bg-accent px-3 text-[11px] font-semibold text-black transition hover:opacity-90">
                      {uploading ? <RefreshCw size={14} className="animate-spin" /> : <Upload size={14} />}
                      {uploading ? c.indexing : c.addBook}
                      <input
                        type="file"
                        accept="application/pdf,.pdf"
                        className="hidden"
                        disabled={uploading}
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0] ?? null;
                          event.currentTarget.value = "";
                          void uploadBook(file);
                        }}
                      />
                    </label>
                  </div>
                ) : (
                  <>
                    <div className="flex items-end gap-2">
                      <label className="min-w-0 flex-1">
                        <span className="text-[11px] font-medium text-frost/55">{c.book}</span>
                        <select
                          value={book}
                          onChange={(event) => setBook(event.target.value)}
                          className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-graphite px-3 text-[12px] text-frost outline-none focus:border-accent/40"
                        >
                          {catalog.books.map((item) => (
                            <option key={item.id} value={item.id}>{item.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-white/10 bg-white/[0.035] text-frost/55 transition hover:bg-white/[0.07] hover:text-frost">
                        {uploading ? <RefreshCw size={15} className="animate-spin" /> : <Plus size={16} />}
                        <input
                          type="file"
                          accept="application/pdf,.pdf"
                          className="hidden"
                          disabled={uploading}
                          onChange={(event) => {
                            const file = event.currentTarget.files?.[0] ?? null;
                            event.currentTarget.value = "";
                            void uploadBook(file);
                          }}
                        />
                      </label>
                    </div>

                    {selectedBook && (selectedBook.status === "queued" || selectedBook.status === "processing") && (
                      <div className="rounded-xl border border-accent/15 bg-accent/[0.04] px-3 py-3">
                        <div className="flex items-center justify-between gap-3 text-[10px]">
                          <span className="font-medium text-frost/60">{c.indexing}</span>
                          <span className="tabular-nums text-accent">{Math.round((selectedBook.progress ?? 0) * 100)}%</span>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                          <div
                            className="h-full rounded-full bg-accent transition-[width] duration-300"
                            style={{ width: Math.max(2, Math.round((selectedBook.progress ?? 0) * 100)) + "%" }}
                          />
                        </div>
                        <div className="mt-2 flex items-center justify-between text-[9px] text-frost/35">
                          <span>{selectedBook.stage || "…"}</span>
                          <span>
                            {selectedBook.indexedPages ?? 0}
                            {selectedBook.totalPages ? " / " + selectedBook.totalPages : ""} {c.indexedPages}
                          </span>
                        </div>
                        {selectedBook.searchReady && (
                          <div className="mt-2 text-[9px] leading-4 text-frost/45">{c.processingReady}</div>
                        )}
                      </div>
                    )}

                    {selectedBook?.status === "error" && (
                      <div className="rounded-xl border border-ember/20 bg-ember/[0.05] px-3 py-3">
                        <div className="text-[10px] leading-4 text-ember">{selectedBook.error || c.generationError}</div>
                        <button
                          type="button"
                          onClick={() => void retryBook()}
                          className="mt-2 text-[10px] font-semibold text-accent hover:opacity-80"
                        >
                          {c.reprocess}
                        </button>
                      </div>
                    )}

                    {selectedBook && (
                      <div className="grid grid-cols-2 gap-1 rounded-xl border border-white/[0.08] bg-black/10 p-1">
                        <button
                          type="button"
                          disabled={selectedBook.sections.length === 0}
                          onClick={() => setTextbookMode("section")}
                          className={cn(
                            "h-9 rounded-lg text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-30",
                            textbookMode === "section" ? "bg-white/[0.08] text-frost" : "text-frost/40 hover:text-frost/65",
                          )}
                        >
                          {c.sectionMode}
                        </button>
                        <button
                          type="button"
                          disabled={!selectedBook.searchReady}
                          onClick={() => setTextbookMode("search")}
                          className={cn(
                            "h-9 rounded-lg text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-30",
                            textbookMode === "search" ? "bg-white/[0.08] text-frost" : "text-frost/40 hover:text-frost/65",
                          )}
                        >
                          {c.searchMode}
                        </button>
                      </div>
                    )}

                    {textbookMode === "section" ? (
                      <label>
                        <span className="text-[11px] font-medium text-frost/55">{c.section}</span>
                        <select
                          value={section}
                          onChange={(event) => setSection(event.target.value)}
                          disabled={!selectedBook?.sections.length}
                          className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-graphite px-3 text-[12px] text-frost outline-none focus:border-accent/40 disabled:opacity-35"
                        >
                          {(selectedBook?.sections ?? []).map((item) => (
                            <option key={item.id} value={item.id}>
                              §{item.id}{item.title ? " · " + item.title : ""} · {item.pageStart}–{item.pageEnd}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <div>
                        <label className="relative block">
                          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-frost/30" />
                          <input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={c.searchPlaceholder}
                            disabled={!selectedBook?.searchReady}
                            className="h-11 w-full rounded-xl border border-white/10 bg-black/10 pl-9 pr-10 text-[12px] text-frost outline-none placeholder:text-frost/25 focus:border-accent/40 disabled:opacity-35"
                          />
                          {searching && (
                            <RefreshCw size={13} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-accent" />
                          )}
                        </label>

                        {query.trim().length >= 2 && selectedBook?.searchReady && (
                          <div className="mt-2">
                            <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-frost/30">{c.searchPages}</div>
                            {searchResults.length ? (
                              <div className="grid max-h-[190px] gap-1.5 overflow-y-auto pr-1">
                                {searchResults.map((item) => (
                                  <div key={item.page} className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2">
                                    <div className="flex items-center gap-2 text-[9px] font-semibold text-accent">
                                      <span>{locale === "en" ? "p." : "стр."} {item.page}</span>
                                      {item.section && <span className="text-frost/35">§{item.section}</span>}
                                    </div>
                                    <div className="mt-1 line-clamp-2 text-[9px] leading-4 text-frost/42">
                                      {item.excerpt.replaceAll("⟦", "").replaceAll("⟧", "")}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : !searching ? (
                              <div className="rounded-lg border border-white/[0.06] px-3 py-2 text-[9px] text-frost/30">{c.searchEmpty}</div>
                            ) : null}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="text-[9px] leading-4 text-frost/30">{c.addBookHint}</div>
                  </>
                )}
              </div>
            )}

            <div className="mt-5 grid gap-4 border-t border-white/[0.07] pt-5">
              <label>
                <span className="text-[11px] font-medium text-frost/55">{c.lessonTitle} · {c.optional}</span>
                <input
                  value={lessonTitle}
                  onChange={(event) => setLessonTitle(event.target.value)}
                  className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-black/10 px-3.5 text-[12px] text-frost outline-none focus:border-accent/40"
                />
              </label>

              <div className="grid grid-cols-3 gap-2">
                <label>
                  <span className="text-[10px] font-medium text-frost/45">{c.language}</span>
                  <select
                    value={language}
                    onChange={(event) => setLanguage(event.target.value as "auto" | "ru" | "kk" | "en")}
                    className="mt-1.5 h-10 w-full rounded-lg border border-white/10 bg-graphite px-2 text-[11px] text-frost outline-none"
                  >
                    <option value="auto">{c.auto}</option>
                    <option value="ru">RU</option>
                    <option value="kk">KK</option>
                    <option value="en">EN</option>
                  </select>
                </label>
                <label>
                  <span className="text-[10px] font-medium text-frost/45">{c.slides}</span>
                  <input
                    type="number"
                    min={3}
                    max={10}
                    value={slideCount}
                    onChange={(event) => setSlideCount(Math.max(3, Math.min(10, Number(event.target.value) || 3)))}
                    className="mt-1.5 h-10 w-full rounded-lg border border-white/10 bg-black/10 px-2 text-[11px] text-frost outline-none"
                  />
                </label>
                <label>
                  <span className="text-[10px] font-medium text-frost/45">{c.tasks}</span>
                  <input
                    type="number"
                    min={3}
                    max={12}
                    value={taskCount}
                    onChange={(event) => setTaskCount(Math.max(3, Math.min(12, Number(event.target.value) || 3)))}
                    className="mt-1.5 h-10 w-full rounded-lg border border-white/10 bg-black/10 px-2 text-[11px] text-frost outline-none"
                  />
                </label>
              </div>
            </div>

            {error && (
              <div className="mt-4 flex gap-2 rounded-xl border border-ember/20 bg-ember/[0.05] px-3 py-2.5 text-[11px] leading-4 text-ember">
                <TriangleAlert size={15} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button className="mt-5 h-11 w-full rounded-xl" onClick={() => void generate()} disabled={!canGenerate}>
              {loading ? <RefreshCw size={16} className="mr-2 animate-spin" /> : <LayoutTemplate size={16} className="mr-2" />}
              {loading ? c.generating : c.generate}
            </Button>

            {loading && generationProgress && (
              <div className="mt-3 rounded-xl border border-white/[0.08] bg-black/10 px-3 py-3">
                <div className="flex items-center justify-between gap-3 text-[10px]">
                  <span className="font-medium text-frost/55">{generationProgressLabel(generationProgress.stage)}</span>
                  <span className="tabular-nums text-accent">{Math.round(generationProgress.progress)}%</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-200"
                    style={{ width: `${Math.max(1, Math.round(generationProgress.progress))}%` }}
                  />
                </div>
                {generationProgress.total ? (
                  <div className="mt-1.5 text-right text-[9px] tabular-nums text-frost/30">
                    {Math.min(generationProgress.total, generationProgress.completed ?? 0)} / {generationProgress.total}
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </div>
      )}

      {screen === "ready" && result && (
        <div className="flex min-h-full items-center justify-center px-5 py-10 sm:px-8">
          <section className="w-full max-w-[680px] rounded-[24px] border border-white/10 bg-white/[0.025] p-7 text-center sm:p-9">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-[18px] bg-accent/10 text-accent">
              <CheckCircle2 size={28} />
            </div>
            <h2 className="mt-5 text-[25px] font-semibold tracking-[-0.02em] text-frost">{c.readyTitle}</h2>
            <p className="mx-auto mt-2 max-w-[500px] text-[12px] leading-5 text-frost/42">{c.readyBody}</p>

            <div className="mx-auto mt-5 flex w-fit flex-wrap items-center justify-center gap-2">
              <span className="rounded-full border border-white/10 px-3 py-1.5 text-[10px] text-frost/50">
                {result.workspace.slides.length} {c.slides.toLowerCase()}
              </span>
              <span className="rounded-full border border-white/10 px-3 py-1.5 text-[10px] text-frost/50">
                {result.workspace.tasks.length} {c.tasks.toLowerCase()}
              </span>
              {(checks.ok ?? 0) > 0 && (
                <span className="rounded-full border border-accent/20 bg-accent/[0.05] px-3 py-1.5 text-[10px] text-accent">
                  {checks.ok} {c.verified}
                </span>
              )}
              {reviewCount > 0 && (
                <span className="rounded-full border border-amber-300/20 bg-amber-300/[0.05] px-3 py-1.5 text-[10px] text-amber-200">
                  {reviewCount} {c.warning}
                </span>
              )}
            </div>

            <div className="mt-7 grid gap-2 sm:grid-cols-2">
              <Button variant="outline" className="h-11 rounded-xl" onClick={() => setScreen("preview")}>
                <Eye size={16} className="mr-2" />
                {c.showPreview}
              </Button>
              <Button className="h-11 rounded-xl" onClick={applyReplaceAll}>
                <CheckCircle2 size={16} className="mr-2" />
                {c.replaceAll}
              </Button>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Button
                type="button"
                variant="ghost"
                className="h-10 rounded-xl border border-white/[0.07] text-[11px] text-frost/60"
                onClick={applyAppendAll}
              >
                <Plus size={14} className="mr-1.5" />
                {c.addAll}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-10 rounded-xl border border-white/[0.07] text-[11px] text-frost/60"
                onClick={() => {
                  setError(null);
                  setScreen("form");
                }}
              >
                {c.backToSettings}
              </Button>
            </div>
          </section>
        </div>
      )}

      {screen === "preview" && result && (
        <div className="mx-auto w-full max-w-[1180px] px-5 py-7 sm:px-8 sm:py-9">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              className="flex items-center gap-2 text-[11px] font-medium text-frost/40 transition hover:text-frost/70"
              onClick={() => setScreen("ready")}
            >
              <ArrowLeft size={14} />
              {c.backToResult}
            </button>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" className="h-9 rounded-lg text-[11px]" onClick={applyAppendAll}>
                <Plus size={14} className="mr-1.5" />
                {c.addAll}
              </Button>
              <Button size="sm" className="h-9 rounded-lg text-[11px]" onClick={applyReplaceAll}>
                {c.replaceAll}
              </Button>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-end justify-between gap-3 border-b border-white/[0.07] pb-4">
            <div>
              <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-frost">{c.preview}</h2>
              <div className="mt-1 text-[10px] text-frost/35">
                {result.workspace.slides.length} {c.slides.toLowerCase()} · {result.workspace.tasks.length} {c.tasks.toLowerCase()}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] text-frost/45">
                {c.source}: {result.meta.textSource ?? "AI"}
              </span>
              {(checks.fixed ?? 0) > 0 && (
                <span className="rounded-full border border-accent/20 bg-accent/[0.05] px-2.5 py-1 text-[10px] text-accent">
                  {checks.fixed} {c.fixed}
                </span>
              )}
              {reviewCount > 0 && (
                <span className="flex items-center gap-1 rounded-full border border-amber-300/20 bg-amber-300/[0.05] px-2.5 py-1 text-[10px] text-amber-200">
                  <TriangleAlert size={11} /> {reviewCount} {c.warning}
                </span>
              )}
            </div>
          </div>

          <div className="mt-5 grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
            <section>
              <div className="mb-3 flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-frost/35">{c.slides}</div>
                <button type="button" onClick={applySlides} className="text-[10px] font-medium text-accent hover:opacity-80">
                  {c.replaceSlides}
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {result.workspace.slides.map((slide, index) => (
                  <div key={slide.id} className="rounded-xl border border-white/[0.08] bg-black/10 p-2.5">
                    <SlideThumbnail slide={slide} />
                    <div className="mt-2 truncate text-[10px] font-medium text-frost/65">{index + 1}. {slide.title}</div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <div className="mb-3 flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-frost/35">{c.tasks}</div>
                <button type="button" onClick={applyTasks} className="text-[10px] font-medium text-accent hover:opacity-80">
                  {c.replaceTasks}
                </button>
              </div>
              <div className="grid gap-2">
                {result.workspace.tasks.map((task, index) => (
                  <div key={task.id} className="rounded-xl border border-white/[0.08] bg-black/10 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-[11px] font-medium leading-4 text-frost/80">{index + 1}. {task.title}</div>
                      {task.kind && (
                        <span className="shrink-0 rounded-md bg-white/[0.05] px-1.5 py-0.5 text-[9px] uppercase text-frost/35">
                          {task.kind}
                        </span>
                      )}
                    </div>
                    {task.check?.note && <div className="mt-1.5 text-[9px] leading-4 text-frost/30">{task.check.note}</div>}
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
