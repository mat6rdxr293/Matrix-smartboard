type Rect = { x: number; y: number; width: number; height: number };
type VisibleWorld = { left: number; top: number; right: number; bottom: number };

export type GraphDockPlacement = {
  side: "right" | "left" | "bottom" | "top";
  left: number;
  top: number;
};

const GAP = 12;
const EDGE = 8;
const clamp = (value: number, min: number, max: number) => max < min ? min : Math.min(Math.max(value, min), max);

export function getGraphDockPlacement(
  graph: Rect,
  visible: VisibleWorld,
  panelWidth: number,
  panelHeight: number,
): GraphDockPlacement {
  const rightSpace = visible.right - (graph.x + graph.width);
  const leftSpace = graph.x - visible.left;
  const bottomSpace = visible.bottom - (graph.y + graph.height);
  const topSpace = graph.y - visible.top;

  if (rightSpace >= panelWidth + GAP) {
    return { side: "right", left: graph.width + GAP, top: 0 };
  }
  if (leftSpace >= panelWidth + GAP) {
    return { side: "left", left: -panelWidth - GAP, top: 0 };
  }
  if (bottomSpace >= panelHeight + GAP || bottomSpace >= topSpace) {
    const worldLeft = clamp(graph.x, visible.left + EDGE, visible.right - panelWidth - EDGE);
    return { side: "bottom", left: worldLeft - graph.x, top: graph.height + GAP };
  }
  const worldLeft = clamp(graph.x, visible.left + EDGE, visible.right - panelWidth - EDGE);
  return { side: "top", left: worldLeft - graph.x, top: -panelHeight - GAP };
}
