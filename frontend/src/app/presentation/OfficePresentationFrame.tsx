import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { PresentationSource } from "@/app/presentation/presentationSource";
import { useI18n } from "@/i18n";

type OfficePresentationFrameProps = {
  source: PresentationSource;
  pageIndex: number;
  onPageIndexChange: (index: number) => void;
  onFallback: () => Promise<void> | void;
};

export default function OfficePresentationFrame({
  source,
  pageIndex,
  onPageIndexChange,
  onFallback,
}: OfficePresentationFrameProps) {
  const { tl } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [fallbacking, setFallbacking] = useState(false);
  const fallbackRequestedRef = useRef(false);

  const fallbackPages = source.fallbackPdf ?? [];
  const hasIframe = (source.type === "m365" || source.type === "office") && !!source.embedUrl;
  const engineLabel = source.type === "office" ? "Office Viewer" : "Microsoft 365";

  const safePageIndex = useMemo(() => {
    if (!fallbackPages.length) return 0;
    return Math.max(0, Math.min(pageIndex, fallbackPages.length - 1));
  }, [fallbackPages.length, pageIndex]);

  useEffect(() => {
    setLoaded(false);
    fallbackRequestedRef.current = false;
  }, [source.embedUrl]);

  useEffect(() => {
    if (!hasIframe || loaded || fallbacking) return;
    const timeout = window.setTimeout(async () => {
      if (fallbackRequestedRef.current) return;
      fallbackRequestedRef.current = true;
      setFallbacking(true);
      try {
        await onFallback();
      } finally {
        setFallbacking(false);
      }
    }, 12000);
    return () => window.clearTimeout(timeout);
  }, [fallbacking, hasIframe, loaded, onFallback]);

  if (!hasIframe && fallbackPages.length > 0) {
    return (
      <div className="glass flex h-full flex-col rounded-2xl p-4 shadow-soft">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold">{tl("presentation")} · Fallback</div>
          <Badge>{engineLabel}</Badge>
        </div>
        <div className="relative flex-1 overflow-hidden rounded-xl border border-white/10 bg-ink/60">
          <img
            src={fallbackPages[safePageIndex]}
            alt=""
            className="h-full w-full object-contain"
            draggable={false}
          />
        </div>
        <div className="mt-3 flex items-center justify-between">
          <Button
            variant="outline"
            onClick={() => onPageIndexChange(Math.max(0, safePageIndex - 1))}
            disabled={safePageIndex <= 0}
          >
            {tl("back")}
          </Button>
          <div className="text-xs text-frost/60">
            {safePageIndex + 1} / {fallbackPages.length}
          </div>
          <Button
            variant="accent"
            onClick={() => onPageIndexChange(Math.min(fallbackPages.length - 1, safePageIndex + 1))}
            disabled={safePageIndex >= fallbackPages.length - 1}
          >
            {tl("forward")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="glass relative h-full rounded-2xl p-3 shadow-soft">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold">{engineLabel}</div>
        <div className="flex items-center gap-2">
          <Badge>{source.type === "m365" && source.mode === "edit" ? "Редактирование" : "Просмотр"}</Badge>
          <Badge>{source.access === "public" ? "Публичный" : "Приватный"}</Badge>
        </div>
      </div>
      <div className="relative h-[calc(100%-34px)] overflow-hidden rounded-xl border border-white/10 bg-black/30">
        {source.embedUrl ? (
          <iframe
            src={source.embedUrl}
            className="h-full w-full"
            referrerPolicy="no-referrer"
            allow="clipboard-read; clipboard-write; fullscreen"
            onLoad={() => setLoaded(true)}
            onError={async () => {
              if (fallbackRequestedRef.current) return;
              fallbackRequestedRef.current = true;
              setFallbacking(true);
              try {
                await onFallback();
              } finally {
                setFallbacking(false);
              }
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-frost/70">
            {tl("loading")}
          </div>
        )}
        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/35 text-sm text-frost/80">
            {fallbacking ? "Переключение в fallback..." : `Подключение к ${engineLabel}...`}
          </div>
        )}
      </div>
    </div>
  );
}
