import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Minus, MoveDiagonal2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useI18n } from "@/i18n";
import type { GraphElement } from "./boardDocument";
import { buildGraphPathSegments, segmentsToSvgPath } from "./graphPlot";
import GraphEditor from "./GraphEditor";
import { TextOnScreenKeyboard, type VirtualKeyboardAction } from "./OnScreenKeyboard";
import { getGraphDockPlacement } from "./graphDock";
import { DEFAULT_GRAPH_VIEWPORT, formatGraphTick, getGraphTicks, getGraphTickStep, panGraphViewport, zoomGraphViewport, type GraphViewport } from "./graphViewport";

type VisibleWorld = { left: number; top: number; right: number; bottom: number };

type Props = {
  graph: GraphElement;
  selected: boolean;
  backgroundColor: string;
  isDarkBackground: boolean;
  zoom: number;
  visibleWorld: VisibleWorld;
  onSelect: () => void;
  onPreview: (graph: GraphElement) => void;
  onCommit: (before: GraphElement, after: GraphElement) => void;
  onDelete: (graph: GraphElement) => void;
  interactionDisabled?: boolean;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export default function GraphElementView(props: Props) {
  const { graph, selected, backgroundColor, isDarkBackground, zoom, visibleWorld, onSelect, onPreview, onCommit, onDelete, interactionDisabled = false } = props;
  const { tl } = useI18n();
  const [editorCollapsed, setEditorCollapsed] = useState(false);
  const [editingLabel, setEditingLabel] = useState<"x" | "y" | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [plotDragging, setPlotDragging] = useState(false);
  const labelInputRef = useRef<HTMLInputElement | null>(null);
  const labelSelectionRef = useRef({ start: 0, end: 0 });
  const dragRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    before: GraphElement;
    last: GraphElement;
  } | null>(null);
  const resizeRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    before: GraphElement;
    last: GraphElement;
  } | null>(null);
  const wheelGestureRef = useRef<{ before: GraphElement; last: GraphElement; timer: ReturnType<typeof setTimeout> } | null>(null);
  const plotPanRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    before: GraphElement;
    last: GraphElement;
  } | null>(null);
  const touchPointsRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{
    before: GraphElement;
    base: GraphElement;
    last: GraphElement;
    viewport: GraphViewport;
    distance: number;
    anchor: { x: number; y: number };
    center: { x: number; y: number };
  } | null>(null);

  const controlSize = Math.max(28, 28 / Math.max(zoom, 0.1));
  const uiScale = 1 / Math.min(Math.max(zoom, 0.1), 1);
  const dockWidthCss = editingLabel ? 500 : 320;
  const dockHeightCss = editingLabel ? 680 : 650;
  const dockPlacement = getGraphDockPlacement(
    graph,
    visibleWorld,
    dockWidthCss * uiScale,
    dockHeightCss * uiScale,
  );
  const mathToX = (x: number) => ((x - graph.xMin) / (graph.xMax - graph.xMin)) * graph.width;
  const mathToY = (y: number) => ((graph.yMax - y) / (graph.yMax - graph.yMin)) * graph.height;
  const axisX = mathToX(0);
  const axisY = mathToY(0);
  const gridStroke = isDarkBackground ? "rgba(255,255,255,0.12)" : "rgba(15,23,42,0.14)";
  const axisStroke = isDarkBackground ? "rgba(255,255,255,0.68)" : "rgba(15,23,42,0.68)";
  const textFill = isDarkBackground ? "rgba(255,255,255,0.78)" : "rgba(15,23,42,0.8)";

  const xTickStep = getGraphTickStep(graph.xMin, graph.xMax);
  const yTickStep = getGraphTickStep(graph.yMin, graph.yMax);
  const xTicks = useMemo(() => getGraphTicks(graph.xMin, graph.xMax, xTickStep), [graph.xMax, graph.xMin, xTickStep]);
  const yTicks = useMemo(() => getGraphTicks(graph.yMin, graph.yMax, yTickStep), [graph.yMax, graph.yMin, yTickStep]);

  const curves = useMemo(() => graph.expressions.map((item) => {
    if (!item.visible) return { id: item.id, color: item.color, path: "" };
    try {
      return {
        id: item.id,
        color: item.color,
        path: segmentsToSvgPath(buildGraphPathSegments(item.expression, {
          width: graph.width,
          height: graph.height,
          xMin: graph.xMin,
          xMax: graph.xMax,
          yMin: graph.yMin,
          yMax: graph.yMax,
        })),
      };
    } catch {
      return { id: item.id, color: item.color, path: "" };
    }
  }), [graph.expressions, graph.height, graph.width, graph.xMax, graph.xMin, graph.yMax, graph.yMin]);

  const viewportOf = (source: GraphElement): GraphViewport => ({
    xMin: source.xMin, xMax: source.xMax, yMin: source.yMin, yMax: source.yMax,
  });
  const withViewport = (source: GraphElement, viewport: GraphViewport): GraphElement => ({ ...source, ...viewport });

  const finishWheelGesture = () => {
    const gesture = wheelGestureRef.current;
    if (!gesture) return;
    clearTimeout(gesture.timer);
    wheelGestureRef.current = null;
    onCommit(gesture.before, gesture.last);
  };

  const handleWheel = (event: React.WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect();
    const rect = event.currentTarget.getBoundingClientRect();
    const anchor = {
      x: rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5,
      y: rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5,
    };
    const active = wheelGestureRef.current;
    const base = active?.last ?? graph;
    const before = active?.before ?? graph;
    const viewport = zoomGraphViewport(viewportOf(base), Math.exp(event.deltaY * 0.0015), anchor);
    const next = withViewport(base, viewport);
    onPreview(next);
    if (active) clearTimeout(active.timer);
    const timer = setTimeout(() => {
      const pending = wheelGestureRef.current;
      if (!pending) return;
      wheelGestureRef.current = null;
      onCommit(pending.before, pending.last);
    }, 220);
    wheelGestureRef.current = { before, last: next, timer };
  };

  const pointerDistance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const pointerCenter = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });

  const startPlotPan = (id: number, x: number, y: number, before: GraphElement) => {
    plotPanRef.current = { id, startX: x, startY: y, before, last: before };
    setPlotDragging(true);
  };

  const previewPlotPan = (event: React.PointerEvent<SVGSVGElement>) => {
    const pan = plotPanRef.current;
    if (!pan || pan.id !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const viewport = panGraphViewport(
      viewportOf(pan.before),
      { x: event.clientX - pan.startX, y: event.clientY - pan.startY },
      { width: rect.width, height: rect.height },
    );
    const next = withViewport(pan.before, viewport);
    pan.last = next;
    onPreview(next);
  };

  const handlePlotPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect();
    finishWheelGesture();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    if (event.pointerType !== "touch") {
      startPlotPan(event.pointerId, event.clientX, event.clientY, graph);
      return;
    }

    touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touchPointsRef.current.size === 1) {
      startPlotPan(event.pointerId, event.clientX, event.clientY, graph);
      return;
    }
    if (touchPointsRef.current.size !== 2) return;

    const [a, b] = Array.from(touchPointsRef.current.values());
    const center = pointerCenter(a, b);
    const rect = event.currentTarget.getBoundingClientRect();
    const existingPan = plotPanRef.current;
    const base = existingPan?.last ?? graph;
    const before = existingPan?.before ?? graph;
    plotPanRef.current = null;
    pinchRef.current = {
      before,
      base,
      last: base,
      viewport: viewportOf(base),
      distance: Math.max(1, pointerDistance(a, b)),
      anchor: {
        x: rect.width > 0 ? (center.x - rect.left) / rect.width : 0.5,
        y: rect.height > 0 ? (center.y - rect.top) / rect.height : 0.5,
      },
      center,
    };
    setPlotDragging(true);
  };

  const handlePlotPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.pointerType === "touch" && touchPointsRef.current.has(event.pointerId)) {
      touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    const pinch = pinchRef.current;
    if (pinch && touchPointsRef.current.size >= 2) {
      const [a, b] = Array.from(touchPointsRef.current.values());
      const center = pointerCenter(a, b);
      const rect = event.currentTarget.getBoundingClientRect();
      const factor = pinch.distance / Math.max(1, pointerDistance(a, b));
      const zoomed = zoomGraphViewport(pinch.viewport, factor, pinch.anchor);
      const viewport = panGraphViewport(
        zoomed,
        { x: center.x - pinch.center.x, y: center.y - pinch.center.y },
        { width: rect.width, height: rect.height },
      );
      const next = withViewport(pinch.base, viewport);
      pinch.last = next;
      onPreview(next);
      return;
    }

    previewPlotPan(event);
  };

  const handlePlotPointerEnd = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.pointerType === "touch") touchPointsRef.current.delete(event.pointerId);
    event.currentTarget.releasePointerCapture?.(event.pointerId);

    const pinch = pinchRef.current;
    if (pinch && touchPointsRef.current.size < 2) {
      pinchRef.current = null;
      if (pinch.last !== pinch.before) onCommit(pinch.before, pinch.last);
      const remaining = Array.from(touchPointsRef.current.entries())[0];
      if (remaining) {
        startPlotPan(remaining[0], remaining[1].x, remaining[1].y, pinch.last);
      } else {
        plotPanRef.current = null;
        setPlotDragging(false);
      }
      return;
    }

    const pan = plotPanRef.current;
    if (!pan || pan.id !== event.pointerId) return;
    plotPanRef.current = null;
    setPlotDragging(false);
    if (pan.last !== pan.before) onCommit(pan.before, pan.last);
  };

  const commitZoom = (factor: number) => {
    finishWheelGesture();
    const after = withViewport(graph, zoomGraphViewport(viewportOf(graph), factor));
    onPreview(after);
    onCommit(graph, after);
  };

  const resetViewport = () => {
    finishWheelGesture();
    const after = withViewport(graph, DEFAULT_GRAPH_VIEWPORT);
    if (graph.xMin === -10 && graph.xMax === 10 && graph.yMin === -10 && graph.yMax === 10) return;
    onPreview(after);
    onCommit(graph, after);
  };

  const clampPosition = (next: GraphElement): GraphElement => ({
    ...next,
    x: clamp(next.x, visibleWorld.left + 48 - next.width, visibleWorld.right - 48),
    y: clamp(next.y, visibleWorld.top + 48 - next.height, visibleWorld.bottom - 48),
  });

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, before: graph, last: graph };
  };

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    const next = clampPosition({
      ...drag.before,
      x: drag.before.x + (event.clientX - drag.startX) / zoom,
      y: drag.before.y + (event.clientY - drag.startY) / zoom,
    });
    drag.last = next;
    onPreview(next);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (drag.last.x !== drag.before.x || drag.last.y !== drag.before.y) onCommit(drag.before, drag.last);
  };

  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    resizeRef.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, before: graph, last: graph };
  };

  const moveResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.id !== event.pointerId) return;
    const next = {
      ...resize.before,
      width: clamp(resize.before.width + (event.clientX - resize.startX) / zoom, 260, 1200),
      height: clamp(resize.before.height + (event.clientY - resize.startY) / zoom, 190, 900),
    };
    resize.last = next;
    onPreview(next);
  };

  const endResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.id !== event.pointerId) return;
    resizeRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (resize.last.width !== resize.before.width || resize.last.height !== resize.before.height) onCommit(resize.before, resize.last);
  };

  const beginLabelEdit = (axis: "x" | "y") => {
    if (!selected) return;
    const value = axis === "x" ? graph.xLabel : graph.yLabel;
    setEditingLabel(axis);
    setLabelDraft(value);
    labelSelectionRef.current = { start: value.length, end: value.length };
  };

  useEffect(() => {
    if (!editingLabel || !labelInputRef.current) return;
    const position = labelDraft.length;
    labelInputRef.current.focus();
    labelInputRef.current.setSelectionRange(position, position);
    labelSelectionRef.current = { start: position, end: position };
  }, [editingLabel]);

  const rememberLabelSelection = (input: HTMLInputElement) => {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    labelSelectionRef.current = { start, end };
  };

  const restoreLabelCaret = (position: number) => {
    labelSelectionRef.current = { start: position, end: position };
    labelInputRef.current?.focus();
    labelInputRef.current?.setSelectionRange(position, position);
  };

  const commitLabel = (axis: "x" | "y") => {
    const value = labelDraft.slice(0, 32);
    const after = axis === "x" ? { ...graph, xLabel: value } : { ...graph, yLabel: value };
    setEditingLabel(null);
    if ((axis === "x" ? graph.xLabel : graph.yLabel) === value) return;
    onPreview(after);
    onCommit(graph, after);
  };

  const cancelLabel = () => {
    setEditingLabel(null);
    setLabelDraft("");
  };

  const handleTextKeyboard = (action: VirtualKeyboardAction) => {
    if (!editingLabel) return;
    let { start, end } = labelSelectionRef.current;
    start = Math.max(0, Math.min(start, labelDraft.length));
    end = Math.max(start, Math.min(end, labelDraft.length));

    if (action.type === "done") {
      commitLabel(editingLabel);
      return;
    }
    if (action.type === "cancel") {
      cancelLabel();
      return;
    }
    if (action.type === "clear") {
      setLabelDraft("");
      restoreLabelCaret(0);
      return;
    }
    if (action.type === "left" || action.type === "right") {
      const position = action.type === "left" ? Math.max(0, start - 1) : Math.min(labelDraft.length, end + 1);
      restoreLabelCaret(position);
      return;
    }
    if (action.type === "backspace") {
      if (start === end && start === 0) return;
      const from = start === end ? start - 1 : start;
      setLabelDraft(labelDraft.slice(0, from) + labelDraft.slice(end));
      restoreLabelCaret(from);
      return;
    }
    if (action.type === "insert") {
      const available = 32 - (labelDraft.length - (end - start));
      const inserted = action.value.slice(0, Math.max(0, available));
      if (!inserted) return;
      setLabelDraft(labelDraft.slice(0, start) + inserted + labelDraft.slice(end));
      restoreLabelCaret(start + inserted.length);
    }
  };

  return (
    <div
      data-testid={`graph-element-${graph.id}`}
      data-graph-interactive="true"
      className={`absolute ${interactionDisabled ? "pointer-events-none" : "pointer-events-auto"}`}
      style={{
        left: 0,
        top: 0,
        width: graph.width,
        height: graph.height,
        zIndex: selected ? 30 : 10,
        transform: `translate3d(${graph.x}px, ${graph.y}px, 0)`,
        willChange: "transform",
        backfaceVisibility: "hidden",
        isolation: "isolate",
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      <svg
        data-testid="graph-plot"
        width={graph.width}
        height={graph.height}
        viewBox={`0 0 ${graph.width} ${graph.height}`}
        className={selected ? "overflow-hidden rounded-lg ring-2 ring-accent/80" : "overflow-hidden rounded-lg"}
        style={{
          backgroundColor,
          touchAction: "none",
          cursor: interactionDisabled ? "default" : plotDragging ? "grabbing" : "grab",
        }}
        onWheel={handleWheel}
        onPointerDown={handlePlotPointerDown}
        onPointerMove={handlePlotPointerMove}
        onPointerUp={handlePlotPointerEnd}
        onPointerCancel={handlePlotPointerEnd}
      >
        <rect x={0} y={0} width={graph.width} height={graph.height} rx={8} fill={backgroundColor} />
        {xTicks.map((value) => (
          <line key={`grid-x-${value}`} x1={mathToX(value)} y1={0} x2={mathToX(value)} y2={graph.height} stroke={gridStroke} strokeWidth={0.8} />
        ))}
        {yTicks.map((value) => (
          <line key={`grid-y-${value}`} x1={0} y1={mathToY(value)} x2={graph.width} y2={mathToY(value)} stroke={gridStroke} strokeWidth={0.8} />
        ))}
        <line x1={axisX} y1={0} x2={axisX} y2={graph.height} stroke={axisStroke} strokeWidth={1.4} />
        <line x1={0} y1={axisY} x2={graph.width} y2={axisY} stroke={axisStroke} strokeWidth={1.4} />
        {xTicks.filter((value) => value !== 0).map((value) => (
          <text key={`tick-x-${value}`} x={mathToX(value)} y={clamp(axisY + 14, 12, graph.height - 4)} textAnchor="middle" fontSize={9} fill={textFill}>
            {formatGraphTick(value, xTickStep)}
          </text>
        ))}
        {yTicks.filter((value) => value !== 0).map((value) => (
          <text key={`tick-y-${value}`} x={clamp(axisX - 5, 24, graph.width - 4)} y={mathToY(value) + 3} textAnchor="end" fontSize={9} fill={textFill}>
            {formatGraphTick(value, yTickStep)}
          </text>
        ))}
        {curves.map((curve) => curve.path ? (
          <path
            key={curve.id}
            data-testid={`graph-curve-${curve.id}`}
            d={curve.path}
            fill="none"
            stroke={curve.color}
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null)}

        {editingLabel !== "x" && (
          <text
            data-testid="graph-x-label"
            x={graph.width - 12}
            y={Math.max(16, axisY - 7)}
            textAnchor="end"
            fontSize={12}
            fontWeight={600}
            fill={textFill}
            style={{ cursor: selected ? "text" : "default" }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => beginLabelEdit("x")}
          >{graph.xLabel}</text>
        )}
        {editingLabel !== "y" && (
          <text
            data-testid="graph-y-label"
            x={Math.min(graph.width - 12, axisX + 8)}
            y={16}
            textAnchor="start"
            fontSize={12}
            fontWeight={600}
            fill={textFill}
            style={{ cursor: selected ? "text" : "default" }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => beginLabelEdit("y")}
          >{graph.yLabel}</text>
        )}

        {editingLabel === "x" && (
          <foreignObject x={Math.max(4, graph.width - 122)} y={Math.max(2, axisY - 28)} width={116} height={30}>
            <input
              ref={labelInputRef}
              autoFocus
              value={labelDraft}
              maxLength={32}
              inputMode="none"
              aria-label={tl("x_axis_label")}
              onPointerDown={(event) => event.stopPropagation()}
              onFocus={(event) => rememberLabelSelection(event.currentTarget)}
              onClick={(event) => rememberLabelSelection(event.currentTarget)}
              onSelect={(event) => rememberLabelSelection(event.currentTarget)}
              onChange={(event) => setLabelDraft(event.target.value)}
              onBlur={() => commitLabel("x")}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") cancelLabel();
              }}
              className="h-7 w-full rounded border border-accent/60 bg-ink px-2 text-xs text-frost outline-none"
            />
          </foreignObject>
        )}
        {editingLabel === "y" && (
          <foreignObject x={Math.min(graph.width - 122, axisX + 8)} y={2} width={116} height={30}>
            <input
              ref={labelInputRef}
              autoFocus
              value={labelDraft}
              maxLength={32}
              inputMode="none"
              aria-label={tl("y_axis_label")}
              onPointerDown={(event) => event.stopPropagation()}
              onFocus={(event) => rememberLabelSelection(event.currentTarget)}
              onClick={(event) => rememberLabelSelection(event.currentTarget)}
              onSelect={(event) => rememberLabelSelection(event.currentTarget)}
              onChange={(event) => setLabelDraft(event.target.value)}
              onBlur={() => commitLabel("y")}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") cancelLabel();
              }}
              className="h-7 w-full rounded border border-accent/60 bg-ink px-2 text-xs text-frost outline-none"
            />
          </foreignObject>
        )}
      </svg>

      {selected && (
        <div
          className="absolute left-0 top-0 flex w-full items-center justify-between rounded-t-lg border-b border-white/15 bg-ink px-1"
          style={{ height: controlSize }}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          aria-label={tl("moving")}
        >
          <span className="px-2 text-[10px] font-semibold text-frost/70">{tl("graph")}</span>
          <div className="flex items-center gap-1" onPointerDown={(event) => event.stopPropagation()}>
            <button data-testid="graph-zoom-in" type="button" className="flex items-center justify-center rounded-md border border-white/15 bg-graphite" style={{ width: controlSize, height: controlSize }} onClick={() => commitZoom(0.5)} aria-label="Приблизить график">
              <Plus size={14} />
            </button>
            <button data-testid="graph-zoom-out" type="button" className="flex items-center justify-center rounded-md border border-white/15 bg-graphite" style={{ width: controlSize, height: controlSize }} onClick={() => commitZoom(2)} aria-label="Отдалить график">
              <Minus size={14} />
            </button>
            <button data-testid="graph-zoom-reset" type="button" className="flex items-center justify-center rounded-md border border-white/15 bg-graphite" style={{ width: controlSize, height: controlSize }} onClick={resetViewport} aria-label="Сбросить масштаб графика">
              <RotateCcw size={13} />
            </button>
            <button
              type="button"
              className="flex items-center justify-center rounded-md border border-white/15 bg-graphite"
              style={{ width: controlSize, height: controlSize }}
              onClick={() => setEditorCollapsed((value) => !value)}
              aria-label={editorCollapsed ? tl("expand_graph_editor") : tl("collapse_graph_editor")}
            >
              {editorCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>
            <button
              type="button"
              className="flex items-center justify-center rounded-md border border-white/15 bg-graphite"
              style={{ width: controlSize, height: controlSize }}
              onClick={() => onDelete(graph)}
              aria-label={tl("delete_graph")}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      )}

      {selected && (!editorCollapsed || editingLabel) && (
        <div
          data-testid="graph-dock-panel"
          data-side={dockPlacement.side}
          className="absolute z-[70] flex flex-col gap-2"
          style={{
            left: dockPlacement.left,
            top: dockPlacement.top,
            transform: `scale(${uiScale})`,
            transformOrigin: "top left",
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {!editorCollapsed && <GraphEditor graph={graph} onPreview={onPreview} onCommit={onCommit} />}
          {editingLabel && <TextOnScreenKeyboard onAction={handleTextKeyboard} />}
        </div>
      )}

      {selected && (
        <button
          type="button"
          className="absolute bottom-0 right-0 flex cursor-nwse-resize items-center justify-center rounded-tl-md border border-white/20 bg-ink"
          style={{ width: controlSize, height: controlSize }}
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          aria-label={tl("resize_graph")}
        >
          <MoveDiagonal2 size={14} />
        </button>
      )}
    </div>
  );
}
