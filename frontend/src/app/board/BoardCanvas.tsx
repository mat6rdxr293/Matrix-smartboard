import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ForwardedRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { callOcr } from "@/app/ai/api";
import { drawStrokes, type Stroke } from "@/app/board/boardEngine";
import type { BoardReplayOp } from "@/app/board/replayApi";
import type { AiSolutionBlock, GraphElement } from "@/app/board/boardDocument";
import { getSelectionBounds, selectGraphIds, selectStrokeIndices, translateBounds, translateStroke, type LassoBounds } from "@/app/board/lasso";
import GraphElementView from "@/app/board/GraphElementView";
import AiSolutionBlockView from "@/app/board/AiSolutionBlockView";
import { findFreeBoardSpace, type BoardRect } from "@/app/board/freeSpace";
import BoardToolbarPopover from "@/app/board/BoardToolbarPopover";
import BoardToolIcon from "@/app/board/BoardToolIcon";
import { Grid3x3, Hand, Highlighter, LassoSelect, Lock, Menu, MessageSquare, Mouse, MousePointer2, NotebookPen, Pointer, RotateCcw, RotateCw, Save, Trash2, Underline, Unlock } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useI18n } from "@/i18n";
import { getBoardProfileConfig, type BoardProfile } from "@/app/board/boardProfiles";

type RenderQualityMode = "quality" | "balanced" | "performance";

const BALANCED_RENDER_WIDTH = 2560;
const BALANCED_RENDER_HEIGHT = 1440;
const PERFORMANCE_RENDER_WIDTH = 1920;
const PERFORMANCE_RENDER_HEIGHT = 1080;

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
  recognize: () => Promise<string>;
  allocateSolutionPlacement: (width?: number, height?: number) => { x: number; y: number; width: number; minHeight: number };
  animateAiStrokes: (
    strokes: Stroke[],
    shouldCancel?: () => boolean,
    lowMotion?: boolean,
  ) => Promise<Stroke[]>;
};

const EMPTY_SOLUTIONS: AiSolutionBlock[] = [];
const NOOP_SOLUTION_CHANGE = (_next: AiSolutionBlock[]) => undefined;

