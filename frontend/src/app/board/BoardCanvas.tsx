import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ForwardedRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { callOcr, type ProgressUpdate } from "@/app/ai/api";
import { drawStrokes, type Stroke } from "@/app/board/boardEngine";
import type { BoardReplayOp } from "@/app/board/replayApi";
import { boardStack, liftedImageIds, newPictureLayer, restackOnBoard, topLayer, type AiSolutionBlock, type BoardImage, type GraphElement } from "@/app/board/boardDocument";
import { BoardImageHandles, BoardPictures } from "./BoardImagesLayer";
import InsertImageDialog, { type InsertedImage } from "./InsertImageDialog";
import { apiFetch } from "@/lib/apiClient";
import { getSelectionBounds, selectGraphIds, selectStrokeIndices, translateBounds, translateStroke, type LassoBounds } from "@/app/board/lasso";
import GraphElementView from "@/app/board/GraphElementView";
import AiSolutionBlockView from "@/app/board/AiSolutionBlockView";
import { findFreeBoardSpace, findFreeBoardSpaceNearTarget, type BoardRect } from "@/app/board/freeSpace";
import BoardToolbarPopover from "@/app/board/BoardToolbarPopover";
import { chooseActiveOcrCluster, chooseOcrTaskClusters, clusterOcrStrokes, composeOcrText, recentUserOcrStrokes, sanitizeMultiTaskOcrTexts, unionRects } from "@/app/board/ocrClusters";
import BoardToolIcon from "@/app/board/BoardToolIcon";
import { Grid3x3, Hand, Highlighter, LassoSelect, Lock, Menu, MessageSquare, Mouse, MousePointer2, NotebookPen, Pointer, RotateCcw, RotateCw, Save, Trash2, Underline, Unlock, X, ChevronLeft, ChevronRight, Plus, ImagePlus } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useI18n } from "@/i18n";
import { getBoardProfileConfig, type BoardProfile } from "@/app/board/boardProfiles";
import { backendAssetUrl, isNativeApp } from "@/lib/apiClient";
import { SHAPE_HOLD_MS, SHAPE_HOLD_TOLERANCE, recognizeShape } from "./shapeRecognition";
import { pageCount, pageInView, panForPage, strokesOnPage } from "./pages";
import { applyConstraint, constrainedPoints, constraintForStroke, createGeometryTool, type GeometryTool, type StrokeConstraint } from "./geometry";
import GeometryOverlay from "./GeometryOverlay";
import {
  NATIVE_HEALTHY_AFTER_MS,
  NativeBoard,
  disableNativeBoardAutomatically,
  encodeNativeStroke,
  nativeBoardAutoDisabledReason,
  nativeBoardRequested,
  nativeStrokeChunks,
  setNativeBoardEnabled,
  type BoardRect as NativeRect, type NativeBoardFrame, type NativeStrokeEvent, type NativeStrokeHoldEvent, type NativeViewportEvent } from "@/app/board/nativeBoard";
import type { PluginListenerHandle } from "@capacitor/core";

type RenderQualityMode = "quality" | "balanced" | "performance";

const BALANCED_RENDER_WIDTH = 2560;
const BALANCED_RENDER_HEIGHT = 1440;
const PERFORMANCE_RENDER_WIDTH = 1920;
const PERFORMANCE_RENDER_HEIGHT = 1080;
const TOOLBAR_REVEAL_STRIP_PX = 64;
const NATIVE_IMAGE_MAX_EDGE = 2048;

const blobToBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

const PRIMARY_COLORS = [
  { name: "Красный", value: "#FF0000" },
  { name: "Черный", value: "#000000" },
  { name: "Белый", value: "#FFFFFF" },
  { name: "Бирюзово-зеленый", value: "#1E5945" },
];
const EXTRA_COLORS = [
  { name: "Черный (Ink)", value: "#0A0E14" },
  { name: "Графит", value: "#121824" },
  { name: "Темно-серый", value: "#1E293B" },
  { name: "Светло-серый", value: "#E7F2FF" },
  { name: "Зеленый", value: "#5BE7C4" },
  { name: "Оранжевый", value: "#FFB86B" },
  { name: "Синий", value: "#4DA3FF" },
  { name: "Розовый", value: "#FF8FA3" },
  { name: "Желтый", value: "#F6D365" },
];
const ALL_PEN_COLORS = [...PRIMARY_COLORS, ...EXTRA_COLORS];

const BG_PRIMARY = [
  { name: "Черный", value: "#0A0E14" },
  { name: "Графит", value: "#121824" },
  { name: "Белый", value: "#FFFFFF" },
  { name: "Голубой", value: "#EAF3FF" },
];
const BG_EXTRA = [
  { name: "Темно-синий", value: "#0b1220" },
  { name: "Сланцевый", value: "#0f1724" },
  { name: "Светло-серый", value: "#E7F2FF" },
  { name: "Кремовый", value: "#FFF7E6" },
  { name: "Мятный", value: "#E9FFF7" },
  { name: "Красный", value: "#FF0000" },
  { name: "Бирюзово-зеленый", value: "#1E5945" },
  { name: "Зеленый", value: "#5BE7C4" },
  { name: "Оранжевый", value: "#FFB86B" },
  { name: "Синий", value: "#4DA3FF" },
  { name: "Розовый", value: "#FF8FA3" },
  { name: "Желтый", value: "#F6D365" },
];
const ALL_BACKGROUNDS = [...BG_PRIMARY, ...BG_EXTRA];

export type BoardCanvasHandle = {
  recognize: (options?: { multipleTasks?: boolean; onProgress?: (update: ProgressUpdate) => void }) => Promise<string>;
  getLastOcrTargetColor: () => string | null;
  allocateSolutionPlacement: (width?: number, height?: number, targetIndex?: number) => { x: number; y: number; width: number; minHeight: number };
  animateAiStrokes: (
    strokes: Stroke[],
    shouldCancel?: () => boolean,
    lowMotion?: boolean,
  ) => Promise<Stroke[]>;
};

const EMPTY_SOLUTIONS: AiSolutionBlock[] = [];
const EMPTY_IMAGES: BoardImage[] = [];
const NOOP_SOLUTION_CHANGE = (_next: AiSolutionBlock[]) => undefined;

/** Pictures drawn under the ink: all of them except those raised over a graph. */
const picturesUnderInk = (images: BoardImage[], graphs: GraphElement[]) => {
  const stack = boardStack(images, graphs);
  const lifted = liftedImageIds(stack);
  return stack.flatMap((entry) => (entry.kind === "image" && !lifted.has(entry.item.id) ? [entry.item] : []));
};

const geometryArtwork = { ruler: "line", protractor: "protractor", compass: "compass" } as const;

