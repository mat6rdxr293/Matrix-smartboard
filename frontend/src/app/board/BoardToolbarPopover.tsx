import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

type Props = {
  anchorRef: RefObject<HTMLElement>;
  open: boolean;
  align?: "left" | "right";
  testId: string;
  className?: string;
  children: ReactNode;
};

type Position = { left: number; top: number; ready: boolean };

export default function BoardToolbarPopover({
  anchorRef, open, align = "left", testId, className, children,
}: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<Position>({ left: 0, top: 0, ready: false });

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const a = anchor.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      const gap = 8;
      const viewportGap = 8;
      let left = align === "right" ? a.right - p.width : a.left;
      left = Math.min(Math.max(viewportGap, left), Math.max(viewportGap, window.innerWidth - p.width - viewportGap));
      let top = a.top - p.height - gap;
      if (top < viewportGap) top = Math.min(window.innerHeight - p.height - viewportGap, a.bottom + gap);
      setPosition({ left, top: Math.max(viewportGap, top), ready: true });
    };
    update();
    const frame = requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [align, anchorRef, open]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={panelRef}
      data-testid={testId}
      className={cn("fixed z-[120]", className)}
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}
