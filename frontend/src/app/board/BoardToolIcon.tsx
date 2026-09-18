import penAsset from "@/assets/board-tools/pen.svg";
import lineAsset from "@/assets/board-tools/line.svg";
import eraserAsset from "@/assets/board-tools/eraser.svg";
import graphAsset from "@/assets/board-tools/graph.svg";
import { cn } from "@/lib/utils";

export type BoardToolArtwork = "pen" | "line" | "eraser" | "graph";

const assets: Record<BoardToolArtwork, string> = {
  pen: penAsset,
  line: lineAsset,
  eraser: eraserAsset,
  graph: graphAsset,
};

export default function BoardToolIcon({ tool, className }: { tool: BoardToolArtwork; className?: string }) {
  return (
    <img
      src={assets[tool]}
      alt=""
      aria-hidden="true"
      data-testid={`board-tool-icon-${tool}`}
      className={cn("pointer-events-none h-12 w-12 shrink-0 object-contain drop-shadow-[0_5px_7px_rgba(0,0,0,0.28)]", className)}
    />
  );
}
