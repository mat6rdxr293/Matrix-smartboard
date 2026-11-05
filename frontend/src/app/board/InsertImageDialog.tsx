import { useEffect, useRef, useState } from "react";
import { BookOpen, ChevronLeft, ChevronRight, ImageUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch, backendAssetUrl } from "@/lib/apiClient";
import { useI18n } from "@/i18n";

type Book = {
  id: string;
  label: string;
  status?: string;
  totalPages?: number;
  sections?: { id: string; title: string; pageStart: number }[];
};

export type InsertedImage = { src: string; label: string; aspect: number };

type Props = { onInsert: (image: InsertedImage) => void; onClose: () => void };

const pageSrc = (bookId: string, page: number) => `/api/textbooks/${encodeURIComponent(bookId)}/pages/${page}/image`;

/** Picks a textbook page or an image file to lay on the board. */
export default function InsertImageDialog({ onInsert, onClose }: Props) {
  const { tl } = useI18n();
  const [tab, setTab] = useState<"textbook" | "file">("textbook");
  const [books, setBooks] = useState<Book[] | null>(null);
  const [bookId, setBookId] = useState("");
  const [page, setPage] = useState(1);
  const [file, setFile] = useState<{ src: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aspect, setAspect] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/lesson-generation/sources", { cache: "no-store" });
        const data = (await res.json()) as { books?: Book[] };
        const ready = (data.books ?? []).filter((book) => (book.totalPages ?? 0) > 0);
        if (cancelled) return;
        setBooks(ready);
        setBookId((current) => current || ready[0]?.id || "");
        if (!ready.length) setTab("file");
      } catch {
        if (!cancelled) {
          setBooks([]);
          setTab("file");
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const book = books?.find((item) => item.id === bookId);
  const totalPages = book?.totalPages ?? 1;
  const clampPage = (value: number) => Math.min(totalPages, Math.max(1, Math.round(value) || 1));

  const previewSrc = tab === "textbook"
    ? (book ? `${pageSrc(book.id, page)}?width=800` : null)
    : file?.src ?? null;

  useEffect(() => setAspect(null), [previewSrc]);

  const upload = async (picked: File) => {
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", picked);
      const res = await apiFetch("/api/board/images", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.src !== "string") throw new Error(data.detail || tl("insert_image_upload_failed"));
      setFile({ src: data.src, name: picked.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : tl("insert_image_upload_failed"));
    } finally {
      setUploading(false);
    }
  };

  const insert = () => {
    if (!aspect) return;
    if (tab === "textbook" && book) {
      onInsert({ src: pageSrc(book.id, page), label: `${book.label}, ${tl("insert_image_page")} ${page}`, aspect });
    } else if (file) {
      onInsert({ src: file.src, label: file.name, aspect });
    }
  };

  return (
    // data-floating-panel keeps the native ink layer from taking touches anywhere on the backdrop.
    <div data-floating-panel className="fixed inset-0 z-[100] grid place-items-center bg-black/60 p-4" role="presentation"
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="insert-image-title"
        className="glass flex max-h-[90vh] w-full max-w-2xl flex-col rounded-[22px] border-white/15 p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="insert-image-title" className="text-lg font-semibold text-frost">{tl("insert_image")}</h2>
          <Button variant="ghost" size="sm" aria-label={tl("close")} title={tl("close")} onClick={onClose}><X size={18} /></Button>
        </div>
        <div className="mb-4 flex gap-2">
          <Button size="sm" variant={tab === "textbook" ? "accent" : "outline"} disabled={!books?.length} onClick={() => setTab("textbook")}>
            <BookOpen size={16} className="mr-1.5" />{tl("insert_image_textbook")}
          </Button>
          <Button size="sm" variant={tab === "file" ? "accent" : "outline"} onClick={() => setTab("file")}>
            <ImageUp size={16} className="mr-1.5" />{tl("insert_image_file")}
          </Button>
        </div>

        {tab === "textbook" && book && (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <select className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-frost"
              value={book.id} onChange={(event) => { setBookId(event.target.value); setPage(1); }}>
              {books!.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
            {!!book.sections?.length && (
              <select className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-frost"
                value="" onChange={(event) => event.target.value && setPage(clampPage(Number(event.target.value)))}>
                <option value="">{tl("insert_image_section")}</option>
                {book.sections.map((section) => (
                  <option key={section.id} value={section.pageStart}>§{section.id} {section.title}</option>
                ))}
              </select>
            )}
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" aria-label={tl("previous_page")} disabled={page <= 1} onClick={() => setPage(clampPage(page - 1))}><ChevronLeft size={18} /></Button>
              <input type="number" inputMode="numeric" min={1} max={totalPages} value={page}
                aria-label={tl("insert_image_page")}
                onChange={(event) => setPage(clampPage(Number(event.target.value)))}
                className="w-16 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-center text-frost" />
              <span className="text-frost/50">/ {totalPages}</span>
              <Button size="sm" variant="ghost" aria-label={tl("next_page")} disabled={page >= totalPages} onClick={() => setPage(clampPage(page + 1))}><ChevronRight size={18} /></Button>
            </div>
          </div>
        )}

        {tab === "file" && (
          <div className="mb-3 flex items-center gap-3 text-sm">
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
              onChange={(event) => { const picked = event.target.files?.[0]; if (picked) void upload(picked); event.target.value = ""; }} />
            <Button size="sm" variant="outline" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
              <ImageUp size={16} className="mr-1.5" />{uploading ? tl("insert_image_uploading") : tl("insert_image_choose")}
            </Button>
            {file && <span className="truncate text-frost/60">{file.name}</span>}
          </div>
        )}

        <div className="relative min-h-[200px] flex-1 overflow-auto rounded-xl border border-white/10 bg-black/20">
          {previewSrc ? (
            <img key={previewSrc} src={backendAssetUrl(previewSrc)} alt="" className="mx-auto block max-h-[52vh] w-auto"
              onLoad={(event) => {
                const img = event.currentTarget;
                if (img.naturalWidth && img.naturalHeight) setAspect(img.naturalHeight / img.naturalWidth);
              }}
              onError={() => setError(tl("insert_image_load_failed"))} />
          ) : (
            <div className="grid h-[200px] place-items-center text-sm text-frost/50">
              {books === null ? "…" : tab === "textbook" ? tl("insert_image_no_textbooks") : tl("insert_image_choose_hint")}
            </div>
          )}
        </div>
        {error && <p className="mt-2 text-sm text-[#FFB86B]">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>{tl("cancel")}</Button>
          <Button variant="accent" disabled={!aspect} onClick={insert}>{tl("insert_image_place")}</Button>
        </div>
      </section>
    </div>
  );
}
