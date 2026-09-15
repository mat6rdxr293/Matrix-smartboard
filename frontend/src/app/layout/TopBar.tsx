import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Expand, Pause, Play, RefreshCw, Settings2, Tv } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

export type ApiStatus = {
  ok: boolean;
  ai: boolean;
  ocr: boolean;
};

type TopBarProps = {
  apiStatus: ApiStatus | null;
  lessonTitle: string;
  presenterMode: boolean;
  onTogglePresenter: () => void;
  running: boolean;
  seconds: number;
  onToggleRunning: () => void;
  onReset: () => void;
  currentTab: string;
  tabs: { id: string; label: string }[];
  onChangeTab: (id: string) => void;
  slideshowOpen: boolean;
  onToggleSlideshow: () => void;
  slideshowDisabled?: boolean;
  m365Mode?: boolean;
  m365BadgeLabel?: string;
  performanceMode: "quality" | "balanced" | "performance";
  onChangePerformanceMode: (mode: "quality" | "balanced" | "performance") => void;
};

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export default function TopBar({
  apiStatus,
  lessonTitle,
  presenterMode,
  onTogglePresenter,
  running,
  seconds,
  onToggleRunning,
  onReset,
  currentTab,
  tabs,
  onChangeTab,
  slideshowOpen,
  onToggleSlideshow,
  slideshowDisabled = false,
  m365Mode = false,
  m365BadgeLabel = "M365",
  performanceMode,
  onChangePerformanceMode,
}: TopBarProps) {
  const { locale, setLocale, tl } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement | null>(null);

  const isSlidesTab = currentTab === "slides";
  const isTeacherTab = currentTab === "teacher";
  const showTimerControls = !isTeacherTab;
  const showPresentationControls = isSlidesTab;
  const officeManaged = isSlidesTab && m365Mode;
  const topActionBtnClass = "h-8 w-[92px] justify-center gap-1 px-2 text-[10px] leading-tight";

  useEffect(() => {
    if (!settingsOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!settingsRef.current) return;
      if (!settingsRef.current.contains(event.target as Node)) setSettingsOpen(false);
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onEscape);
    };
  }, [settingsOpen]);

  const handleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => undefined);
    } else {
      document.exitFullscreen().catch(() => undefined);
    }
  };

  return (
    <div className="glass relative z-50 overflow-visible grid grid-cols-[1fr_auto_1fr] items-center gap-4 rounded-2xl px-5 py-3 shadow-soft">
      <div className="flex items-center gap-3">
        <Badge className="bg-white/10">{tl("open_lesson")}</Badge>
        <div className="text-lg font-semibold">{lessonTitle}</div>
      </div>
      <div className="flex items-center justify-center">
        <div className="relative flex items-center gap-1 rounded-full border border-white/10 bg-white/5 p-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => onChangeTab(tab.id)}
              className={cn(
                "relative overflow-hidden rounded-full px-4 py-2 text-sm font-semibold transition",
                currentTab === tab.id ? "text-ink" : "text-frost/70 hover:text-frost"
              )}
            >
              {currentTab === tab.id && (
                <motion.span
                  layoutId="topbar-tab-pill"
                  className="absolute inset-0 rounded-full bg-accent"
                  transition={{ type: "spring", stiffness: 500, damping: 40 }}
                />
              )}
              <span className="relative z-10">{tab.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-end gap-3">
        {showTimerControls && (
          <>
            <div className="rounded-xl bg-white/10 px-3 py-2 text-sm font-semibold">{formatTime(seconds)}</div>
            <Button variant="ghost" size="sm" onClick={onToggleRunning}>
              {running ? <Pause size={16} /> : <Play size={16} />}
            </Button>
            <Button variant="ghost" size="sm" onClick={onReset}>
              <RefreshCw size={16} />
            </Button>
          </>
        )}
        {showPresentationControls && (
          <>
            <Button
              variant={presenterMode ? "accent" : "outline"}
              size="sm"
              onClick={onTogglePresenter}
              disabled={officeManaged}
            >
              <Tv size={16} className="mr-2" /> {tl("notes")}
            </Button>
            <Button
              variant={slideshowOpen ? "accent" : "outline"}
              size="sm"
              onClick={onToggleSlideshow}
              disabled={slideshowDisabled}
            >
              <Play size={16} className="mr-2" /> {tl("slideshow")}
            </Button>
            {officeManaged && <Badge className="bg-white/10">{m365BadgeLabel}</Badge>}
          </>
        )}
        <Button variant="outline" size="sm" onClick={handleFullscreen} className={topActionBtnClass}>
          <Expand size={16} /> {tl("fullscreen")}
        </Button>

        <div ref={settingsRef} className="relative">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSettingsOpen((v) => !v)}
            className={`${topActionBtnClass} bg-white text-ink hover:bg-white/90 hover:text-ink`}
          >
            <Settings2 size={16} /> {tl("settings")}
          </Button>

          {settingsOpen && (
            <div className="absolute right-0 top-[calc(100%+8px)] z-40 w-[220px] rounded-xl border border-white/10 bg-ink/95 p-2.5 shadow-soft backdrop-blur-md">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-frost/60">{tl("language")}</div>
              <div className="mb-2.5 inline-flex h-7 items-center gap-1 rounded-full border border-white/10 bg-white/5 p-0.5">
                <button
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none transition",
                    locale === "ru" ? "bg-accent text-ink" : "text-frost/70 hover:text-frost"
                  )}
                  onClick={() => setLocale("ru")}
                >
                  {tl("language_ru")}
                </button>
                <button
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none transition",
                    locale === "kk" ? "bg-accent text-ink" : "text-frost/70 hover:text-frost"
                  )}
                  onClick={() => setLocale("kk")}
                >
                  {tl("language_kk")}
                </button>
              </div>

              <div className="mb-1 text-[10px] uppercase tracking-wide text-frost/60">{tl("services")}</div>
              <div className="grid grid-cols-2 gap-1.5">
                <Badge className={cn("justify-center bg-white/5 text-[11px]", apiStatus?.ai && "bg-emerald-500/15 text-emerald-200")}>
                  {tl("ai")}: {apiStatus ? (apiStatus.ai ? tl("on") : tl("off")) : "..."}
                </Badge>
                <Badge className={cn("justify-center bg-white/5 text-[11px]", apiStatus?.ocr && "bg-emerald-500/15 text-emerald-200")}>
                  {tl("ocr")}: {apiStatus ? (apiStatus.ocr ? tl("on") : tl("off")) : "..."}
                </Badge>
              </div>
              <div className="mt-2.5 mb-1 text-[10px] uppercase tracking-wide text-frost/60">{tl("performance_mode")}</div>
              <div className="inline-flex h-7 w-full items-center gap-1 rounded-full border border-white/10 bg-white/5 p-0.5">
                <button
                  className={cn(
                    "flex-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none transition",
                    performanceMode === "quality" ? "bg-accent text-ink" : "text-frost/70 hover:text-frost"
                  )}
                  onClick={() => onChangePerformanceMode("quality")}
                >
                  {tl("performance_quality")}
                </button>
                <button
                  className={cn(
                    "flex-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none transition",
                    performanceMode === "balanced" ? "bg-accent text-ink" : "text-frost/70 hover:text-frost"
                  )}
                  onClick={() => onChangePerformanceMode("balanced")}
                >
                  {tl("performance_balanced")}
                </button>
                <button
                  className={cn(
                    "flex-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none transition",
                    performanceMode === "performance" ? "bg-accent text-ink" : "text-frost/70 hover:text-frost"
                  )}
                  onClick={() => onChangePerformanceMode("performance")}
                >
                  {tl("performance_performance")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
