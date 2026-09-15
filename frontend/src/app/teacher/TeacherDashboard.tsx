import { useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "@/app/tasks/tasks";
import type { Slide, SlideElement } from "@/app/presentation/Slides";
import { DEFAULT_PRESENTATION_SOURCE, type PresentationSource } from "@/app/presentation/presentationSource";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import MathText from "@/components/MathText";
import { useI18n } from "@/i18n";
import { drawStrokes, type Stroke } from "@/app/board/boardEngine";
import { withSubjectQuery } from "@/app/subjects/subjectConfig";
import { Download, Pause, Play, RefreshCw } from "lucide-react";

const STAGE_W = 960;
const STAGE_H = 540;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const formatDateTime = (ts: number, locale: "ru" | "kk") =>
  new Date(ts).toLocaleString(locale === "kk" ? "kk-KZ" : "ru-RU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const applyReplayOp = (strokes: Stroke[], redo: Stroke[], op: ReplayOp) => {
  const nextStrokes = [...strokes];
  const nextRedo = [...redo];
  if (op.op === "add") {
    nextStrokes.push(op.stroke);
    nextRedo.length = 0;
  } else if (op.op === "undo") {
    const last = nextStrokes.pop();
    if (last) nextRedo.push(last);
  } else if (op.op === "redo") {
    const restore = nextRedo.pop();
    if (restore) nextStrokes.push(restore);
  } else if (op.op === "clear") {
    nextStrokes.length = 0;
    nextRedo.length = 0;
  }
  return { strokes: nextStrokes, redo: nextRedo };
};

const computeReplayState = (ops: ReplayOp[], cursor: number) => {
  let strokes: Stroke[] = [];
  let redo: Stroke[] = [];
  const end = Math.max(0, Math.min(cursor, ops.length));
  for (let i = 0; i < end; i += 1) {
    const result = applyReplayOp(strokes, redo, ops[i]);
    strokes = result.strokes;
    redo = result.redo;
  }
  return { strokes, redo };
};

const getReplayDelayMs = (ops: ReplayOp[], cursor: number, speed: number) => {
  if (cursor <= 0) return 0;
  const prev = ops[cursor - 1];
  const current = ops[cursor];
  if (!prev || !current) return 0;
  const safeSpeed = speed > 0 ? speed : 1;
  const delta = Math.max(0, current.ts - prev.ts);
  return Math.round(delta / safeSpeed);
};

const REPLAY_DRAW_FPS = 24;
const REPLAY_MIN_STROKE_MS = 120;
const REPLAY_MAX_STROKE_MS = 2500;
const REPLAY_MAX_STROKE_POINTS = 180;

const compactStrokeForReplay = (stroke: Stroke) => {
  const pts = stroke.points ?? [];
  if (pts.length <= REPLAY_MAX_STROKE_POINTS) return stroke;
  const step = Math.ceil(pts.length / REPLAY_MAX_STROKE_POINTS);
  const sampled = pts.filter((_, i) => i % step === 0);
  const last = pts[pts.length - 1];
  const tail = sampled[sampled.length - 1];
  if (!tail || tail.x !== last.x || tail.y !== last.y) sampled.push(last);
  if (sampled.length < 2) sampled.push(last);
  return { ...stroke, points: sampled };
};

const FONT_OPTIONS = [
  "Calibri",
  "Montserrat",
  "Manrope",
  "Merriweather",
  "PT Sans",
  "Fira Sans",
  "Times New Roman",
  "Georgia",
  "Arial",
];

type ReplayOp =
  | { op: "add"; ts: number; stroke: Stroke }
  | { op: "undo"; ts: number }
  | { op: "redo"; ts: number }
  | { op: "clear"; ts: number };

type ReplayItem = {
  id: string;
  startTs: number;
  endTs: number;
  durationSec: number;
  opsCount: number;
  addCount: number;
  undoCount: number;
  redoCount: number;
  clearCount: number;
};

type ReplayDetail = ReplayItem & { ops: ReplayOp[] };

type AiHistoryItem = {
  ts: number;
  mode: "hint" | "check" | "solution";
  problem: string;
  studentAttempt?: string | null;
  response?: string;
  error?: string;
  ok: boolean;
};

export default function TeacherDashboard({
  subjectId,
  tasks,
  slides,
  presentationSource,
  onChangeTasks,
  onChangeSlides,
  onChangePresentationSource,
  onClose,
  onDragHandlePointerDown,
  siteBackground,
  onChangeSiteBackground,
  autosaveInfo,
  fullPage = false,
}: {
  subjectId: string;
  tasks: Task[];
  slides: Slide[];
  presentationSource: PresentationSource;
  onChangeTasks: (next: Task[]) => void;
  onChangeSlides: (next: Slide[]) => void;
  onChangePresentationSource: (next: PresentationSource) => void;
  onClose: () => void;
  onDragHandlePointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  siteBackground: {
    mode: "solid" | "gradient" | "image";
    color: string;
    gradient: string;
    image: string;
  };
  onChangeSiteBackground: (next: {
    mode: "solid" | "gradient" | "image";
    color: string;
    gradient: string;
    image: string;
  }) => void;
  autosaveInfo?: {
    intervalSec: number;
    lastServerSaveAt: number | null;
    lastLocalBackupAt: number | null;
  };
  fullPage?: boolean;
}) {
  const { tl, locale } = useI18n();
  const withSubjectApi = (path: string) => withSubjectQuery(path, subjectId);
  const [section, setSection] = useState<"tasks" | "slides" | "replays">("tasks");
  const [taskIndex, setTaskIndex] = useState(0);
  const [slideIndex, setSlideIndex] = useState(0);
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const dragRef = useRef<{
    id: string;
    mode: "move" | "resize";
    handle?: "nw" | "ne" | "sw" | "se";
    startX: number;
    startY: number;
    rect: { x: number; y: number; w: number; h: number };
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pptxInputRef = useRef<HTMLInputElement | null>(null);
  const m365PptxInputRef = useRef<HTMLInputElement | null>(null);
  const officeViewerInputRef = useRef<HTMLInputElement | null>(null);
  const authPopupRef = useRef<Window | null>(null);
  const [imageTargetId, setImageTargetId] = useState<string | null>(null);
  const [bgImageTarget, setBgImageTarget] = useState(false);
  const [pptxLoading, setPptxLoading] = useState(false);
  const [pptxError, setPptxError] = useState<string | null>(null);
  const [pptxWithBackground, setPptxWithBackground] = useState(false);
  const [pptxMode, setPptxMode] = useState<"full" | "editable" | "stickers">("full");
  const [serverLoading, setServerLoading] = useState(false);
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [m365Loading, setM365Loading] = useState(false);
  const [m365StatusLoading, setM365StatusLoading] = useState(false);
  const [officeViewerLink, setOfficeViewerLink] = useState("");
  const [m365Status, setM365Status] = useState<{
    configured: boolean;
    connected: boolean;
    user?: { displayName?: string | null; userPrincipalName?: string | null } | null;
  } | null>(null);
  const [showSlideMeta, setShowSlideMeta] = useState(true);
  const [replaysLoading, setReplaysLoading] = useState(false);
  const [replayItems, setReplayItems] = useState<ReplayItem[]>([]);
  const [selectedReplay, setSelectedReplay] = useState<ReplayDetail | null>(null);
  const [replayCursor, setReplayCursor] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const [replayStrokes, setReplayStrokes] = useState<Stroke[]>([]);
  const [aiHistoryLoading, setAiHistoryLoading] = useState(false);
  const [aiHistory, setAiHistory] = useState<AiHistoryItem[]>([]);
  const replayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const replayTimerRef = useRef<number | null>(null);
  const replayRafRef = useRef<number | null>(null);
  const replayRunIdRef = useRef(0);
  const replayRedoRef = useRef<Stroke[]>([]);
  const lowPowerUi = useMemo(() => {
    if (typeof window === "undefined") return false;
    const nav = navigator as Navigator & { deviceMemory?: number };
    const memory = nav.deviceMemory ?? 8;
    const cores = nav.hardwareConcurrency ?? 8;
    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
    return memory <= 4 || cores <= 4 || coarse;
  }, []);

  const activeTask = tasks[taskIndex] ?? tasks[0];
  const activeSlide = slides[slideIndex] ?? slides[0];
  const elements = activeSlide?.elements ?? [];

  const taskIds = useMemo(() => tasks.map((t) => t.id), [tasks]);
  const slideIds = useMemo(() => slides.map((s) => s.id), [slides]);

  useEffect(() => {
    setSelectedElementId(null);
  }, [slideIndex]);

  useEffect(() => {
    if (section !== "replays") return;
    void fetchReplayItems();
    void fetchAiHistory();
  }, [section]);

  useEffect(() => {
    if (section === "slides") {
      void fetchM365Status();
    }
  }, [section]);

  useEffect(() => {
    drawReplayCanvas(replayStrokes);
  }, [replayStrokes]);

  useEffect(() => {
    if (!selectedReplay || !replayPlaying) return;
    const ops = selectedReplay.ops ?? [];
    if (replayCursor >= ops.length) {
      setReplayPlaying(false);
      return;
    }
    replayRunIdRef.current += 1;
    const runId = replayRunIdRef.current;
    const op = ops[replayCursor];
    const delay = getReplayDelayMs(ops, replayCursor, replaySpeed);

    const applySimpleOp = () => {
      const next = applyReplayOp(replayStrokes, replayRedoRef.current, op);
      replayRedoRef.current = next.redo;
      setReplayStrokes(next.strokes);
      setReplayCursor((v) => v + 1);
    };

    if (op.op === "add" && op.stroke) {
      const strokeDuration = delay > 0 ? delay : Math.round((op.stroke.points?.length ?? 2) * (14 / replaySpeed));
      void (async () => {
        await animateReplayStroke(op.stroke, replayStrokes, strokeDuration, runId);
        if (runId !== replayRunIdRef.current) return;
        const next = applyReplayOp(replayStrokes, replayRedoRef.current, {
          op: "add",
          ts: op.ts,
          stroke: op.stroke,
        });
        replayRedoRef.current = next.redo;
        setReplayStrokes(next.strokes);
        setReplayCursor((v) => v + 1);
      })();
    } else {
      replayTimerRef.current = window.setTimeout(() => {
        if (runId !== replayRunIdRef.current) return;
        applySimpleOp();
      }, delay);
    }

    return () => {
      replayRunIdRef.current += 1;
      if (replayTimerRef.current) {
        window.clearTimeout(replayTimerRef.current);
      }
      if (replayRafRef.current) {
        cancelAnimationFrame(replayRafRef.current);
      }
    };
  }, [selectedReplay, replayPlaying, replayCursor, replaySpeed, replayStrokes]);

  useEffect(() => {
    return () => {
      if (replayTimerRef.current) window.clearTimeout(replayTimerRef.current);
      if (replayRafRef.current) cancelAnimationFrame(replayRafRef.current);
      authPopupRef.current?.close();
    };
  }, []);

  const updateTask = (patch: Partial<Task>) => {
    if (!activeTask) return;
    onChangeTasks(tasks.map((t, i) => (i === taskIndex ? { ...t, ...patch } : t)));
  };

  const updateSlide = (patch: Partial<Slide>) => {
    if (!activeSlide) return;
    onChangeSlides(slides.map((s, i) => (i === slideIndex ? { ...s, ...patch } : s)));
  };

  const updateElements = (next: SlideElement[]) => {
    updateSlide({ elements: next });
  };

  const updateElement = (id: string, patch: Partial<SlideElement>) => {
    updateElements(elements.map((el) => (el.id === id ? ({ ...el, ...patch } as SlideElement) : el)));
  };

  const addTask = () => {
    const nextId = Math.max(0, ...taskIds) + 1;
    const next = [
      ...tasks,
      {
        id: nextId,
        title: tl("new_task_id", { id: nextId }),
        problem: "",
        tags: [tl("task_tag")],
      },
    ];
    onChangeTasks(next);
    setTaskIndex(next.length - 1);
  };

  const deleteTask = () => {
    if (!activeTask || tasks.length <= 1) return;
    const next = tasks.filter((_, i) => i !== taskIndex);
    onChangeTasks(next);
    setTaskIndex(Math.max(0, taskIndex - 1));
  };

  const addSlide = () => {
    const nextId = Math.max(0, ...slideIds) + 1;
    const next = [
      ...slides,
      {
        id: nextId,
        title: tl("new_slide_id", { id: nextId }),
        content: "",
        notes: "",
        elements: [],
      },
    ];
    onChangeSlides(next);
    setSlideIndex(next.length - 1);
  };

  const deleteSlide = () => {
    if (!activeSlide || slides.length <= 1) return;
    const next = slides.filter((_, i) => i !== slideIndex);
    onChangeSlides(next);
    setSlideIndex(Math.max(0, slideIndex - 1));
  };

  const addTextElement = () => {
    const id = `text-${Date.now()}`;
    const next: SlideElement = {
      id,
      type: "text",
      x: 60,
      y: 60,
      w: 320,
      h: 100,
      text: tl("new_text"),
      padding: 8,
      paddingLeft: 8,
      paddingRight: 8,
      paddingTop: 8,
      paddingBottom: 8,
      fontSize: 24,
      fontFamily: "Montserrat",
      color: "#E7F2FF",
      strokeColor: "#0A0E14",
      strokeWidth: 0,
      align: "left",
    };
    updateElements([...elements, next]);
    setSelectedElementId(id);
  };

  const addShapeElement = (shape: "rect" | "round" | "ellipse") => {
    const id = `shape-${Date.now()}`;
    const next: SlideElement = {
      id,
      type: "shape",
      shape,
      x: 100,
      y: 120,
      w: 240,
      h: 160,
      fill: "#1B2332",
      strokeColor: "#7C8BA1",
      strokeWidth: 2,
    };
    updateElements([...elements, next]);
    setSelectedElementId(id);
  };

  const addImageElement = (src: string) => {
    const id = `img-${Date.now()}`;
    const next: SlideElement = {
      id,
      type: "image",
      x: 80,
      y: 80,
      w: 320,
      h: 200,
      src,
    };
    updateElements([...elements, next]);
    setSelectedElementId(id);
  };

  const handlePickImage = (targetId?: string) => {
    setBgImageTarget(false);
    setImageTargetId(targetId ?? null);
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result || "");
      if (!src) return;
      if (bgImageTarget) {
        onChangeSiteBackground({ ...siteBackground, mode: "image", image: src });
        setBgImageTarget(false);
      } else if (imageTargetId) {
        updateElement(imageTargetId, { src });
        setImageTargetId(null);
      } else {
        addImageElement(src);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const handlePptxImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPptxError(null);
    setPptxLoading(true);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const params =
        pptxMode === "full"
          ? "mode=full"
          : pptxMode === "stickers"
            ? "mode=stickers"
            : `mode=editable&with_background=${pptxWithBackground ? "1" : "0"}`;
      const res = await fetch(`/api/import/pptx?${params}`, { method: "POST", body: form });
      if (!res.ok) {
        let detail = tl("failed_to_import_pptx");
        try {
          const err = await res.json();
          if (err?.detail) detail = String(err.detail);
        } catch {}
        throw new Error(detail);
      }
      const data = (await res.json()) as { slides: Slide[] };
      if (data.slides && data.slides.length) {
        onChangeSlides(data.slides);
        setSlideIndex(0);
      }
    } catch (err) {
      setPptxError(err instanceof Error ? err.message : tl("failed_to_import_pptx"));
    } finally {
      setPptxWithBackground(false);
      setPptxMode("full");
      setPptxLoading(false);
    }
  };

  const handleSaveServer = async () => {
    setServerMessage(null);
    setServerLoading(true);
    try {
      const res = await fetch(withSubjectApi("/api/storage"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks, slides, siteBackground, presentationSource }),
      });
      if (!res.ok) throw new Error("save failed");
      setServerMessage(tl("saved_on_the_server"));
    } catch {
      setServerMessage(tl("failed_to_save_to_server"));
    } finally {
      setServerLoading(false);
    }
  };

  const handleDownloadPptx = async () => {
    setExportLoading(true);
    try {
      const res = await fetch("/api/export/pptx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slides, filename: "presentation.pptx" }),
      });
      if (!res.ok) throw new Error("export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "presentation.pptx";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setServerMessage(tl("failed_to_download_pptx"));
    } finally {
      setExportLoading(false);
    }
  };

  const handleSavePptxServer = async () => {
    setExportLoading(true);
    try {
      const res = await fetch("/api/export/pptx/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slides, filename: "presentation.pptx" }),
      });
      if (!res.ok) throw new Error("export save failed");
      setServerMessage(tl("pptx_saved_on_the_server"));
    } catch {
      setServerMessage(tl("failed_to_save_pptx_to_server"));
    } finally {
      setExportLoading(false);
    }
  };

  const fetchM365Status = async () => {
    setM365StatusLoading(true);
    try {
      const res = await fetch("/api/m365/auth/status", { cache: "no-store" });
      if (!res.ok) throw new Error("status");
      const data = (await res.json()) as {
        configured?: boolean;
        connected?: boolean;
        user?: { displayName?: string | null; userPrincipalName?: string | null } | null;
      };
      const nextStatus = {
        configured: !!data.configured,
        connected: !!data.connected,
        user: data.user ?? null,
      };
      setM365Status(nextStatus);
      return nextStatus;
    } catch {
      const fallbackStatus = { configured: false, connected: false, user: null };
      setM365Status(fallbackStatus);
      return fallbackStatus;
    } finally {
      setM365StatusLoading(false);
    }
  };

  const handleM365Connect = async () => {
    setServerMessage(null);
    setM365Loading(true);
    try {
      const res = await fetch("/api/m365/auth/start", { cache: "no-store" });
      if (!res.ok) {
        let detail = "Не удалось начать OAuth Microsoft 365";
        try {
          const err = await res.json();
          if (err?.detail) detail = String(err.detail);
        } catch {
          // ignore
        }
        throw new Error(detail);
      }
      const data = (await res.json()) as { url?: string };
      if (!data.url) throw new Error("OAuth URL отсутствует");
      authPopupRef.current?.close();
      const popup = window.open(data.url, "m365-auth", "width=640,height=780");
      if (!popup) throw new Error("Браузер заблокировал popup для авторизации Microsoft 365");
      authPopupRef.current = popup;

      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error("Таймаут авторизации Microsoft 365"));
        }, 120000);
        const poll = window.setInterval(() => {
          if (!popup || popup.closed) {
            cleanup();
            resolve();
          }
        }, 500);

        const onMessage = (event: MessageEvent) => {
          const payload = event.data;
          if (!payload || typeof payload !== "object") return;
          if ((payload as { type?: string }).type !== "m365-auth-complete") return;
          cleanup();
          const ok = Boolean((payload as { ok?: boolean }).ok);
          if (!ok) {
            const err = (payload as { error?: string }).error || "Microsoft 365 auth failed";
            reject(new Error(err));
            return;
          }
          resolve();
        };

        const cleanup = () => {
          window.clearTimeout(timeout);
          window.clearInterval(poll);
          window.removeEventListener("message", onMessage);
        };

        window.addEventListener("message", onMessage);
      });

      const status = await fetchM365Status();
      if (!status.connected) {
        throw new Error("Авторизация Microsoft 365 не завершена");
      }
      setServerMessage("Microsoft 365 подключен");
    } catch (err) {
      setServerMessage(err instanceof Error ? err.message : "Ошибка подключения Microsoft 365");
    } finally {
      authPopupRef.current = null;
      setM365Loading(false);
    }
  };

  const applyM365Source = (payload: unknown) => {
    if (!payload || typeof payload !== "object") return false;
    const src = payload as Partial<PresentationSource>;
    if (src.type !== "m365" && src.type !== "office") return false;
    onChangePresentationSource({
      type: src.type,
      mode: src.type === "m365" && src.mode === "edit" ? "edit" : "view",
      access: src.access === "public" ? "public" : "private",
      embedUrl: typeof src.embedUrl === "string" ? src.embedUrl : null,
      fileId: typeof src.fileId === "string" ? src.fileId : null,
      lastSyncTs: typeof src.lastSyncTs === "number" ? src.lastSyncTs : Date.now(),
      fallbackPdf: Array.isArray(src.fallbackPdf)
        ? src.fallbackPdf.filter((x): x is string => typeof x === "string")
        : [],
    });
    return true;
  };

  const handleM365PptxUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setM365Loading(true);
    setServerMessage(null);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await fetch("/api/m365/pptx/upload", { method: "POST", body: form });
      if (!res.ok) {
        let detail = "Не удалось загрузить PPTX в Microsoft 365";
        try {
          const err = await res.json();
          if (err?.detail) detail = String(err.detail);
        } catch {
          // ignore
        }
        throw new Error(detail);
      }
      const data = (await res.json()) as { presentationSource?: unknown };
      if (!applyM365Source(data.presentationSource)) {
        throw new Error("Некорректный ответ Microsoft 365");
      }
      await fetchM365Status();
      setServerMessage("PPTX загружен в Microsoft 365");
      setSection("slides");
    } catch (err) {
      setServerMessage(err instanceof Error ? err.message : "Ошибка загрузки PPTX в Microsoft 365");
    } finally {
      setM365Loading(false);
    }
  };

  const handleM365SessionUpdate = async (patch: Partial<Pick<PresentationSource, "mode" | "access">>) => {
    if (presentationSource.type !== "m365" || !presentationSource.fileId) {
      setServerMessage("Upload PPTX to Microsoft 365 first");
      return;
    }
    const fileId = presentationSource.fileId ?? null;
    const nextMode = patch.mode ?? presentationSource.mode;
    const nextAccess = patch.access ?? presentationSource.access;

    setM365Loading(true);
    setServerMessage(null);
    try {
      const endpoint = nextAccess === "public" ? "/api/m365/presentation/public-link" : "/api/m365/presentation/session";
      const body =
        nextAccess === "public"
          ? { fileId }
          : { fileId, mode: nextMode, access: nextAccess };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let detail = "Failed to update Microsoft 365 session";
        try {
          const err = await res.json();
          if (err?.detail) detail = String(err.detail);
        } catch {
          // ignore
        }
        throw new Error(detail);
      }
      const data = (await res.json()) as { presentationSource?: unknown };
      if (!applyM365Source(data.presentationSource)) {
        throw new Error("Invalid Microsoft 365 response");
      }
      setServerMessage("Microsoft 365 session updated");
    } catch (err) {
      setServerMessage(err instanceof Error ? err.message : "Microsoft 365 error");
    } finally {
      setM365Loading(false);
    }
  };

  const handleM365Disconnect = async () => {
    setM365Loading(true);
    setServerMessage(null);
    try {
      const res = await fetch("/api/m365/presentation/disconnect", {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to disconnect Microsoft 365");
      onChangePresentationSource(DEFAULT_PRESENTATION_SOURCE);
      await fetchM365Status();
      setServerMessage("Microsoft 365 disconnected");
    } catch (err) {
      setServerMessage(err instanceof Error ? err.message : "Failed to disconnect Microsoft 365");
    } finally {
      setM365Loading(false);
    }
  };

  const handleOfficeViewerUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setM365Loading(true);
    setServerMessage(null);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await fetch("/api/office/viewer/upload", { method: "POST", body: form });
      if (!res.ok) {
        let detail = "Failed to import presentation to Office Viewer";
        try {
          const err = await res.json();
          if (err?.detail) detail = String(err.detail);
        } catch {
          // ignore
        }
        throw new Error(detail);
      }
      const data = (await res.json()) as { presentationSource?: unknown };
      if (!applyM365Source(data.presentationSource)) {
        throw new Error("Invalid Office Viewer response");
      }
      setServerMessage("Presentation opened in Office Viewer");
      setSection("slides");
    } catch (err) {
      setServerMessage(err instanceof Error ? err.message : "Office Viewer error");
    } finally {
      setM365Loading(false);
    }
  };

  const handleOfficeViewerLinkApply = async () => {
    const raw = officeViewerLink.trim();
    if (!raw) {
      setServerMessage("Вставьте ссылку на презентацию");
      return;
    }

    setM365Loading(true);
    setServerMessage(null);
    try {
      const res = await fetch("/api/office/viewer/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: raw }),
      });
      if (!res.ok) {
        let detail = "Не удалось применить ссылку Office Viewer";
        try {
          const err = await res.json();
          if (err?.detail) detail = String(err.detail);
        } catch {
          // ignore
        }
        throw new Error(detail);
      }
      const data = (await res.json()) as { presentationSource?: unknown };
      if (!applyM365Source(data.presentationSource)) {
        throw new Error("Некорректный ответ Office Viewer");
      }
      setServerMessage("Ссылка Office Viewer применена");
      setSection("slides");
    } catch (err) {
      setServerMessage(err instanceof Error ? err.message : "Ошибка Office Viewer");
    } finally {
      setM365Loading(false);
    }
  };

  const drawReplayCanvas = (strokes: Stroke[], previewStroke?: Stroke) => {
    const canvas = replayCanvasRef.current;
    if (!canvas) return;
    const ratio = lowPowerUi ? 1 : Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = STAGE_W * ratio;
    canvas.height = STAGE_H * ratio;
    canvas.style.width = `${STAGE_W}px`;
    canvas.style.height = `${STAGE_H}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = "#0A0E14";
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    const rendered = previewStroke ? [...strokes, previewStroke] : strokes;
    drawStrokes(ctx, rendered, {
      grid: true,
      width: STAGE_W,
      height: STAGE_H,
      zoom: 1,
      pan: { x: 0, y: 0 },
      ratio,
      gridColor: "rgba(255,255,255,0.06)",
    });
  };

  const fetchReplayItems = async () => {
    setReplaysLoading(true);
    try {
      const res = await fetch(withSubjectApi("/api/board/replays?limit=200"), { cache: "no-store" });
      if (!res.ok) throw new Error("failed");
      const data = (await res.json()) as { items?: ReplayItem[] };
      setReplayItems(Array.isArray(data.items) ? data.items : []);
    } catch {
      setReplayItems([]);
    } finally {
      setReplaysLoading(false);
    }
  };

  const fetchReplayDetail = async (replayId: string) => {
    setReplaysLoading(true);
    try {
      const res = await fetch(withSubjectApi(`/api/board/replays/${encodeURIComponent(replayId)}`), { cache: "no-store" });
      if (!res.ok) throw new Error("failed");
      const data = (await res.json()) as { item?: ReplayDetail };
      if (!data.item) throw new Error("failed");
      replayRunIdRef.current += 1;
      setSelectedReplay(data.item);
      setReplayPlaying(false);
      setReplayCursor(0);
      setReplayStrokes([]);
      replayRedoRef.current = [];
    } catch {
      setSelectedReplay(null);
    } finally {
      setReplaysLoading(false);
    }
  };

  const fetchAiHistory = async () => {
    setAiHistoryLoading(true);
    try {
      const res = await fetch(withSubjectApi("/api/ai/history?limit=200"), { cache: "no-store" });
      if (!res.ok) throw new Error("failed");
      const data = (await res.json()) as { items?: AiHistoryItem[] };
      setAiHistory(Array.isArray(data.items) ? data.items : []);
    } catch {
      setAiHistory([]);
    } finally {
      setAiHistoryLoading(false);
    }
  };

  const resetReplay = () => {
    replayRunIdRef.current += 1;
    if (replayTimerRef.current) window.clearTimeout(replayTimerRef.current);
    if (replayRafRef.current) cancelAnimationFrame(replayRafRef.current);
    setReplayPlaying(false);
    setReplayCursor(0);
    setReplayStrokes([]);
    replayRedoRef.current = [];
  };

  const handleReplayCursorChange = (nextCursor: number) => {
    if (!selectedReplay) return;
    const result = computeReplayState(selectedReplay.ops ?? [], nextCursor);
    setReplayPlaying(false);
    replayRunIdRef.current += 1;
    if (replayTimerRef.current) window.clearTimeout(replayTimerRef.current);
    if (replayRafRef.current) cancelAnimationFrame(replayRafRef.current);
    setReplayCursor(nextCursor);
    setReplayStrokes(result.strokes);
    replayRedoRef.current = result.redo;
  };

  const animateReplayStroke = (
    strokeRaw: Stroke,
    baseStrokes: Stroke[],
    durationMs: number,
    runId: number
  ) =>
    new Promise<void>((resolve) => {
      const stroke = compactStrokeForReplay(strokeRaw);
      if (!stroke.points || stroke.points.length < 3) {
        drawReplayCanvas(baseStrokes, stroke);
        resolve();
        return;
      }
      const points = stroke.points;
      const duration = Math.max(REPLAY_MIN_STROKE_MS, Math.min(REPLAY_MAX_STROKE_MS, durationMs));
      const frameMinDelta = 1000 / REPLAY_DRAW_FPS;
      const start = performance.now();
      let lastFrame = start - frameMinDelta;

      const tick = (now: number) => {
        if (runId !== replayRunIdRef.current) {
          resolve();
          return;
        }
        const progress = Math.max(0, Math.min(1, (now - start) / duration));
        if (now - lastFrame >= frameMinDelta || progress >= 1) {
          const count = Math.max(2, Math.floor(2 + (points.length - 2) * progress));
          drawReplayCanvas(baseStrokes, { ...stroke, points: points.slice(0, count) });
          lastFrame = now;
        }
        if (progress >= 1) {
          resolve();
          return;
        }
        replayRafRef.current = requestAnimationFrame(tick);
      };

      replayRafRef.current = requestAnimationFrame(tick);
    });

  const downloadReplayVideo = async () => {
    if (!selectedReplay || !selectedReplay.ops.length) return;
    const canvas = replayCanvasRef.current;
    if (!canvas) return;
    const stream = canvas.captureStream(30);
    const mimeCandidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
    recorder.start();
    let strokes: Stroke[] = [];
    let redo: Stroke[] = [];
    drawReplayCanvas(strokes);
    await sleep(120);
    let opIndex = 0;
    for (const op of selectedReplay.ops) {
      const delay = getReplayDelayMs(selectedReplay.ops, opIndex, replaySpeed);
      if (op.op === "add" && op.stroke) {
        const stroke = compactStrokeForReplay(op.stroke);
        const duration = Math.max(REPLAY_MIN_STROKE_MS, Math.min(REPLAY_MAX_STROKE_MS, delay || 180));
        const points = stroke.points ?? [];
        const steps = Math.max(4, Math.min(40, Math.round(duration / (1000 / REPLAY_DRAW_FPS))));
        for (let step = 1; step <= steps; step += 1) {
          const progress = step / steps;
          const count = Math.max(2, Math.floor(2 + (points.length - 2) * progress));
          drawReplayCanvas(strokes, { ...stroke, points: points.slice(0, count) });
          await sleep(Math.max(8, Math.round(duration / steps)));
        }
        strokes = [...strokes, op.stroke];
        redo = [];
        drawReplayCanvas(strokes);
      } else {
        if (delay > 0) await sleep(delay);
        const next = applyReplayOp(strokes, redo, op);
        strokes = next.strokes;
        redo = next.redo;
        drawReplayCanvas(strokes);
      }
      opIndex += 1;
    }
    await sleep(240);
    recorder.stop();
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `replay-${selectedReplay.id}.webm`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const deleteElement = () => {
    if (!selectedElementId) return;
    updateElements(elements.filter((el) => el.id !== selectedElementId));
    setSelectedElementId(null);
  };

  const startDrag = (
    el: SlideElement,
    mode: "move" | "resize",
    e: React.PointerEvent<HTMLDivElement>,
    handle?: "nw" | "ne" | "sw" | "se"
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedElementId(el.id);
    dragRef.current = {
      id: el.id,
      mode,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      rect: { x: el.x, y: el.y, w: el.w, h: el.h },
    };

    const handleMove = (ev: PointerEvent) => {
      const data = dragRef.current;
      if (!data) return;
      const dx = ev.clientX - data.startX;
      const dy = ev.clientY - data.startY;
      const minW = 80;
      const minH = 60;

      if (data.mode === "move") {
        const nextX = clamp(data.rect.x + dx, 0, STAGE_W - data.rect.w);
        const nextY = clamp(data.rect.y + dy, 0, STAGE_H - data.rect.h);
        updateElement(data.id, { x: nextX, y: nextY });
      } else {
        const handle = data.handle ?? "se";
        let nextX = data.rect.x;
        let nextY = data.rect.y;
        let nextW = data.rect.w;
        let nextH = data.rect.h;

        if (handle === "se") {
          nextW = clamp(data.rect.w + dx, minW, STAGE_W - data.rect.x);
          nextH = clamp(data.rect.h + dy, minH, STAGE_H - data.rect.y);
        } else if (handle === "sw") {
          nextX = clamp(data.rect.x + dx, 0, data.rect.x + data.rect.w - minW);
          nextW = clamp(data.rect.w - dx, minW, STAGE_W - nextX);
          nextH = clamp(data.rect.h + dy, minH, STAGE_H - data.rect.y);
        } else if (handle === "ne") {
          nextY = clamp(data.rect.y + dy, 0, data.rect.y + data.rect.h - minH);
          nextW = clamp(data.rect.w + dx, minW, STAGE_W - data.rect.x);
          nextH = clamp(data.rect.h - dy, minH, STAGE_H - nextY);
        } else if (handle === "nw") {
          nextX = clamp(data.rect.x + dx, 0, data.rect.x + data.rect.w - minW);
          nextY = clamp(data.rect.y + dy, 0, data.rect.y + data.rect.h - minH);
          nextW = clamp(data.rect.w - dx, minW, STAGE_W - nextX);
          nextH = clamp(data.rect.h - dy, minH, STAGE_H - nextY);
        }

        updateElement(data.id, { x: nextX, y: nextY, w: nextW, h: nextH });
      }
    };

    const handleUp = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  const selectedElement = elements.find((el) => el.id === selectedElementId) ?? null;
  const formatAutosaveTime = (ts: number | null) =>
    ts
      ? new Date(ts).toLocaleTimeString(locale === "kk" ? "kk-KZ" : "ru-RU", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      : tl("not_available");
  const bgPresets = [
    {
      label: tl("bg_preset_light_gradient"),
      value:
        "radial-gradient(1000px 600px at 30% -10%, rgba(72, 149, 239, 0.25) 0%, rgba(240, 248, 255, 0.9) 55%, rgba(245, 249, 255, 1) 100%)",
    },
    {
      label: tl("bg_preset_blue_volume"),
      value:
        "radial-gradient(1200px 600px at 30% -10%, rgba(77,163,255,0.16) 0%, rgba(10,14,20,0.4) 45%, rgba(10,14,20,1) 100%)",
    },
    {
      label: tl("bg_preset_deep"),
      value:
        "radial-gradient(1200px 800px at 70% -10%, rgba(94, 96, 206, 0.18) 0%, rgba(10,14,20,0.55) 45%, rgba(10,14,20,1) 100%)",
    },
  ];

  return (
    <div className={cn("glass flex flex-col rounded-2xl shadow-glass", fullPage ? "h-full" : "h-full max-h-[92vh]")}>
      <div
        className={cn(
          "modal-handle flex items-center justify-between border-b border-white/10 px-4 py-3",
          onDragHandlePointerDown ? "cursor-grab active:cursor-grabbing" : ""
        )}
        onPointerDown={onDragHandlePointerDown}
      >
        <div className="text-sm font-semibold uppercase tracking-wider text-frost/70">{tl("teacher_dashboard")}</div>
        <button
          className="rounded-lg border border-white/10 px-2 py-1 text-xs text-frost/70 hover:text-frost"
          onClick={onClose}
        >{
          tl("close")
        }</button>
      </div>
      <div className="flex-1 overflow-auto">
        <div className="flex items-center justify-between px-4 pt-3">
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 p-1">
            <button
              className={cn(
                "rounded-full px-3 py-1 text-xs font-semibold transition",
                section === "tasks" ? "bg-accent text-ink" : "text-frost/70 hover:text-frost"
              )}
              onClick={() => setSection("tasks")}
            >{
              tl("tasks")
            }</button>
            <button
              className={cn(
                "rounded-full px-3 py-1 text-xs font-semibold transition",
                section === "slides" ? "bg-accent text-ink" : "text-frost/70 hover:text-frost"
              )}
              onClick={() => setSection("slides")}
            >{
              tl("presentation")
            }</button>
            <button
              className={cn(
                "rounded-full px-3 py-1 text-xs font-semibold transition",
                section === "replays" ? "bg-accent text-ink" : "text-frost/70 hover:text-frost"
              )}
              onClick={() => setSection("replays")}
            >{
              tl("replays")
            }</button>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={handleSaveServer} disabled={serverLoading}>{
              tl("save_to_server")
            }</Button>
            <Button size="sm" variant="outline" onClick={handleDownloadPptx} disabled={exportLoading}>{
              tl("download_pptx")
            }</Button>
            <Button size="sm" variant="outline" onClick={handleSavePptxServer} disabled={exportLoading}>{
              tl("save_pptx")
            }</Button>
            <Badge className="bg-white/5">{tl("editor")}</Badge>
          </div>
        </div>
        {autosaveInfo && (
          <div className="px-4 pt-2 text-[11px] text-frost/60">
            {tl("autosave_server_every_secs_server_server_local_draft_local", {
              sec: autosaveInfo.intervalSec,
              server: formatAutosaveTime(autosaveInfo.lastServerSaveAt),
              local: formatAutosaveTime(autosaveInfo.lastLocalBackupAt),
            })}
          </div>
        )}
        {serverMessage && <div className="px-4 pt-2 text-xs text-frost/60">{serverMessage}</div>}

        {section === "tasks" && (
          <div className="grid gap-4 p-4 lg:grid-cols-[220px_1fr]">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs uppercase tracking-wider text-frost/60">{tl("list")}</div>
                <Button size="sm" variant="outline" onClick={addTask}>{
                  tl("add")
                }</Button>
              </div>
              <div className="max-h-[50vh] space-y-2 overflow-auto pr-1">
                {tasks.map((task, idx) => (
                  <button
                    key={task.id}
                    className={cn(
                      "w-full rounded-xl border px-3 py-2 text-left text-xs transition",
                      idx === taskIndex
                        ? "border-accent/60 bg-accent/10"
                        : "border-white/10 hover:border-white/30"
                    )}
                    onClick={() => setTaskIndex(idx)}
                  >
                    <div className="font-semibold">
                      #{task.id} {task.title}
                    </div>
                    <div className="text-[11px] text-frost/60">{task.tags.join(", ")}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs uppercase tracking-wider text-frost/60">{tl("task_editor")}</div>
                <Button size="sm" variant="ghost" onClick={deleteTask} disabled={!activeTask || tasks.length <= 1}>{
                  tl("delete")
                }</Button>
              </div>
              {activeTask ? (
                <div className="grid gap-3">
                  <label className="text-xs text-frost/60">{
                    tl("heading")
                    }<input
                      className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm"
                      value={activeTask.title}
                      onChange={(e) => updateTask({ title: e.target.value })}
                    />
                  </label>
                  <label className="text-xs text-frost/60">{
                    tl("condition_latex_support")
                    }<textarea
                      className="mt-1 h-28 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm"
                      value={activeTask.problem}
                      onChange={(e) => updateTask({ problem: e.target.value })}
                    />
                  </label>
                  <label className="text-xs text-frost/60">{
                    tl("tags_separated_by_commas")
                    }<input
                      className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm"
                      value={activeTask.tags.join(", ")}
                      onChange={(e) =>
                        updateTask({
                          tags: e.target.value
                            .split(",")
                            .map((t) => t.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </label>
                </div>
              ) : (
                <div className="text-sm text-frost/50">{tl("no_tasks")}</div>
              )}
            </div>
          </div>
        )}

        {section === "slides" && (
          <div className="grid gap-4 p-4 lg:grid-cols-[220px_1fr_260px]">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs uppercase tracking-wider text-frost/60">{tl("slides")}</div>
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                  <Button size="sm" variant="outline" onClick={addSlide}>{
                    tl("add")
                  }</Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="whitespace-normal leading-tight"
                    onClick={() => {
                      setPptxMode("full");
                      setPptxWithBackground(false);
                      pptxInputRef.current?.click();
                    }}
                    disabled={pptxLoading}
                  >
                    {pptxLoading ? tl("import_menu") : tl("import_pptx_as_picture")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="whitespace-normal leading-tight"
                    onClick={() => {
                      setPptxMode("editable");
                      setPptxWithBackground(true);
                      pptxInputRef.current?.click();
                    }}
                    disabled={pptxLoading}
                  >{
                    tl("import_background")
                  }</Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="whitespace-normal leading-tight"
                    onClick={() => {
                      setPptxMode("stickers");
                      setPptxWithBackground(false);
                      pptxInputRef.current?.click();
                    }}
                    disabled={pptxLoading}
                  >{
                    tl("import_stickers_slow")
                  }</Button>
                </div>
              </div>

              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs uppercase tracking-wider text-frost/60">Microsoft 365</div>
                  <Badge className="bg-white/10">
                    {m365StatusLoading
                      ? tl("loading")
                      : m365Status?.connected
                        ? "Connected"
                        : m365Status?.configured
                          ? "Not connected"
                          : "Not configured"}
                  </Badge>
                </div>

                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleM365Connect}
                    disabled={m365Loading || m365StatusLoading || !m365Status?.configured}
                  >
                    Connect M365
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => m365PptxInputRef.current?.click()}
                    disabled={m365Loading || m365StatusLoading || !m365Status?.connected}
                  >
                    Upload PPTX to M365
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void handleM365SessionUpdate({
                        mode: presentationSource.mode === "edit" ? "view" : "edit",
                        access: presentationSource.access,
                      })
                    }
                    disabled={
                      m365Loading ||
                      m365StatusLoading ||
                      !m365Status?.connected ||
                      !presentationSource.fileId
                    }
                  >
                    {presentationSource.mode === "edit" ? "Mode: Edit" : "Mode: View"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void handleM365SessionUpdate({
                        mode: presentationSource.mode,
                        access: presentationSource.access === "public" ? "private" : "public",
                      })
                    }
                    disabled={
                      m365Loading ||
                      m365StatusLoading ||
                      !m365Status?.connected ||
                      !presentationSource.fileId
                    }
                  >
                    {presentationSource.access === "public" ? "Access: Public" : "Access: Private"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleM365Disconnect}
                    disabled={m365Loading || m365StatusLoading || !m365Status?.connected}
                  >
                    Disconnect M365
                  </Button>
                </div>
                {!!m365Status?.user && (
                  <div className="mt-2 text-[11px] text-frost/60">
                    {m365Status.user.displayName || m365Status.user.userPrincipalName}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs uppercase tracking-wider text-frost/60">Office Viewer (no M365)</div>
                  <Badge className="bg-white/10">{presentationSource.type === "office" ? "Active" : "Inactive"}</Badge>
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    type="url"
                    className="h-8 flex-1 rounded-lg border border-white/10 bg-white/5 px-2 text-xs"
                    placeholder="Вставьте публичную ссылку PPTX/OneDrive"
                    value={officeViewerLink}
                    onChange={(e) => setOfficeViewerLink(e.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleOfficeViewerLinkApply()}
                    disabled={m365Loading}
                  >
                    Применить
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => officeViewerInputRef.current?.click()}
                    disabled={m365Loading}
                  >
                    Import to Office Viewer
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onChangePresentationSource(DEFAULT_PRESENTATION_SOURCE)}
                    disabled={m365Loading || presentationSource.type !== "office"}
                  >
                    Disable Office Viewer
                  </Button>
                </div>
              </div>

              <div className="max-h-[50vh] space-y-2 overflow-auto pr-1">
                {slides.map((slide, idx) => (
                  <button
                    key={slide.id}
                    className={cn(
                      "w-full rounded-xl border px-3 py-2 text-left text-xs transition",
                      idx === slideIndex ? "border-neon/40 bg-white/10" : "border-white/10 hover:border-white/30"
                    )}
                    onClick={() => setSlideIndex(idx)}
                  >
                    <div className="font-semibold">
                      #{slide.id} {slide.title}
                    </div>
                    <div className="text-[11px] text-frost/60">{slide.notes ? tl("has_notes") : tl("no_notes")}</div>
                  </button>
                ))}
              </div>
              {pptxError && <div className="mt-2 text-xs text-ember">{pptxError}</div>}
            </div>

            <div className="space-y-3">
              <div className="text-xs uppercase tracking-wider text-frost/60">{tl("slide_designer")}</div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={addTextElement}>{
                  tl("text")
                }</Button>
                <Button size="sm" variant="outline" onClick={() => handlePickImage()}>{
                  tl("picture")
                }</Button>
                <Button size="sm" variant="outline" onClick={() => addShapeElement("rect")}>{
                  tl("rectangular")
                }</Button>
                <Button size="sm" variant="outline" onClick={() => addShapeElement("round")}>{
                  tl("rounded")
                }</Button>
                <Button size="sm" variant="outline" onClick={() => addShapeElement("ellipse")}>{
                  tl("circle")
                }</Button>
                {activeSlide?.background && (
                  <Button size="sm" variant="outline" onClick={() => updateSlide({ background: "" })}>{
                    tl("reset_background")
                  }</Button>
                )}
                <Button size="sm" variant="outline" onClick={() => setShowSlideMeta((prev) => !prev)}>
                  {showSlideMeta ? tl("hide_fields") : tl("show_fields")}
                </Button>
                <Button size="sm" variant="ghost" onClick={deleteSlide} disabled={!activeSlide || slides.length <= 1}>{
                  tl("delete")
                }</Button>
              </div>

              <div className="rounded-xl border border-white/10 bg-white/5 p-2 overflow-auto">
                <div
                  className="relative rounded-lg border border-white/10 bg-ink/60 overflow-hidden"
                  style={{
                    width: STAGE_W,
                    height: STAGE_H,
                    backgroundImage: activeSlide?.background ? `url(${activeSlide.background})` : undefined,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                    backgroundRepeat: "no-repeat",
                  }}
                  onPointerDown={() => setSelectedElementId(null)}
                >
                  {elements.map((el) => (
                    <div
                      key={el.id}
                      className={cn(
                        "absolute rounded-md border",
                        selectedElementId === el.id ? "border-accent" : "border-white/10"
                      )}
                      style={{ left: el.x, top: el.y, width: el.w, height: el.h }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        setSelectedElementId(el.id);
                      }}
                    >
                      {el.type === "text" ? (
                        <div
                          className="h-full w-full"
                          style={{
                            padding: el.padding ?? 0,
                            paddingLeft: el.paddingLeft ?? el.padding ?? 0,
                            paddingRight: el.paddingRight ?? el.padding ?? 0,
                            paddingTop: el.paddingTop ?? el.padding ?? 0,
                            paddingBottom: el.paddingBottom ?? el.padding ?? 0,
                            fontSize: el.fontSize ?? 22,
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
                          src={el.src}
                          alt=""
                          className="h-full w-full object-contain"
                          style={{
                            transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
                            transformOrigin: "center",
                          }}
                        />
                      ) : (
                        <div
                          className="h-full w-full"
                          style={{
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
                      )}
                      <div
                        className="absolute -top-3 left-1/2 h-4 w-12 -translate-x-1/2 cursor-move rounded-full border border-white/30 bg-white/10"
                        onPointerDown={(e) => startDrag(el, "move", e)}
                        title={tl("drag")}
                      />
                      <div
                        className="absolute -top-2 -left-2 h-4 w-4 cursor-nwse-resize rounded-sm border border-white/30 bg-white/10"
                        onPointerDown={(e) => startDrag(el, "resize", e, "nw")}
                        title={tl("resize")}
                      />
                      <div
                        className="absolute -top-2 -right-2 h-4 w-4 cursor-nesw-resize rounded-sm border border-white/30 bg-white/10"
                        onPointerDown={(e) => startDrag(el, "resize", e, "ne")}
                        title={tl("resize")}
                      />
                      <div
                        className="absolute -bottom-2 -left-2 h-4 w-4 cursor-nesw-resize rounded-sm border border-white/30 bg-white/10"
                        onPointerDown={(e) => startDrag(el, "resize", e, "sw")}
                        title={tl("resize")}
                      />
                      <div
                        className="absolute -bottom-2 -right-2 h-4 w-4 cursor-nwse-resize rounded-sm border border-white/30 bg-white/10"
                        onPointerDown={(e) => startDrag(el, "resize", e, "se")}
                        title={tl("resize")}
                      />
                    </div>
                  ))}
                  {showSlideMeta && (
                    <div
                      className="absolute bottom-2 left-1/2 w-[92%] -translate-x-1/2 rounded-xl border border-white/10 bg-black/50 backdrop-blur-md p-3 max-h-[42%] overflow-auto"
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <div className="grid gap-2">
                        <label className="text-[10px] uppercase tracking-wider text-frost/60">{
                          tl("heading")
                          }<input
                            className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm"
                            value={activeSlide?.title ?? ""}
                            onChange={(e) => updateSlide({ title: e.target.value })}
                          />
                        </label>
                        <div className="grid gap-2 md:grid-cols-2">
                          <label className="text-[10px] uppercase tracking-wider text-frost/60">{
                            tl("notes")
                            }<textarea
                              className="mt-1 h-16 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm"
                              value={activeSlide?.notes ?? ""}
                              onChange={(e) => updateSlide({ notes: e.target.value })}
                            />
                          </label>
                          <label className="text-[10px] uppercase tracking-wider text-frost/60">{
                            tl("content_if_without_elements")
                            }<textarea
                              className="mt-1 h-16 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm"
                              value={activeSlide?.content ?? ""}
                              onChange={(e) => updateSlide({ content: e.target.value })}
                            />
                          </label>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="text-xs text-frost/60">{
                tl("slide_size_16_9_960_540_drag_blocks_and_resize_corners")
              }</div>
            </div>

            <div className="space-y-3">
              <div className="text-xs uppercase tracking-wider text-frost/60">{tl("properties")}</div>
              {selectedElement ? (
                <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-frost/60">
                    {tl("type")}{" "}
                    {selectedElement.type === "text"
                      ? tl("text")
                      : selectedElement.type === "shape"
                        ? tl("figure")
                        : tl("image")}
                  </div>
                  {selectedElement.type === "text" ? (
                    <>
                      <label className="text-xs text-frost/60">{
                        tl("text")
                        }<textarea
                          className="mt-1 h-24 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm"
                          value={selectedElement.text}
                          onChange={(e) => updateElement(selectedElement.id, { text: e.target.value })}
                        />
                      </label>
                      <label className="text-xs text-frost/60">{
                        tl("font")
                        }<select
                          className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm"
                          value={selectedElement.fontFamily ?? "Montserrat"}
                          onChange={(e) => updateElement(selectedElement.id, { fontFamily: e.target.value })}
                        >
                          {FONT_OPTIONS.map((font) => (
                            <option key={font} value={font}>
                              {font}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="text-xs text-frost/60">{
                        tl("font_size")
                        }<input
                          type="range"
                          min={12}
                          max={72}
                          value={selectedElement.fontSize ?? 22}
                          onChange={(e) => updateElement(selectedElement.id, { fontSize: Number(e.target.value) })}
                        />
                      </label>
                      <div className="grid grid-cols-2 gap-2 text-xs text-frost/60">
                        <label>{
                          tl("color")
                          }<input
                            type="color"
                            className="mt-1 h-8 w-full rounded border border-white/10 bg-white/5"
                            value={selectedElement.color ?? "#E7F2FF"}
                            onChange={(e) => updateElement(selectedElement.id, { color: e.target.value })}
                          />
                        </label>
                        <label>{
                          tl("stroke")
                          }<input
                            type="color"
                            className="mt-1 h-8 w-full rounded border border-white/10 bg-white/5"
                            value={selectedElement.strokeColor ?? "#0A0E14"}
                            onChange={(e) => updateElement(selectedElement.id, { strokeColor: e.target.value })}
                          />
                        </label>
                      </div>
                      <label className="text-xs text-frost/60">{
                        tl("stroke_thickness")
                        }<input
                          type="range"
                          min={0}
                          max={6}
                          value={selectedElement.strokeWidth ?? 0}
                          onChange={(e) =>
                            updateElement(selectedElement.id, { strokeWidth: Number(e.target.value) })
                          }
                        />
                      </label>
                      <div className="flex items-center gap-2 text-xs text-frost/60">
                        <span>{tl("alignment")}</span>
                        {["left", "center", "right"].map((align) => (
                          <button
                            key={align}
                            className={cn(
                              "rounded-full px-3 py-1 text-xs font-semibold transition",
                              selectedElement.align === align
                                ? "bg-accent text-ink"
                                : "border border-white/10 text-frost/70 hover:text-frost"
                            )}
                            onClick={() => updateElement(selectedElement.id, { align })}
                          >
                            {align === "left" ? tl("left") : align === "center" ? tl("centered") : tl("right")}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : selectedElement.type === "shape" ? (
                    <>
                      <label className="text-xs text-frost/60">{
                        tl("shape_type")
                        }<select
                          className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm"
                          value={selectedElement.shape}
                          onChange={(e) =>
                            updateElement(selectedElement.id, {
                              shape: e.target.value as "rect" | "round" | "ellipse",
                            })
                          }
                        >
                          <option value="rect">{tl("rectangle")}</option>
                          <option value="round">{tl("rounded_shape")}</option>
                          <option value="ellipse">{tl("circle_oval")}</option>
                        </select>
                      </label>
                      <div className="grid grid-cols-2 gap-2 text-xs text-frost/60">
                        <label>{
                          tl("fill")
                          }<input
                            type="color"
                            className="mt-1 h-8 w-full rounded border border-white/10 bg-white/5"
                            value={selectedElement.fill ?? "#1B2332"}
                            onChange={(e) => updateElement(selectedElement.id, { fill: e.target.value })}
                          />
                        </label>
                        <label>{
                          tl("stroke")
                          }<input
                            type="color"
                            className="mt-1 h-8 w-full rounded border border-white/10 bg-white/5"
                            value={selectedElement.strokeColor ?? "#7C8BA1"}
                            onChange={(e) => updateElement(selectedElement.id, { strokeColor: e.target.value })}
                          />
                        </label>
                      </div>
                      <label className="text-xs text-frost/60">{
                        tl("stroke_thickness")
                        }<input
                          type="range"
                          min={0}
                          max={12}
                          value={selectedElement.strokeWidth ?? 2}
                          onChange={(e) =>
                            updateElement(selectedElement.id, { strokeWidth: Number(e.target.value) })
                          }
                        />
                      </label>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => handlePickImage(selectedElement.id)}>{
                      tl("replace_image")
                    }</Button>
                  )}
                  <div className="grid grid-cols-2 gap-2 text-xs text-frost/60">
                    <label>
                      W
                      <input
                        type="number"
                        className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1"
                        value={Math.round(selectedElement.w)}
                        onChange={(e) => updateElement(selectedElement.id, { w: Number(e.target.value) })}
                      />
                    </label>
                    <label>
                      H
                      <input
                        type="number"
                        className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1"
                        value={Math.round(selectedElement.h)}
                        onChange={(e) => updateElement(selectedElement.id, { h: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                  <Button size="sm" variant="ghost" onClick={deleteElement}>{
                    tl("remove_element")
                  }</Button>
                </div>
              ) : (
                <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-frost/50">{
                  tl("select_an_element_on_the_slide")
                }</div>
              )}

              <div className="rounded-xl border border-white/10 bg-white/5 p-3 space-y-2">
                <div className="text-xs uppercase tracking-wider text-frost/60">{tl("website_background")}</div>
                <div className="flex items-center gap-2">
                  <button
                    className={cn(
                      "rounded-full px-3 py-1 text-xs font-semibold transition",
                      siteBackground.mode === "solid" ? "bg-accent text-ink" : "text-frost/70 hover:text-frost"
                    )}
                    onClick={() => onChangeSiteBackground({ ...siteBackground, mode: "solid" })}
                  >{
                    tl("fill")
                  }</button>
                  <button
                    className={cn(
                      "rounded-full px-3 py-1 text-xs font-semibold transition",
                      siteBackground.mode === "gradient" ? "bg-accent text-ink" : "text-frost/70 hover:text-frost"
                    )}
                    onClick={() => onChangeSiteBackground({ ...siteBackground, mode: "gradient" })}
                  >{
                    tl("gradient")
                  }</button>
                  <button
                    className={cn(
                      "rounded-full px-3 py-1 text-xs font-semibold transition",
                      siteBackground.mode === "image" ? "bg-accent text-ink" : "text-frost/70 hover:text-frost"
                    )}
                    onClick={() => onChangeSiteBackground({ ...siteBackground, mode: "image" })}
                  >{
                    tl("picture")
                  }</button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-frost/60">{tl("color")}</span>
                  <input
                    type="color"
                    value={siteBackground.color}
                    onChange={(e) => onChangeSiteBackground({ ...siteBackground, color: e.target.value })}
                    className="h-7 w-10 rounded border border-white/10 bg-white/5"
                  />
                  <input
                    type="text"
                    value={siteBackground.color}
                    onChange={(e) => onChangeSiteBackground({ ...siteBackground, color: e.target.value })}
                    className="w-28 rounded border border-white/10 bg-white/5 px-2 py-1 text-xs"
                  />
                </div>
                {siteBackground.mode === "gradient" && (
                  <div className="space-y-2">
                    <div className="text-xs text-frost/60">{tl("presets")}</div>
                    <div className="grid gap-2">
                      {bgPresets.map((preset) => (
                        <button
                          key={preset.label}
                          className={cn(
                            "rounded-lg border border-white/10 px-3 py-2 text-left text-xs transition",
                            siteBackground.gradient === preset.value
                              ? "border-accent/60 bg-accent/10"
                              : "hover:border-white/30"
                          )}
                          onClick={() =>
                            onChangeSiteBackground({ ...siteBackground, mode: "gradient", gradient: preset.value })
                          }
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {siteBackground.mode === "image" && (
                  <div className="space-y-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setBgImageTarget(true);
                        setImageTargetId(null);
                        fileInputRef.current?.click();
                      }}
                    >{
                      tl("upload_background")
                    }</Button>
                    {siteBackground.image && <div className="text-xs text-frost/60">{tl("image_uploaded")}</div>}
                  </div>
                )}
              </div>
            </div>

            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
            <input ref={pptxInputRef} type="file" accept=".pptx" className="hidden" onChange={handlePptxImport} />
            <input ref={m365PptxInputRef} type="file" accept=".pptx" className="hidden" onChange={handleM365PptxUpload} />
            <input ref={officeViewerInputRef} type="file" accept=".pptx" className="hidden" onChange={handleOfficeViewerUpload} />
          </div>
        )}
        {section === "replays" && (
          <div className="grid gap-4 p-4 lg:grid-cols-[320px_1fr]">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs uppercase tracking-wider text-frost/60">{tl("board_replays")}</div>
                <Button size="sm" variant="outline" onClick={() => void fetchReplayItems()} disabled={replaysLoading}>
                  <RefreshCw size={14} className="mr-2" />
                  {tl("refresh")}
                </Button>
              </div>
              <div className="max-h-[36vh] space-y-2 overflow-auto pr-1">
                {replaysLoading && !replayItems.length && (
                  <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-frost/60">
                    {tl("loading")}
                  </div>
                )}
                {!replaysLoading && replayItems.length === 0 && (
                  <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-frost/60">
                    {tl("no_replays")}
                  </div>
                )}
                {replayItems.map((item) => (
                  <button
                    key={item.id}
                    className={cn(
                      "w-full rounded-xl border px-3 py-2 text-left text-xs transition",
                      selectedReplay?.id === item.id
                        ? "border-accent/60 bg-accent/10"
                        : "border-white/10 hover:border-white/30"
                    )}
                    onClick={() => void fetchReplayDetail(item.id)}
                  >
                    <div className="font-semibold">{formatDateTime(item.startTs, locale)}</div>
                    <div className="mt-1 text-[11px] text-frost/60">
                      {tl("duration_sec_ops_count", { sec: item.durationSec, count: item.opsCount })}
                    </div>
                    <div className="mt-1 text-[11px] text-frost/60">
                      {tl("strokes_add_undo_redo_clear", {
                        add: item.addCount,
                        undo: item.undoCount,
                        redo: item.redoCount,
                        clear: item.clearCount,
                      })}
                    </div>
                  </button>
                ))}
              </div>

              <div className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs uppercase tracking-wider text-frost/60">{tl("ai_assistant_history")}</div>
                <div className="max-h-[30vh] space-y-2 overflow-auto pr-1">
                  {aiHistoryLoading && aiHistory.length === 0 && (
                    <div className="rounded-lg border border-white/10 bg-white/5 p-2 text-xs text-frost/60">
                      {tl("loading")}
                    </div>
                  )}
                  {!aiHistoryLoading && aiHistory.length === 0 && (
                    <div className="rounded-lg border border-white/10 bg-white/5 p-2 text-xs text-frost/60">
                      {tl("no_ai_requests")}
                    </div>
                  )}
                  {aiHistory.map((item, idx) => (
                    <div key={`${item.ts}-${idx}`} className="rounded-lg border border-white/10 bg-white/5 p-2 text-xs">
                      <div className="flex items-center justify-between gap-2 text-frost/70">
                        <span>{formatDateTime(item.ts, locale)}</span>
                        <Badge className={item.ok ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"}>
                          {item.ok ? tl("status_ok") : tl("status_error")}
                        </Badge>
                      </div>
                      <div className="mt-1 text-frost/70">{tl("mode_label", { mode: item.mode })}</div>
                      <div className="mt-1 line-clamp-2 text-frost/80">{item.problem}</div>
                      {item.error ? (
                        <div className="mt-1 text-red-300">{item.error}</div>
                      ) : (
                        <div className="mt-1 line-clamp-3 text-frost/70">{item.response}</div>
                      )}
                    </div>
                  ))}
                </div>
                <Button size="sm" variant="outline" onClick={() => void fetchAiHistory()} disabled={aiHistoryLoading}>
                  <RefreshCw size={14} className="mr-2" />
                  {tl("refresh")}
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              <div className="text-xs uppercase tracking-wider text-frost/60">{tl("replay_viewer")}</div>
              <div className="rounded-xl border border-white/10 bg-ink/60 p-3">
                <canvas ref={replayCanvasRef} className="max-w-full rounded-lg border border-white/10 bg-ink" />
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (!selectedReplay) return;
                      if (replayCursor >= selectedReplay.ops.length) {
                        resetReplay();
                      }
                      setReplayPlaying((v) => !v);
                    }}
                    disabled={!selectedReplay}
                  >
                    {replayPlaying ? <Pause size={14} className="mr-2" /> : <Play size={14} className="mr-2" />}
                    {replayPlaying ? tl("pause") : tl("play")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={resetReplay} disabled={!selectedReplay}>
                    <RefreshCw size={14} className="mr-2" />
                    {tl("reset")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={downloadReplayVideo} disabled={!selectedReplay}>
                    <Download size={14} className="mr-2" />
                    {tl("download_video")}
                  </Button>
                </div>
                <div className="mt-3 grid gap-2 md:grid-cols-[1fr_180px] md:items-center">
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, (selectedReplay?.ops.length ?? 0))}
                    value={replayCursor}
                    onChange={(e) => handleReplayCursorChange(Number(e.target.value))}
                    disabled={!selectedReplay}
                  />
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-frost/60">{tl("speed")}</span>
                    <input
                      type="range"
                      min={0.25}
                      max={3}
                      step={0.25}
                      value={replaySpeed}
                      onChange={(e) => setReplaySpeed(Number(e.target.value))}
                    />
                    <span className="min-w-[42px] text-right text-xs text-frost/70">{replaySpeed.toFixed(2)}x</span>
                  </div>
                </div>
                <div className="mt-2 text-xs text-frost/60">
                  {selectedReplay
                    ? tl("step_current_total", { current: replayCursor, total: selectedReplay.ops.length })
                    : tl("select_replay_in_list")}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
