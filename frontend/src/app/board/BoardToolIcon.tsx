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
  const mask = `url(${assets[tool]})`;
  return (
    <span
      aria-hidden="true"
      data-testid={`board-tool-icon-${tool}`}
      className={cn("inline-block h-7 w-7 shrink-0 bg-current", className)}
      style={{ WebkitMaskImage: mask, maskImage: mask, WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat", WebkitMaskSize: "contain", maskSize: "contain", WebkitMaskPosition: "center", maskPosition: "center" }}
    />
  );
}
