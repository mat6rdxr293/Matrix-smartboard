import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type BoardToolArtwork = "pen" | "line" | "eraser" | "graph";

function PenArtwork({ id }: { id: string }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-body`} x1="18" y1="8" x2="46" y2="52" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffffff" /><stop offset=".42" stopColor="#dfe4ea" /><stop offset=".72" stopColor="#ffffff" /><stop offset="1" stopColor="#aeb7c2" />
        </linearGradient>
        <linearGradient id={`${id}-tip`} x1="26" y1="43" x2="38" y2="61" gradientUnits="userSpaceOnUse">
          <stop stopColor="#20242a" /><stop offset="1" stopColor="#050607" />
        </linearGradient>
      </defs>
      <g>
        <path d="M22 13c0-5 4-9 10-9s10 4 10 9l-2 34H24L22 13Z" fill={`url(#${id}-body)`} />
        <path d="M25 11c2-3 5-4 8-4" stroke="#fff" strokeWidth="3" strokeLinecap="round" opacity=".85" />
        <path d="M24 43h16l-2 8H26l-2-8Z" fill="#c7ced7" />
        <path d="m27 50 5 11 5-11H27Z" fill={`url(#${id}-tip)`} />
        <path d="M32 61v-6" stroke="#050607" strokeWidth="2.5" strokeLinecap="round" />
      </g>
    </>
  );
}

function LineArtwork({ id }: { id: string }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-metal`} x1="15" y1="48" x2="49" y2="14" gradientUnits="userSpaceOnUse">
          <stop stopColor="#17191d" /><stop offset=".24" stopColor="#5d6570" /><stop offset=".5" stopColor="#eef2f6" /><stop offset=".7" stopColor="#747d88" /><stop offset="1" stopColor="#111318" />
        </linearGradient>
      </defs>
      <g transform="rotate(-45 32 32)">
        <rect x="25" y="5" width="14" height="45" rx="6" fill={`url(#${id}-metal)`} />
        <rect x="27.5" y="8" width="3" height="35" rx="1.5" fill="#fff" opacity=".65" />
        <path d="M25 46h14l-3 10h-8l-3-10Z" fill="#24272d" />
        <path d="m28 56 4 6 4-6h-8Z" fill="#090a0c" />
      </g>
    </>
  );
}

function EraserArtwork({ id }: { id: string }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-front`} x1="13" y1="12" x2="47" y2="54" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffd1cb" /><stop offset=".5" stopColor="#ec9e98" /><stop offset="1" stopColor="#c87572" />
        </linearGradient>
        <linearGradient id={`${id}-side`} x1="47" y1="15" x2="54" y2="49" gradientUnits="userSpaceOnUse">
          <stop stopColor="#d88482" /><stop offset="1" stopColor="#a55455" />
        </linearGradient>
      </defs>
      <g>
        <path d="M13 20c0-5 4-9 9-9h23c4 0 7 3 7 7v28c0 5-4 9-9 9H20c-4 0-7-3-7-7V20Z" fill={`url(#${id}-front)`} />
        <path d="M45 11c4 0 7 3 7 7v28c0 5-4 9-9 9h-4c5-2 7-6 7-11V17c0-3-1-5-3-6h2Z" fill={`url(#${id}-side)`} opacity=".85" />
        <path d="M18 19c1-3 3-4 7-4h13" stroke="#ffe9e5" strokeWidth="4" strokeLinecap="round" opacity=".65" />
        <path d="M16 46c8 2 23 2 33-1" stroke="#b46263" strokeWidth="2" opacity=".4" />
      </g>
    </>
  );
}

function GraphArtwork({ id }: { id: string }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-card`} x1="8" y1="7" x2="56" y2="57" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f8fbff" /><stop offset="1" stopColor="#cdd8e8" />
        </linearGradient>
        <linearGradient id={`${id}-curve`} x1="13" y1="43" x2="52" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7c4dff" /><stop offset="1" stopColor="#3bbbea" />
        </linearGradient>
      </defs>
      <g>
        <rect x="7" y="7" width="50" height="50" rx="11" fill={`url(#${id}-card)`} />
        <path d="M17 14v36M11 44h41" stroke="#536174" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M25 14v36M33 14v36M41 14v36M49 14v36M11 20h41M11 28h41M11 36h41" stroke="#8795a8" strokeWidth="1" opacity=".35" />
        <path d="M12 42c8 0 10-20 18-20s9 20 21 20" stroke={`url(#${id}-curve)`} strokeWidth="4.5" strokeLinecap="round" fill="none" />
        <circle cx="30" cy="22" r="3" fill="#7248ed" />
      </g>
    </>
  );
}

const artwork: Record<BoardToolArtwork, (props: { id: string }) => ReactNode> = {
  pen: PenArtwork,
  line: LineArtwork,
  eraser: EraserArtwork,
  graph: GraphArtwork,
};

export default function BoardToolIcon({ tool, className }: { tool: BoardToolArtwork; className?: string }) {
  const gradientId = `board-tool-${tool}-${useId().replaceAll(":", "")}`;
  const Artwork = artwork[tool];

  return (
    <span
      aria-hidden="true"
      data-parallax-art="true"
      className={cn("board-tool-art pointer-events-none inline-flex h-14 w-14 shrink-0", className)}
    >
      <svg
        viewBox="0 0 64 64"
        fill="none"
        aria-hidden="true"
        focusable="false"
        data-testid={`board-tool-icon-${tool}`}
        className="h-14 w-14"
      >
        <Artwork id={gradientId} />
      </svg>
    </span>
  );
}
