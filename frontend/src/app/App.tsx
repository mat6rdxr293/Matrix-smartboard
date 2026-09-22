import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import TopBar from "@/app/layout/TopBar";
import Slides, { type Slide } from "@/app/presentation/Slides";
import OfficePresentationFrame from "@/app/presentation/OfficePresentationFrame";
import {
  DEFAULT_PRESENTATION_SOURCE,
  isPresentationSource,
  type PresentationSource,
} from "@/app/presentation/presentationSource";
import type { Task } from "@/app/tasks/tasks";
import TaskPanel from "@/app/tasks/TaskPanel";
import MathText from "@/components/MathText";
import BoardCanvas, { type BoardCanvasHandle } from "@/app/board/BoardCanvas";
import { extractSafeHandwritingSteps, solutionStepsToHandwritingStrokes } from "@/app/board/aiHandwriting";
import AIAssistant, { type AssistantMessage } from "@/app/ai/AIAssistant";
import { createBoardHistory, replayBoardOperations, type BoardHistory } from "@/app/board/boardDocument";
import { appendBoardReplay, filterPendingBoardReplayOps, loadBoardReplay, type BoardReplayOp } from "@/app/board/replayApi";
import {
  buildDefaultSlidesForSubject,
  getDefaultTasksForSubject,
  getLessonTitleForLocale,
  getSubjectNameForLocale,
  withSubjectQuery,
} from "@/app/subjects/subjectConfig";
import { Button } from "@/components/ui/button";
import { callAi, getStatus, type AiMode } from "@/app/ai/api";
import { X } from "lucide-react";
import { AnimatePresence, MotionConfig, motion, useDragControls } from "framer-motion";
import { useI18n } from "@/i18n";
import { useTheme } from "@/app/theme/ThemeProvider";
import { sessionApi } from "@/app/session/api";
import type { Lesson, Room, School } from "@/app/session/types";
import type { BoardProfile } from "@/app/board/boardProfiles";
import TeacherPinGate from "@/app/teacher/TeacherPinGate";

const TeacherDashboard = lazy(() => import("@/app/teacher/TeacherDashboard"));

const TAB_IDS = ["tasks", "slides", "teacher"] as const;

type TabId = (typeof TAB_IDS)[number];
type PerformanceMode = "quality" | "balanced" | "performance";

const loadFromStorage = <T,>(key: string, fallback: T): T => {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const SLIDE_BASE_W = 960;
const SLIDE_BASE_H = 540;

type SiteBackground = {
  mode: "solid" | "gradient" | "image";
  color: string;
  gradient: string;
  image: string;
};

const DEFAULT_SITE_BACKGROUND: SiteBackground = {
  mode: "gradient",
  color: "#0A0E14",
  gradient:
    "radial-gradient(1200px 600px at 30% -10%, rgba(77,163,255,0.12) 0%, rgba(10,14,20,0.4) 45%, rgba(10,14,20,1) 100%)",
  image: "",
};

const isSiteBackground = (value: unknown): value is SiteBackground => {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.mode === "solid" || v.mode === "gradient" || v.mode === "image") &&
    typeof v.color === "string" &&
    typeof v.gradient === "string" &&
    typeof v.image === "string"
  );
};

type LessonWorkspaceProps = {
  school: School;
  room: Room;
  lesson: Lesson;
  boardProfile: BoardProfile;
  onComplete: () => void;
  onOpenHistory: () => void;
  onChangeRoom: () => void;
};

