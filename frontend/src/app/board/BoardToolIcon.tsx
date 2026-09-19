import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type BoardToolArtwork = "pen" | "line" | "eraser" | "graph";

function PenArtwork({ id }: { id: string }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-body`} x1="23" y1="17" x2="41" y2="60" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffffff" />
          <stop offset=".36" stopColor="#eef2f6" />
          <stop offset=".72" stopColor="#ffffff" />
          <stop offset="1" stopColor="#b9c3ce" />
        </linearGradient>
        <linearGradient id={`${id}-collar`} x1="24" y1="12" x2="40" y2="23" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f8fafc" />
          <stop offset=".48" stopColor="#c2cbd5" />
          <stop offset="1" stopColor="#e8edf2" />
        </linearGradient>
      </defs>
      <g>
        <path d="M27.3 14.5h9.4L34 3.8h-4l-2.7 10.7Z" fill="#23272d" />
        <path d="M30.2 5.8h3.6L32 1.8l-1.8 4Z" fill="#050607" />
        <path d="M24.3 14h15.4l-1.7 10.8H26L24.3 14Z" fill={`url(#${id}-collar)`} />
        <rect x="23.5" y="21.5" width="17" height="40" rx="8.5" fill={`url(#${id}-body)`} />
        <path d="M27 29c1.8-2.1 4-3.1 6.7-3.1" stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" opacity=".9" />
      </g>
    </>
  );
}

function RulerArtwork({ id }: { id: string }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-ruler`} x1="20" y1="4" x2="44" y2="60" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f6f9fc" />
          <stop offset=".45" stopColor="#dce4ed" />
          <stop offset="1" stopColor="#bac6d3" />
        </linearGradient>
        <linearGradient id={`${id}-edge`} x1="39" y1="5" x2="44" y2="60" gradientUnits="userSpaceOnUse">
          <stop stopColor="#c8d3df" />
          <stop offset="1" stopColor="#94a3b3" />
        </linearGradient>
      </defs>
      <g>
        <rect x="20" y="3" width="24" height="58" rx="5.5" fill={`url(#${id}-ruler)`} />
        <path d="M40 5.5h1.4c1.4 0 2.6 1.2 2.6 2.6v47.8c0 1.4-1.2 2.6-2.6 2.6H40V5.5Z" fill={`url(#${id}-edge)`} opacity=".8" />
        <path d="M24 11h10M24 17h6M24 23h10M24 29h6M24 35h10M24 41h6M24 47h10M24 53h6" stroke="#5c6978" strokeWidth="1.8" strokeLinecap="round" opacity=".88" />
        <path d="M28.5 7.5v49" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" opacity=".5" />
      </g>
    </>
  );
}

function EraserArtwork({ id }: { id: string }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-front`} x1="14" y1="7" x2="49" y2="57" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffc8c2" />
          <stop offset=".48" stopColor="#ee9c98" />
          <stop offset="1" stopColor="#cf7775" />
        </linearGradient>
        <linearGradient id={`${id}-side`} x1="43" y1="8" x2="52" y2="56" gradientUnits="userSpaceOnUse">
          <stop stopColor="#dc8b88" />
          <stop offset="1" stopColor="#af595c" />
        </linearGradient>
      </defs>
      <g>
        <rect x="12.5" y="7.5" width="39" height="49" rx="10.5" fill={`url(#${id}-front)`} />
        <path d="M43.5 7.5c5 0 8 3.6 8 8.5v29c0 6.8-4.2 11.5-10.8 11.5h-4.1c5-2.4 6.8-6.2 6.8-11.2V15c0-3.2-.8-5.5-2.8-7.5h2.9Z" fill={`url(#${id}-side)`} opacity=".92" />
        <path d="M18.2 15.8c1.5-2.4 3.9-3.5 7.1-3.5h11.4" stroke="#ffe7e4" strokeWidth="3.6" strokeLinecap="round" opacity=".82" />
        <path d="M16 20.5c8.8-2.2 22.7-2.2 33.2.6" stroke="#fff0ed" strokeWidth="1.8" strokeLinecap="round" opacity=".34" />
        <path d="M16 47.5c8.8 2.5 22.7 2.6 33.2-.8" stroke="#b75f61" strokeWidth="1.9" strokeLinecap="round" opacity=".38" />
      </g>
    </>
  );
}

function GraphArtwork({ id }: { id: string }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-card`} x1="7" y1="6" x2="57" y2="58" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f4f8fd" />
          <stop offset=".52" stopColor="#dce5f0" />
          <stop offset="1" stopColor="#c5d1df" />
        </linearGradient>
        <linearGradient id={`${id}-curve`} x1="13" y1="44" x2="52" y2="20" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8d4ff0" />
          <stop offset=".58" stopColor="#6e4eef" />
          <stop offset="1" stopColor="#4b63ed" />
        </linearGradient>
      </defs>
      <g>
        <rect x="6.5" y="6.5" width="51" height="51" rx="12.5" fill={`url(#${id}-card)`} />
        <path d="M18 13.5v37M13.5 45h38.5" stroke="#526175" strokeWidth="2.2" strokeLinecap="round" opacity=".82" />
        <path d="M26 13.5v37M34 13.5v37M42 13.5v37M50 13.5v37M13.5 21h38.5M13.5 29h38.5M13.5 37h38.5" stroke="#8190a3" strokeWidth=".95" opacity=".34" />
        <path d="M13.5 43c7.8 0 10.1-20.3 18.1-20.3 7.7 0 8.9 20.3 20.1 20.3" stroke={`url(#${id}-curve)`} strokeWidth="4.5" strokeLinecap="round" fill="none" />
        <circle cx="31.6" cy="22.7" r="2.8" fill="#754ce8" />
      </g>
    </>
  );
}

const artwork: Record<BoardToolArtwork, (props: { id: string }) => ReactNode> = {
  pen: PenArtwork,
  line: RulerArtwork,
  eraser: EraserArtwork,
  graph: GraphArtwork,
};

export default function BoardToolIcon({ tool, className }: { tool: BoardToolArtwork; className?: string }) {
  const gradientId = `board-tool-${tool}-${useId().replace(/:/g, "")}`;
  const Artwork = artwork[tool];

  return (
    <span
      aria-hidden="true"
      data-tool-artwork={tool}
      className={cn("board-tool-art pointer-events-none inline-flex h-16 w-16 shrink-0", className)}
    >
      <svg
        viewBox="0 0 64 64"
        fill="none"
        aria-hidden="true"
        focusable="false"
        data-testid={`board-tool-icon-${tool}`}
        className="h-16 w-16"
      >
        <Artwork id={gradientId} />
      </svg>
    </span>
  );
}
