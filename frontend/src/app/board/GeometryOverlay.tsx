import { useId, useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  COMPASS_HANDLE_RADIUS,
  GEOMETRY_CM,
  PROTRACTOR_RADIUS,
  RULER_LENGTH,
  RULER_WIDTH,
  compassHinge,
  rotateHandle,
  snapAngle,
  type GeometryTool,
} from "./geometry";

type Props = {
  tool: GeometryTool;
  zoom: number;
  pan: { x: number; y: number };
  onChange: (tool: GeometryTool) => void;
};

type Drag = { part: "body" | "rotate" | "pin" | "hinge"; start: { x: number; y: number }; tool: GeometryTool };

const LINE = "rgb(var(--color-frost) / 0.75)";
const HANDLE = "rgb(var(--color-accent) / 0.85)";
const INK = "rgb(var(--color-frost) / 0.9)";
const FROST = "rgb(var(--color-frost))";

/** Shared look of clear tinted plastic: body gradient, top-edge glint and a soft drop shadow. */
function PlasticDefs({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={`${id}-body`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style={{ stopColor: FROST, stopOpacity: 0.26 }} />
        <stop offset="0.18" style={{ stopColor: FROST, stopOpacity: 0.12 }} />
        <stop offset="0.82" style={{ stopColor: FROST, stopOpacity: 0.08 }} />
        <stop offset="1" style={{ stopColor: FROST, stopOpacity: 0.18 }} />
      </linearGradient>
      <radialGradient id={`${id}-disc`} cx="0.5" cy="1" r="1">
        <stop offset="0" style={{ stopColor: FROST, stopOpacity: 0.06 }} />
        <stop offset="0.7" style={{ stopColor: FROST, stopOpacity: 0.12 }} />
        <stop offset="0.96" style={{ stopColor: FROST, stopOpacity: 0.24 }} />
        <stop offset="1" style={{ stopColor: FROST, stopOpacity: 0.34 }} />
      </radialGradient>
      <linearGradient id={`${id}-glint`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="white" stopOpacity="0" />
        <stop offset="0.35" stopColor="white" stopOpacity="0.55" />
        <stop offset="0.65" stopColor="white" stopOpacity="0.2" />
        <stop offset="1" stopColor="white" stopOpacity="0" />
      </linearGradient>
      <filter id={`${id}-shadow`} x="-10%" y="-20%" width="120%" height="160%">
        <feDropShadow dx="0" dy="6" stdDeviation="7" floodColor="black" floodOpacity="0.35" />
      </filter>
    </defs>
  );
}

/** Ruler, protractor or compass drawn in board units; dragging moves, turns or resizes it. */
export default function GeometryOverlay({ tool, zoom, pan, onChange }: Props) {
  const id = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<Drag | null>(null);

  const toWorld = (event: ReactPointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left - pan.x) / zoom, y: (event.clientY - rect.top - pan.y) / zoom };
  };

  const begin = (part: Drag["part"]) => (event: ReactPointerEvent<SVGElement>) => {
    event.stopPropagation();
    event.preventDefault();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    dragRef.current = { part, start: toWorld(event), tool };
  };

  const move = (event: ReactPointerEvent<SVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    event.stopPropagation();
    const p = toWorld(event);
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    const t = drag.tool;
    if (t.kind === "compass") {
      // The hinge sits halfway along the legs, so the pencil moves twice as far.
      if (drag.part === "hinge") onChange({ ...t, px: t.px + dx * 2, py: t.py + dy * 2 });
      else onChange({ ...t, x: t.x + dx, y: t.y + dy, px: t.px + dx, py: t.py + dy });
      return;
    }
    if (drag.part === "rotate") {
      const raw = Math.atan2(p.y - t.y, p.x - t.x) + (t.kind === "protractor" ? Math.PI / 2 : 0);
      onChange({ ...t, angle: snapAngle(raw) });
      return;
    }
    onChange({ ...t, x: t.x + dx, y: t.y + dy });
  };

  const end = (event: ReactPointerEvent<SVGElement>) => {
    if (!dragRef.current) return;
    event.stopPropagation();
    dragRef.current = null;
  };

  const handlers = (part: Drag["part"]) => ({
    onPointerDown: begin(part),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
    style: { pointerEvents: "all" as const, cursor: part === "rotate" ? "grab" : "move" },
  });

  const handle = (x: number, y: number, part: Drag["part"]) => (
    <circle cx={x} cy={y} r={COMPASS_HANDLE_RADIUS} fill={HANDLE} stroke={LINE} strokeWidth={1.5}
      vectorEffect="non-scaling-stroke" {...handlers(part)} />
  );

  const degrees = (radians: number) => Math.round((((radians * 180) / Math.PI) % 360 + 360) % 360);

  let body = null;
  if (tool.kind === "ruler") {
    const mm = GEOMETRY_CM / 10;
    const half = RULER_LENGTH / 2;
    const top = -RULER_WIDTH / 2;
    const inset = 14; // the scale starts a little in from the end, as on a real ruler
    const ticks = [];
    for (let i = 0; i <= (RULER_LENGTH - inset * 2) / mm; i++) {
      const x = -half + inset + i * mm;
      const length = i % 10 === 0 ? 20 : i % 5 === 0 ? 13 : 8;
      ticks.push(<line key={i} x1={x} y1={top} x2={x} y2={top + length} stroke={INK}
        strokeWidth={i % 10 === 0 ? 1.4 : 0.9} vectorEffect="non-scaling-stroke" />);
      if (i % 10 === 0) {
        ticks.push(<text key={`l${i}`} x={x} y={top + 35} fontSize={13} fontWeight={600} textAnchor="middle"
          fill={INK} style={{ fontFeatureSettings: '"tnum"' }}>{i / 10}</text>);
      }
    }
    const h = rotateHandle(tool);
    body = (
      <>
        <PlasticDefs id={id} />
        <g transform={`translate(${tool.x} ${tool.y}) rotate(${(tool.angle * 180) / Math.PI})`}>
          <g filter={`url(#${id}-shadow)`}>
            <rect x={-half} y={top} width={RULER_LENGTH} height={RULER_WIDTH} rx={5}
              fill={`url(#${id}-body)`} stroke={FROST} strokeOpacity={0.45} strokeWidth={1.2}
              vectorEffect="non-scaling-stroke" {...handlers("body")} />
          </g>
          <g style={{ pointerEvents: "none" }}>
            {/* Light catching the bevel along the measuring edge, and the darker back edge. */}
            <rect x={-half + 3} y={top + 1.5} width={RULER_LENGTH - 6} height={2.5} rx={1.2} fill={`url(#${id}-glint)`} />
            <line x1={-half + 5} y1={-top - 1.5} x2={half - 5} y2={-top - 1.5} stroke="black" strokeOpacity={0.25}
              strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            {ticks}
            <text x={half - inset - 4} y={-top - 10} fontSize={11} textAnchor="end" fill={INK} opacity={0.7}>см</text>
          </g>
        </g>
        {handle(h.x, h.y, "rotate")}
        <text x={h.x} y={h.y + 5} fontSize={13} textAnchor="middle" fill="white" style={{ pointerEvents: "none" }}>{degrees(tool.angle)}°</text>
      </>
    );
  } else if (tool.kind === "protractor") {
    const R = PROTRACTOR_RADIUS;
    const inner = R * 0.42; // the clear cut-out over the vertex
    const ticks = [];
    for (let d = 0; d <= 180; d++) {
      const a = (-d * Math.PI) / 180;
      const length = d % 10 === 0 ? 20 : d % 5 === 0 ? 13 : 7;
      ticks.push(<line key={d} x1={R * Math.cos(a)} y1={R * Math.sin(a)} x2={(R - length) * Math.cos(a)} y2={(R - length) * Math.sin(a)}
        stroke={INK} strokeWidth={d % 10 === 0 ? 1.3 : 0.8} vectorEffect="non-scaling-stroke" />);
      if (d % 10 === 0) {
        // Outer row counts from the right, inner row from the left, so either arm can be read.
        const r1 = R - 33;
        const r2 = R - 54;
        ticks.push(<text key={`o${d}`} x={r1 * Math.cos(a)} y={r1 * Math.sin(a) + 4} fontSize={12} fontWeight={600} textAnchor="middle" fill={INK}>{d}</text>);
        ticks.push(<text key={`i${d}`} x={r2 * Math.cos(a)} y={r2 * Math.sin(a) + 3.5} fontSize={10} textAnchor="middle" fill={INK} opacity={0.65}>{180 - d}</text>);
      }
      if (d % 30 === 0 && d > 0 && d < 180) {
        ticks.push(<line key={`g${d}`} x1={inner * Math.cos(a)} y1={inner * Math.sin(a)} x2={(R - 62) * Math.cos(a)} y2={(R - 62) * Math.sin(a)}
          stroke={INK} strokeOpacity={0.18} strokeWidth={0.8} vectorEffect="non-scaling-stroke" />);
      }
    }
    const h = rotateHandle(tool);
    const plate = `M ${-R} 0 A ${R} ${R} 0 0 1 ${R} 0 L ${inner} 0 A ${inner} ${inner} 0 0 0 ${-inner} 0 Z`;
    body = (
      <>
        <PlasticDefs id={id} />
        <g transform={`translate(${tool.x} ${tool.y}) rotate(${(tool.angle * 180) / Math.PI})`}>
          <g filter={`url(#${id}-shadow)`}>
            <path d={plate} fill={`url(#${id}-disc)`} fillRule="evenodd" stroke={FROST} strokeOpacity={0.45} strokeWidth={1.2}
              vectorEffect="non-scaling-stroke" {...handlers("body")} />
            {/* The cut-out still moves the protractor, like gripping its inner rim. */}
            <path d={`M ${-inner} 0 A ${inner} ${inner} 0 0 1 ${inner} 0 Z`} fill={FROST} fillOpacity={0.04}
              stroke={FROST} strokeOpacity={0.3} strokeWidth={1} vectorEffect="non-scaling-stroke" {...handlers("body")} />
          </g>
          <g style={{ pointerEvents: "none" }}>
            <path d={`M ${-R + 6} -4 A ${R - 6} ${R - 6} 0 0 1 ${-R * 0.2} ${-R + 10}`} fill="none" stroke="white"
              strokeOpacity={0.35} strokeWidth={2} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            {ticks}
            <line x1={-R} y1={0} x2={R} y2={0} stroke={INK} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
            <line x1={-10} y1={0} x2={10} y2={0} stroke={INK} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            <line x1={0} y1={-10} x2={0} y2={4} stroke={INK} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            <circle cx={0} cy={0} r={2.5} fill={INK} />
          </g>
        </g>
        {handle(h.x, h.y, "rotate")}
        <text x={h.x} y={h.y + 5} fontSize={13} textAnchor="middle" fill="white" style={{ pointerEvents: "none" }}>{degrees(tool.angle)}°</text>
      </>
    );
  } else {
    const r = Math.hypot(tool.px - tool.x, tool.py - tool.y);
    body = (
      <>
        <circle cx={tool.x} cy={tool.y} r={r} fill="none" stroke={LINE} strokeOpacity={0.35} strokeDasharray="6 6"
          strokeWidth={1} vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />
        <line x1={tool.x} y1={tool.y} x2={tool.px} y2={tool.py} stroke={LINE} strokeWidth={2} vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />
        <text x={(tool.x + tool.px) / 2} y={(tool.y + tool.py) / 2 - COMPASS_HANDLE_RADIUS - 8} fontSize={14} textAnchor="middle" fill={LINE}
          style={{ pointerEvents: "none" }}>{(r / GEOMETRY_CM).toFixed(1)} см</text>
        {handle(tool.x, tool.y, "pin")}
        {handle(compassHinge(tool).x, compassHinge(tool).y, "hinge")}
        {/* The pencil draws: a stroke started here follows the circle, so it takes no drag. */}
        <circle cx={tool.px} cy={tool.py} r={COMPASS_HANDLE_RADIUS * 0.6} fill="none" stroke={HANDLE} strokeWidth={2}
          vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />
      </>
    );
  }

  return (
    // touch-action is ignored on SVG shapes; set on the root it stops the browser turning a drag into a scroll.
    <svg ref={svgRef} data-testid="geometry-overlay" data-tool={tool.kind} className="absolute inset-0 h-full w-full"
      style={{ pointerEvents: "none", touchAction: "none" }}>
      <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>{body}</g>
    </svg>
  );
}