export default function App({ school, room, lesson, boardProfile, onComplete, onOpenHistory, onChangeRoom }: LessonWorkspaceProps) {
  const { locale, tl } = useI18n();
  const { theme } = useTheme();
  const subjectId = lesson.subjectId;
  const [teacherUnlocked, setTeacherUnlocked] = useState(false);
  const teacherPinKey = `school.${school.id}.teacherPinHash`;
  const lessonTitle = getLessonTitleForLocale(subjectId, locale);
  const subjectName = getSubjectNameForLocale(subjectId, locale);
  const defaultTaskData = useMemo(() => getDefaultTasksForSubject(subjectId), [subjectId]);
  const defaultSlideData = useMemo(() => buildDefaultSlidesForSubject(subjectId, locale), [subjectId, locale]);
  const subjectStoragePrefix = `subject.${subjectId}`;
  const storageBackupKey = `${subjectStoragePrefix}.backup.storage`;
  const boardReplayBackupKey = `school.${school.id}.room.${room.id}.lesson.${lesson.id}.backup.boardReplayQueue`;
  const performanceModeKey = `${subjectStoragePrefix}.performance.mode`;
  const tasksSidebarWidthKey = `${subjectStoragePrefix}.sidebar.tasks`;
  const slidesSidebarWidthKey = `${subjectStoragePrefix}.sidebar.slides`;
  const freeBoardModeKey = `practice.lesson.${lesson.id}.freeBoard`;
  const withSubjectApi = useMemo(
    () => (path: string) => withSubjectQuery(path, subjectId),
    [subjectId]
  );
  const tabs = [
    { id: "tasks", label: tl("tasks") },
    { id: "slides", label: tl("presentation") },
    { id: "teacher", label: tl("teacher") },
  ] as const;
  const appRef = useRef<HTMLDivElement | null>(null);
  const autoUltraLite = useMemo(() => {
    if (typeof window === "undefined") return false;
    const nav = navigator as Navigator & { deviceMemory?: number };
    const memory = nav.deviceMemory ?? 8;
    const cores = nav.hardwareConcurrency ?? 8;
    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
    return memory <= 2 || (memory <= 4 && cores <= 4) || (coarse && memory <= 4);
  }, []);
  const defaultPerformanceMode: PerformanceMode = autoUltraLite ? "performance" : "balanced";
  const [performanceMode, setPerformanceMode] = useState<PerformanceMode>(() => {
    const raw = loadFromStorage<string>(performanceModeKey, "");
    if (raw === "quality" || raw === "balanced" || raw === "performance") return raw;
    if (raw === "on") return "performance";
    if (raw === "off") return "balanced";
    if (raw === "auto") return defaultPerformanceMode;
    return defaultPerformanceMode;
  });
  const ultraLite = performanceMode === "performance";
  const [currentSlide, setCurrentSlide] = useState(0);
  const [selectedTaskId, setSelectedTaskId] = useState(() => defaultTaskData[0]?.id ?? 1);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [aiBoardContext, setAiBoardContext] = useState("");
  const [presenterMode, setPresenterMode] = useState(false);
  const [apiStatus, setApiStatus] = useState<{ ok: boolean; ai: boolean; ocr: boolean } | null>(null);
  const [tab, setTab] = useState<TabId>("tasks");
  useEffect(() => {
    if (tab !== "teacher") setTeacherUnlocked(false);
  }, [tab]);

  useEffect(() => {
    setTeacherUnlocked(false);
  }, [teacherPinKey]);
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [boardExpanded, setBoardExpanded] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantLoading, setAssistantLoading] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [focusedFloatingPanel, setFocusedFloatingPanel] = useState<"task" | "assistant">("assistant");
  const [slideshowOpen, setSlideshowOpen] = useState(false);
  const [tasksSidebarWidth, setTasksSidebarWidth] = useState(() => loadFromStorage(tasksSidebarWidthKey, 360));
  const [slidesSidebarWidth, setSlidesSidebarWidth] = useState(() => loadFromStorage(slidesSidebarWidthKey, 360));
  const [taskSize, setTaskSize] = useState({ w: 560, h: 520 });
  const [assistantSize, setAssistantSize] = useState({ w: 420, h: 420 });
  const slideShowWrapRef = useRef<HTMLDivElement | null>(null);
  const [slideShowScale, setSlideShowScale] = useState(1);
  const taskDragControls = useDragControls();
  const assistantDragControls = useDragControls();
  const boardCanvasRef = useRef<BoardCanvasHandle | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [boardHistory, setBoardHistory] = useState<BoardHistory>(() => createBoardHistory());
  const [boardPenColor, setBoardPenColor] = useState("#FF0000");
  const [boardBgColor, setBoardBgColor] = useState(() => theme === "light" ? "#FFFFFF" : "#0A0E14");
  const [taskData, setTaskData] = useState<Task[]>(() => defaultTaskData);
  const [freeBoardRequested, setFreeBoardRequested] = useState(() => loadFromStorage(freeBoardModeKey, false));
  const freeBoardForced = taskData.length === 0;
  const freeBoardMode = freeBoardForced || freeBoardRequested;
  const [slideData, setSlideData] = useState<Slide[]>(() => defaultSlideData);
  const [presentationSource, setPresentationSource] = useState<PresentationSource>(DEFAULT_PRESENTATION_SOURCE);
  const [lastServerSaveAt, setLastServerSaveAt] = useState<number | null>(null);
  const [lastLocalBackupAt, setLastLocalBackupAt] = useState<number | null>(null);
  const [siteBackground, setSiteBackground] = useState<SiteBackground>(DEFAULT_SITE_BACKGROUND);
  const continueTokenRef = useRef(0);
  const solutionRunRef = useRef(0);
  const activeSolutionTokenRef = useRef<{ id: string; token: number } | null>(null);
  const storageReadyRef = useRef(false);
  const autoSavingRef = useRef(false);
  const latestStorageRef = useRef<{
    tasks: Task[];
    slides: Slide[];
    siteBackground: SiteBackground;
    presentationSource: PresentationSource;
  }>({
    tasks: defaultTaskData,
    slides: defaultSlideData,
    siteBackground: DEFAULT_SITE_BACKGROUND,
    presentationSource: DEFAULT_PRESENTATION_SOURCE,
  });
  const lastServerSnapshotRef = useRef("");
  const scoreHideTimerRef = useRef<number | null>(null);
  const boardReplayQueueRef = useRef<BoardReplayOp[]>([]);
  const boardReplayFlushRef = useRef<Promise<void> | null>(null);
  const boardReplayLoadedRef = useRef(false);
  const [scoreOverlay, setScoreOverlay] = useState<{
    percent: number;
    color: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (storageReadyRef.current) return;
    setTaskData(defaultTaskData);
    setSlideData(defaultSlideData);
    setSelectedTaskId(defaultTaskData[0]?.id ?? 1);
    latestStorageRef.current = {
      ...latestStorageRef.current,
      tasks: defaultTaskData,
      slides: defaultSlideData,
    };
  }, [defaultSlideData, defaultTaskData]);

  const nowLabel = () => {
    const d = new Date();
    return d.toLocaleTimeString(locale === "kk" ? "kk-KZ" : locale === "en" ? "en-US" : "ru-RU", { hour: "2-digit", minute: "2-digit" });
  };

  const showScoreOverlay = (rawPercent: number) => {
    const percent = clamp(Math.round(rawPercent), 0, 100);
    let color = "#FF3B30";
    let message = tl("you_need_to_try_harder");
    if (percent >= 85) {
      color = "#10B981";
      message = tl("great_well_done");
    } else if (percent >= 65) {
      color = "#9BE15D";
      message = tl("okay_well_done");
    } else if (percent >= 42) {
      color = "#FF9F0A";
      message = tl("we_need_to_repeat_the_material");
    }

    setScoreOverlay({ percent, color, message });
    if (scoreHideTimerRef.current) window.clearTimeout(scoreHideTimerRef.current);
    scoreHideTimerRef.current = window.setTimeout(() => {
      setScoreOverlay(null);
      scoreHideTimerRef.current = null;
    }, 3000);
  };

  const persistBoardReplayQueue = (queue: BoardReplayOp[]) => {
    if (typeof window === "undefined") return;
    if (!queue.length) {
      window.localStorage.removeItem(boardReplayBackupKey);
      return;
    }
    try {
      window.localStorage.setItem(boardReplayBackupKey, JSON.stringify(queue));
    } catch {
      // ignore quota/storage errors
    }
  };

  const flushBoardReplay = () => {
    if (boardReplayFlushRef.current) return boardReplayFlushRef.current;
    if (!boardReplayQueueRef.current.length) return Promise.resolve();
    const run = (async () => {
      try {
        while (boardReplayQueueRef.current.length) {
          const chunk = boardReplayQueueRef.current.slice(0, 80);
          await appendBoardReplay(chunk, lesson.id);
          const acknowledged = new Set(
            chunk.map((operation) => operation.client_operation_id ?? operation.clientOperationId).filter(Boolean)
          );
          boardReplayQueueRef.current = boardReplayQueueRef.current.filter((operation) => {
            const id = operation.client_operation_id ?? operation.clientOperationId;
            return id ? !acknowledged.has(id) : !chunk.includes(operation);
          });
          persistBoardReplayQueue(boardReplayQueueRef.current);
        }
      } catch {
        // offline/server unavailable: keep queue for next retry
      }
    })();
    const tracked = run.finally(() => {
      if (boardReplayFlushRef.current === tracked) boardReplayFlushRef.current = null;
    });
    boardReplayFlushRef.current = tracked;
    return tracked;
  };

  const onBoardReplayOp = (op: BoardReplayOp) => {
    setBoardHistory((previous) => replayBoardOperations(previous, [op]));
    boardReplayQueueRef.current.push({ ...op, client_operation_id: crypto.randomUUID() } as BoardReplayOp);
    persistBoardReplayQueue(boardReplayQueueRef.current);
    if (boardReplayLoadedRef.current && boardReplayQueueRef.current.length >= 24) {
      void flushBoardReplay();
    }
  };

  const syncBoardStrokes = (strokes: BoardHistory["document"]["strokes"]) => {
    setBoardHistory((previous) => ({
      ...previous,
      document: { ...previous.document, strokes },
    }));
  };

  const syncBoardGraphs = (graphs: BoardHistory["document"]["graphs"]) => {
    setBoardHistory((previous) => ({
      ...previous,
      document: { ...previous.document, graphs },
    }));
  };

  const syncBoardSolutions = (solutions: BoardHistory["document"]["solutions"]) => {
    setBoardHistory((previous) => ({
      ...previous,
      document: { ...previous.document, solutions },
    }));
  };

  const leaveLesson = async (next: () => void) => {
    await flushBoardReplay();
    next();
  };

  const typeText = (
    text: string,
    onUpdate: (partial: string) => void,
    shouldCancel: () => boolean
  ) =>
    new Promise<void>((resolve) => {
      if (!text) {
        onUpdate("");
        resolve();
        return;
      }
      if (ultraLite) {
        let index = 0;
        const tickMs = 120;
        const charsPerTick = Math.max(8, Math.floor((95 * tickMs) / 1000));
        const timer = window.setInterval(() => {
          if (shouldCancel()) {
            window.clearInterval(timer);
            resolve();
            return;
          }
          index = Math.min(text.length, index + charsPerTick);
          onUpdate(text.slice(0, index));
          if (index >= text.length) {
            window.clearInterval(timer);
            resolve();
          }
        }, tickMs);
        return;
      }
      let index = 0;
      let last = 0;
      const charsPerSecond = 140;
      const step = (ts: number) => {
        if (shouldCancel()) return resolve();
        if (!last) last = ts;
        const delta = ts - last;
        last = ts;
        const add = Math.max(1, Math.floor((delta * charsPerSecond) / 1000));
        index = Math.min(text.length, index + add);
        onUpdate(text.slice(0, index));
        if (index >= text.length) return resolve();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

  const serializeStorage = (
    nextTasks: Task[],
    nextSlides: Slide[],
    nextSiteBackground: SiteBackground,
    nextPresentationSource: PresentationSource
  ) =>
    JSON.stringify({
      tasks: nextTasks,
      slides: nextSlides,
      siteBackground: nextSiteBackground,
      presentationSource: nextPresentationSource,
    });

  useEffect(() => {
    if (!timerRunning) return;
    const id = setInterval(() => setTimerSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [timerRunning]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.classList.toggle("lite-mode", ultraLite);
    return () => {
      document.body.classList.remove("lite-mode");
    };
  }, [ultraLite]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(performanceModeKey, performanceMode);
  }, [performanceMode, performanceModeKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(freeBoardModeKey, JSON.stringify(freeBoardRequested));
  }, [freeBoardModeKey, freeBoardRequested]);

  useEffect(() => {
    if (freeBoardMode) setTaskOpen(false);
  }, [freeBoardMode]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      getStatus()
        .then((res) => {
          if (alive) setApiStatus(res);
        })
        .catch(() => {
          if (alive) setApiStatus({ ok: false, ai: false, ocr: false });
        });
    load();
    const id = setInterval(load, ultraLite ? 30000 : 10000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [ultraLite]);

  useEffect(() => {
    let alive = true;
    const loadReplay = async () => {
      boardReplayLoadedRef.current = false;
      setBoardHistory(createBoardHistory());
      let queue: BoardReplayOp[] = [];
      if (typeof window !== "undefined") {
        try {
          const raw = window.localStorage.getItem(boardReplayBackupKey);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) queue = parsed as BoardReplayOp[];
          }
        } catch {
          queue = [];
        }
      }
      boardReplayQueueRef.current = queue;
      try {
        const data = await loadBoardReplay(lesson.id);
        if (!alive) return;
        const serverOperations = Array.isArray(data.operations) ? data.operations : [];
        const pending = filterPendingBoardReplayOps(serverOperations, boardReplayQueueRef.current);
        boardReplayQueueRef.current = pending;
        persistBoardReplayQueue(pending);
        const base = replayBoardOperations(createBoardHistory(), serverOperations);
        const withQueue = pending.length ? replayBoardOperations(base, pending) : base;
        setBoardHistory(withQueue);
      } catch {
        if (!alive) return;
        const pending = boardReplayQueueRef.current;
        if (pending.length) {
          setBoardHistory((previous) => replayBoardOperations(previous, pending));
        }
      } finally {
        if (alive) boardReplayLoadedRef.current = true;
      }
    };
    loadReplay();
    return () => {
      alive = false;
    };
  }, [boardReplayBackupKey, lesson.id]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (!boardReplayLoadedRef.current) return;
      void flushBoardReplay();
    }, ultraLite ? 5000 : 2000);
    return () => window.clearInterval(id);
  }, [ultraLite]);

  useEffect(() => {
    const onPageHide = () => {
      if (!boardReplayQueueRef.current.length || typeof navigator === "undefined" || !navigator.sendBeacon) return;
      try {
        persistBoardReplayQueue(boardReplayQueueRef.current);
        const body = JSON.stringify({ operations: boardReplayQueueRef.current.slice(0, 80) });
        navigator.sendBeacon(`/api/lessons/${lesson.id}/board/operations`, new Blob([body], { type: "application/json" }));
      } catch {
        // keep the local backup; the server deduplicates retries by client operation id
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [lesson.id]);

  useEffect(() => {
    let alive = true;
    sessionApi.loadChat(lesson.id)
      .then((items) => {
        if (!alive) return;
        setMessages(items.map((item) => ({
          id: item.clientMessageId,
          role: item.role,
          text: item.status === "error" ? `${tl("error")}: ${item.text}` : item.text,
          mode: item.mode || undefined,
          timestamp: new Date(item.createdAt).toLocaleTimeString(locale === "kk" ? "kk-KZ" : locale === "en" ? "en-US" : "ru-RU", { hour: "2-digit", minute: "2-digit" }),
        })));
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [lesson.id, locale, tl]);

  useEffect(() => {
    if (currentSlide > slideData.length - 1) {
      setCurrentSlide(Math.max(0, slideData.length - 1));
    }
  }, [currentSlide, slideData.length]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(tasksSidebarWidthKey, JSON.stringify(tasksSidebarWidth));
  }, [tasksSidebarWidth, tasksSidebarWidthKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(slidesSidebarWidthKey, JSON.stringify(slidesSidebarWidth));
  }, [slidesSidebarWidth, slidesSidebarWidthKey]);

  useEffect(() => {
    latestStorageRef.current = { tasks: taskData, slides: slideData, siteBackground, presentationSource };
    if (!storageReadyRef.current) return;
    if (typeof window === "undefined") return;
    // аварийный локальный бэкап на случай внезапного отключения
    window.localStorage.setItem(
      storageBackupKey,
      serializeStorage(taskData, slideData, siteBackground, presentationSource)
    );
    setLastLocalBackupAt(Date.now());
  }, [taskData, slideData, siteBackground, presentationSource]);

  useEffect(() => {
    return () => {
      if (scoreHideTimerRef.current) window.clearTimeout(scoreHideTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const loadStorage = async () => {
      let loadedTasks = taskData;
      let loadedSlides = slideData;
      let loadedSiteBackground = siteBackground;
      let loadedPresentationSource = presentationSource;
      try {
        const res = await fetch(withSubjectApi("/api/storage"), { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as {
            tasks?: Task[];
            slides?: Slide[];
            siteBackground?: SiteBackground;
            presentationSource?: PresentationSource;
          };
          if (!alive) return;
          setLastServerSaveAt(Date.now());
          if (Array.isArray(data.tasks)) {
            loadedTasks = data.tasks;
            setTaskData(data.tasks);
          }
          if (Array.isArray(data.slides) && data.slides.length > 0) {
            loadedSlides = data.slides;
            setSlideData(data.slides);
            setCurrentSlide(0);
          }
          if (isSiteBackground(data.siteBackground)) {
            loadedSiteBackground = data.siteBackground;
            setSiteBackground(data.siteBackground);
          }
          if (isPresentationSource(data.presentationSource)) {
            loadedPresentationSource = data.presentationSource;
            setPresentationSource(data.presentationSource);
          }
        } else if (typeof window !== "undefined") {
          const backupRaw = window.localStorage.getItem(storageBackupKey);
          if (backupRaw) {
            const backup = JSON.parse(backupRaw) as {
              tasks?: Task[];
              slides?: Slide[];
              siteBackground?: SiteBackground;
              presentationSource?: PresentationSource;
            };
            if (Array.isArray(backup.tasks)) {
              loadedTasks = backup.tasks;
              setTaskData(backup.tasks);
            }
            if (Array.isArray(backup.slides) && backup.slides.length > 0) {
              loadedSlides = backup.slides;
              setSlideData(backup.slides);
              setCurrentSlide(0);
            }
            if (isSiteBackground(backup.siteBackground)) {
              loadedSiteBackground = backup.siteBackground;
              setSiteBackground(backup.siteBackground);
            }
            if (isPresentationSource(backup.presentationSource)) {
              loadedPresentationSource = backup.presentationSource;
              setPresentationSource(backup.presentationSource);
            }
          }
        }
      } catch {
        if (typeof window !== "undefined") {
          try {
            const backupRaw = window.localStorage.getItem(storageBackupKey);
            if (backupRaw) {
              const backup = JSON.parse(backupRaw) as {
                tasks?: Task[];
                slides?: Slide[];
                siteBackground?: SiteBackground;
                presentationSource?: PresentationSource;
              };
              if (Array.isArray(backup.tasks)) {
                loadedTasks = backup.tasks;
                setTaskData(backup.tasks);
              }
              if (Array.isArray(backup.slides) && backup.slides.length > 0) {
                loadedSlides = backup.slides;
                setSlideData(backup.slides);
                setCurrentSlide(0);
              }
              if (isSiteBackground(backup.siteBackground)) {
                loadedSiteBackground = backup.siteBackground;
                setSiteBackground(backup.siteBackground);
              }
              if (isPresentationSource(backup.presentationSource)) {
                loadedPresentationSource = backup.presentationSource;
                setPresentationSource(backup.presentationSource);
              }
            }
          } catch {
            // keep defaults if backup is broken
          }
        }
      } finally {
        const snapshot = serializeStorage(loadedTasks, loadedSlides, loadedSiteBackground, loadedPresentationSource);
        lastServerSnapshotRef.current = snapshot;
        latestStorageRef.current = {
          tasks: loadedTasks,
          slides: loadedSlides,
          siteBackground: loadedSiteBackground,
          presentationSource: loadedPresentationSource,
        };
        storageReadyRef.current = true;
        if (typeof window !== "undefined") {
          window.localStorage.setItem(storageBackupKey, snapshot);
          setLastLocalBackupAt(Date.now());
        }
      }
    };
    loadStorage();
    return () => {
      alive = false;
    };
  }, [storageBackupKey, subjectId]);

  useEffect(() => {
    const id = window.setInterval(async () => {
      if (!storageReadyRef.current) return;
      if (autoSavingRef.current) return;
      const current = latestStorageRef.current;
      const snapshot = serializeStorage(
        current.tasks,
        current.slides,
        current.siteBackground,
        current.presentationSource
      );
      if (snapshot === lastServerSnapshotRef.current) return;
      autoSavingRef.current = true;
      try {
        const res = await fetch(withSubjectApi("/api/storage"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: snapshot,
        });
        if (res.ok) {
          lastServerSnapshotRef.current = snapshot;
          setLastServerSaveAt(Date.now());
        }
      } catch {
        // сервер недоступен, остаемся на аварийном локальном бэкапе
      } finally {
        autoSavingRef.current = false;
      }
    }, 30000);
    return () => window.clearInterval(id);
  }, [withSubjectApi]);

  useEffect(() => {
    if (tab !== "slides") setSlideshowOpen(false);
  }, [tab]);

  useLayoutEffect(() => {
    if (!slideshowOpen) return;
    const wrap = slideShowWrapRef.current;
    if (!wrap) return;
    const update = () => {
      const rect = wrap.getBoundingClientRect();
      const scale = Math.max(rect.width / SLIDE_BASE_W, rect.height / SLIDE_BASE_H) || 1;
      setSlideShowScale(scale);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [slideshowOpen]);

  const selectedTask = taskData.find((t) => t.id === selectedTaskId) ?? taskData[0];

  useEffect(() => {
    if (!taskData.length) {
      setTaskOpen(false);
      return;
    }
    if (!taskData.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(taskData[0].id);
    }
  }, [selectedTaskId, taskData]);

  const slideshowSlide = slideData[currentSlide];
  const ringSize = 224;
  const ringStroke = 14;
  const ringRadius = (ringSize - ringStroke) / 2;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const lastAssistant = messages.slice().reverse().find((m) => m.role === "assistant" && m.text.trim());
  const shouldContinue = (text?: string) => {
    if (!text) return false;
    const t = text.trim().toLowerCase();
    if (!t) return false;
    if (t.endsWith("...") || t.endsWith("…")) return true;
    if (t.includes("обрыв") || t.includes("нет итогов")) return true;
    return false;
  };
  const canContinue = !!lastAssistant && !!aiBoardContext.trim() && shouldContinue(lastAssistant.text);
  const isOfficeEmbedSource = presentationSource.type === "m365" || presentationSource.type === "office";
  const officeEmbedLabel = presentationSource.type === "office" ? "Office" : "M365";

  const siteBgStyle: React.CSSProperties =
    siteBackground.mode === "solid"
      ? { backgroundColor: siteBackground.color, backgroundImage: "none" }
      : siteBackground.mode === "image"
        ? {
            backgroundColor: siteBackground.color,
            backgroundImage: siteBackground.image ? `url(${siteBackground.image})` : "none",
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
          }
        : { backgroundImage: siteBackground.gradient };
  const usesDefaultSiteBackground = siteBackground.mode === DEFAULT_SITE_BACKGROUND.mode
    && siteBackground.color === DEFAULT_SITE_BACKGROUND.color
    && siteBackground.gradient === DEFAULT_SITE_BACKGROUND.gradient
    && !siteBackground.image;
  const effectiveSiteBgStyle: React.CSSProperties = (ultraLite || (theme === "light" && usesDefaultSiteBackground))
    ? { backgroundColor: "var(--app-background)", backgroundImage: "none" }
    : siteBgStyle;

  const addMessage = (msg: AssistantMessage) => {
    setMessages((prev) => [...prev, msg]);
  };

  const updateMessage = (id: string, text: string) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text } : m)));
  };

  const appendStudentAttempt = (text: string) => {
    const msg: AssistantMessage = {
      id: `${Date.now()}-student`,
      role: "student",
      text,
      timestamp: new Date().toLocaleTimeString(locale === "kk" ? "kk-KZ" : locale === "en" ? "en-US" : "ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };
    setMessages((prev) => [...prev, msg]);
  };

  const extractCheckPercent = (text: string): number | null => {
    const normalized = text.replace(",", ".");
    const strict = /(?:^|\n)\s*\**\s*(?:выполнено|орындалды|completed)\s*:\s*(\d{1,3}(?:\.\d+)?)\s*%\s*\**\s*(?:\n|$)/i;
    const strictMatch = normalized.match(strict);
    if (!strictMatch) return null;
    const value = Number(strictMatch[1]);
    return Number.isFinite(value) ? clamp(Math.round(value), 0, 100) : null;
  };

  const recognizeBoard = async () => {
    if (!apiStatus?.ocr || !boardCanvasRef.current) {
      throw new Error(tl("ocr_not_available"));
    }
    return boardCanvasRef.current.recognize();
  };

  const cancelAiSolution = (solutionId: string) => {
    const active = activeSolutionTokenRef.current;
    if (!active || active.id !== solutionId) return;
    solutionRunRef.current += 1;
    activeSolutionTokenRef.current = null;
    const current = boardHistory.document.solutions.find((solution) => solution.id === solutionId);
    if (current && (current.status === "thinking" || current.status === "streaming")) {
      onBoardReplayOp({
        op: "solution_update",
        before: current,
        after: { ...current, status: "done" },
        ts: Date.now(),
      });
    }
    setAssistantLoading(false);
  };

  const handleBoardSolution = async (recognizedText: string) => {
    const boardText = recognizedText.trim();
    if (!boardText || assistantLoading) return;

    setAssistantLoading(true);
    setAiBoardContext(boardText);
    setTimerRunning(false);
    setAssistantOpen(false);

    const token = ++solutionRunRef.current;
    const solutionId = crypto.randomUUID();
    activeSolutionTokenRef.current = { id: solutionId, token };

    const isCancelled = () =>
      solutionRunRef.current !== token ||
      activeSolutionTokenRef.current?.id !== solutionId;

    try {
      const res = await callAi(
        "solution",
        boardText,
        undefined,
        undefined,
        false,
        subjectName,
        lesson.id,
        crypto.randomUUID(),
        true,
        true,
        locale,
      );
      if (isCancelled()) return;

      const rawSteps = extractSafeHandwritingSteps(res.steps, res.text, locale);
      if (!rawSteps.length) {
        throw new Error("AI вернул поврежденный structured response");
      }

      const placement = boardCanvasRef.current?.allocateSolutionPlacement(560, 480) ?? {
        x: 48,
        y: 48,
        width: 560,
        minHeight: 480,
      };

      const generated = solutionStepsToHandwritingStrokes(rawSteps, {
        x: placement.x + 12,
        y: placement.y + 10,
        maxWidth: Math.max(300, placement.width - 24),
        color: boardPenColor,
        strokeWidth: ultraLite ? 2.4 : 2.15,
        fontSize: ultraLite ? 27 : 29,
        lineGap: 11,
        stepGap: 16,
      });
      if (!generated.strokes.length) throw new Error("Не удалось построить рукописные штрихи");

      const written = await boardCanvasRef.current?.animateAiStrokes(
        generated.strokes,
        isCancelled,
        ultraLite,
      );
      if (!written?.length) return;

      onBoardReplayOp({
        op: "stroke_batch_add",
        strokes: written,
        ts: Date.now(),
      });
    } catch (err) {
      if (isCancelled()) return;
      const message = err instanceof Error ? err.message : tl("unknown_error");
      addMessage({
        id: `${Date.now()}-solution-error`,
        role: "assistant",
        text: `${tl("error")}: ${message}`,
        mode: "solution",
        timestamp: nowLabel(),
      });
      setAssistantOpen(true);
    } finally {
      if (activeSolutionTokenRef.current?.id === solutionId) {
        activeSolutionTokenRef.current = null;
      }
      if (solutionRunRef.current === token) setAssistantLoading(false);
    }
  };

  const handleRecognizedAi = (mode: AiMode, recognizedText: string) => {
    if (mode === "solution") {
      void handleBoardSolution(recognizedText);
      return;
    }
    void (async () => {
      const boardText = recognizedText.trim();
      if (!boardText || assistantLoading) return;
      setAssistantLoading(true);
      setAiBoardContext(boardText);
      if (mode !== "hint") setTimerRunning(false);
      appendStudentAttempt(boardText);

      continueTokenRef.current += 1;
      const token = continueTokenRef.current;
      const id = `${Date.now()}-${Math.random()}`;
      addMessage({
        id,
        role: "assistant",
        text: tl("thinking"),
        mode,
        timestamp: nowLabel(),
      });

      try {
        let fullText = "";
        const res = await callAi(
          mode,
          boardText,
          undefined,
          undefined,
          false,
          subjectName,
          lesson.id,
          crypto.randomUUID(),
          true,
          undefined,
          locale,
        );
        fullText = res.text || "";
        await typeText(
          fullText,
          (partial) => updateMessage(id, partial),
          () => continueTokenRef.current !== token,
        );

        let guard = 0;
        while (guard < 2 && shouldContinue(fullText) && continueTokenRef.current === token) {
          guard += 1;
          const continuation = await callAi(
            mode,
            boardText,
            undefined,
            fullText,
            true,
            subjectName,
            lesson.id,
            crypto.randomUUID(),
            true,
            undefined,
            locale,
          );
          const next = continuation.text || "";
          if (!next.trim()) break;
          await typeText(
            next,
            (partial) => updateMessage(id, `${fullText}\n${partial}`),
            () => continueTokenRef.current !== token,
          );
          fullText = `${fullText}\n${next}`;
        }

        if (mode === "check") {
          const percent = extractCheckPercent(fullText);
          if (percent !== null) showScoreOverlay(percent);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : tl("unknown_error");
        updateMessage(id, `${tl("error")}: ${message}`);
      } finally {
        setAssistantLoading(false);
      }
    })();
  };

  const handleContinue = async () => {
    if (assistantLoading) return;
    const lastAssistant = messages.slice().reverse().find((m) => m.role === "assistant" && m.text.trim());
    if (!lastAssistant || !aiBoardContext.trim()) return;
    if (!shouldContinue(lastAssistant.text)) return;
    setAssistantLoading(true);
    continueTokenRef.current += 1;
    const token = continueTokenRef.current;
    const id = `${Date.now()}-${Math.random()}`;
    addMessage({
      id,
      role: "assistant",
      text: tl("thinking"),
      mode: "continue",
      timestamp: nowLabel(),
    });
    try {
      const mode = (lastAssistant.mode as AiMode) || "solution";
      const res = await callAi(
        mode,
        aiBoardContext,
        undefined,
        lastAssistant.text,
        true,
        subjectName,
        lesson.id,
        crypto.randomUUID(),
        true,
        undefined,
        locale,
      );
      await typeText(res.text, (partial) => updateMessage(id, partial), () => continueTokenRef.current !== token);
    } catch (err) {
      const message = err instanceof Error ? err.message : tl("unknown_error");
      updateMessage(id, `${tl("error")}: ${message}`);
    } finally {
      setAssistantLoading(false);
    }
  };

  const handleM365Fallback = async () => {
    if (presentationSource.type !== "m365" || !presentationSource.fileId) return;
    try {
      const res = await fetch("/api/m365/presentation/fallback/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: presentationSource.fileId }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        presentationSource?: unknown;
        fallbackPdf?: unknown;
      };
      if (isPresentationSource(data.presentationSource)) {
        setPresentationSource(data.presentationSource);
        return;
      }
      const fallbackPdf = Array.isArray(data.fallbackPdf)
        ? data.fallbackPdf.filter((x): x is string => typeof x === "string")
        : [];
      setPresentationSource((prev) => ({
        ...prev,
        type: "m365",
        embedUrl: null,
        fallbackPdf,
        lastSyncTs: Date.now(),
      }));
    } catch {
      // keep current source if fallback failed
    }
  };

  const startResize =
    (target: "task" | "assistant") => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();

      const panel = e.currentTarget.closest<HTMLElement>("[data-floating-panel]");
      if (!panel) return;

      const rect = panel.getBoundingClientRect();
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startY = e.clientY;
      const startSize = { w: rect.width, h: rect.height };
      const min = target === "task" ? { w: 420, h: 360 } : { w: 340, h: 320 };
      const viewportPadding = 12;
      const bounds = appRef.current?.getBoundingClientRect();
      const rightBound = bounds?.right ?? window.innerWidth;
      const bottomBound = bounds?.bottom ?? window.innerHeight;
      const max = {
        w: Math.max(min.w, rightBound - rect.left - viewportPadding),
        h: Math.max(min.h, bottomBound - rect.top - viewportPadding),
      };

      const root = document.documentElement;
      const previousCursor = root.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      root.style.cursor = "nwse-resize";
      document.body.style.userSelect = "none";

      const handleMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const next = {
          w: clamp(startSize.w + (ev.clientX - startX), min.w, max.w),
          h: clamp(startSize.h + (ev.clientY - startY), min.h, max.h),
        };
        if (target === "task") setTaskSize(next);
        else setAssistantSize(next);
      };

      const cleanup = () => {
        root.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleUp);
      };

      const handleUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        cleanup();
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleUp);
    };

  const startSidebarResize =
    (target: "tasks" | "slides") => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = target === "tasks" ? tasksSidebarWidth : slidesSidebarWidth;
      const min = 240;
      const max = Math.max(min, Math.floor(window.innerWidth * 0.55));

      const handleMove = (ev: PointerEvent) => {
        const next = clamp(startW + (ev.clientX - startX), min, max);
        if (target === "tasks") setTasksSidebarWidth(next);
        else setSlidesSidebarWidth(next);
      };

      const handleUp = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    };

  const toggleFreeBoardMode = () => {
    if (freeBoardForced) return;
    setFreeBoardRequested((value) => !value);
  };

  const toggleTaskPanel = () => {
    setTaskOpen((open) => {
      const next = !open;
      if (next) setFocusedFloatingPanel("task");
      else if (assistantOpen) setFocusedFloatingPanel("assistant");
      return next;
    });
  };

  const toggleAssistantPanel = () => {
    setAssistantOpen((open) => {
      const next = !open;
      if (next) setFocusedFloatingPanel("assistant");
      else if (taskOpen) setFocusedFloatingPanel("task");
      return next;
    });
  };

  const closeTaskPanel = () => {
    setTaskOpen(false);
    if (assistantOpen) setFocusedFloatingPanel("assistant");
  };

  const closeAssistantPanel = () => {
    setAssistantOpen(false);
    if (taskOpen) setFocusedFloatingPanel("task");
  };

  const nextSlide = () => {
    setCurrentSlide((prev) => {
      if (prev >= slideData.length - 1) {
        if (slideshowOpen) setSlideshowOpen(false);
        return prev;
      }
      return prev + 1;
    });
  };

  const prevSlide = () => {
    setCurrentSlide((prev) => Math.max(0, prev - 1));
  };

  useEffect(() => {
    if (!slideshowOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (!isOfficeEmbedSource && ["ArrowRight", "PageDown"].includes(e.key)) nextSlide();
      if (!isOfficeEmbedSource && ["ArrowLeft", "PageUp"].includes(e.key)) prevSlide();
      if (e.key === "Escape") setSlideshowOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [slideshowOpen, slideData.length, isOfficeEmbedSource]);

  if (slideshowOpen && tab === "slides" && isOfficeEmbedSource && presentationSource.embedUrl) {
    return (
      <MotionConfig reducedMotion={ultraLite ? "always" : "never"}>
        <div className="min-h-screen bg-black">
          <div className="relative h-screen w-screen overflow-hidden">
            <Button
              variant="outline"
              size="sm"
              className="absolute right-4 top-4 z-20"
              onClick={() => setSlideshowOpen(false)}
            >
              <X size={14} className="mr-2" />
              {tl("close")}
            </Button>
            <iframe
              src={presentationSource.embedUrl}
              className="absolute inset-0 h-full w-full border-0"
              referrerPolicy="no-referrer"
              allow="clipboard-read; clipboard-write; fullscreen"
            />
          </div>
        </div>
      </MotionConfig>
    );
  }

  if (slideshowOpen && tab === "slides" && slideshowSlide) {
    return (
      <MotionConfig reducedMotion={ultraLite ? "always" : "never"}>
      <div className="min-h-screen" style={effectiveSiteBgStyle}>
        <div
          className="relative h-screen w-screen overflow-hidden"
          style={{ touchAction: "none" }}
          onPointerDown={(e) => {
            const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
            const x = e.clientX - rect.left;
            if (x > rect.width / 2) nextSlide();
            else prevSlide();
          }}
        >
          <Button
            variant="outline"
            size="sm"
            className="absolute right-4 top-4 z-20"
            onClick={() => setSlideshowOpen(false)}
          >
            <X size={14} className="mr-2" />
            {tl("close")}
          </Button>
          <div className="absolute left-1/2 top-6 z-10 -translate-x-1/2 text-xs text-frost/60">
            {currentSlide + 1} / {slideData.length}
          </div>
          <div ref={slideShowWrapRef} className="absolute inset-0 flex items-center justify-center overflow-hidden">
            <div
              className="relative"
              style={{
                width: SLIDE_BASE_W,
                height: SLIDE_BASE_H,
                transform: `scale(${slideShowScale})`,
                transformOrigin: "center",
                backgroundImage: slideshowSlide.background ? `url(${slideshowSlide.background})` : undefined,
                backgroundSize: "cover",
                backgroundPosition: "center",
                backgroundRepeat: "no-repeat",
              }}
            >
              {slideshowSlide.elements && slideshowSlide.elements.length > 0 ? (
                slideshowSlide.elements.map((el) =>
                  el.type === "text" ? (
                    <div
                      key={el.id}
                      className="absolute"
                      style={{
                        left: el.x,
                        top: el.y,
                        width: el.w,
                        height: el.h,
                        padding: el.padding ?? 0,
                        paddingLeft: el.paddingLeft ?? el.padding ?? 0,
                        paddingRight: el.paddingRight ?? el.padding ?? 0,
                        paddingTop: el.paddingTop ?? el.padding ?? 0,
                        paddingBottom: el.paddingBottom ?? el.padding ?? 0,
                        fontSize: el.fontSize ?? 24,
                        lineHeight: 1.25,
                        fontFamily: el.fontFamily,
                        color: el.color ?? "#E7F2FF",
                        textAlign: el.align ?? "left",
                        WebkitTextStroke:
                          el.strokeWidth && el.strokeColor ? `${el.strokeWidth}px ${el.strokeColor}` : undefined,
                        transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
                        transformOrigin: "center",
                      }}
                    >
                      <MathText text={el.text} />
                    </div>
                  ) : el.type === "image" ? (
                    <img
                      key={el.id}
                      src={el.src}
                      alt=""
                      className="absolute object-contain"
                      style={{
                        left: el.x,
                        top: el.y,
                        width: el.w,
                        height: el.h,
                        transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
                        transformOrigin: "center",
                      }}
                    />
                  ) : (
                    <div
                      key={el.id}
                      className="absolute"
                      style={{
                        left: el.x,
                        top: el.y,
                        width: el.w,
                        height: el.h,
                        backgroundColor: el.fill ?? "transparent",
                        border:
                          el.strokeWidth && el.strokeColor
                            ? `${el.strokeWidth}px solid ${el.strokeColor}`
                            : "none",
                        borderRadius: el.shape === "ellipse" ? "999px" : el.shape === "round" ? "24px" : "8px",
                        transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
                        transformOrigin: "center",
                      }}
                    />
                  )
                )
              ) : (
                <div className="h-full w-full p-6 text-2xl text-frost/95">
                  <MathText text={slideshowSlide.content} />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion={ultraLite ? "always" : "never"}>
    <div
      ref={appRef}
      className="h-screen overflow-hidden px-1 pt-2"
      onContextMenu={(e) => e.preventDefault()}
      style={effectiveSiteBgStyle}
    >
      <div className="mx-auto flex h-full w-full max-w-[1920px] min-h-0 flex-col gap-3">
        <TopBar
          apiStatus={apiStatus}
          lessonTitle={lessonTitle}
          presenterMode={presenterMode}
          onTogglePresenter={() => setPresenterMode((v) => !v)}
          running={timerRunning}
          seconds={timerSeconds}
          onToggleRunning={() => setTimerRunning((v) => !v)}
          onReset={() => setTimerSeconds(0)}
          currentTab={tab}
          tabs={tabs}
          onChangeTab={(id) => setTab(id as TabId)}
          slideshowOpen={slideshowOpen}
          onToggleSlideshow={() => setSlideshowOpen((v) => !v)}
          slideshowDisabled={tab !== "slides"}
          m365Mode={tab === "slides" && isOfficeEmbedSource}
          m365BadgeLabel={officeEmbedLabel}
          performanceMode={performanceMode}
          onChangePerformanceMode={setPerformanceMode}
          schoolName={school.name}
          roomName={room.name}
          grade={lesson.grade}
          subjectName={subjectName}
          onCompleteLesson={() => void leaveLesson(onComplete)}
          onOpenHistory={() => void leaveLesson(onOpenHistory)}
          onChangeRoom={() => void leaveLesson(onChangeRoom)}
        />
        <div className="relative min-h-0 flex-1">
          {tab === "tasks" && (
            <div className="relative flex h-full min-h-0 flex-col gap-2">
              <div className="relative min-h-0 flex-1">
              <AnimatePresence mode="wait">
                {boardExpanded ? (
                  <motion.div
                    key="board-expanded"
                    className="h-full"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.25 }}
                  >
                    <BoardCanvas
                      ref={boardCanvasRef}
                      ocrEnabled={!!apiStatus?.ocr}
                      expanded={boardExpanded}
                      onTogglePanels={() => setBoardExpanded((v) => !v)}
                      onStartTimer={() => setTimerRunning(true)}
                      initialStrokes={boardHistory.document.strokes}
                      onChangeStrokes={syncBoardStrokes}
                      initialGraphs={boardHistory.document.graphs}
                      onChangeGraphs={syncBoardGraphs}
                      initialSolutions={boardHistory.document.solutions}
                      onChangeSolutions={syncBoardSolutions}
                      onCancelAiSolution={cancelAiSolution}
                      canUndo={boardHistory.undoStack.length > 0}
                      canRedo={boardHistory.redoStack.length > 0}
                      initialPenColor={boardPenColor}
                      onChangePenColor={setBoardPenColor}
                      initialBgColor={boardBgColor}
                      onChangeBgColor={setBoardBgColor}
                      onReplayOp={onBoardReplayOp}
                      lowPowerOverride={ultraLite}
                      renderQualityMode={performanceMode}
                      taskOpen={taskOpen}
                      assistantOpen={assistantOpen}
                      onToggleTask={!freeBoardMode && taskData.length ? toggleTaskPanel : undefined}
                      onToggleAssistant={toggleAssistantPanel}
                      boardProfile={boardProfile}
                    />
                  </motion.div>
                ) : (
                  <motion.div
                    key="board-split"
                    className="grid h-full gap-2"
                    style={{ gridTemplateColumns: `${tasksSidebarWidth}px 8px 1fr` }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.25 }}
                  >
                    <motion.div
                      className="glass rounded-2xl p-4 shadow-soft"
                      initial={{ x: -12, opacity: 0 }}
                      animate={{ x: 0, opacity: 1 }}
                      exit={{ x: -12, opacity: 0 }}
                      transition={{ duration: 0.25 }}
                    >
                      <div className="mb-3">
                        <h3 className="text-sm font-semibold uppercase tracking-wider text-frost/70">
                          {tl("cards_count_tasks", { count: taskData.length })}
                        </h3>
                      </div>
                      <div ref={listRef} className="scrollbar-hide max-h-[60vh] overflow-auto pr-1">
                        <div className="grid grid-cols-1 gap-2">
                          <button
                            type="button"
                            aria-pressed={freeBoardMode}
                            disabled={freeBoardForced}
                            title={freeBoardForced ? tl("free_board_auto") : tl("free_board_description")}
                            onClick={toggleFreeBoardMode}
                            className={
                              freeBoardMode
                                ? "w-full rounded-xl border border-accent/60 bg-accent/10 px-3 py-2.5 text-left"
                                : "w-full rounded-xl border border-white/10 px-3 py-2.5 text-left transition hover:border-white/30"
                            }
                          >
                            <div className="text-[12px] font-semibold text-frost">{tl("free_board_mode")}</div>
                            <div className="mt-1 text-[11px] leading-4 text-frost/45">
                              {freeBoardForced ? tl("free_board_auto") : tl("free_board_description")}
                            </div>
                          </button>

                          {taskData.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-white/10 px-3 py-4 text-[12px] leading-5 text-frost/45">
                              {tl("teacher_tasks_empty")}
                            </div>
                          ) : (
                            taskData.map((task) => (
                              <button
                                key={task.id}
                                type="button"
                                className={
                                  !freeBoardMode && task.id === selectedTaskId
                                    ? "w-full rounded-xl border border-accent/60 bg-accent/10 px-3 py-2 text-left text-sm"
                                    : "w-full rounded-xl border border-white/10 px-3 py-2 text-left text-sm hover:border-white/30"
                                }
                                onClick={() => {
                                  setSelectedTaskId(task.id);
                                  setFreeBoardRequested(false);
                                }}
                              >
                                <div className="flex items-center justify-between">
                                  <span className="font-semibold">#{task.id}</span>
                                  <span className="text-xs text-frost/60">{task.tags[0] ?? tl("task")}</span>
                                </div>
                                <div className="text-xs text-frost/70">
                                  {task.id === selectedTaskId ? (
                                    <div className="inline-block align-middle">
                                      <MathText text={task.title} />
                                    </div>
                                  ) : (
                                    task.title.replace(/\$/g, "")
                                  )}
                                </div>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    </motion.div>

                    <motion.div
                      className="relative flex h-full items-stretch"
                      onPointerDown={startSidebarResize("tasks")}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.25 }}
                    >
                      <div
                        className="h-full w-2 cursor-col-resize rounded-full bg-white/5 hover:bg-white/10"
                        style={{ touchAction: "none" }}
                      />
                    </motion.div>

                    <motion.div
                      initial={{ opacity: 0, x: 12 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 12 }}
                      transition={{ duration: 0.25 }}
                    >
                      <BoardCanvas
                        ref={boardCanvasRef}
                        ocrEnabled={!!apiStatus?.ocr}
                        expanded={boardExpanded}
                        onTogglePanels={() => setBoardExpanded((v) => !v)}
                        onStartTimer={() => setTimerRunning(true)}
                        initialStrokes={boardHistory.document.strokes}
                        onChangeStrokes={syncBoardStrokes}
                        initialGraphs={boardHistory.document.graphs}
                        onChangeGraphs={syncBoardGraphs}
                        initialSolutions={boardHistory.document.solutions}
                        onChangeSolutions={syncBoardSolutions}
                        onCancelAiSolution={cancelAiSolution}
                        canUndo={boardHistory.undoStack.length > 0}
                        canRedo={boardHistory.redoStack.length > 0}
                        initialPenColor={boardPenColor}
                        onChangePenColor={setBoardPenColor}
                        initialBgColor={boardBgColor}
                        onChangeBgColor={setBoardBgColor}
                        onReplayOp={onBoardReplayOp}
                        lowPowerOverride={ultraLite}
                        renderQualityMode={performanceMode}
                        taskOpen={taskOpen}
                        assistantOpen={assistantOpen}
                        onToggleTask={!freeBoardMode && taskData.length ? toggleTaskPanel : undefined}
                        onToggleAssistant={toggleAssistantPanel}
                        boardProfile={boardProfile}
                      />
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
              </div>

              <AnimatePresence>
                {taskOpen && selectedTask && (
                  <motion.div
                    data-floating-panel
                    className="absolute touch-none"
                    style={{
                      left: "max(12px, calc(100% - 576px))",
                      top: "max(12px, calc(100% - 600px))",
                      width: taskSize.w,
                      height: taskSize.h,
                      maxWidth: "calc(100% - 24px)",
                      maxHeight: "calc(100% - 24px)",
                      zIndex: focusedFloatingPanel === "task" ? 40 : 30,
                    }}
                    onPointerDownCapture={() => setFocusedFloatingPanel("task")}
                    drag
                    dragControls={taskDragControls}
                    dragListener={false}
                    dragMomentum={false}
                    dragElastic={0}
                    dragConstraints={appRef}
                    initial={{ opacity: 0, scale: 0.98, y: 8 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98, y: 8 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className="surface-popover relative flex h-full flex-col overflow-hidden rounded-[18px] shadow-[0_18px_46px_rgb(0_0_0/0.14)]">
                      <div
                        className="modal-handle flex h-12 cursor-grab items-center justify-between border-b border-white/10 px-4 active:cursor-grabbing"
                        onPointerDown={(e) => taskDragControls.start(e)}
                      >
                        <div className="text-[12px] font-semibold text-frost/65">
                          {tl("exercise")}
                        </div>
                        <button
                          className="grid h-8 w-8 place-items-center rounded-lg text-frost/45 transition hover:bg-white/[0.06] hover:text-frost"
                          onClick={closeTaskPanel}
                          aria-label="Закрыть"
                        >
                          <X size={16} />
                        </button>
                      </div>
                      <div className="min-h-0 flex-1 overflow-auto p-4">
                        <TaskPanel task={selectedTask} />
                      </div>
                      <div
                        className="absolute bottom-1.5 right-1.5 h-4 w-4 cursor-se-resize touch-none opacity-35 after:absolute after:bottom-0 after:right-0 after:h-2.5 after:w-2.5 after:border-b after:border-r after:border-frost/50"
                        onPointerDown={startResize("task")}
                        title={tl("resize")}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {assistantOpen && (
                  <motion.div
                    data-floating-panel
                    className="absolute touch-none"
                    style={{
                      left: "max(12px, calc(100% - 436px))",
                      top: "max(12px, calc(100% - 500px))",
                      width: assistantSize.w,
                      height: assistantSize.h,
                      maxWidth: "calc(100% - 24px)",
                      maxHeight: "calc(100% - 24px)",
                      zIndex: focusedFloatingPanel === "assistant" ? 40 : 30,
                    }}
                    onPointerDownCapture={() => setFocusedFloatingPanel("assistant")}
                    drag
                    dragControls={assistantDragControls}
                    dragListener={false}
                    dragMomentum={false}
                    dragElastic={0}
                    dragConstraints={appRef}
                    initial={{ opacity: 0, scale: 0.98, y: 8 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98, y: 8 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className="surface-popover relative flex h-full flex-col overflow-hidden rounded-[18px] shadow-[0_18px_46px_rgb(0_0_0/0.14)]">
                      <div
                        className="modal-handle flex h-12 cursor-grab items-center justify-between border-b border-white/10 px-4 active:cursor-grabbing"
                        onPointerDown={(e) => assistantDragControls.start(e)}
                      >
                        <div className="text-[12px] font-semibold text-frost/65">
                          {tl("ai_assistant")}
                        </div>
                        <button
                          className="grid h-8 w-8 place-items-center rounded-lg text-frost/45 transition hover:bg-white/[0.06] hover:text-frost"
                          onClick={closeAssistantPanel}
                          aria-label="Закрыть"
                        >
                          <X size={16} />
                        </button>
                      </div>
                      <div className="min-h-0 flex-1 overflow-hidden p-4">
                        <AIAssistant
                          messages={messages}
                          onContinue={handleContinue}
                          canContinue={canContinue}
                          loading={assistantLoading}
                          lowPowerMode={ultraLite}
                          ocrEnabled={!!apiStatus?.ocr}
                          onRecognizeBoard={recognizeBoard}
                          onSubmitRecognized={handleRecognizedAi}
                        />
                      </div>
                      <div
                        className="absolute bottom-1.5 right-1.5 h-4 w-4 cursor-se-resize touch-none opacity-35 after:absolute after:bottom-0 after:right-0 after:h-2.5 after:w-2.5 after:border-b after:border-r after:border-frost/50"
                        onPointerDown={startResize("assistant")}
                        title={tl("resize")}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

            </div>
          )}

          {tab === "slides" &&
            (isOfficeEmbedSource ? (
              <OfficePresentationFrame
                source={presentationSource}
                pageIndex={currentSlide}
                onPageIndexChange={setCurrentSlide}
                onFallback={handleM365Fallback}
              />
            ) : (
              <div className="grid h-full gap-2" style={{ gridTemplateColumns: `${slidesSidebarWidth}px 8px 1fr` }}>
                <div className="glass rounded-2xl p-4 shadow-soft">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold uppercase tracking-wider text-frost/70">{tl("lesson_slides")}</h3>
                    <Badge>{tl("plan")}</Badge>
                  </div>
                  <div className="flex flex-col gap-2">
                    {slideData.map((slide, idx) => (
                      <button
                        key={slide.id}
                        className={
                          idx === currentSlide
                            ? "rounded-xl border border-neon/40 bg-white/10 px-3 py-2 text-left text-sm"
                            : "rounded-xl border border-white/10 px-3 py-2 text-left text-sm text-frost/70 hover:border-white/30"
                        }
                        onClick={() => setCurrentSlide(idx)}
                      >
                        <div className="flex items-center justify-between">
                          <span>{slide.title}</span>
                          <span className="text-xs text-frost/50">{idx + 1}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
                <div
                  className="relative flex h-full items-stretch"
                  onPointerDown={startSidebarResize("slides")}
                >
                  <div
                    className="h-full w-2 cursor-col-resize rounded-full bg-white/5 hover:bg-white/10"
                    style={{ touchAction: "none" }}
                  />
                </div>
                <Slides
                  slides={slideData}
                  index={currentSlide}
                  onChange={setCurrentSlide}
                  presenterMode={presenterMode}
                  enableHotkeys={!slideshowOpen}
                />
              </div>
            ))}

          {tab === "teacher" && (
            <div className="h-full">
              {!teacherUnlocked ? (
                <TeacherPinGate storageKey={teacherPinKey} onUnlock={() => setTeacherUnlocked(true)} />
              ) : (
                <Suspense
                  fallback={
                    <div className="glass flex h-full items-center justify-center rounded-2xl text-sm text-frost/70">
                      {tl("loading")}
                    </div>
                  }
                >
                  <TeacherDashboard
                    subjectId={subjectId}
                    tasks={taskData}
                    slides={slideData}
                    presentationSource={presentationSource}
                    onChangeTasks={setTaskData}
                    onChangeSlides={setSlideData}
                    onChangePresentationSource={setPresentationSource}
                    onClose={() => setTab("tasks")}
                    siteBackground={siteBackground}
                    onChangeSiteBackground={setSiteBackground}
                    autosaveInfo={{ intervalSec: 30, lastServerSaveAt, lastLocalBackupAt }}
                    fullPage
                  />
                </Suspense>
              )}
            </div>
          )}

        </div>

      </div>
      <AnimatePresence>
        {scoreOverlay && (
          <motion.div
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              className="rounded-3xl px-8 py-7 text-center"
              initial={{ scale: 0.94, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.97, opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <div className="relative mx-auto h-56 w-56">
                <svg className="absolute inset-0" viewBox={`0 0 ${ringSize} ${ringSize}`}>
                  <circle
                    cx={ringSize / 2}
                    cy={ringSize / 2}
                    r={ringRadius}
                    fill="none"
                    stroke="rgba(231,242,255,0.12)"
                    strokeWidth={ringStroke}
                  />
                  <circle
                    cx={ringSize / 2}
                    cy={ringSize / 2}
                    r={ringRadius}
                    fill="none"
                    stroke={scoreOverlay.color}
                    strokeWidth={ringStroke}
                    strokeLinecap="round"
                    strokeDasharray={ringCircumference}
                    strokeDashoffset={ringCircumference * (1 - scoreOverlay.percent / 100)}
                    transform={`rotate(-90 ${ringSize / 2} ${ringSize / 2})`}
                  />
                </svg>
                <div className="absolute inset-[14px] flex items-center justify-center rounded-full bg-transparent">
                  <div className="text-5xl font-semibold" style={{ color: scoreOverlay.color }}>
                    {scoreOverlay.percent}%
                  </div>
                </div>
              </div>
              <div className="mt-5 text-xl font-semibold" style={{ color: scoreOverlay.color }}>
                {scoreOverlay.message}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </MotionConfig>
  );
}
