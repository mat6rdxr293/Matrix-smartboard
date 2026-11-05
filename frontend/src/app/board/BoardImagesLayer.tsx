import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { MoveHorizontal, Trash2 } from "lucide-react";
import { backendAssetUrl } from "@/lib/apiClient";
import type { BoardImage } from "./boardDocument";

type View = { zoom: number; pan: { x: number; y: number } };

const box = (image: BoardImage, { zoom, pan }: View) => ({
  left: image.x * zoom + pan.x,
  top: image.y * zoom + pan.y,
  width: image.width * zoom,
  height: image.height * zoom,
});

/** Pictures under the web canvas, so ink and the eraser work over them without touching them. */
export function BoardPictures({ images, zoom, pan }: View & { images: BoardImage[] }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="board-pictures">
      {images.map((image) => (
        <img
          key={image.id}
          src={backendAssetUrl(image.src)}
          alt={image.label ?? ""}
          draggable={false}
          className="absolute select-none"
          style={{ ...box(image, { zoom, pan }), objectFit: "fill" }}
        />
      ))}
    </div>
  );
}

const MIN_SIZE = 40;

type Drag = { kind: "move" | "resize"; start: { x: number; y: number }; image: BoardImage };

/**
 * With the hand tool, pictures can be picked up: drag to move; a bar inside the picture's top edge
 * holds a grip to resize (right grows, left shrinks, proportions kept) and a bin to remove it. The
 * bar stays inside the picture so the pager and the toolbar never cover it. Changes are reported
 * once, when the gesture ends.
 */
export function BoardImageHandles({
  images, zoom, pan, selectedId, onSelect, onCommit, onDelete, deleteLabel, resizeLabel,
}: View & {
  images: BoardImage[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCommit: (before: BoardImage, after: BoardImage) => void;
  onDelete: (image: BoardImage) => void;
  deleteLabel: string;
  resizeLabel: string;
}) {
  const dragRef = useRef<Drag | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const latestRef = useRef<BoardImage | null>(null);

  const begin = (image: BoardImage, kind: Drag["kind"]) => (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    event.preventDefault();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    onSelect(image.id);
    dragRef.current = { kind, start: { x: event.clientX, y: event.clientY }, image };
    latestRef.current = image;
  };

  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    event.stopPropagation();
    const dx = (event.clientX - drag.start.x) / zoom;
    const dy = (event.clientY - drag.start.y) / zoom;
    const source = drag.image;
    let next: BoardImage;
    if (drag.kind === "move") {
      next = { ...source, x: source.x + dx, y: source.y + dy };
    } else {
      // The grip is mid-width, so a drag changes both sides: twice the travel, anchored at the centre.
      const width = Math.max(MIN_SIZE, source.width + dx * 2);
      const height = width * (source.height / source.width);
      next = { ...source, x: source.x + (source.width - width) / 2, width, height };
      latestRef.current = next;
      const frame = previewRef.current;
      if (frame) Object.assign(frame.style, Object.fromEntries(Object.entries(box(next, { zoom, pan })).map(([k, v]) => [k, `${v}px`])));
      return;
    }
    latestRef.current = next;
    // Follow the finger without a React render per move; the commit re-renders once.
    const frame = previewRef.current;
    if (frame) Object.assign(frame.style, Object.fromEntries(Object.entries(box(next, { zoom, pan })).map(([k, v]) => [k, `${v}px`])));
  };

  const end = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    event.stopPropagation();
    dragRef.current = null;
    const after = latestRef.current;
    if (after && (after.x !== drag.image.x || after.y !== drag.image.y || after.width !== drag.image.width)) {
      onCommit(drag.image, after);
    }
  };

  const gesture = { onPointerMove: move, onPointerUp: end, onPointerCancel: end };

  return (
    <div className="absolute inset-0 overflow-hidden" data-testid="board-image-handles"
      style={{ pointerEvents: "none", touchAction: "none" }}
      onPointerDown={() => onSelect(null)}>
      {images.map((image) => {
        const selected = image.id === selectedId;
        return (
          <div
            key={image.id}
            ref={selected ? previewRef : undefined}
            data-board-image={image.id}
            className={selected ? "absolute rounded-sm outline outline-2 outline-offset-2 outline-[rgb(var(--color-accent))]" : "absolute"}
            style={{ ...box(image, { zoom, pan }), pointerEvents: "auto", cursor: "move", touchAction: "none" }}
            onPointerDown={begin(image, "move")}
            {...gesture}
          >
            {selected && (
              <div className="glass absolute left-1/2 top-2 flex -translate-x-1/2 items-center gap-1 rounded-full p-1 shadow-soft">
                <div
                  data-testid="board-image-resize"
                  role="slider"
                  aria-label={resizeLabel}
                  aria-valuenow={Math.round(image.width)}
                  title={resizeLabel}
                  className="grid h-9 w-14 place-items-center rounded-full bg-[rgb(var(--color-accent))] text-black"
                  style={{ cursor: "ew-resize", touchAction: "none" }}
                  onPointerDown={begin(image, "resize")}
                  {...gesture}
                >
                  <MoveHorizontal size={18} />
                </div>
                <button
                  type="button"
                  aria-label={deleteLabel}
                  title={deleteLabel}
                  className="grid h-9 w-9 place-items-center rounded-full text-frost hover:bg-white/10"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => onDelete(image)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
