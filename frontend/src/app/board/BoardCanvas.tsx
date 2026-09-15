import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { callOcr } from "@/app/ai/api";
import { drawStrokes, type Stroke } from "@/app/board/boardEngine";
import type { BoardReplayOp } from "@/app/board/replayApi";
import type { GraphElement } from "@/app/board/boardDocument";
import GraphElementView from "@/app/board/GraphElementView";
import { ChartSpline, Eraser, Grid3x3, Hand, Lock, Menu, MessageSquare, Minus, NotebookPen, Paintbrush, RotateCcw, RotateCw, Scan, Save, Trash2, Unlock } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useI18n } from "@/i18n";

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

export default function BoardCanvas({
  onOcrText,
  ocrEnabled,
  expanded,
  onTogglePanels,
  onStartTimer,
  initialStrokes,
  onChangeStrokes,
  initialGraphs,
  onChangeGraphs,
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
}: {
  onOcrText: (text: string) => void;
  ocrEnabled: boolean;
  expanded: boolean;
  onTogglePanels: () => void;
  onStartTimer: () => void;
  initialStrokes: Stroke[];
  onChangeStrokes: (next: Stroke[]) => void;
  initialGraphs: GraphElement[];
  onChangeGraphs: (next: GraphElement[]) => void;
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
}) {
  const { tl } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRenderRef = useRef(false);
  const drawFrameRef = useRef<() => void>(() => undefined);
  const workerEnabledRef = useRef(false);
  const strokesRef = useRef<Stroke[]>(initialStrokes);
  const graphsRef = useRef<GraphElement[]>(initialGraphs);
  const [graphs, setGraphs] = useState<GraphElement[]>(initialGraphs);
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
  const [mode, setMode] = useState<"draw" | "erase" | "line" | "pan" | "graph">("draw");
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
  const localSyncRef = useRef(false);
  const penTimerRef = useRef<number | null>(null);
  const eraserTimerRef = useRef<number | null>(null);
  const lineTimerRef = useRef<number | null>(null);
  const [inputMode, setInputMode] = useState<"auto" | "mouse" | "touch">("auto");
  const activePointerIdRef = useRef<number | null>(null);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const [dynamicSize, setDynamicSize] = useState({ w: 1600, h: 900 });
  const widthPx = dynamicSize.w;
  const heightPx = dynamicSize.h;
  const compactToolbar = widthPx < 1750;
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
  const eraserPreviewRef = useRef<{ x: number; y: number } | null>(null);

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
  const gridStep = lowPowerMode ? 40 : 28;
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
      const nextW = Math.max(1, Math.floor(rect.width));
      const nextH = Math.max(1, Math.floor(rect.height));
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
    canvas.style.width = `${widthPx}px`;
    canvas.style.height = `${heightPx}px`;
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

  const syncStrokesToParent = (next: Stroke[]) => {
    localSyncRef.current = true;
    onChangeStrokes(next);
    window.setTimeout(() => {
      localSyncRef.current = false;
    }, 0);
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
    const w = mode === "erase" ? eraserWidth : width;
    strokesRef.current.push({
      points: [{ x, y }],
      color,
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
    if (mode === "graph") {
      createGraphAt(x, y);
      setMode("draw");
      activePointerIdRef.current = null;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      return;
    }
    if (mode === "line") {
      lineStartRef.current = { x, y };
      linePreviewRef.current = { points: [{ x, y }, { x, y }], color, width, mode: "draw" };
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
      linePreviewRef.current = { points: [lineStartRef.current, { x: last.x, y: last.y }], color, width, mode: "draw" };
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
      syncStrokesToParent([...strokesRef.current]);
    };
  }, [onChangeStrokes]);

  useEffect(() => {
    if (localSyncRef.current) return;
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
    setColor(initialPenColor);
  }, [initialPenColor]);

  useEffect(() => {
    setBg(initialBgColor);
  }, [initialBgColor]);

  const handleUndo = () => {
    if (!canUndo) return;
    onReplayOp?.({ op: "undo", ts: Date.now() });
  };

  const handleRedo = () => {
    if (!canRedo) return;
    onReplayOp?.({ op: "redo", ts: Date.now() });
  };

  const handleClear = () => {
    if (strokesRef.current.length === 0 && graphsRef.current.length === 0) return;
    onReplayOp?.({ op: "clear", ts: Date.now() });
    strokesRef.current = [];
    syncGraphsToParent([]);
    setSelectedGraphId(null);
    scheduleRender();
    syncStrokesToParent([]);
  };

  const handleSnapshot = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const url = canvas.toDataURL("image/png");
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

  const handleOcr = async () => {
    if (!ocrEnabled) return;
    setLoading(true);
    try {
      const blob = await renderOcrBlob();
      if (!blob) {
        onOcrText(tl("ocr_not_available"));
        return;
      }
      const res = await callOcr(blob);
      onOcrText(res.text);
    } catch {
      onOcrText(tl("ocr_not_available"));
    } finally {
      setLoading(false);
    }
  };

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
      className={cn("glass flex h-full flex-col rounded-2xl shadow-glass", expanded ? "p-2" : "p-4")}
    >
      <div ref={areaRef} className="relative flex-1 min-h-0 overflow-hidden">
        <div className="absolute inset-0 flex items-stretch justify-stretch">
          <div
            className="relative rounded-2xl border border-white/10 overflow-hidden"
            style={{
              width: `${widthPx}px`,
              height: `${heightPx}px`,
              backgroundColor: bg,
            }}
          >
            <canvas
              ref={canvasRef}
              className="block h-full w-full rounded-2xl"
              style={{ touchAction: "none" }}
              onContextMenu={(e) => e.preventDefault()}
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
              {graphs.map((graph) => (
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
                  interactionDisabled={mode === "pan"}
                />
              ))}
            </div>
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-black/40 text-sm">
                {tl("recognition_loading")}
              </div>
            )}
          </div>
        </div>
      </div>
      <div data-testid="board-toolbar" className="scrollbar-hide mt-3 flex flex-nowrap items-center gap-2 overflow-x-auto pb-1 [&>*]:shrink-0">
        <Button variant="outline" size="sm" onClick={onTogglePanels}>
          <Menu size={14} className="mr-2" /> {tl("panels")}
        </Button>
        <div className="relative">
          <Button
            variant={mode === "draw" ? "accent" : "outline"}
            size="sm"
            onClick={() => {
              setMode("draw");
              setShowPenSlider(true);
              setShowPenPalette(true);
              setShowLineSlider(false);
              schedulePenHide();
              closeBoardSettings();
            }}
          >
            <Paintbrush size={14} className="mr-2" /> {tl("pen")}
          </Button>
          <AnimatePresence>
            {showPenPalette && mode === "draw" && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                className="absolute bottom-full left-0 z-50 mb-2 rounded-xl border border-white/10 bg-ink/95 px-2 py-2 shadow-glass backdrop-blur"
                onPointerDown={schedulePenHide}
                onPointerUp={schedulePenHide}
                onPointerMove={schedulePenHide}
              >
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
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="relative">
          <Button
            variant={mode === "line" ? "accent" : "outline"}
            size="sm"
            onClick={() => {
              setMode("line");
              setShowLineSlider(true);
              setShowPenPalette(false);
              setShowAllPens(false);
              setShowPenSlider(false);
              scheduleLineHide();
              closeBoardSettings();
            }}
          >
            <Minus size={14} className="mr-2" /> {tl("line")}
          </Button>
          <AnimatePresence>
            {showLineSlider && mode === "line" && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                className="absolute bottom-full left-0 z-50 mb-2 rounded-xl border border-white/10 bg-ink/95 px-2 py-2 shadow-glass backdrop-blur"
                onPointerDown={scheduleLineHide}
                onPointerUp={scheduleLineHide}
                onPointerMove={scheduleLineHide}
              >
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
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <Button
          variant={mode === "graph" ? "accent" : "outline"}
          size="sm"
          aria-label={tl("graph")}
          onClick={() => {
            setMode("graph");
            setShowPenSlider(false);
            setShowPenPalette(false);
            setShowAllPens(false);
            setShowEraserSlider(false);
            setShowLineSlider(false);
            closeBoardSettings();
          }}
        >
          <ChartSpline size={14} className="mr-2" /> {tl("graph")}
        </Button>
        <Button
          variant={mode === "pan" ? "accent" : "outline"}
          size="sm"
          disabled={boardLock}
          onClick={() => {
            setMode("pan");
            setShowPenSlider(false);
            setShowPenPalette(false);
            setShowAllPens(false);
            setShowEraserSlider(false);
            setShowLineSlider(false);
            closeBoardSettings();
          }}
        >
          <Hand size={14} className="mr-2" /> {tl("moving")}
        </Button>
        <Button
          variant={boardLock ? "accent" : "outline"}
          size="sm"
          onClick={() => setBoardLock((v) => !v)}
          title={boardLock ? tl("board_lock_on") : tl("board_lock_off")}
        >
          {boardLock ? <Lock size={14} className="mr-2" /> : <Unlock size={14} className="mr-2" />}
          {tl("board_lock")}
        </Button>
        <div className="relative">
          <Button
            variant={mode === "erase" ? "accent" : "outline"}
            size="sm"
            onClick={() => {
            setMode("erase");
            setShowEraserSlider(true);
            setShowPenPalette(false);
            setShowAllPens(false);
            setShowLineSlider(false);
            scheduleEraserHide();
            closeBoardSettings();
          }}
        >
          <Eraser size={14} className="mr-2" /> {tl("eraser")}
        </Button>
          <AnimatePresence>
            {showEraserSlider && mode === "erase" && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                className="absolute bottom-full left-0 z-50 mb-2 rounded-xl border border-white/10 bg-ink/95 px-2 py-2 shadow-glass backdrop-blur"
                onPointerDown={scheduleEraserHide}
                onPointerUp={scheduleEraserHide}
                onPointerMove={scheduleEraserHide}
              >
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
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="relative">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setShowBoardSettings((v) => !v);
              setShowAllBg(false);
            }}
          >
            <Grid3x3 size={14} className="mr-2" /> {tl("board")}
          </Button>
          <AnimatePresence>
            {showBoardSettings && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                className="absolute bottom-full left-0 z-40 mb-2 rounded-xl border border-white/10 bg-ink/95 px-3 py-2 shadow-glass backdrop-blur"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs text-frost/60">{tl("grid")}</span>
                  <Button variant={grid ? "accent" : "outline"} size="sm" onClick={() => setGrid((v) => !v)}>
                    {grid ? tl("grid_on") : tl("grid_off")}
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
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="relative flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-2 py-1">
          <button
            className={cn(
              "relative z-10 rounded-full px-3 py-1 text-xs font-semibold transition",
              inputMode === "auto" ? "text-ink" : "text-frost/70 hover:text-frost"
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
            <span className="relative z-10">{tl("auto")}</span>
          </button>
          <button
            className={cn(
              "relative z-10 rounded-full px-3 py-1 text-xs font-semibold transition",
              inputMode === "mouse" ? "text-ink" : "text-frost/70 hover:text-frost"
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
            <span className="relative z-10">{tl("mouse")}</span>
          </button>
          <button
            className={cn(
              "relative z-10 rounded-full px-3 py-1 text-xs font-semibold transition",
              inputMode === "touch" ? "text-ink" : "text-frost/70 hover:text-frost"
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
            <span className="relative z-10">{tl("touch_mode")}</span>
          </button>
        </div>

        <Button variant="ghost" size="sm" className="flex h-8 w-8 items-center justify-center p-0" onClick={handleUndo} disabled={!canUndo} aria-label={tl("undo")}>
          <RotateCcw size={14} />
        </Button>
        <Button variant="ghost" size="sm" className="flex h-8 w-8 items-center justify-center p-0" onClick={handleRedo} disabled={!canRedo} aria-label={tl("redo")}>
          <RotateCw size={14} />
        </Button>
        <div className="relative flex items-center">
          <Button
            variant="ghost"
            size="sm"
            className="flex h-8 w-8 items-center justify-center p-0"
            aria-label={tl("clear_board")}
            onClick={() => {
              setShowClearConfirm((v) => !v);
              setClearSlideValue(0);
            }}
          >
            <Trash2 size={14} />
          </Button>
          <AnimatePresence>
            {showClearConfirm && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                className="absolute bottom-full right-0 z-50 mb-2 w-[260px] rounded-xl border border-white/10 bg-ink/95 px-3 py-2 shadow-glass backdrop-blur"
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
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <Button variant="outline" size="sm" onClick={handleSnapshot}>
          <Save size={14} className="mr-2" /> {tl("snapshot")}
        </Button>
        <Button
          variant={ocrEnabled ? "default" : "outline"}
          size="sm"
          onClick={handleOcr}
          disabled={!ocrEnabled || loading}
        >
          <Scan size={14} className="mr-2" /> {tl("recognize")}
        </Button>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {onToggleTask && (
            <Button variant={taskOpen ? "accent" : "outline"} size="sm" onClick={onToggleTask} aria-label={tl("exercise")} title={tl("exercise")}>
              <NotebookPen size={16} className={compactToolbar ? "" : "mr-2"} />
              {!compactToolbar && tl("exercise")}
            </Button>
          )}
          {onToggleAssistant && (
            <Button variant={assistantOpen ? "accent" : "outline"} size="sm" onClick={onToggleAssistant} aria-label={tl("ai_assistant")} title={tl("ai_assistant")}>
              <MessageSquare size={16} className={compactToolbar ? "" : "mr-2"} />
              {!compactToolbar && tl("ai_assistant")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