const BoardCanvas = forwardRef(function BoardCanvas({
  onOcrText,
  ocrEnabled,
  expanded,
  onTogglePanels,
  onStartTimer,
  initialStrokes,
  onChangeStrokes,
  initialGraphs,
  onChangeGraphs,
  initialSolutions = EMPTY_SOLUTIONS,
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
  const workerRef = useRef<Worker | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRenderRef = useRef(false);
  const drawFrameRef = useRef<() => void>(() => undefined);
  const workerEnabledRef = useRef(false);
  const strokesRef = useRef<Stroke[]>(initialStrokes);
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
  const [loading, setLoading] = useState(false);
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
  const [showLineSlider, setShowLineSlider] = useState(false);
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
    (showLineSlider && mode === "line") ||
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
    const nearBottom = event.clientY >= rect.bottom - 64 && event.clientY <= rect.bottom;
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
  const renderMinDeltaMs = lowPowerMode ? 60 : 16;
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

  function drawFrame() {
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

  const startStroke = (x: number, y: number) => {
    const isHighlighter = humanitiesPreset === "highlight";
    const w = mode === "erase" ? eraserWidth : isHighlighter ? 14 : width;
    strokesRef.current.push({
      points: [{ x, y }],
      color: isHighlighter ? "#F6D365A6" : color,
      width: w,
      mode: mode === "erase" ? "erase" : "draw",
    });
    scheduleRender();
  };

  const addPoints = (points: { x: number; y: number }[]) => {
    const last = strokesRef.current[strokesRef.current.length - 1];
    if (!last) return;
    const startPoint = last.points[last.points.length - 1];
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
    if (!workerEnabledRef.current && mode !== "line" && mode !== "pan") {
      drawIncrementalSegment(last, [startPoint, ...appended]);
      return;
    }
    scheduleRender();
  };

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

  const extractPoints = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const native = e.nativeEvent as PointerEvent;
    const coalesced =
      !lowPowerMode && typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [native];
    const scale = zoomRef.current || 1;
    const panNow = panRef.current;
    if (!coalesced || coalesced.length === 0) {
      return [
        {
          x: (e.clientX - rect.left - panNow.x) / scale,
          y: (e.clientY - rect.top - panNow.y) / scale,
        },
      ];
    }
    return coalesced.map((evt) => ({
      x: (evt.clientX - rect.left - panNow.x) / scale,
      y: (evt.clientY - rect.top - panNow.y) / scale,
    }));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!shouldHandlePointer(e)) return;
    e.preventDefault();
    setShowPenPalette(false);
    setShowAllPens(false);
    setShowPenSlider(false);
    setShowEraserSlider(false);
    setShowLineSlider(false);
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
  }, [grid, widthPx, heightPx, zoom, pan, gridColor, mode, eraserWidth, isDarkBg, bg, renderRatio, lowPowerMode]);

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

  const allocateSolutionPlacement = (requestedWidth = 500, requestedHeight = 320) => {
    const scale = Math.max(zoomRef.current, 0.01);
    const currentPan = panRef.current;
    const viewport: BoardRect = {
      left: -currentPan.x / scale,
      top: -currentPan.y / scale,
      right: (widthPx - currentPan.x) / scale,
      bottom: (heightPx - currentPan.y) / scale,
    };
    const placement = findFreeBoardSpace(
      viewport,
      occupiedBoardRects(),
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
    const committed: Stroke[] = [];
    const frameDelay = lowMotion ? 0 : 5;
    const penLiftDelay = lowMotion ? 0 : 7;

    const densify = (points: Stroke["points"], maxSegment = 2.2) => {
      if (points.length < 2) return points.map((point) => ({ ...point }));
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

    for (const source of incoming) {
      if (shouldCancel?.()) break;
      if (source.points.length < 2) continue;

      const animationPoints = lowMotion ? source.points : densify(source.points);
      const preview: Stroke = {
        ...source,
        points: [{ ...animationPoints[0] }],
      };
      strokesRef.current.push(preview);

      const stride = lowMotion
        ? animationPoints.length
        : Math.max(1, Math.ceil(animationPoints.length / 14));

      for (let index = 1; index < animationPoints.length; index += stride) {
        if (shouldCancel?.()) break;
        preview.points = animationPoints
          .slice(0, Math.min(animationPoints.length, index + stride))
          .map((point) => ({ ...point }));
        scheduleRender();

        if (!lowMotion) {
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, frameDelay);
          });
        }
      }

      if (shouldCancel?.()) {
        if (preview.points.length < 2) {
          strokesRef.current.pop();
        } else {
          committed.push({
            ...source,
            points: source.points.map((point) => ({ ...point })),
          });
        }
        scheduleRender();
        break;
      }

      preview.points = source.points.map((point) => ({ ...point }));
      committed.push({
        ...source,
        points: source.points.map((point) => ({ ...point })),
      });
      scheduleRender();

      if (!lowMotion) {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, penLiftDelay);
        });
      }
    }

    return committed;
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
    if (strokesRef.current.length === 0 && graphsRef.current.length === 0 && solutionsRef.current.length === 0) return;
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
  };

  const renderOcrBlob = (): Promise<Blob | null> => {
    const canvas = canvasRef.current;
    if (!canvas) return Promise.resolve(null);
    const drawStrokesOnly = strokesRef.current.filter((s) => s.mode === "draw" && s.points.length > 0);
    if (!drawStrokesOnly.length) {
      return new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob), "image/png");
      });
    }

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
    const scale = Math.min(1, maxEdge / Math.max(contentWidth, contentHeight));
    const outWidth = Math.max(1, Math.round(contentWidth * scale));
    const outHeight = Math.max(1, Math.round(contentHeight * scale));

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = outWidth;
    exportCanvas.height = outHeight;
    const ctx = exportCanvas.getContext("2d");
    if (!ctx) return Promise.resolve(null);

    drawStrokes(ctx, strokesRef.current, {
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

    return new Promise((resolve) => {
      exportCanvas.toBlob((blob) => resolve(blob), "image/png");
    });
  };

  const handleOcr = async (): Promise<string> => {
    const graphLines = graphsRef.current.flatMap((graph) =>
      graph.expressions
        .filter((expression) => expression.visible && expression.expression.trim())
        .map((expression) => `График: y = ${expression.expression.trim()}`)
    );
    const hasInk = strokesRef.current.some((stroke) => stroke.mode === "draw" && stroke.points.length > 0);

    if (!hasInk && graphLines.length > 0) {
      const text = graphLines.join("\n");
      onOcrText?.(text);
      return text;
    }
    if (!ocrEnabled) throw new Error(tl("ocr_not_available"));

    setLoading(true);
    try {
      const blob = await renderOcrBlob();
      if (!blob) throw new Error(tl("ocr_not_available"));
      const res = await callOcr(blob);
      const text = [res.text.trim(), ...graphLines].filter(Boolean).join("\n").trim();
      if (!text) throw new Error(tl("ocr_not_available"));
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

  useImperativeHandle(ref, () => ({ recognize: handleOcr, allocateSolutionPlacement, animateAiStrokes }));

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

  const scheduleLineHide = () => {
    if (lineTimerRef.current) window.clearTimeout(lineTimerRef.current);
    lineTimerRef.current = window.setTimeout(() => setShowLineSlider(false), 5000);
  };

  const closeBoardSettings = () => {
    setShowBoardSettings(false);
    setShowAllBg(false);
  };

  return (
    <div
      data-testid="board-canvas-root"
      className="relative flex h-full flex-col pb-0"
      onPointerMoveCapture={revealToolbarNearBottom}
      onPointerDownCapture={revealToolbarNearBottom}
    >
      <div ref={areaRef} className="relative flex-1 min-h-0 overflow-hidden">
        <div className="absolute inset-0">
          <div
            className="absolute inset-0 rounded-2xl border border-white/10 overflow-hidden"
            style={{ backgroundColor: bg }}
          >
            <canvas
              ref={canvasRef}
              className={cn("block h-full w-full rounded-2xl", mode === "lasso" && "cursor-crosshair")}
              style={{ touchAction: "none" }}
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
            <div
              className="pointer-events-none absolute inset-0 overflow-visible"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: "0 0",
              }}
            >
              {profileConfig.graphTools && graphs.map((graph) => (
                <GraphElementView
                  key={graph.id}
                  graph={graph}
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
              ))}
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
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-black/40 text-sm">
                {tl("recognition_loading")}
              </div>
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
              setShowLineSlider(false);
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
            aria-label={tl("line")}
            aria-pressed={mode === "line"}
            title={tl("line")}
            onClick={() => {
              setHumanitiesPreset(null);
              setMode("line");
              setShowLineSlider(true);
              setShowPenPalette(false);
              setShowAllPens(false);
              setShowPenSlider(false);
              scheduleLineHide();
              closeBoardSettings();
            }}
          >
            <BoardToolIcon tool="line" />
          </Button>
          <BoardToolbarPopover
            anchorRef={lineToolbarAnchorRef}
            open={showLineSlider && mode === "line"}
            testId="board-toolbar-popover-line"
            className="surface-popover rounded-xl px-2 py-2 shadow-glass backdrop-blur"
          >
            <div onPointerDown={scheduleLineHide} onPointerUp={scheduleLineHide} onPointerMove={scheduleLineHide}>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-frost/60">{tl("thickness")}</span>
                  <input
                    type="range"
                    min={2}
                    max={12}
                    value={width}
                    onChange={(e) => {
                      setWidth(Number(e.target.value));
                      scheduleLineHide();
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
            setShowLineSlider(false);
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
                setShowLineSlider(false);
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
                setShowLineSlider(false);
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
              setShowLineSlider(false);
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
            setShowLineSlider(false);
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
            setShowLineSlider(false);
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