const BoardCanvas = forwardRef(function BoardCanvas({
  onOcrText,
  ocrEnabled,
  onTogglePanels,
  onStartTimer,
  initialStrokes,
  onChangeStrokes,
  initialGraphs,
  onChangeGraphs,
  initialSolutions = EMPTY_SOLUTIONS,
  initialImages = EMPTY_IMAGES,
  contentLoading = false,
  onChangeSolutions = NOOP_SOLUTION_CHANGE,
  onCancelAiSolution,
  canUndo,
  canRedo,
  initialPenColor,
  onChangePenColor,
  initialBgColor,
  onChangeBgColor,
  onReplayOp,
  lowPowerOverride,
  renderQualityMode,
  taskOpen,
  assistantOpen,
  onToggleTask,
  onToggleAssistant,
  boardProfile,
}: {
  onOcrText?: (text: string) => void;
  ocrEnabled: boolean;
  expanded: boolean;
  onTogglePanels: () => void;
  onStartTimer: () => void;
  initialStrokes: Stroke[];
  onChangeStrokes: (next: Stroke[]) => void;
  initialGraphs: GraphElement[];
  onChangeGraphs: (next: GraphElement[]) => void;
  initialSolutions?: AiSolutionBlock[];
  /** Pictures come from board history like everything else; this component only emits image operations. */
  initialImages?: BoardImage[];
  /** True while the lesson's board is still being fetched, so an empty board is not mistaken for a loaded one. */
  contentLoading?: boolean;
  onChangeSolutions?: (next: AiSolutionBlock[]) => void;
  onCancelAiSolution?: (id: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  initialPenColor: string;
  onChangePenColor: (color: string) => void;
  initialBgColor: string;
  onChangeBgColor: (color: string) => void;
  onReplayOp?: (op: BoardReplayOp) => void;
  lowPowerOverride?: boolean;
  renderQualityMode?: RenderQualityMode;
  taskOpen?: boolean;
  assistantOpen?: boolean;
  onToggleTask?: () => void;
  onToggleAssistant?: () => void;
  boardProfile: BoardProfile;
}, ref: ForwardedRef<BoardCanvasHandle>) {
  const { tl } = useI18n();
  const profileConfig = getBoardProfileConfig(boardProfile);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasRectRef = useRef<DOMRectReadOnly | null>(null);
  // Opt-in native Android backend. The legacy HTML canvas remains the automatic fallback.
  const [nativeBoardReady, setNativeBoardReady] = useState(false);
  const nativeReadyRef = useRef(false);
  const nativeSyncedStrokesRef = useRef<Stroke[] | null>(null);
  const nativeStrokeStartedRef = useRef<() => void>(() => undefined);
  const nativeStrokeCommittedRef = useRef<(event: NativeStrokeEvent) => void>(() => undefined);
  const nativeViewportRef = useRef<(event: NativeViewportEvent) => void>(() => undefined);
  const nativeOwnedStrokesRef = useRef(new WeakSet<Stroke>());
  const nativeStrokeHoldRef = useRef<(event: NativeStrokeHoldEvent) => void>(() => undefined);
  const nativeDocumentRevisionRef = useRef(0);
  const [nativeFallbackReason, setNativeFallbackReason] = useState(() =>
    isNativeApp() ? nativeBoardAutoDisabledReason() : null,
  );
  const [nativeFallbackDismissed, setNativeFallbackDismissed] = useState(false);

  const rawPointerSupportedRef = useRef(false);
  const rawPointerHandlerRef = useRef<(event: PointerEvent) => void>(() => undefined);
  const workerRef = useRef<Worker | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRenderRef = useRef(false);
  const drawFrameRef = useRef<() => void>(() => undefined);
  const workerEnabledRef = useRef(false);
  const strokesRef = useRef<Stroke[]>(initialStrokes);
  const aiStrokeAnimationActiveRef = useRef(false);
  const graphsRef = useRef<GraphElement[]>(initialGraphs);
  const [graphs, setGraphs] = useState<GraphElement[]>(initialGraphs);
  const solutionsRef = useRef<AiSolutionBlock[]>(initialSolutions);
  const [solutions, setSolutions] = useState<AiSolutionBlock[]>(initialSolutions);
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedGraphId) return;
    const handleOutsideGraphPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[data-graph-interactive="true"]')) return;
      setSelectedGraphId(null);
    };
    document.addEventListener("pointerdown", handleOutsideGraphPointer, true);
    return () => document.removeEventListener("pointerdown", handleOutsideGraphPointer, true);
  }, [selectedGraphId]);
  const [color, setColor] = useState(initialPenColor);
  const [showAllPens, setShowAllPens] = useState(false);
  const [width, setWidth] = useState(4);
  const [eraserWidth, setEraserWidth] = useState(16);
  const [mode, setMode] = useState<"draw" | "erase" | "line" | "pan" | "graph" | "lasso">("draw");
  const [humanitiesPreset, setHumanitiesPreset] = useState<"highlight" | "underline" | null>(null);
  const [grid, setGrid] = useState(true);
  const [, setLoading] = useState(false);
  const [bg, setBg] = useState(initialBgColor);
  const [showAllBg, setShowAllBg] = useState(false);
  const [showBoardSettings, setShowBoardSettings] = useState(false);
  const [boardLock, setBoardLock] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("board.lockZoomPan") === "1";
  });
  const lineStartRef = useRef<{ x: number; y: number } | null>(null);
  const linePreviewRef = useRef<Stroke | null>(null);
  const [showPenSlider, setShowPenSlider] = useState(false);
  const [showPenPalette, setShowPenPalette] = useState(false);
  const [showEraserSlider, setShowEraserSlider] = useState(false);
  const [showGeometryMenu, setShowGeometryMenu] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearSlideValue, setClearSlideValue] = useState(0);
  const penTimerRef = useRef<number | null>(null);
  const eraserTimerRef = useRef<number | null>(null);
  const lineTimerRef = useRef<number | null>(null);
  const [inputMode, setInputMode] = useState<"auto" | "mouse" | "touch">("auto");
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const toolbarHideTimerRef = useRef<number | null>(null);
  const toolbarPinnedRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const lastOcrTargetBoundsRef = useRef<BoardRect | null>(null);
  const lastOcrTaskBoundsRef = useRef<BoardRect[]>([]);
  const lastOcrTargetColorRef = useRef<string | null>(null);
  const penToolbarAnchorRef = useRef<HTMLDivElement | null>(null);
  const lineToolbarAnchorRef = useRef<HTMLDivElement | null>(null);
  const eraserToolbarAnchorRef = useRef<HTMLDivElement | null>(null);
  const boardToolbarAnchorRef = useRef<HTMLDivElement | null>(null);
  const clearToolbarAnchorRef = useRef<HTMLDivElement | null>(null);
  const [dynamicSize, setDynamicSize] = useState({ w: 1600, h: 900 });
  const widthPx = dynamicSize.w;
  const heightPx = dynamicSize.h;
  const [zoom, setZoom] = useState(() => {
    if (typeof window === "undefined") return 1;
    const raw = window.localStorage.getItem("board.zoom");
    const value = raw ? Number(raw) : 1;
    if (!Number.isFinite(value)) return 1;
    return Math.min(Math.max(value, 0.5), 2.5);
  });
  const zoomRef = useRef(zoom);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panRef = useRef(pan);
  const panStartRef = useRef<{ id: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const touchPointsRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const touchPanRef = useRef<{ active: boolean; lastCenter: { x: number; y: number } | null }>({
    active: false,
    lastCenter: null,
  });
  const pinchRef = useRef<{ active: boolean; startDist: number }>({ active: false, startDist: 0 });
  const safariPinchRef = useRef<{
    startZoom: number;
    startPan: { x: number; y: number };
    anchor: { x: number; y: number };
  } | null>(null);
  const boardLockRef = useRef(boardLock);
  boardLockRef.current = boardLock;
  const [lassoPath, setLassoPath] = useState<{ x: number; y: number }[]>([]);
  const lassoPathRef = useRef<{ x: number; y: number }[]>([]);
  const [lassoSelection, setLassoSelection] = useState<{
    strokeIndices: number[];
    graphIds: string[];
    bounds: LassoBounds | null;
  }>({ strokeIndices: [], graphIds: [], bounds: null });
  const lassoMoveRef = useRef<{
    pointerId: number;
    start: { x: number; y: number };
    delta: { x: number; y: number };
    bounds: LassoBounds;
    strokeSnapshots: Map<number, Stroke>;
    graphSnapshots: Map<string, GraphElement>;
  } | null>(null);
  const eraserPreviewRef = useRef<{ x: number; y: number } | null>(null);
  const toolbarPinned =
    (showPenPalette && mode === "draw") ||
    showGeometryMenu ||
    (showEraserSlider && mode === "erase") ||
    showBoardSettings ||
    showClearConfirm;
  toolbarPinnedRef.current = toolbarPinned;

  const clearToolbarHideTimer = () => {
    if (toolbarHideTimerRef.current === null) return;
    window.clearTimeout(toolbarHideTimerRef.current);
    toolbarHideTimerRef.current = null;
  };

  const scheduleToolbarHide = () => {
    clearToolbarHideTimer();
    toolbarHideTimerRef.current = window.setTimeout(() => {
      toolbarHideTimerRef.current = null;
      if (toolbarPinnedRef.current || activePointerIdRef.current !== null) {
        scheduleToolbarHide();
        return;
      }
      setToolbarVisible(false);
    }, 2500);
  };

  const revealToolbar = () => {
    setToolbarVisible(true);
    scheduleToolbarHide();
  };

  const revealToolbarNearBottom = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.height <= 0) return;
    const nearBottom = event.clientY >= rect.bottom - TOOLBAR_REVEAL_STRIP_PX && event.clientY <= rect.bottom;
    if (!nearBottom) return;
    const wasHidden = !toolbarVisible;
    revealToolbar();
    if (wasHidden && event.type === "pointerdown") {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  useEffect(() => {
    if (toolbarPinned) {
      clearToolbarHideTimer();
      setToolbarVisible(true);
      return () => clearToolbarHideTimer();
    }
    scheduleToolbarHide();
    return () => clearToolbarHideTimer();
  }, [toolbarPinned]);

  useEffect(() => {
    revealToolbar();
  }, [mode]);

  const isDarkBg = useMemo(() => {
    const hex = bg.replace("#", "");
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance < 140;
  }, [bg]);
  const gridColor = isDarkBg ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.08)";
  const autoLowPowerMode = useMemo(() => {
    if (typeof window === "undefined") return false;
    const nav = navigator as Navigator & { deviceMemory?: number };
    const memory = nav.deviceMemory ?? 8;
    const cores = nav.hardwareConcurrency ?? 8;
    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
    return memory <= 4 || cores <= 4 || coarse;
  }, []);
  const effectiveRenderMode: RenderQualityMode = useMemo(() => {
    if (renderQualityMode) return renderQualityMode;
    if (typeof lowPowerOverride === "boolean") return lowPowerOverride ? "performance" : "balanced";
    return autoLowPowerMode ? "performance" : "balanced";
  }, [autoLowPowerMode, lowPowerOverride, renderQualityMode]);
  const lowPowerMode = effectiveRenderMode === "performance";
  const pixelRatio = useMemo(() => {
    if (typeof window === "undefined") return 1;
    const ratio = window.devicePixelRatio || 1;
    if (effectiveRenderMode === "performance") return 1;
    if (effectiveRenderMode === "balanced") return Math.min(ratio, 1.5);
    return Math.min(ratio, 2);
  }, [effectiveRenderMode]);
  const renderCap = useMemo<{ width: number; height: number } | null>(() => {
    if (effectiveRenderMode === "performance") {
      return { width: PERFORMANCE_RENDER_WIDTH, height: PERFORMANCE_RENDER_HEIGHT };
    }
    if (effectiveRenderMode === "balanced") {
      return { width: BALANCED_RENDER_WIDTH, height: BALANCED_RENDER_HEIGHT };
    }
    return null;
  }, [effectiveRenderMode]);
  const renderRatio = useMemo(() => {
    const base = pixelRatio;
    if (!widthPx || !heightPx) return base;
    if (!renderCap) return base;
    const cap = Math.min(1, renderCap.width / (widthPx * base), renderCap.height / (heightPx * base));
    return Math.max(0.1, base * cap);
  }, [heightPx, pixelRatio, renderCap, widthPx]);
  const minPointDistanceSq = lowPowerMode ? 1.4 : 0.64;
  const maxPointsPerStroke = lowPowerMode ? 1200 : 2200;
  const renderMinDeltaMs = lowPowerMode ? 32 : 16;
  const gridStep = profileConfig.backgroundPattern === "lines" ? (lowPowerMode ? 48 : 36) : (lowPowerMode ? 40 : 28);
  const lastRenderTsRef = useRef(0);
  const supportsOffscreenWorker = useMemo(() => {
    if (typeof window === "undefined") return false;
    const hasWorker = typeof Worker !== "undefined";
    const hasOffscreen = typeof OffscreenCanvas !== "undefined";
    const hasTransfer =
      typeof HTMLCanvasElement !== "undefined" &&
      typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function";
    return hasWorker && hasOffscreen && hasTransfer;
  }, []);
  const enableExperimentalWorker = false;
  const shouldUseWorker = enableExperimentalWorker && lowPowerMode && supportsOffscreenWorker;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!shouldUseWorker) return;
    if (workerRef.current) return;
    try {
      const offscreen = canvas.transferControlToOffscreen();
      const worker = new Worker(new URL("./boardRender.worker.ts", import.meta.url), { type: "module" });
      worker.postMessage({ type: "init", canvas: offscreen }, [offscreen]);
      workerRef.current = worker;
      workerEnabledRef.current = true;
      scheduleRender();
    } catch {
      workerRef.current = null;
      workerEnabledRef.current = false;
    }
  }, [shouldUseWorker]);

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const nextW = Math.floor(rect.width);
      const nextH = Math.floor(rect.height);
      if (nextW <= 1 || nextH <= 1) return;
      setDynamicSize({ w: nextW, h: nextH });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!workerEnabledRef.current) {
      const ratio = renderRatio;
      canvas.width = widthPx * ratio;
      canvas.height = heightPx * ratio;
    }
    scheduleRender();
  }, [widthPx, heightPx, renderRatio]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("board.zoom", String(zoom));
  }, [zoom]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("board.lockZoomPan", boardLock ? "1" : "0");
  }, [boardLock]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  const clampZoom = (value: number) => Math.min(Math.max(value, 0.5), 2.5);

  const clampPan = (next: { x: number; y: number }) => next;

  const clearLassoSelection = () => {
    lassoPathRef.current = [];
    setLassoPath([]);
    setLassoSelection({ strokeIndices: [], graphIds: [], bounds: null });
    lassoMoveRef.current = null;
  };

  const pointInsideBounds = (point: { x: number; y: number }, bounds: LassoBounds) =>
    point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;

  const startLassoMove = (pointerId: number, point: { x: number; y: number }, bounds: LassoBounds) => {
    const strokeSnapshots = new Map<number, Stroke>();
    for (const index of lassoSelection.strokeIndices) {
      const stroke = strokesRef.current[index];
      if (stroke) {
        strokeSnapshots.set(index, {
          ...stroke,
          points: stroke.points.map((item) => ({ ...item })),
        });
      }
    }

    const selectedGraphIds = new Set(lassoSelection.graphIds);
    const graphSnapshots = new Map<string, GraphElement>();
    for (const graph of graphsRef.current) {
      if (!selectedGraphIds.has(graph.id)) continue;
      graphSnapshots.set(graph.id, {
        ...graph,
        expressions: graph.expressions.map((expression) => ({ ...expression })),
      });
    }

    lassoMoveRef.current = {
      pointerId,
      start: point,
      delta: { x: 0, y: 0 },
      bounds,
      strokeSnapshots,
      graphSnapshots,
    };
  };

  const updateLassoMove = (point: { x: number; y: number }) => {
    const move = lassoMoveRef.current;
    if (!move) return;
    const dx = point.x - move.start.x;
    const dy = point.y - move.start.y;
    move.delta = { x: dx, y: dy };

    const nextStrokes = strokesRef.current.map((stroke, index) => {
      const original = move.strokeSnapshots.get(index);
      return original ? translateStroke(original, dx, dy) : stroke;
    });
    strokesRef.current = nextStrokes;

    const nextGraphs = graphsRef.current.map((graph) => {
      const original = move.graphSnapshots.get(graph.id);
      return original ? { ...original, x: original.x + dx, y: original.y + dy } : graph;
    });
    graphsRef.current = nextGraphs;
    setGraphs(nextGraphs);
    setLassoSelection((current) => ({ ...current, bounds: translateBounds(move.bounds, dx, dy) }));
    scheduleRender();
  };

  const finishLassoMove = () => {
    const move = lassoMoveRef.current;
    lassoMoveRef.current = null;
    if (!move) return;
    const { x: dx, y: dy } = move.delta;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;

    const strokeIndexes = [...move.strokeSnapshots.keys()];
    if (strokeIndexes.length) {
      if (onReplayOp) {
        onReplayOp({ op: "stroke_move", indexes: strokeIndexes, dx, dy, ts: Date.now() });
      } else {
        syncStrokesToParent([...strokesRef.current]);
      }
    }

    if (move.graphSnapshots.size) {
      if (onReplayOp) {
        for (const [id, before] of move.graphSnapshots) {
          const after = graphsRef.current.find((graph) => graph.id === id);
          if (after) onReplayOp({ op: "graph_update", before, after, ts: Date.now() });
        }
      } else {
        onChangeGraphs([...graphsRef.current]);
      }
    }
  };

  const finishLassoPath = () => {
    const polygon = lassoPathRef.current;
    lassoPathRef.current = [];
    setLassoPath([]);
    if (polygon.length < 3) {
      setLassoSelection({ strokeIndices: [], graphIds: [], bounds: null });
      return;
    }

    const strokeIndices = selectStrokeIndices(strokesRef.current, polygon);
    const graphIds = selectGraphIds(graphsRef.current, polygon);
    const bounds = getSelectionBounds(strokesRef.current, strokeIndices, graphsRef.current, graphIds);
    setLassoSelection({ strokeIndices, graphIds, bounds });
  };

  const deleteLassoSelection = () => {
    const strokeIndexes = [...lassoSelection.strokeIndices]
      .filter((index) => Number.isInteger(index) && index >= 0 && index < strokesRef.current.length)
      .sort((a, b) => a - b);
    const selectedStrokes = strokeIndexes.map((index) => ({
      ...strokesRef.current[index],
      points: strokesRef.current[index].points.map((point) => ({ ...point })),
    }));

    const graphIds = new Set(lassoSelection.graphIds);
    const selectedGraphs = graphsRef.current
      .filter((graph) => graphIds.has(graph.id))
      .map((graph) => ({
        ...graph,
        expressions: graph.expressions.map((expression) => ({ ...expression })),
      }));

    if (!strokeIndexes.length && !selectedGraphs.length) {
      clearLassoSelection();
      return;
    }

    if (onReplayOp) {
      if (strokeIndexes.length) {
        onReplayOp({
          op: "stroke_delete",
          indexes: strokeIndexes,
          strokes: selectedStrokes,
          ts: Date.now(),
        });
      }
      for (const graph of selectedGraphs) {
        onReplayOp({ op: "graph_delete", graph, ts: Date.now() });
      }
    } else {
      if (strokeIndexes.length) {
        const indexes = new Set(strokeIndexes);
        strokesRef.current = strokesRef.current.filter((_, index) => !indexes.has(index));
        syncStrokesToParent([...strokesRef.current]);
      }
      if (selectedGraphs.length) {
        const ids = new Set(selectedGraphs.map((graph) => graph.id));
        syncGraphsToParent(graphsRef.current.filter((graph) => !ids.has(graph.id)));
      }
    }

    clearLassoSelection();
    scheduleRender();
  };

  const syncStrokesToParent = (next: Stroke[]) => {
    onChangeStrokes(next);
  };

  // Native events commit into the unchanged React history/replay/OCR document model.
  nativeStrokeHoldRef.current = ({ seq, stroke }) => {
    const shape = recognizeShape(stroke.points);
    if (shape) void NativeBoard.replaceLiveStroke({ seq, points: shape.points }).catch(() => undefined);
  };
  nativeStrokeStartedRef.current = () => onStartTimer();
  nativeStrokeCommittedRef.current = ({ stroke }) => {
    if (!nativeReadyRef.current || !stroke?.points?.length) return;
    strokesRef.current.push(stroke);
    nativeOwnedStrokesRef.current.add(stroke);
    onReplayOp?.({ op: "add", stroke: buildReplayStroke(stroke), ts: Date.now() });
    syncStrokesToParent([...strokesRef.current]);
    scheduleRender();
  };
  nativeViewportRef.current = ({ zoom: nextZoom, panX, panY }) => {
    zoomRef.current = nextZoom;
    panRef.current = { x: panX, y: panY };
    setZoom(nextZoom);
    setPan({ x: panX, y: panY });
  };

  const images = initialImages;
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [showInsertImage, setShowInsertImage] = useState(false);
  // A server without image operations would reject the whole sync batch, strokes included.
  const [imagesSupported, setImagesSupported] = useState(false);
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/status", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((status) => { if (!cancelled) setImagesSupported(Boolean(status?.features?.boardImages)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (mode !== "pan") setSelectedImageId(null);
  }, [mode]);

  const insertImage = ({ src, label, aspect }: InsertedImage) => {
    const viewWidth = widthPx / zoomRef.current;
    const viewHeight = heightPx / zoomRef.current;
    const left = -panRef.current.x / zoomRef.current;
    const top = -panRef.current.y / zoomRef.current;
    // Fit the page into most of the view, so it is readable and still leaves room to write beside it;
    // the bottom fifth stays free for the toolbar.
    let width = Math.min(viewWidth * 0.6, 1000);
    let height = width * aspect;
    if (height > viewHeight * 0.8) {
      height = viewHeight * 0.8;
      width = height / aspect;
    }
    const image: BoardImage = {
      id: `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      src,
      label,
      x: left + (viewWidth - width) / 2,
      y: top + Math.max(16 / zoomRef.current, (viewHeight * 0.85 - height) / 2),
      width,
      height,
      z: newPictureLayer(imagesRef.current, graphsRef.current),
    };
    onReplayOp?.({ op: "image_add", image, ts: Date.now() });
    setShowInsertImage(false);
    // Leave it picked up, so it can be moved or resized straight away; the pen tool writes over it.
    setMode("pan");
    setSelectedImageId(image.id);
  };

  const commitImage = (before: BoardImage, after: BoardImage) => {
    onReplayOp?.({ op: "image_update", before, after, ts: Date.now() });
  };

  const liftedImages = useMemo(() => liftedImageIds(boardStack(images, profileConfig.graphTools ? graphs : [])), [images, graphs, profileConfig.graphTools]);

  const restackPicture = (image: BoardImage, direction: 1 | -1) => {
    const moved = restackOnBoard(imagesRef.current, graphsRef.current, image.id, direction);
    if (moved?.kind === "image") commitImage(image, moved.item);
  };

  const deleteImage = (image: BoardImage) => {
    onReplayOp?.({ op: "image_delete", image, ts: Date.now() });
    setSelectedImageId(null);
  };

  const currentPage = pageInView(pan, zoom, heightPx);
  const totalPages = pageCount(strokesRef.current, currentPage);
  const goToPage = (page: number) => {
    const next = panForPage(Math.max(0, page), zoomRef.current, panRef.current);
    clearLassoSelection();
    panRef.current = next;
    setPan(next);
  };

  const switchRenderer = (native: boolean) => {
    setNativeBoardEnabled(native);
    // A deliberate switch also forgives earlier crashed starts.
    void NativeBoard.markHealthy()
      .catch(() => undefined)
      .finally(() => window.location.reload());
  };

  const syncGraphsToParent = (next: GraphElement[]) => {
    graphsRef.current = next;
    setGraphs(next);
    onChangeGraphs(next);
  };

  const updateGraphPreview = (next: GraphElement) => {
    const nextGraphs = graphsRef.current.map((graph) => graph.id === next.id ? next : graph);
    syncGraphsToParent(nextGraphs);
  };

  const commitGraphUpdate = (before: GraphElement, after: GraphElement) => {
    updateGraphPreview(after);
    onReplayOp?.({ op: "graph_update", before, after, ts: Date.now() });
  };

  const restackGraph = (graph: GraphElement, direction: 1 | -1) => {
    const moved = restackOnBoard(imagesRef.current, graphsRef.current, graph.id, direction);
    if (moved?.kind === "graph") commitGraphUpdate(graph, moved.item);
  };

  const graphVisibleWorld = () => {
    const scale = zoomRef.current || 1;
    const currentPan = panRef.current;
    const left = -currentPan.x / scale;
    const top = -currentPan.y / scale;
    return { left, top, right: left + widthPx / scale, bottom: top + heightPx / scale };
  };

  const clampGraphPosition = (graph: GraphElement): GraphElement => {
    const visible = graphVisibleWorld();
    return {
      ...graph,
      x: Math.min(Math.max(graph.x, visible.left + 48 - graph.width), visible.right - 48),
      y: Math.min(Math.max(graph.y, visible.top + 48 - graph.height), visible.bottom - 48),
    };
  };

  const createGraphAt = (x: number, y: number) => {
    const safeX = Number.isFinite(x) ? x : 0;
    const safeY = Number.isFinite(y) ? y : 0;
    const id = crypto.randomUUID();
    const graph = clampGraphPosition({
      id, x: safeX - 210, y: safeY - 150, width: 420, height: 300,
      xLabel: "x", yLabel: "y", xMin: -10, xMax: 10, yMin: -10, yMax: 10,
      expressions: [{ id: crypto.randomUUID(), expression: "x", color: "#4DA3FF", visible: true }],
      z: topLayer(imagesRef.current, graphsRef.current),
    });
    onReplayOp?.({ op: "graph_add", graph, ts: Date.now() });
    syncGraphsToParent([...graphsRef.current, graph]);
    setSelectedGraphId(graph.id);
  };

  const deleteGraph = (graph: GraphElement) => {
    onReplayOp?.({ op: "graph_delete", graph, ts: Date.now() });
    syncGraphsToParent(graphsRef.current.filter((item) => item.id !== graph.id));
    if (selectedGraphId === graph.id) setSelectedGraphId(null);
  };

  const buildReplayStroke = (stroke: Stroke): Stroke => {
    const source = stroke.points;
    if (!source.length) return stroke;
    const step = source.length > 600 ? 4 : source.length > 300 ? 3 : source.length > 150 ? 2 : 1;
    const sampled: typeof source = [];
    let lastX = Number.NaN;
    let lastY = Number.NaN;
    for (let i = 0; i < source.length; i += step) {
      const p = source[i];
      const x = Math.round(p.x * 10) / 10;
      const y = Math.round(p.y * 10) / 10;
      if (!Number.isNaN(lastX)) {
        const dx = x - lastX;
        const dy = y - lastY;
        if (dx * dx + dy * dy < 0.64) continue;
      }
      sampled.push({ x, y });
      lastX = x;
      lastY = y;
    }
    const end = source[source.length - 1];
    const endRounded = { x: Math.round(end.x * 10) / 10, y: Math.round(end.y * 10) / 10 };
    const tail = sampled[sampled.length - 1];
    if (!tail || tail.x !== endRounded.x || tail.y !== endRounded.y) {
      sampled.push(endRounded);
    }
    if (sampled.length < 2) sampled.push({ ...endRounded });
    return { ...stroke, points: sampled };
  };

  useEffect(() => {
    setPan((prev) => clampPan(prev));
  }, [zoom, widthPx, heightPx]);

  useEffect(() => {
    if (mode !== "erase") {
      eraserPreviewRef.current = null;
      scheduleRender();
    }
    if (mode !== "lasso") clearLassoSelection();
  }, [mode]);

  useEffect(() => {
    if (!boardLock) return;
    if (mode === "pan") setMode("draw");
    lineStartRef.current = null;
    linePreviewRef.current = null;
  }, [boardLock, mode]);

  function drawNativeFrame() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return;
    const strokes = strokesRef.current;
    const synced = nativeSyncedStrokesRef.current;
    // Strokes are immutable once committed, so comparing identities finds what Android lacks.
    const onlyGrew = synced !== null && synced.length <= strokes.length &&
      synced.every((stroke, index) => stroke === strokes[index]);
    const grownStrokes = onlyGrew
      ? strokes.slice(synced.length).filter((stroke) => !nativeOwnedStrokesRef.current.has(stroke))
      : [];
    if (!onlyGrew || synced.length !== strokes.length) nativeSyncedStrokesRef.current = [...strokes];
    const frame: NativeBoardFrame = {
      viewport: {
        left: rect.left, top: rect.top, width: rect.width, height: rect.height,
        screenWidth: window.innerWidth, screenHeight: window.innerHeight,
      },
      mode,
      inputMode,
      zoomPanLocked: boardLock,
      color: humanitiesPreset === "highlight" ? "#F6D365A6" : color,
      width: humanitiesPreset === "highlight" ? 14 : width,
      eraserWidth,
      bg,
      appBg: getComputedStyle(document.documentElement).getPropertyValue("--app-background").trim() || "#0A0E14",
      grid,
      gridColor: isDarkBg ? "#FFFFFF0F" : "#00000014",
      gridStep,
      pattern: profileConfig.backgroundPattern,
      zoom, pan,
      preview: linePreviewRef.current,
      geometry: geometryToolRef.current,
      // Pictures raised over a graph are drawn by the WebView among the graphs instead.
      images: picturesUnderInk(imagesRef.current, profileConfig.graphTools ? graphsRef.current : []).map(({ src, x, y, width, height }) => ({ key: src, x, y, width, height })),
      documentRevision: nativeDocumentRevisionRef.current,
      strokeCount: strokes.length,
      ...(grownStrokes.length ? { appendStrokes: grownStrokes.map(encodeNativeStroke) } : {}),
    };
    const failToWebCanvas = () => {
      // If the Android view fails, restore the legacy web canvas rather than losing ink,
      // and keep this board on it: a broken bridge would fail again on the next lesson.
      disableNativeBoardAutomatically("bridge-failure");
      setNativeFallbackReason("bridge-failure");
      nativeReadyRef.current = false;
      document.body.classList.remove("native-board-active");
      setNativeBoardReady(false);
      void NativeBoard.disable().catch(() => undefined);
    };
    if (!onlyGrew) {
      frame.documentRevision = ++nativeDocumentRevisionRef.current;
      for (const chunk of nativeStrokeChunks(strokes, frame.documentRevision)) {
        void NativeBoard.loadStrokes(chunk).catch(failToWebCanvas);
      }
    }
    void NativeBoard.present(frame).catch(failToWebCanvas);
  }

  function drawFrame() {
    if (nativeReadyRef.current) {
      drawNativeFrame();
      return;
    }
    if (workerEnabledRef.current && workerRef.current) {
      workerRef.current.postMessage({
        type: "render",
        payload: {
          grid,
          width: widthPx,
          height: heightPx,
          zoom,
          pan,
          ratio: renderRatio,
          gridColor,
          gridStep,
          pattern: profileConfig.backgroundPattern,
          mode,
          eraserWidth,
          isDarkBg,
          lowPowerMode,
          strokes: strokesRef.current,
          linePreview: linePreviewRef.current,
          eraserPreview: eraserPreviewRef.current,
        },
      });
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rendered = linePreviewRef.current ? [...strokesRef.current, linePreviewRef.current] : strokesRef.current;
    const shouldRenderGrid = grid;
    drawStrokes(ctx, rendered, {
      grid: shouldRenderGrid,
      width: widthPx,
      height: heightPx,
      zoom,
      pan,
      ratio: renderRatio,
      gridColor,
      gridStep,
      pattern: profileConfig.backgroundPattern,
    });
    const eraserPreview = eraserPreviewRef.current;
    if (!lowPowerMode && mode === "erase" && eraserPreview) {
      const ratio = renderRatio;
      ctx.save();
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.translate(pan.x, pan.y);
      ctx.scale(zoom, zoom);
      ctx.globalCompositeOperation = "source-over";
      ctx.setLineDash([6 / zoom, 4 / zoom]);
      ctx.strokeStyle = isDarkBg ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.6)";
      ctx.lineWidth = 1 / zoom;
      ctx.beginPath();
      ctx.arc(eraserPreview.x, eraserPreview.y, eraserWidth / 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawFrameRef.current = drawFrame;

  function scheduleRender() {
    if (pendingRenderRef.current) return;
    pendingRenderRef.current = true;
    rafRef.current = requestAnimationFrame((ts) => {
      if (ts - lastRenderTsRef.current < renderMinDeltaMs) {
        rafRef.current = requestAnimationFrame((nextTs) => {
          lastRenderTsRef.current = nextTs;
          pendingRenderRef.current = false;
          rafRef.current = null;
          drawFrameRef.current();
        });
        return;
      }
      lastRenderTsRef.current = ts;
      pendingRenderRef.current = false;
      rafRef.current = null;
      drawFrameRef.current();
    });
  }

  function forceCanvasRedraw() {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    pendingRenderRef.current = false;
    lastRenderTsRef.current = 0;
    drawFrameRef.current();
  }

  const drawIncrementalSegment = (stroke: Stroke, segment: { x: number; y: number }[]) => {
    if (segment.length < 2) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const ratio = renderRatio;
    ctx.save();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.translate(panRef.current.x, panRef.current.y);
    ctx.scale(zoomRef.current, zoomRef.current);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = stroke.width;
    ctx.strokeStyle = stroke.color;
    ctx.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over";
    ctx.beginPath();
    ctx.moveTo(segment[0].x, segment[0].y);
    for (let i = 1; i < segment.length; i += 1) {
      const p = segment[i];
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();
  };

  const [geometryTool, setGeometryTool] = useState<GeometryTool | null>(null);
  const geometryToolRef = useRef<GeometryTool | null>(null);
  geometryToolRef.current = geometryTool;
  // Set at touch-down: a stroke started against a ruler edge or the compass pencil follows it.
  const strokeConstraintRef = useRef<StrokeConstraint | null>(null);

  // The toolbar button wears the last tool picked, and brings that one back.
  const [geometryKind, setGeometryKind] = useState<GeometryTool["kind"]>("ruler");
  const toggleGeometryTool = (kind: GeometryTool["kind"]) => {
    setGeometryKind(kind);
    if (geometryTool?.kind === kind) {
      setGeometryTool(null);
      return;
    }
    const center = { x: (widthPx / 2 - panRef.current.x) / zoomRef.current, y: (heightPx / 2 - panRef.current.y) / zoomRef.current };
    setGeometryTool(createGeometryTool(kind, center));
  };

  // Holding the pen still mid-stroke snaps it to a clean shape before it is lifted.
  const shapeHoldRef = useRef<{ stroke: Stroke; anchor: { x: number; y: number }; timer: number; snapped: boolean } | null>(null);

  const armShapeHold = (stroke: Stroke, point: { x: number; y: number }) => {
    const hold = shapeHoldRef.current;
    if (hold?.stroke === stroke && (hold.snapped ||
      Math.hypot(point.x - hold.anchor.x, point.y - hold.anchor.y) < SHAPE_HOLD_TOLERANCE)) return;
    if (hold) window.clearTimeout(hold.timer);
    const timer = window.setTimeout(() => {
      const current = shapeHoldRef.current;
      if (!current || current.stroke !== stroke || activePointerIdRef.current === null) return;
      const shape = recognizeShape(stroke.points);
      if (!shape) return;
      stroke.points = shape.points;
      current.snapped = true;
      scheduleRender();
    }, SHAPE_HOLD_MS);
    shapeHoldRef.current = { stroke, anchor: point, timer, snapped: false };
  };

  const startStroke = (x: number, y: number) => {
    const isHighlighter = humanitiesPreset === "highlight";
    const w = mode === "erase" ? eraserWidth : isHighlighter ? 14 : width;
    const constraint = mode === "erase" ? null : constraintForStroke(geometryToolRef.current, { x, y });
    strokeConstraintRef.current = constraint;
    const start = constraint ? applyConstraint(constraint, { x, y }) : { x, y };
    const stroke: Stroke = {
      points: [start],
      color: isHighlighter ? "#F6D365A6" : color,
      width: w,
      mode: mode === "erase" ? "erase" : "draw",
    };
    strokesRef.current.push(stroke);
    if (stroke.mode === "draw" && !constraint) armShapeHold(stroke, { x, y });
    scheduleRender();
  };

  const addPoints = (points: { x: number; y: number }[]) => {
    const last = strokesRef.current[strokesRef.current.length - 1];
    if (!last) return;
    if (shapeHoldRef.current?.stroke === last && shapeHoldRef.current.snapped) return;
    const constraint = strokeConstraintRef.current;
    const startPoint = last.points[last.points.length - 1];
    if (constraint) {
      let from = startPoint ?? null;
      points = points.flatMap((point) => {
        const added = constrainedPoints(constraint, from, point);
        if (added.length) from = added[added.length - 1];
        return added;
      });
    }
    let prev = startPoint;
    const appended: { x: number; y: number }[] = [];
    for (const point of points) {
      if (last.points.length >= maxPointsPerStroke) break;
      const dx = point.x - prev.x;
      const dy = point.y - prev.y;
      if (dx * dx + dy * dy < minPointDistanceSq) continue;
      last.points.push(point);
      appended.push(point);
      prev = point;
    }
    if (!appended.length) return;
    if (last.mode === "draw" && !constraint) armShapeHold(last, appended[appended.length - 1]);
    if (!workerEnabledRef.current && mode !== "line" && mode !== "pan") {
      drawIncrementalSegment(last, [startPoint, ...appended]);
      return;
    }
    scheduleRender();
  };

  rawPointerHandlerRef.current = (event: PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas || activePointerIdRef.current !== event.pointerId) return;
    if (touchPanRef.current.active || (mode !== "draw" && mode !== "erase")) return;
    if (!shouldHandlePointerType(event.pointerType)) return;
    if (event.cancelable) event.preventDefault();
    const points = extractNativePoints(event, canvas);
    if (points.length) addPoints(points);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const supported =
      !!canvas &&
      isNativeApp() &&
      typeof window !== "undefined" &&
      "onpointerrawupdate" in window;
    rawPointerSupportedRef.current = supported;
    if (!canvas || !supported) return;

    const listener = (event: Event) => rawPointerHandlerRef.current(event as PointerEvent);
    canvas.addEventListener("pointerrawupdate", listener, { passive: false });
    return () => {
      rawPointerSupportedRef.current = false;
      canvas.removeEventListener("pointerrawupdate", listener);
    };
  }, []);

  const shouldHandlePointerType = (pointerType: string) => {
    if (inputMode === "auto") return true;
    if (inputMode === "mouse") return pointerType === "mouse";
    return pointerType === "pen" || pointerType === "touch";
  };

  const shouldHandlePointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    return shouldHandlePointerType(e.pointerType);
  };

  const handleCanvasWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (boardLock || (!e.ctrlKey && !e.metaKey)) return;

    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const anchor = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
    const currentZoom = zoomRef.current;
    const currentPan = panRef.current;
    const nextZoom = clampZoom(currentZoom * Math.exp(-e.deltaY * 0.008));
    if (Math.abs(nextZoom - currentZoom) < 0.0001) return;

    const worldX = (anchor.x - currentPan.x) / currentZoom;
    const worldY = (anchor.y - currentPan.y) / currentZoom;
    const nextPan = clampPan({
      x: anchor.x - worldX * nextZoom,
      y: anchor.y - worldY * nextZoom,
    });

    zoomRef.current = nextZoom;
    panRef.current = nextPan;
    setZoom(nextZoom);
    setPan(nextPan);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    type SafariGestureEvent = Event & {
      scale?: number;
      clientX?: number;
      clientY?: number;
    };

    const handleGestureStart = (event: Event) => {
      if (boardLockRef.current) return;
      const gesture = event as SafariGestureEvent;
      event.preventDefault();
      event.stopPropagation();
      const rect = canvas.getBoundingClientRect();
      const clientX = Number.isFinite(gesture.clientX) ? Number(gesture.clientX) : rect.left + rect.width / 2;
      const clientY = Number.isFinite(gesture.clientY) ? Number(gesture.clientY) : rect.top + rect.height / 2;
      safariPinchRef.current = {
        startZoom: zoomRef.current,
        startPan: { ...panRef.current },
        anchor: { x: clientX - rect.left, y: clientY - rect.top },
      };
    };

    const handleGestureChange = (event: Event) => {
      const active = safariPinchRef.current;
      if (!active || boardLockRef.current) return;
      const gesture = event as SafariGestureEvent;
      const scale = Number(gesture.scale);
      if (!Number.isFinite(scale) || scale <= 0) return;
      event.preventDefault();
      event.stopPropagation();

      const nextZoom = clampZoom(active.startZoom * scale);
      const worldX = (active.anchor.x - active.startPan.x) / active.startZoom;
      const worldY = (active.anchor.y - active.startPan.y) / active.startZoom;
      const nextPan = clampPan({
        x: active.anchor.x - worldX * nextZoom,
        y: active.anchor.y - worldY * nextZoom,
      });

      zoomRef.current = nextZoom;
      panRef.current = nextPan;
      setZoom(nextZoom);
      setPan(nextPan);
    };

    const handleGestureEnd = (event: Event) => {
      if (!safariPinchRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      safariPinchRef.current = null;
    };

    canvas.addEventListener("gesturestart", handleGestureStart, { passive: false });
    canvas.addEventListener("gesturechange", handleGestureChange, { passive: false });
    canvas.addEventListener("gestureend", handleGestureEnd, { passive: false });
    return () => {
      canvas.removeEventListener("gesturestart", handleGestureStart);
      canvas.removeEventListener("gesturechange", handleGestureChange);
      canvas.removeEventListener("gestureend", handleGestureEnd);
    };
  }, []);

  const extractNativePoints = (native: PointerEvent, target: HTMLCanvasElement) => {
    const rect = canvasRectRef.current ?? target.getBoundingClientRect();
    const rawEvents =
      typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [native];
    const coalesced =
      rawEvents && rawEvents.length
        ? (lowPowerMode && rawEvents.length > 12 ? rawEvents.slice(-12) : rawEvents)
        : [native];
    const scale = zoomRef.current || 1;
    const panNow = panRef.current;
    return coalesced.map((evt) => ({
      x: (evt.clientX - rect.left - panNow.x) / scale,
      y: (evt.clientY - rect.top - panNow.y) / scale,
    }));
  };

  const extractPoints = (e: React.PointerEvent<HTMLCanvasElement>) =>
    extractNativePoints(e.nativeEvent as PointerEvent, e.currentTarget);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!shouldHandlePointer(e)) return;
    canvasRectRef.current = e.currentTarget.getBoundingClientRect();
    e.preventDefault();
    setShowPenPalette(false);
    setShowAllPens(false);
    setShowPenSlider(false);
    setShowEraserSlider(false);
    setShowGeometryMenu(false);
    setShowClearConfirm(false);
    setShowBoardSettings(false);
    setShowAllBg(false);
    if (penTimerRef.current) window.clearTimeout(penTimerRef.current);
    if (eraserTimerRef.current) window.clearTimeout(eraserTimerRef.current);
    if (lineTimerRef.current) window.clearTimeout(lineTimerRef.current);
    if (e.pointerType === "touch") {
      touchPointsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!boardLock && touchPointsRef.current.size >= 2) {
        const points = Array.from(touchPointsRef.current.values());
        const center = {
          x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
          y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
        };
        const dist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        touchPanRef.current.active = true;
        touchPanRef.current.lastCenter = center;
        pinchRef.current = { active: true, startDist: dist };
        activePointerIdRef.current = null;
        lineStartRef.current = null;
        linePreviewRef.current = null;
        if (mode === "lasso") {
          if (lassoMoveRef.current) finishLassoMove();
          lassoPathRef.current = [];
          setLassoPath([]);
        }
        scheduleRender();
        return;
      }
    }
    if (mode !== "pan") {
      onStartTimer();
    }
    activePointerIdRef.current = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore capture errors on some devices
    }
    if (mode === "pan") {
      panStartRef.current = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        panX: panRef.current.x,
        panY: panRef.current.y,
      };
      return;
    }
    const firstPoint = extractPoints(e)[0];
    const x = firstPoint.x;
    const y = firstPoint.y;
    if (mode === "lasso") {
      setSelectedGraphId(null);
      const hasSelection = lassoSelection.strokeIndices.length > 0 || lassoSelection.graphIds.length > 0;
      if (hasSelection && lassoSelection.bounds && pointInsideBounds(firstPoint, lassoSelection.bounds)) {
        startLassoMove(e.pointerId, firstPoint, lassoSelection.bounds);
      } else {
        setLassoSelection({ strokeIndices: [], graphIds: [], bounds: null });
        lassoPathRef.current = [firstPoint];
        setLassoPath([firstPoint]);
      }
      return;
    }
    if (mode === "graph") {
      createGraphAt(x, y);
      setMode("draw");
      activePointerIdRef.current = null;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      return;
    }
    if (mode === "line") {
      lineStartRef.current = { x, y };
      linePreviewRef.current = { points: [{ x, y }, { x, y }], color, width: humanitiesPreset === "underline" ? 3 : width, mode: "draw" };
      scheduleRender();
      return;
    }
    if (!lowPowerMode && mode === "erase" && e.pointerType !== "touch") {
      eraserPreviewRef.current = { x, y };
      scheduleRender();
    }
    if (!lowPowerMode && mode === "erase" && e.pointerType === "touch") {
      eraserPreviewRef.current = { x, y };
      scheduleRender();
    }
    startStroke(x, y);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!shouldHandlePointer(e)) return;
    if (!lowPowerMode && mode === "erase") {
      const hover = extractPoints(e)[0];
      if (hover) {
        eraserPreviewRef.current = hover;
        scheduleRender();
      }
    }
    if (e.pointerType === "touch" && touchPointsRef.current.has(e.pointerId)) {
      touchPointsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!boardLock && touchPanRef.current.active && touchPointsRef.current.size >= 2) {
        e.preventDefault();
        if (!lowPowerMode && mode === "erase") {
          eraserPreviewRef.current = null;
          scheduleRender();
        }
        const points = Array.from(touchPointsRef.current.values());
        const center = {
          x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
          y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
        };
        const last = touchPanRef.current.lastCenter;
        let nextPan = panRef.current;
        if (last) {
          nextPan = {
            x: panRef.current.x + (center.x - last.x),
            y: panRef.current.y + (center.y - last.y),
          };
        }
        const dist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        let nextZoom = zoom;
        if (pinchRef.current.active && pinchRef.current.startDist > 0) {
          const ratio = dist / pinchRef.current.startDist;
          nextZoom = clampZoom(zoom * ratio);
          const worldX = (center.x - nextPan.x) / zoom;
          const worldY = (center.y - nextPan.y) / zoom;
          nextPan = {
            x: center.x - worldX * nextZoom,
            y: center.y - worldY * nextZoom,
          };
        }
        setZoom(nextZoom);
        setPan(clampPan(nextPan));
        touchPanRef.current.lastCenter = center;
        pinchRef.current.startDist = dist;
        return;
      }
    }
    if (mode === "lasso" && activePointerIdRef.current === e.pointerId) {
      e.preventDefault();
      const points = extractPoints(e);
      if (!points.length) return;
      if (lassoMoveRef.current) {
        updateLassoMove(points[points.length - 1]);
        return;
      }

      const path = [...lassoPathRef.current];
      for (const point of points) {
        const previous = path[path.length - 1];
        if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 2 / Math.max(zoomRef.current, 0.5)) {
          path.push(point);
        }
      }
      lassoPathRef.current = path;
      setLassoPath(path);
      return;
    }
    if (panStartRef.current && panStartRef.current.id === e.pointerId) {
      e.preventDefault();
      const next = clampPan({
        x: panStartRef.current.panX + (e.clientX - panStartRef.current.x),
        y: panStartRef.current.panY + (e.clientY - panStartRef.current.y),
      });
      setPan(next);
      return;
    }
    if (activePointerIdRef.current !== e.pointerId) return;
    e.preventDefault();
    if (rawPointerSupportedRef.current && (mode === "draw" || mode === "erase")) {
      return;
    }
    const points = extractPoints(e);
    if (!points.length) return;
    const last = points[points.length - 1];
    if (mode === "line" && lineStartRef.current) {
      linePreviewRef.current = { points: [lineStartRef.current, { x: last.x, y: last.y }], color, width: humanitiesPreset === "underline" ? 3 : width, mode: "draw" };
      scheduleRender();
      return;
    }
    addPoints(points);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!shouldHandlePointer(e)) return;
    canvasRectRef.current = null;
    if (e.pointerType === "touch") {
      touchPointsRef.current.delete(e.pointerId);
      if (touchPointsRef.current.size < 2) {
        touchPanRef.current.active = false;
        touchPanRef.current.lastCenter = null;
        pinchRef.current = { active: false, startDist: 0 };
      }
      if (!lowPowerMode && mode === "erase" && touchPointsRef.current.size === 0) {
        eraserPreviewRef.current = null;
        scheduleRender();
      }
    }
    if (mode === "lasso" && activePointerIdRef.current === e.pointerId) {
      e.preventDefault();
      activePointerIdRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore release errors
      }
      if (lassoMoveRef.current) finishLassoMove();
      else finishLassoPath();
      return;
    }
    if (panStartRef.current && panStartRef.current.id === e.pointerId) {
      panStartRef.current = null;
      activePointerIdRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      return;
    }
    if (activePointerIdRef.current !== e.pointerId) return;
    e.preventDefault();
    activePointerIdRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore release errors
    }
    if (mode === "line" && lineStartRef.current && linePreviewRef.current) {
      strokesRef.current.push(linePreviewRef.current);
      onReplayOp?.({ op: "add", stroke: buildReplayStroke(linePreviewRef.current), ts: Date.now() });
      lineStartRef.current = null;
      linePreviewRef.current = null;
      syncStrokesToParent([...strokesRef.current]);
      scheduleRender();
    }
    if (mode !== "line" && mode !== "pan") {
      const last = strokesRef.current[strokesRef.current.length - 1];
      if (last) {
        onReplayOp?.({ op: "add", stroke: buildReplayStroke(last), ts: Date.now() });
      }
      syncStrokesToParent([...strokesRef.current]);
    }
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    canvasRectRef.current = null;
    if (e.pointerType === "touch") {
      touchPointsRef.current.delete(e.pointerId);
      if (touchPointsRef.current.size < 2) {
        touchPanRef.current.active = false;
        touchPanRef.current.lastCenter = null;
        pinchRef.current = { active: false, startDist: 0 };
      }
      if (!lowPowerMode && mode === "erase" && touchPointsRef.current.size === 0) {
        eraserPreviewRef.current = null;
        scheduleRender();
      }
    }
    if (mode === "lasso" && activePointerIdRef.current === e.pointerId) {
      activePointerIdRef.current = null;
      if (lassoMoveRef.current) finishLassoMove();
      else {
        lassoPathRef.current = [];
        setLassoPath([]);
      }
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      return;
    }
    if (panStartRef.current && panStartRef.current.id === e.pointerId) {
      panStartRef.current = null;
      activePointerIdRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
    if (activePointerIdRef.current !== e.pointerId) return;
    activePointerIdRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    lineStartRef.current = null;
    linePreviewRef.current = null;
    scheduleRender();
  };

  useLayoutEffect(() => {
    scheduleRender();
  }, [grid, widthPx, heightPx, zoom, pan, gridColor, mode, color, width, humanitiesPreset, inputMode, boardLock, eraserWidth, isDarkBg, bg, renderRatio, lowPowerMode, nativeBoardReady, geometryTool, images, graphs]);

  useEffect(() => {
    if (!isNativeApp() || !nativeBoardRequested()) return;
    let disposed = false;
    let healthyTimer: number | undefined;
    const handles: PluginListenerHandle[] = [];
    const setup = async () => {
      try {
        handles.push(await NativeBoard.addListener("strokeStarted", () => nativeStrokeStartedRef.current()));
        handles.push(await NativeBoard.addListener("strokeCommitted", (event) => nativeStrokeCommittedRef.current(event)));
        handles.push(await NativeBoard.addListener("viewportChanged", (event) => nativeViewportRef.current(event)));
        handles.push(await NativeBoard.addListener("strokeHold", (event) => nativeStrokeHoldRef.current(event)));
        handles.push(await NativeBoard.addListener("resyncNeeded", () => {
          nativeSyncedStrokesRef.current = null;
          scheduleRender();
        }));
        if (disposed) return;
        await NativeBoard.enable();
        if (disposed) {
          await NativeBoard.disable();
          return;
        }
        nativeSyncedStrokesRef.current = null;
        nativeReadyRef.current = true;
        document.body.classList.add("native-board-active");
        setNativeBoardReady(true);
        healthyTimer = window.setTimeout(() => {
          void NativeBoard.markHealthy().catch(() => undefined);
        }, NATIVE_HEALTHY_AFTER_MS);
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        const reason = code === "AUTO_DISABLED" ? "repeated-crash" : "enable-failed";
        disableNativeBoardAutomatically(reason);
        setNativeFallbackReason(reason);
        nativeReadyRef.current = false;
        document.body.classList.remove("native-board-active");
        setNativeBoardReady(false);
      }
    };
    void setup();
    return () => {
      disposed = true;
      // Leaving the board on purpose is not a crash, however soon it happens.
      window.clearTimeout(healthyTimer);
      void NativeBoard.markHealthy().catch(() => undefined);
      nativeReadyRef.current = false;
      document.body.classList.remove("native-board-active");
      handles.forEach((handle) => { void handle.remove(); });
      void NativeBoard.disable().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!nativeBoardReady) return;
    // React controls, graph edit handles and floating dialogs must remain clickable
    // above the ink view. Android receives their bounding rects, never JS touch events.
    const updateBlockers = () => {
      const boardRect = canvasRef.current?.getBoundingClientRect();
      if (!boardRect) return;
      const selector = [
        "button", "input", "textarea", "select", "[role=dialog]", "[aria-modal=true]",
        "[data-floating-panel]", "[data-graph-interactive=true]",
        "[data-radix-popper-content-wrapper]", "[data-testid=board-toolbar]",
        // Whole panels, not just their buttons: a tap between swatches or beside a slider is still UI.
        "[data-testid^=board-toolbar-popover]", "[data-testid=board-pager]", "[data-testid=native-fallback-notice]",
        // A picture raised over a graph hides ink, so writing is kept off it as it is off a graph.
        "[data-board-object]",
      ].join(",");
      // Anything positioned over the board that is not part of it (settings, menus, panels, dialogs,
      // whatever is added later) is UI: the ink layer must neither draw there nor take its touches.
      // The board's own layers live inside areaRef and are left to the rules above.
      const area = areaRef.current;
      const overlays = Array.from(document.querySelectorAll<HTMLElement>('[class*="absolute"], [class*="fixed"], body > *'))
        .filter((el) => {
          if (area && (area.contains(el) || el.contains(area))) return false;
          const position = getComputedStyle(el).position;
          return position === "absolute" || position === "fixed";
        });
      const rects: NativeRect[] = Array.from(new Set([...document.querySelectorAll<HTMLElement>(selector), ...overlays]))
        .filter((el) => {
          const style = getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden" &&
            style.pointerEvents !== "none" && Number(style.opacity) > 0.05;
        })
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0 &&
          r.left < boardRect.right && r.right > boardRect.left &&
          r.top < boardRect.bottom && r.bottom > boardRect.top)
        .map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height }));
      if (!toolbarVisible) {
        // Android takes every pen touch on the board, so the strip that summons the hidden
        // toolbar has to be handed back to the WebView or the toolbar can never return.
        rects.push({
          left: boardRect.left,
          top: boardRect.bottom - TOOLBAR_REVEAL_STRIP_PX,
          width: boardRect.width,
          height: TOOLBAR_REVEAL_STRIP_PX,
          // Nothing is drawn there, so live ink may still show through it.
          covers: false,
        });
      }
      void NativeBoard.setBlockers({ rects }).catch(() => undefined);
    };
    // A popover or dialog that has just opened must be clickable straight away, or Android takes
    // the tap as ink. DOM changes schedule a refresh for the next frame; the interval only catches
    // movement that changes no DOM, such as a CSS transition.
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        updateBlockers();
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "data-visible", "hidden"] });
    updateBlockers();
    const interval = window.setInterval(updateBlockers, 400);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.clearInterval(interval);
    };
  }, [nativeBoardReady, toolbarVisible]);

  useEffect(() => {
    scheduleRender();
  }, [nativeBoardReady]);

  // Android cannot fetch through the WebView's pinned connection, so pictures are downloaded here,
  // shrunk to a sane size and handed over once per source.
  const nativeImagesSentRef = useRef(new Set<string>());
  const [pendingNativeImages, setPendingNativeImages] = useState(0);
  useEffect(() => {
    if (!nativeBoardReady) {
      nativeImagesSentRef.current.clear();
      return;
    }
    for (const src of new Set(images.map((image) => image.src))) {
      if (nativeImagesSentRef.current.has(src)) continue;
      nativeImagesSentRef.current.add(src);
      setPendingNativeImages((count) => count + 1);
      void (async () => {
        try {
          const res = await apiFetch(src, { cache: "force-cache" });
          if (!res.ok) throw new Error(String(res.status));
          // The file's own bytes: re-encoding through a canvas cost seconds on a slow board.
          // Android decodes and downsamples it off its UI thread.
          const data = await blobToBase64(await res.blob());
          await NativeBoard.loadImage({ key: src, data, maxEdge: NATIVE_IMAGE_MAX_EDGE });
        } catch {
          nativeImagesSentRef.current.delete(src); // try again on the next change
        } finally {
          setPendingNativeImages((count) => Math.max(0, count - 1));
        }
      })();
    }
  }, [images, nativeBoardReady]);



  useEffect(() => {
    const redrawIfVisible = () => {
      if (document.visibilityState === "visible") forceCanvasRedraw();
    };
    const redraw = () => forceCanvasRedraw();
    document.addEventListener("visibilitychange", redrawIfVisible);
    window.addEventListener("pageshow", redraw);
    window.addEventListener("focus", redraw);
    return () => {
      document.removeEventListener("visibilitychange", redrawIfVisible);
      window.removeEventListener("pageshow", redraw);
      window.removeEventListener("focus", redraw);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      pendingRenderRef.current = false;
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      workerEnabledRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (aiStrokeAnimationActiveRef.current) return;
    strokesRef.current = [...initialStrokes];
    setShowClearConfirm(false);
    setClearSlideValue(0);
    scheduleRender();
  }, [initialStrokes]);

  useEffect(() => {
    graphsRef.current = initialGraphs;
    setGraphs(initialGraphs);
    if (selectedGraphId && !initialGraphs.some((graph) => graph.id === selectedGraphId)) {
      setSelectedGraphId(null);
    }
  }, [initialGraphs, selectedGraphId]);

  useEffect(() => {
    solutionsRef.current = initialSolutions;
    setSolutions(initialSolutions);
  }, [initialSolutions]);

  useEffect(() => {
    setColor(initialPenColor);
  }, [initialPenColor]);

  useEffect(() => {
    setBg(initialBgColor);
  }, [initialBgColor]);

  const syncSolutionsToParent = (next: AiSolutionBlock[]) => {
    solutionsRef.current = next;
    setSolutions(next);
    onChangeSolutions(next);
  };

  const commitSolutionUpdate = (before: AiSolutionBlock, after: AiSolutionBlock) => {
    if (before.id !== after.id) return;
    onReplayOp?.({ op: "solution_update", before, after, ts: Date.now() });
    syncSolutionsToParent(
      solutionsRef.current.map((solution) => solution.id === after.id ? after : solution)
    );
  };

  const deleteSolution = (solution: AiSolutionBlock) => {
    onReplayOp?.({ op: "solution_delete", solution, ts: Date.now() });
    syncSolutionsToParent(solutionsRef.current.filter((item) => item.id !== solution.id));
  };

  const occupiedBoardRects = (): BoardRect[] => {
    const rects: BoardRect[] = [];
    for (const graph of graphsRef.current) {
      rects.push({
        left: graph.x,
        top: graph.y,
        right: graph.x + graph.width,
        bottom: graph.y + graph.height,
      });
    }
    for (const solution of solutionsRef.current) {
      const estimatedHeight = Math.max(
        solution.minHeight,
        96 + solution.steps.reduce((sum, step) => sum + Math.max(34, Math.ceil(step.text.length / 46) * 24), 0),
      );
      rects.push({
        left: solution.x,
        top: solution.y,
        right: solution.x + solution.width,
        bottom: solution.y + estimatedHeight,
      });
    }
    for (const stroke of strokesRef.current) {
      if (!stroke.points.length) continue;
      let left = Number.POSITIVE_INFINITY;
      let top = Number.POSITIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      let bottom = Number.NEGATIVE_INFINITY;
      const half = Math.max(3, stroke.width / 2);
      for (const point of stroke.points) {
        left = Math.min(left, point.x - half);
        top = Math.min(top, point.y - half);
        right = Math.max(right, point.x + half);
        bottom = Math.max(bottom, point.y + half);
      }
      if ([left, top, right, bottom].every(Number.isFinite)) rects.push({ left, top, right, bottom });
    }
    return rects;
  };

  const allocateSolutionPlacement = (
    requestedWidth = 500,
    requestedHeight = 320,
    targetIndex?: number,
  ) => {
    const scale = Math.max(zoomRef.current, 0.01);
    const currentPan = panRef.current;
    const viewport: BoardRect = {
      left: -currentPan.x / scale,
      top: -currentPan.y / scale,
      right: (widthPx - currentPan.x) / scale,
      bottom: (heightPx - currentPan.y) / scale,
    };
    const occupied = occupiedBoardRects();
    const targetBounds =
      targetIndex !== undefined
        ? (lastOcrTaskBoundsRef.current[targetIndex] ?? lastOcrTargetBoundsRef.current)
        : lastOcrTargetBoundsRef.current;
    const nearTarget = targetBounds
      ? findFreeBoardSpaceNearTarget(
          viewport,
          occupied,
          targetBounds,
          requestedWidth,
          requestedHeight,
          38,
          16,
        )
      : null;
    const placement = nearTarget ?? findFreeBoardSpace(
      viewport,
      occupied,
      requestedWidth,
      requestedHeight,
      24,
    );
    if (!placement.insideViewport) {
      const targetScreenX = widthPx / 2 - (placement.x + placement.width / 2) * scale;
      const targetScreenY = heightPx / 2 - (placement.y + placement.height / 2) * scale;
      const nextPan = clampPan({ x: targetScreenX, y: targetScreenY });
      panRef.current = nextPan;
      setPan(nextPan);
      scheduleRender();
    }
    return {
      x: placement.x,
      y: placement.y,
      width: placement.width,
      minHeight: placement.height,
    };
  };

  const animateAiStrokes = async (
    incoming: Stroke[],
    shouldCancel?: () => boolean,
    lowMotion = false,
  ) => {
    const sources = incoming.filter((stroke) => stroke.points.length >= 2);
    if (!sources.length) return [] as Stroke[];

    const cloneStroke = (stroke: Stroke): Stroke => ({
      ...stroke,
      points: stroke.points.map((point) => ({ ...point })),
    });

    if (lowMotion) {
      const committed = sources.map(cloneStroke);
      strokesRef.current.push(...committed.map(cloneStroke));
      scheduleRender();
      return committed;
    }

    const densify = (points: Stroke["points"], maxSegment = 4.5) => {
      const result: Stroke["points"] = [{ ...points[0] }];
      for (let index = 1; index < points.length; index += 1) {
        const start = points[index - 1];
        const end = points[index];
        const distance = Math.hypot(end.x - start.x, end.y - start.y);
        const segments = Math.max(1, Math.ceil(distance / maxSegment));
        for (let part = 1; part <= segments; part += 1) {
          const ratio = part / segments;
          result.push({
            x: start.x + (end.x - start.x) * ratio,
            y: start.y + (end.y - start.y) * ratio,
          });
        }
      }
      return result;
    };

    const paths = sources.map((source) => ({
      source,
      points: densify(source.points),
    }));
    const totalUnits = paths.reduce(
      (sum, path) => sum + Math.max(1, path.points.length - 1),
      0,
    );
    // Keep the visible writing gesture, but cap long solutions so they do not
    // take tens of seconds. Typical school solutions finish in ~2-4.5 seconds.
    const targetDurationMs = Math.min(3200, Math.max(1200, sources.length * 3.2));
    const targetFrames = Math.max(1, Math.round(targetDurationMs / 16.67));
    const unitsPerFrame = Math.max(1, Math.ceil(totalUnits / targetFrames));

    const committed: Stroke[] = [];
    let pathIndex = 0;
    let pointIndex = 1;
    // Assigned inside the animation callbacks, which TypeScript's narrowing cannot see.
    let preview = null as Stroke | null;
    aiStrokeAnimationActiveRef.current = true;

    try {
      await new Promise<void>((resolve) => {
        const frame = () => {
          if (shouldCancel?.()) {
            resolve();
            return;
          }

          // If the tab gets backgrounded, finish immediately instead of letting
          // browser timer throttling leave a half-written solution.
          let budget = document.hidden ? totalUnits : unitsPerFrame;

          while (budget > 0 && pathIndex < paths.length) {
            const current = paths[pathIndex];
            if (!preview) {
              preview = {
                ...current.source,
                points: [{ ...current.points[0] }],
              };
              strokesRef.current.push(preview);
              pointIndex = 1;
            }

            const remaining = current.points.length - pointIndex;
            const take = Math.max(0, Math.min(remaining, budget));
            if (take > 0) {
              preview.points.push(
                ...current.points
                  .slice(pointIndex, pointIndex + take)
                  .map((point) => ({ ...point })),
              );
              pointIndex += take;
              budget -= take;
            }

            if (pointIndex >= current.points.length) {
              preview.points = current.source.points.map((point) => ({ ...point }));
              committed.push(cloneStroke(current.source));
              preview = null;
              pathIndex += 1;
              pointIndex = 1;
              // A pen lift still exists visually because the next path begins
              // in sequence, but we no longer wait a timer for every tiny glyph.
            } else if (take === 0) {
              break;
            }
          }

          scheduleRender();

          if (pathIndex >= paths.length || shouldCancel?.()) {
            resolve();
            return;
          }
          window.requestAnimationFrame(frame);
        };

        window.requestAnimationFrame(frame);
      });

      if (shouldCancel?.() && preview && preview.points.length >= 2) {
        // Never leave a transient preview stroke in a shape that cannot be
        // represented by the persisted command.
        const current = paths[Math.min(pathIndex, paths.length - 1)];
        if (current) {
          preview.points = current.source.points.map((point) => ({ ...point }));
          committed.push(cloneStroke(current.source));
        }
      }
      scheduleRender();
      return committed;
    } finally {
      aiStrokeAnimationActiveRef.current = false;
    }
  };

  const handleUndo = () => {
    if (!canUndo) return;
    onReplayOp?.({ op: "undo", ts: Date.now() });
  };

  const handleRedo = () => {
    if (!canRedo) return;
    onReplayOp?.({ op: "redo", ts: Date.now() });
  };

  const handleClear = () => {
    if (strokesRef.current.length === 0 && graphsRef.current.length === 0 && solutionsRef.current.length === 0 &&
      imagesRef.current.length === 0) return;
    onReplayOp?.({ op: "clear", ts: Date.now() });
    strokesRef.current = [];
    syncGraphsToParent([]);
    syncSolutionsToParent([]);
    setSelectedGraphId(null);
    scheduleRender();
    syncStrokesToParent([]);
  };

  const handleSnapshot = async () => {
    const board = areaRef.current;
    if (!board) return;
    const webCanvas = canvasRef.current;
    // html2canvas cannot capture an Android View behind the WebView. Repaint the
    // existing web canvas only for export, then return to the native fast path.
    if (nativeReadyRef.current && webCanvas) {
      const ctx = webCanvas.getContext("2d");
      if (ctx) drawStrokes(ctx, strokesRef.current, {
        grid, width: widthPx, height: heightPx, zoom, pan,
        ratio: renderRatio, gridColor, gridStep, pattern: profileConfig.backgroundPattern,
      });
      webCanvas.style.opacity = "1";
    }
    try {
      const { default: html2canvas } = await import("html2canvas");
      const snapshot = await html2canvas(board, {
        backgroundColor: bg,
        scale: Math.min(window.devicePixelRatio || 1, 2),
        useCORS: true,
        logging: false,
      });
      const url = snapshot.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = "board.png";
      a.click();
    } finally {
      if (nativeReadyRef.current && webCanvas) webCanvas.style.opacity = "0";
    }
  };

  const renderOcrBlob = (inputStrokes?: Stroke[]): Promise<Blob | null> => {
    const canvas = canvasRef.current;
    if (!canvas) return Promise.resolve(null);
    const source = inputStrokes ?? strokesRef.current;
    const drawStrokesOnly = source.filter(
      (stroke) =>
        stroke.mode === "draw" &&
        stroke.points.length > 0 &&
        stroke.source !== "ai",
    );
    if (!drawStrokesOnly.length) return Promise.resolve(null);

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const stroke of drawStrokesOnly) {
      const half = Math.max(1, stroke.width / 2);
      for (const p of stroke.points) {
        if (p.x - half < minX) minX = p.x - half;
        if (p.y - half < minY) minY = p.y - half;
        if (p.x + half > maxX) maxX = p.x + half;
        if (p.y + half > maxY) maxY = p.y + half;
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob), "image/png");
      });
    }

    const padding = 40;
    const contentWidth = Math.max(1, Math.ceil(maxX - minX + padding * 2));
    const contentHeight = Math.max(1, Math.ceil(maxY - minY + padding * 2));
    const maxEdge = 4096;
    const scale = Math.min(2.2, maxEdge / Math.max(contentWidth, contentHeight));
    const outWidth = Math.max(1, Math.round(contentWidth * scale));
    const outHeight = Math.max(1, Math.round(contentHeight * scale));

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = outWidth;
    exportCanvas.height = outHeight;
    const ctx = exportCanvas.getContext("2d");
    if (!ctx) return Promise.resolve(null);

    const normalizedStrokes = drawStrokesOnly.map((stroke) => ({
      ...stroke,
      color: "#111111",
      width: Math.max(2.4, stroke.width * 1.2),
    }));

    drawStrokes(ctx, normalizedStrokes, {
      grid: false,
      width: outWidth,
      height: outHeight,
      zoom: scale,
      pan: {
        x: (-minX + padding) * scale,
        y: (-minY + padding) * scale,
      },
      ratio: 1,
    });

    ctx.save();
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outWidth, outHeight);
    ctx.restore();

    return new Promise((resolve) => {
      exportCanvas.toBlob((blob) => resolve(blob), "image/png");
    });
  };

  const handleOcr = async (
    options?: { multipleTasks?: boolean; onProgress?: (update: ProgressUpdate) => void },
  ): Promise<string> => {
    const graphLines = graphsRef.current.flatMap((graph) =>
      graph.expressions
        .filter((expression) => expression.visible && expression.expression.trim())
        .map((expression) => `График: y = ${expression.expression.trim()}`)
    );

    const selectedIndices = lassoSelection.strokeIndices.length
      ? lassoSelection.strokeIndices
      : undefined;
    // Without a lasso selection "the board" means the page in view, not every page of the lesson.
    const pageStrokes = selectedIndices
      ? strokesRef.current
      : strokesOnPage(strokesRef.current, pageInView(panRef.current, zoomRef.current, heightPx));
    const ocrSourceStrokes =
      !selectedIndices && options?.multipleTasks
        ? recentUserOcrStrokes(pageStrokes)
        : pageStrokes;
    const clusters = clusterOcrStrokes(ocrSourceStrokes, selectedIndices);
    const targetClusters = selectedIndices
      ? (clusters[0] ? [clusters[0]] : [])
      : options?.multipleTasks
        ? chooseOcrTaskClusters(clusters)
        : (() => {
            const active = chooseActiveOcrCluster(clusters);
            return active ? [active] : [];
          })();

    lastOcrTaskBoundsRef.current = targetClusters.map((cluster) => cluster.bounds);
    lastOcrTargetBoundsRef.current = targetClusters.length
      ? unionRects(lastOcrTaskBoundsRef.current)
      : null;

    if (targetClusters.length) {
      const colorWeights = new Map<string, number>();
      for (const stroke of targetClusters.flatMap((cluster) => cluster.strokes)) {
        let length = 0;
        for (let index = 1; index < stroke.points.length; index += 1) {
          const previous = stroke.points[index - 1];
          const current = stroke.points[index];
          length += Math.hypot(current.x - previous.x, current.y - previous.y);
        }
        colorWeights.set(stroke.color, (colorWeights.get(stroke.color) ?? 0) + Math.max(1, length));
      }
      lastOcrTargetColorRef.current =
        [...colorWeights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    } else {
      lastOcrTargetColorRef.current = null;
    }

    if (!targetClusters.length && graphLines.length > 0) {
      const text = composeOcrText("", graphLines, false);
      onOcrText?.(text);
      return text;
    }
    if (!targetClusters.length) throw new Error(tl("ocr_not_available"));
    if (!ocrEnabled) throw new Error(tl("ocr_not_available"));

    setLoading(true);
    try {
      const recognized: string[] = [];
      for (const [clusterIndex, cluster] of targetClusters.entries()) {
        const blob = await renderOcrBlob(cluster.strokes);
        if (!blob) throw new Error(tl("ocr_not_available"));
        const res = await callOcr(blob, (update) => {
          const totalClusters = Math.max(1, targetClusters.length);
          const overall = Math.round(((clusterIndex + update.progress / 100) / totalClusters) * 100);
          options?.onProgress?.({
            ...update,
            progress: overall,
            completed: clusterIndex,
            total: totalClusters,
          });
        });
        const value = res.text.trim();
        if (!value) continue;
        recognized.push(value);
      }

      options?.onProgress?.({ progress: 98, stage: "composing", completed: targetClusters.length, total: targetClusters.length });
      const taskTexts = sanitizeMultiTaskOcrTexts(recognized);

      const text = taskTexts.length > 1
        ? taskTexts
            .map((value, index) => `Задание ${index + 1}:\n${value}`)
            .join("\n\n")
        : composeOcrText(taskTexts[0] ?? "", graphLines, true);

      if (!text) throw new Error(tl("ocr_not_available"));
      options?.onProgress?.({ progress: 100, stage: "done", completed: targetClusters.length, total: targetClusters.length });
      onOcrText?.(text);
      return text;
    } catch (error) {
      const message = error instanceof Error ? error.message : tl("ocr_not_available");
      onOcrText?.(message);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setLoading(false);
    }
  };

  useImperativeHandle(ref, () => ({
    recognize: handleOcr,
    getLastOcrTargetColor: () => lastOcrTargetColorRef.current,
    allocateSolutionPlacement,
    animateAiStrokes,
  }));

  const schedulePenHide = () => {
    if (penTimerRef.current) window.clearTimeout(penTimerRef.current);
    penTimerRef.current = window.setTimeout(() => {
      setShowPenSlider(false);
      setShowPenPalette(false);
      setShowAllPens(false);
    }, 5000);
  };

  const scheduleEraserHide = () => {
    if (eraserTimerRef.current) window.clearTimeout(eraserTimerRef.current);
    eraserTimerRef.current = window.setTimeout(() => setShowEraserSlider(false), 5000);
  };

  const scheduleGeometryHide = () => {
    if (lineTimerRef.current) window.clearTimeout(lineTimerRef.current);
    lineTimerRef.current = window.setTimeout(() => setShowGeometryMenu(false), 5000);
  };

  const closeBoardSettings = () => {
    setShowBoardSettings(false);
    setShowAllBg(false);
  };

  return (
    <div
      data-testid="board-canvas-root"
      className="board-canvas-root relative flex h-full flex-col pb-0"
      onPointerMoveCapture={revealToolbarNearBottom}
      onPointerDownCapture={revealToolbarNearBottom}
    >
      <div
        data-testid="board-pager"
        className="glass absolute right-3 top-3 z-30 flex items-center gap-1 rounded-xl p-1 text-sm shadow-soft"
      >
        <Button size="sm" variant="ghost" disabled={currentPage === 0} aria-label={tl("previous_page")} title={tl("previous_page")} onClick={() => goToPage(currentPage - 1)}>
          <ChevronLeft size={18} />
        </Button>
        <span data-testid="board-page-label" className="min-w-[3.5rem] text-center tabular-nums text-frost/80">
          {currentPage + 1} / {totalPages}
        </span>
        <Button size="sm" variant="ghost" disabled={currentPage >= totalPages - 1} aria-label={tl("next_page")} title={tl("next_page")} onClick={() => goToPage(currentPage + 1)}>
          <ChevronRight size={18} />
        </Button>
        <Button size="sm" variant="ghost" aria-label={tl("new_page")} title={tl("new_page")} onClick={() => goToPage(totalPages)}>
          <Plus size={18} />
        </Button>
      </div>
      {(contentLoading || pendingNativeImages > 0) && (
        <div role="status" data-testid="board-loading"
          className="glass pointer-events-none absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-sm text-frost/80 shadow-soft">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-frost/25 border-t-[rgb(var(--color-accent))]" />
          {contentLoading ? tl("board_loading") : tl("board_loading_images")}
        </div>
      )}
      {showInsertImage && <InsertImageDialog onInsert={insertImage} onClose={() => setShowInsertImage(false)} />}
      {nativeFallbackReason && !nativeFallbackDismissed && (
        <div
          role="status"
          data-testid="native-fallback-notice"
          data-reason={nativeFallbackReason}
          className="glass absolute left-1/2 top-3 z-50 flex w-[min(720px,calc(100%-24px))] -translate-x-1/2 items-center gap-3 rounded-2xl px-4 py-2 text-sm shadow-soft"
        >
          <span className="min-w-0 flex-1">{tl("native_fallback_notice")}</span>
          <Button size="sm" variant="outline" onClick={() => switchRenderer(true)}>
            {tl("native_fallback_retry")}
          </Button>
          <Button size="sm" variant="ghost" aria-label={tl("close")} title={tl("close")} onClick={() => setNativeFallbackDismissed(true)}>
            <X size={16} />
          </Button>
        </div>
      )}
      <div ref={areaRef} className="relative flex-1 min-h-0 overflow-hidden">
        <div className="absolute inset-0">
          <div
            className="absolute inset-0 rounded-2xl border border-white/10 overflow-hidden"
            style={{ backgroundColor: nativeBoardReady ? "transparent" : bg }}
          >
            {/* Android draws pictures under its own ink layer; in the WebView they would cover the ink. */}
            {!nativeBoardReady && images.length > 0 && <BoardPictures images={picturesUnderInk(images, profileConfig.graphTools ? graphs : [])} zoom={zoom} pan={pan} />}
            <canvas
              ref={canvasRef}
              className={cn("block h-full w-full rounded-2xl", mode === "lasso" && "cursor-crosshair")}
              style={{ touchAction: "none", opacity: nativeBoardReady ? 0 : 1 }}
              onContextMenu={(e) => e.preventDefault()}
              onWheel={handleCanvasWheel}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onPointerLeave={() => {
                eraserPreviewRef.current = null;
                if (!lowPowerMode) scheduleRender();
              }}
            />
            {mode === "pan" && images.length > 0 && (
              <BoardImageHandles images={images} graphs={graphs} zoom={zoom} pan={pan} selectedId={selectedImageId}
                onSelect={setSelectedImageId} onCommit={commitImage} onDelete={deleteImage} onRestack={restackPicture}
                deleteLabel={tl("delete_image")} resizeLabel={tl("resize_image")} upLabel={tl("image_layer_up")} downLabel={tl("image_layer_down")} />
            )}
            {geometryTool && <GeometryOverlay tool={geometryTool} zoom={zoom} pan={pan} onChange={setGeometryTool} />}
            <div
              className="pointer-events-none absolute inset-0 overflow-visible"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: "0 0",
              }}
            >
              {boardStack(images, profileConfig.graphTools ? graphs : []).map((entry, layer) => entry.kind === "image" ? (
                liftedImages.has(entry.item.id) && (
                  // Over a graph, so over the ink as well: it hides writing under it, as a graph does.
                  <img
                    key={entry.item.id}
                    data-board-object="image"
                    src={backendAssetUrl(entry.item.src)}
                    alt={entry.item.label ?? ""}
                    draggable={false}
                    className="absolute select-none"
                    style={{
                      left: entry.item.x, top: entry.item.y, width: entry.item.width, height: entry.item.height,
                      objectFit: "fill", zIndex: 10 + Math.min(layer, 50),
                      pointerEvents: mode === "pan" ? "none" : "auto",
                    }}
                  />
                )
              ) : (() => { const graph = entry.item; return (
                <GraphElementView
                  key={graph.id}
                  graph={graph}
                  layer={layer}
                  onRestack={restackGraph}
                  selected={selectedGraphId === graph.id}
                  backgroundColor={bg}
                  isDarkBackground={isDarkBg}
                  zoom={zoom}
                  visibleWorld={graphVisibleWorld()}
                  onSelect={() => setSelectedGraphId(graph.id)}
                  onPreview={updateGraphPreview}
                  onCommit={commitGraphUpdate}
                  onDelete={deleteGraph}
                  interactionDisabled={mode === "pan" || mode === "lasso"}
                />
              ); })())}
              {solutions.map((solution) => (
                <AiSolutionBlockView
                  key={solution.id}
                  solution={solution}
                  zoom={zoom}
                  onCommitChange={commitSolutionUpdate}
                  onDelete={deleteSolution}
                  onCancel={onCancelAiSolution}
                />
              ))}
            </div>
            {mode === "lasso" && (
              <>
                <svg
                  data-testid="lasso-overlay"
                  className="pointer-events-none absolute inset-0 h-full w-full"
                  aria-hidden="true"
                >
                  {lassoPath.length >= 3 ? (
                    <polygon
                      points={lassoPath.map((point) => `${point.x * zoom + pan.x},${point.y * zoom + pan.y}`).join(" ")}
                      fill="rgba(77, 163, 255, 0.07)"
                      stroke="rgba(77, 163, 255, 0.95)"
                      strokeWidth="1.5"
                      strokeDasharray="6 5"
                    />
                  ) : lassoPath.length > 1 ? (
                    <polyline
                      points={lassoPath.map((point) => `${point.x * zoom + pan.x},${point.y * zoom + pan.y}`).join(" ")}
                      fill="none"
                      stroke="rgba(77, 163, 255, 0.95)"
                      strokeWidth="1.5"
                      strokeDasharray="6 5"
                    />
                  ) : null}
                </svg>
                {lassoSelection.bounds && (
                  <>
                    <div
                      data-testid="lasso-selection"
                      className="pointer-events-none absolute border border-dashed border-accent/80 bg-accent/[0.035]"
                      style={{
                        left: lassoSelection.bounds.left * zoom + pan.x,
                        top: lassoSelection.bounds.top * zoom + pan.y,
                        width: Math.max(1, (lassoSelection.bounds.right - lassoSelection.bounds.left) * zoom),
                        height: Math.max(1, (lassoSelection.bounds.bottom - lassoSelection.bounds.top) * zoom),
                      }}
                    />
                    <button
                      type="button"
                      data-testid="lasso-delete"
                      aria-label={tl("delete_selection")}
                      title={tl("delete_selection")}
                      className="absolute z-20 grid h-8 w-8 place-items-center rounded-md border border-ember/30 bg-graphite/95 text-ember shadow-soft transition hover:bg-ember/10"
                      style={{
                        left: Math.min(
                          Math.max(4, lassoSelection.bounds.right * zoom + pan.x - 32),
                          Math.max(4, widthPx - 36),
                        ),
                        top: Math.max(4, lassoSelection.bounds.top * zoom + pan.y - 36),
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={deleteLassoSelection}
                    >
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      <div
        data-testid="board-toolbar"
        data-layout="two-level"
        data-visible={toolbarVisible ? "true" : "false"}
        className={cn(
          "board-toolbar-dock absolute z-40 rounded-[22px] px-1.5 pt-1.5 pb-0 transition-[transform,opacity] duration-200",
          toolbarVisible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        )}
        onPointerMove={revealToolbar}
        onPointerDown={revealToolbar}
      >
        <div
          data-testid="board-toolbar-primary"
          data-toolbar-level="primary"
          className="board-toolbar-primary-row scrollbar-hide flex flex-nowrap items-center gap-1.5 overflow-visible [&>*]:shrink-0 [&_button]:min-h-11 [&_button]:min-w-11"
        >
        <Button variant="outline" size="sm" className="board-utility-button" aria-label={tl("panels")} title={tl("panels")} onClick={onTogglePanels}>
          <Menu size={26} />
        </Button>
        <div ref={penToolbarAnchorRef} className="board-tool-embedded-anchor relative self-stretch">
          <Button
            variant="ghost"
            size="sm"
            className={cn("board-tool-button board-tool-embedded board-tool-unframed", mode === "draw" && !humanitiesPreset && "is-active")}
            aria-label={tl("pen")}
            aria-pressed={mode === "draw"}
            title={tl("pen")}
            onClick={() => {
              setHumanitiesPreset(null);
              setMode("draw");
              setShowPenSlider(true);
              setShowPenPalette(true);
              setShowGeometryMenu(false);
              schedulePenHide();
              closeBoardSettings();
            }}
          >
            <BoardToolIcon tool="pen" />
          </Button>
          <BoardToolbarPopover
            anchorRef={penToolbarAnchorRef}
            open={showPenPalette && mode === "draw"}
            testId="board-toolbar-popover-pen"
            className="surface-popover rounded-xl px-2 py-2 shadow-glass backdrop-blur"
          >
            <div onPointerDown={schedulePenHide} onPointerUp={schedulePenHide} onPointerMove={schedulePenHide}>
                {showPenSlider && (
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-xs text-frost/60">{tl("thickness")}</span>
                    <input
                      type="range"
                      min={2}
                      max={12}
                      value={width}
                      onChange={(e) => {
                        setWidth(Number(e.target.value));
                        schedulePenHide();
                      }}
                    />
                    <span
                      className="inline-block rounded-full"
                      style={{
                        width: `${Math.max(6, width)}px`,
                        height: `${Math.max(6, width)}px`,
                        backgroundColor: color,
                      }}
                    />
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <div
                    className="h-6 w-6 rounded-full border border-white/20 bg-white/10 flex items-center justify-center text-xs"
                    title={tl("pen_palette")}
                  >
                    ✎
                  </div>
                  {PRIMARY_COLORS.map((c) => (
                    <button
                      key={c.value}
                      className={cn(
                        "h-5 w-5 rounded-full border",
                        color === c.value ? "border-white" : "border-white/20"
                      )}
                      style={{ backgroundColor: c.value }}
                      onClick={() => {
                        setColor(c.value);
                        onChangePenColor(c.value);
                        schedulePenHide();
                      }}
                      title={`${tl("pen")}: ${tl(c.name)}`}
                    />
                  ))}
                  <button
                    className="h-5 w-5 rounded-full border border-white/20 text-xs text-frost/70 hover:text-frost"
                    onClick={() => setShowAllPens((v) => !v)}
                    title={showAllPens ? tl("hide_pen_palette") : tl("show_all_pen_colors")}
                  >
                    ...
                  </button>
                </div>
                <AnimatePresence>
                  {showAllPens && (
                    <motion.div
                      initial={{ opacity: 0, height: 0, y: -4 }}
                      animate={{ opacity: 1, height: "auto", y: 0 }}
                      exit={{ opacity: 0, height: 0, y: -4 }}
                      className="mt-2 flex items-center gap-2 overflow-hidden rounded-lg border border-white/10 bg-white/5 px-2 py-1"
                    >
                      {ALL_PEN_COLORS.map((c) => (
                        <button
                          key={`pen-${c.value}`}
                          className={cn(
                            "h-5 w-5 rounded-full border",
                            color === c.value ? "border-white" : "border-white/20"
                          )}
                          style={{ backgroundColor: c.value }}
                          onClick={() => {
                            setColor(c.value);
                            onChangePenColor(c.value);
                            schedulePenHide();
                          }}
                          title={`${tl("pen")}: ${tl(c.name)}`}
                        />
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
            </div>
          </BoardToolbarPopover>
        </div>
        <div ref={lineToolbarAnchorRef} className="board-tool-embedded-anchor relative self-stretch">
          <Button
            variant="ghost"
            size="sm"
            className={cn("board-tool-button board-tool-embedded board-tool-unframed", mode === "line" && !humanitiesPreset && "is-active")}
            aria-label={tl("ruler")}
            aria-pressed={geometryTool !== null}
            title={tl("ruler")}
            onClick={() => {
              setHumanitiesPreset(null);
              // The pen draws along the tools, so geometry always pairs with the pen.
              setMode("draw");
              if (!geometryTool) toggleGeometryTool(geometryKind);
              setShowGeometryMenu(true);
              setShowPenPalette(false);
              setShowAllPens(false);
              setShowPenSlider(false);
              scheduleGeometryHide();
              closeBoardSettings();
            }}
          >
            <BoardToolIcon tool={geometryArtwork[geometryTool?.kind ?? geometryKind]} />
          </Button>
          <BoardToolbarPopover
            anchorRef={lineToolbarAnchorRef}
            open={showGeometryMenu}
            testId="board-toolbar-popover-geometry"
            className="surface-popover rounded-xl px-2 py-2 shadow-glass backdrop-blur"
          >
            <div className="flex items-center gap-1" onPointerDown={scheduleGeometryHide} onPointerUp={scheduleGeometryHide}>
              {(["ruler", "protractor", "compass"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-label={tl(kind)}
                  aria-pressed={geometryTool?.kind === kind}
                  title={tl(kind)}
                  className={cn(
                    "grid h-[84px] w-[84px] place-items-center rounded-2xl transition",
                    geometryTool?.kind === kind ? "bg-[rgb(var(--color-accent)/0.22)] ring-1 ring-[rgb(var(--color-accent)/0.7)]" : "hover:bg-white/10",
                  )}
                  // Tapping the tool already on the board takes it away.
                  onClick={() => toggleGeometryTool(kind)}
                >
                  <BoardToolIcon tool={geometryArtwork[kind]} size={76} />
                </button>
              ))}
            </div>
          </BoardToolbarPopover>
        </div>
        <div ref={eraserToolbarAnchorRef} className="board-tool-embedded-anchor relative self-stretch">
          <Button
            variant="ghost"
            size="sm"
            className={cn("board-tool-button board-tool-embedded board-tool-unframed", mode === "erase" && "is-active")}
            aria-label={tl("eraser")}
            aria-pressed={mode === "erase"}
            title={tl("eraser")}
            onClick={() => {
            setHumanitiesPreset(null);
            setMode("erase");
            setShowEraserSlider(true);
            setShowPenPalette(false);
            setShowAllPens(false);
            setShowGeometryMenu(false);
            scheduleEraserHide();
            closeBoardSettings();
          }}
        >
          <BoardToolIcon tool="eraser" />
        </Button>
          <BoardToolbarPopover
            anchorRef={eraserToolbarAnchorRef}
            open={showEraserSlider && mode === "erase"}
            testId="board-toolbar-popover-eraser"
            className="surface-popover rounded-xl px-2 py-2 shadow-glass backdrop-blur"
          >
            <div onPointerDown={scheduleEraserHide} onPointerUp={scheduleEraserHide} onPointerMove={scheduleEraserHide}>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-frost/60">{tl("eraser_size")}</span>
                  <input
                    type="range"
                    min={6}
                    max={36}
                    value={eraserWidth}
                    onChange={(e) => {
                      setEraserWidth(Number(e.target.value));
                      scheduleEraserHide();
                    }}
                  />
                  <span
                    className="inline-block rounded-full border border-white/30"
                    style={{
                      width: `${Math.max(8, eraserWidth)}px`,
                      height: `${Math.max(8, eraserWidth)}px`,
                      backgroundColor: "transparent",
                    }}
                  />
                </div>
            </div>
          </BoardToolbarPopover>
        </div>
        {profileConfig.humanitiesTools && (
          <>
            <Button
              variant={humanitiesPreset === "highlight" ? "accent" : "outline"}
              size="sm"
              className="board-utility-button"
              aria-label="Маркер"
              title="Маркер"
              onClick={() => {
                setHumanitiesPreset("highlight");
                setMode("draw");
                setShowPenSlider(false);
                setShowPenPalette(false);
                setShowAllPens(false);
                setShowGeometryMenu(false);
                closeBoardSettings();
              }}
            >
              <Highlighter size={25} />
            </Button>
            <Button
              variant={humanitiesPreset === "underline" ? "accent" : "outline"}
              size="sm"
              className="board-utility-button"
              aria-label="Подчёркивание"
              title="Подчёркивание"
              onClick={() => {
                setHumanitiesPreset("underline");
                setMode("line");
                setShowGeometryMenu(false);
                setShowPenPalette(false);
                setShowAllPens(false);
                setShowPenSlider(false);
                closeBoardSettings();
              }}
            >
              <Underline size={25} />
            </Button>
          </>
        )}
        {profileConfig.graphTools && (
          <Button
            variant="ghost"
            size="sm"
            className={cn("board-tool-button board-tool-unframed", mode === "graph" && "is-active")}
            aria-label={tl("graph")}
            aria-pressed={mode === "graph"}
            title={tl("graph")}
            onClick={() => {
              setHumanitiesPreset(null);
              setMode("graph");
              setShowPenSlider(false);
              setShowPenPalette(false);
              setShowAllPens(false);
              setShowEraserSlider(false);
              setShowGeometryMenu(false);
              closeBoardSettings();
            }}
          >
            <BoardToolIcon tool="graph" />
          </Button>
        )}
        <Button
          variant={mode === "lasso" ? "accent" : "outline"}
          size="sm"
          className="board-utility-button"
          aria-label={tl("lasso")}
          aria-pressed={mode === "lasso"}
          title={tl("lasso")}
          onClick={() => {
            setHumanitiesPreset(null);
            setMode("lasso");
            setShowPenSlider(false);
            setShowPenPalette(false);
            setShowAllPens(false);
            setShowEraserSlider(false);
            setShowGeometryMenu(false);
            closeBoardSettings();
          }}
        >
          <LassoSelect size={26} />
        </Button>
        <Button
          variant={mode === "pan" ? "accent" : "outline"}
          size="sm"
          className="board-utility-button"
          aria-label={tl("moving")}
          title={tl("moving")}
          disabled={boardLock}
          onClick={() => {
            setHumanitiesPreset(null);
            setMode("pan");
            setShowPenSlider(false);
            setShowPenPalette(false);
            setShowAllPens(false);
            setShowEraserSlider(false);
            setShowGeometryMenu(false);
            closeBoardSettings();
          }}
        >
          <Hand size={27} />
        </Button>
        <Button
          variant={boardLock ? "accent" : "outline"}
          size="sm"
          className="board-utility-button"
          aria-label={tl("board_lock")}
          onClick={() => setBoardLock((v) => !v)}
          title={tl("board_lock")}
        >
          {boardLock ? <Lock size={26} /> : <Unlock size={26} />}
        </Button>
        <div ref={boardToolbarAnchorRef} className="relative">
          <Button
            variant="outline"
            size="sm"
            className="board-utility-button"
            aria-label={tl("board")}
            title={tl("board")}
            onClick={() => {
              setShowBoardSettings((v) => !v);
              setShowAllBg(false);
            }}
          >
            <Grid3x3 size={26} />
          </Button>
          <BoardToolbarPopover
            anchorRef={boardToolbarAnchorRef}
            open={showBoardSettings}
            testId="board-toolbar-popover-board"
            className="surface-popover rounded-xl px-3 py-2 shadow-glass backdrop-blur"
          >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs text-frost/60">
                    {profileConfig.backgroundPattern === "lines" ? tl("lines") : tl("grid")}
                  </span>
                  <Button variant={grid ? "accent" : "outline"} size="sm" onClick={() => setGrid((v) => !v)}>
                    {tl(grid ? "grid_on" : "grid_off")}
                  </Button>
                </div>
                <div className="mb-2 flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2 py-1">
                  <button
                    className="rounded-full px-2 py-1 text-xs font-semibold text-frost/70 hover:text-frost"
                    disabled={boardLock}
                    onClick={() => setZoom((z) => clampZoom(z - 0.1))}
                  >
                    −
                  </button>
                  <button
                    className="rounded-full px-2 py-1 text-xs font-semibold text-frost/70 hover:text-frost"
                    disabled={boardLock}
                    onClick={() => setZoom(1)}
                  >
                    {Math.round(zoom * 100)}%
                  </button>
                  <button
                    className="rounded-full px-2 py-1 text-xs font-semibold text-frost/70 hover:text-frost"
                    disabled={boardLock}
                    onClick={() => setZoom((z) => clampZoom(z + 0.1))}
                  >
                    +
                  </button>
                  <button
                    className="rounded-full px-2 py-1 text-xs font-semibold text-frost/70 hover:text-frost"
                    disabled={boardLock}
                    onClick={() => setPan({ x: 0, y: 0 })}
                  >
                    {tl("center")}
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <div
                    className="h-6 w-6 rounded-full border border-white/20 bg-white/10 flex items-center justify-center text-xs"
                    title={tl("background_color")}
                  >
                    ▦
                  </div>
                  {BG_PRIMARY.map((b) => (
                    <button
                      key={`bg-${b.value}`}
                      className={cn(
                        "h-5 w-5 rounded-full border",
                        bg === b.value ? "border-white" : "border-white/20"
                      )}
                      style={{ backgroundColor: b.value }}
                      onClick={() => {
                        setBg(b.value);
                        onChangeBgColor(b.value);
                      }}
                      title={`${tl("board")}: ${tl(b.name)}`}
                    />
                  ))}
                  <button
                    className="h-5 w-5 rounded-full border border-white/20 text-xs text-frost/70 hover:text-frost"
                    onClick={() => setShowAllBg((v) => !v)}
                    title={showAllBg ? tl("hide_background_palette") : tl("show_all_background_colors")}
                  >
                    ...
                  </button>
                </div>
                {isNativeApp() && (
                  <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/10 pt-2">
                    <span className="text-xs text-frost/70">Canvas renderer</span>
                    <Button
                      size="sm"
                      variant={nativeBoardReady ? "accent" : "outline"}
                      title="Switch renderer and reload the Android app"
                      onClick={() => switchRenderer(!nativeBoardReady)}
                    >
                      {nativeBoardReady ? "Android (native)" : "Web Canvas"}
                    </Button>
                  </div>
                )}
                <AnimatePresence>
                  {showAllBg && (
                    <motion.div
                      initial={{ opacity: 0, height: 0, y: -4 }}
                      animate={{ opacity: 1, height: "auto", y: 0 }}
                      exit={{ opacity: 0, height: 0, y: -4 }}
                      className="mt-2 flex items-center gap-2 overflow-hidden rounded-lg border border-white/10 bg-white/5 px-2 py-1"
                    >
                      {ALL_BACKGROUNDS.map((b) => (
                        <button
                          key={`bg-all-${b.value}`}
                          className={cn(
                            "h-5 w-5 rounded-full border",
                            bg === b.value ? "border-white" : "border-white/20"
                          )}
                          style={{ backgroundColor: b.value }}
                          onClick={() => {
                            setBg(b.value);
                            onChangeBgColor(b.value);
                          }}
                          title={`${tl("board")}: ${tl(b.name)}`}
                        />
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
          </BoardToolbarPopover>
        </div>
        <div className="board-input-mode relative flex items-center gap-1 rounded-2xl border border-white/10 bg-white/5 p-1">
          <button
            aria-label={tl("auto")}
            title={tl("auto")}
            className={cn(
              "board-segment-button relative z-10 rounded-xl transition",
              inputMode === "auto" ? "text-accentText" : "text-frost/70 hover:text-frost"
            )}
            onClick={() => setInputMode("auto")}
          >
            {inputMode === "auto" && (
              <motion.span
                layoutId="input-mode-pill"
                className="absolute inset-0 rounded-full bg-accent"
                transition={{ type: "spring", stiffness: 500, damping: 40 }}
              />
            )}
            <MousePointer2 size={24} className="relative z-10" />
          </button>
          <button
            aria-label={tl("mouse")}
            title={tl("mouse")}
            className={cn(
              "board-segment-button relative z-10 rounded-xl transition",
              inputMode === "mouse" ? "text-accentText" : "text-frost/70 hover:text-frost"
            )}
            onClick={() => setInputMode("mouse")}
          >
            {inputMode === "mouse" && (
              <motion.span
                layoutId="input-mode-pill"
                className="absolute inset-0 rounded-full bg-accent"
                transition={{ type: "spring", stiffness: 500, damping: 40 }}
              />
            )}
            <Mouse size={24} className="relative z-10" />
          </button>
          <button
            aria-label={tl("touch_mode")}
            title={tl("touch_mode")}
            className={cn(
              "board-segment-button relative z-10 rounded-xl transition",
              inputMode === "touch" ? "text-accentText" : "text-frost/70 hover:text-frost"
            )}
            onClick={() => setInputMode("touch")}
          >
            {inputMode === "touch" && (
              <motion.span
                layoutId="input-mode-pill"
                className="absolute inset-0 rounded-full bg-accent"
                transition={{ type: "spring", stiffness: 500, damping: 40 }}
              />
            )}
            <Pointer size={24} className="relative z-10" />
          </button>
        </div>

        <Button data-testid="board-undo" variant="ghost" size="sm" className="board-utility-button" onClick={handleUndo} disabled={!canUndo} aria-label={tl("undo")} title={tl("undo")}>
          <RotateCcw size={25} />
        </Button>
        <Button data-testid="board-redo" variant="ghost" size="sm" className="board-utility-button" onClick={handleRedo} disabled={!canRedo} aria-label={tl("redo")} title={tl("redo")}>
          <RotateCw size={25} />
        </Button>
        <div ref={clearToolbarAnchorRef} className="relative flex items-center">
          <Button
            variant="ghost"
            size="sm"
            className="board-utility-button"
            aria-label={tl("clear_board")}
            title={tl("clear_board")}
            onClick={() => {
              setShowClearConfirm((v) => !v);
              setClearSlideValue(0);
            }}
          >
            <Trash2 size={25} />
          </Button>
          <BoardToolbarPopover
            anchorRef={clearToolbarAnchorRef}
            open={showClearConfirm}
            align="right"
            testId="board-toolbar-popover-clear"
            className="surface-popover w-[260px] rounded-xl px-3 py-2 shadow-glass backdrop-blur"
          >
                <div className="mb-2 text-xs text-frost/70">{tl("slide_to_clear")}</div>
                <input
                  type="range"
                  aria-label={tl("slide_to_clear")}
                  min={0}
                  max={100}
                  value={clearSlideValue}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setClearSlideValue(next);
                    if (next >= 100) {
                      handleClear();
                      setShowClearConfirm(false);
                      setClearSlideValue(0);
                    }
                  }}
                  onPointerUp={() => {
                    if (clearSlideValue < 100) setClearSlideValue(0);
                  }}
                  className="w-[140px]"
                />
          </BoardToolbarPopover>
        </div>
        {imagesSupported && (
          <Button variant="outline" size="sm" className="board-utility-button" aria-label={tl("insert_image")} title={tl("insert_image")}
            onClick={() => setShowInsertImage(true)}>
            <ImagePlus size={26} />
          </Button>
        )}
        <Button variant="outline" size="sm" className="board-utility-button" aria-label={tl("snapshot")} title={tl("snapshot")} onClick={handleSnapshot}>
          <Save size={26} />
        </Button>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {onToggleTask && (
            <Button variant={taskOpen ? "accent" : "outline"} size="sm" className="board-utility-button" onClick={onToggleTask} aria-label={tl("exercise")} title={tl("exercise")}>
              <NotebookPen size={26} />
            </Button>
          )}
          {onToggleAssistant && (
            <Button data-testid="open-ai-assistant" variant={assistantOpen ? "accent" : "outline"} size="sm" className="board-utility-button" onClick={onToggleAssistant} aria-label={tl("ai_assistant")} title={tl("ai_assistant")}>
              <MessageSquare size={26} />
            </Button>
          )}
        </div>
        </div>
      </div>
    </div>
  );
});

export default BoardCanvas;
