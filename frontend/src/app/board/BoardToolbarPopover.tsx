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
    let last = "";
    const update = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const a = anchor.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      // Tool artwork rises above its button when active; keep the panel clear of it too.
      let anchorTop = a.top;
      anchor.querySelectorAll(".board-tool-art").forEach((art) => {
        anchorTop = Math.min(anchorTop, art.getBoundingClientRect().top);
      });
      const gap = 8;
      const viewportGap = 8;
      let left = align === "right" ? a.right - p.width : a.left;
      left = Math.min(Math.max(viewportGap, left), Math.max(viewportGap, window.innerWidth - p.width - viewportGap));
      let top = anchorTop - p.height - gap;
      if (top < viewportGap) top = Math.min(window.innerHeight - p.height - viewportGap, a.bottom + gap);
      top = Math.max(viewportGap, top);
      const key = `${Math.round(left)}:${Math.round(top)}`;
      if (key === last) return;
      last = key;
      setPosition({ left, top, ready: true });
    };
    update();
    // The toolbar slides in and its icons lift, and the panel can change size, so follow them
    // every frame while open instead of measuring once.
    let frame = 0;
    let stopped = false;
    let inFrame = false;
    const follow = () => {
      // A scheduler that runs the callback straight away would otherwise recurse forever.
      if (stopped || inFrame) return;
      inFrame = true;
      update();
      frame = requestAnimationFrame(follow);
      inFrame = false;
    };
    frame = requestAnimationFrame(follow);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
    };
  }, [align, anchorRef, open]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={panelRef}
      data-testid={testId}
      data-toolbar-level="context"
      className={cn("board-toolbar-context-row fixed z-[120]", className)}
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}
