import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, MoveDiagonal2, Trash2 } from "lucide-react";
import { useI18n } from "@/i18n";
import type { GraphElement } from "./boardDocument";
import { buildGraphPathSegments, segmentsToSvgPath } from "./graphPlot";
import GraphEditor from "./GraphEditor";
import { TextOnScreenKeyboard, type VirtualKeyboardAction } from "./OnScreenKeyboard";
import { getGraphDockPlacement } from "./graphDock";

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

  const tickStep = graph.width < 330 ? 5 : graph.width < 620 ? 2 : 1;
  const ticks = useMemo(() => {
    const values: number[] = [];
    for (let value = -10; value <= 10; value += tickStep) values.push(value);
    return values;
  }, [tickStep]);

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
        width={graph.width}
        height={graph.height}
        viewBox={`0 0 ${graph.width} ${graph.height}`}
        className={selected ? "overflow-hidden rounded-lg ring-2 ring-accent/80" : "overflow-hidden rounded-lg"}
        style={{ backgroundColor }}
      >
        <rect x={0} y={0} width={graph.width} height={graph.height} rx={8} fill={backgroundColor} />
        {ticks.map((value) => (
          <g key={`grid-${value}`}>
            <line x1={mathToX(value)} y1={0} x2={mathToX(value)} y2={graph.height} stroke={gridStroke} strokeWidth={0.8} />
            <line x1={0} y1={mathToY(value)} x2={graph.width} y2={mathToY(value)} stroke={gridStroke} strokeWidth={0.8} />
          </g>
        ))}
        <line x1={axisX} y1={0} x2={axisX} y2={graph.height} stroke={axisStroke} strokeWidth={1.4} />
        <line x1={0} y1={axisY} x2={graph.width} y2={axisY} stroke={axisStroke} strokeWidth={1.4} />
        {ticks.filter((value) => value !== 0).map((value) => (
          <g key={`tick-label-${value}`}>
            <text x={mathToX(value)} y={Math.min(graph.height - 4, axisY + 14)} textAnchor="middle" fontSize={9} fill={textFill}>{value}</text>
            <text x={Math.max(4, axisX - 5)} y={mathToY(value) + 3} textAnchor="end" fontSize={9} fill={textFill}>{value}</text>
          </g>
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
            <button
              type="button"
              className="flex items-center justify-center rounded-md border border-white/15 bg-[#151b24]"
              style={{ width: controlSize, height: controlSize }}
              onClick={() => setEditorCollapsed((value) => !value)}
              aria-label={editorCollapsed ? tl("expand_graph_editor") : tl("collapse_graph_editor")}
            >
              {editorCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>
            <button
              type="button"
              className="flex items-center justify-center rounded-md border border-white/15 bg-[#151b24]"
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
