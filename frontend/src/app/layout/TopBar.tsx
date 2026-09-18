import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DoorOpen, Expand, History, Moon, Pause, Play, RefreshCw, Settings2, SquareCheckBig, Sun, Tv } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { useTheme } from "@/app/theme/ThemeProvider";

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
  tabs: readonly { id: string; label: string }[];
  onChangeTab: (id: string) => void;
  slideshowOpen: boolean;
  onToggleSlideshow: () => void;
  slideshowDisabled?: boolean;
  m365Mode?: boolean;
  m365BadgeLabel?: string;
  performanceMode: "quality" | "balanced" | "performance";
  onChangePerformanceMode: (mode: "quality" | "balanced" | "performance") => void;
  schoolName: string;
  roomName: string;
  grade: number;
  subjectName: string;
  onCompleteLesson: () => void;
  onOpenHistory: () => void;
  onChangeRoom: () => void;
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
  schoolName,
  roomName,
  grade,
  subjectName,
  onCompleteLesson,
  onOpenHistory,
  onChangeRoom,
}: TopBarProps) {
  const { locale, setLocale, tl } = useI18n();
  const { theme, setTheme } = useTheme();
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
    <div className="glass relative z-50 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 overflow-visible rounded-2xl px-4 py-2.5 shadow-soft">
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0">
          <div className="truncate text-base font-semibold" title={lessonTitle}>{subjectName}</div>
          <div className="truncate text-[11px] text-frost/50">{schoolName} · кабинет {roomName} · {grade} класс</div>
        </div>
      </div>
      <div className="flex items-center justify-center">
        <div className="relative flex items-center gap-1 rounded-full border border-white/10 bg-white/5 p-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => onChangeTab(tab.id)}
              className={cn(
                "relative overflow-hidden rounded-full px-4 py-2 text-sm font-semibold transition",
                currentTab === tab.id ? "text-accentText" : "text-frost/70 hover:text-frost"
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
      <div className="flex min-w-0 items-center justify-end gap-1.5">
        {showTimerControls && (
          <div className="rounded-xl bg-white/10 px-3 py-2 text-sm font-semibold">{formatTime(seconds)}</div>
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
        <Button variant="outline" size="sm" onClick={onCompleteLesson} className="h-8 whitespace-nowrap px-2 text-[10px]" title="Завершить урок">
          <SquareCheckBig size={15} className="mr-1" /> Завершить
        </Button>

        <div ref={settingsRef} className="relative">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSettingsOpen((v) => !v)}
            className={`${topActionBtnClass} bg-frost text-ink hover:bg-frost/90 hover:text-ink`}
          >
            <Settings2 size={16} /> {tl("settings")}
          </Button>

          {settingsOpen && (
            <div className="surface-popover absolute right-0 top-[calc(100%+8px)] z-40 w-[240px] rounded-xl p-2.5 shadow-soft backdrop-blur-md">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-frost/60">{tl("lesson_controls")}</div>
              <div className="mb-2.5 grid grid-cols-2 gap-1.5">
                {showTimerControls && (
                  <>
                    <Button variant="ghost" size="sm" onClick={onToggleRunning} aria-label={running ? tl("pause") : tl("play")} className="h-8 justify-start px-2 text-[10px]">
                      {running ? <Pause size={14} /> : <Play size={14} />} {running ? tl("pause") : tl("play")}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={onReset} aria-label={tl("reset")} className="h-8 justify-start px-2 text-[10px]">
                      <RefreshCw size={14} /> {tl("reset")}
                    </Button>
                  </>
                )}
                <Button variant="ghost" size="sm" onClick={onOpenHistory} aria-label={tl("history")} className="h-8 justify-start px-2 text-[10px]">
                  <History size={14} /> {tl("history")}
                </Button>
                <Button variant="ghost" size="sm" onClick={onChangeRoom} aria-label={tl("change_room")} className="h-8 justify-start px-2 text-[10px]">
                  <DoorOpen size={14} /> {tl("change_room")}
                </Button>
              </div>

              <div className="mb-1 text-[10px] uppercase tracking-wide text-frost/60">{tl("appearance")}</div>
              <div className="mb-2.5 grid grid-cols-2 gap-1 rounded-full border border-white/10 bg-white/5 p-0.5">
                <button
                  type="button"
                  aria-pressed={theme === "light"}
                  className={cn(
                    "flex h-7 items-center justify-center gap-1 rounded-full px-2 text-[10px] font-semibold transition",
                    theme === "light" ? "bg-accent text-accentText" : "text-frost/70 hover:text-frost"
                  )}
                  onClick={() => setTheme("light")}
                >
                  <Sun size={13} /> {tl("theme_light")}
                </button>
                <button
                  type="button"
                  aria-pressed={theme === "dark"}
                  className={cn(
                    "flex h-7 items-center justify-center gap-1 rounded-full px-2 text-[10px] font-semibold transition",
                    theme === "dark" ? "bg-accent text-accentText" : "text-frost/70 hover:text-frost"
                  )}
                  onClick={() => setTheme("dark")}
                >
                  <Moon size={13} /> {tl("theme_dark")}
                </button>
              </div>

              <div className="mb-1 text-[10px] uppercase tracking-wide text-frost/60">{tl("language")}</div>
              <div className="mb-2.5 inline-flex h-7 items-center gap-1 rounded-full border border-white/10 bg-white/5 p-0.5">
                <button
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none transition",
                    locale === "ru" ? "bg-accent text-accentText" : "text-frost/70 hover:text-frost"
                  )}
                  onClick={() => setLocale("ru")}
                >
                  {tl("language_ru")}
                </button>
                <button
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none transition",
                    locale === "kk" ? "bg-accent text-accentText" : "text-frost/70 hover:text-frost"
                  )}
                  onClick={() => setLocale("kk")}
                >
                  {tl("language_kk")}
                </button>
              </div>

              <div className="mb-1 text-[10px] uppercase tracking-wide text-frost/60">{tl("services")}</div>
              <div className="grid grid-cols-2 gap-1.5">
                <Badge className={cn("justify-center bg-white/5 text-[11px]", apiStatus?.ai && "bg-emerald-500/15 text-success")}>
                  {tl("ai")}: {apiStatus ? (apiStatus.ai ? tl("on") : tl("off")) : "..."}
                </Badge>
                <Badge className={cn("justify-center bg-white/5 text-[11px]", apiStatus?.ocr && "bg-emerald-500/15 text-success")}>
                  {tl("ocr")}: {apiStatus ? (apiStatus.ocr ? tl("on") : tl("off")) : "..."}
                </Badge>
              </div>
              <div className="mt-2.5 mb-1 text-[10px] uppercase tracking-wide text-frost/60">{tl("performance_mode")}</div>
              <div className="inline-flex h-7 w-full items-center gap-1 rounded-full border border-white/10 bg-white/5 p-0.5">
                <button
                  className={cn(
                    "flex-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none transition",
                    performanceMode === "quality" ? "bg-accent text-accentText" : "text-frost/70 hover:text-frost"
                  )}
                  onClick={() => onChangePerformanceMode("quality")}
                >
                  {tl("performance_quality")}
                </button>
                <button
                  className={cn(
                    "flex-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none transition",
                    performanceMode === "balanced" ? "bg-accent text-accentText" : "text-frost/70 hover:text-frost"
                  )}
                  onClick={() => onChangePerformanceMode("balanced")}
                >
                  {tl("performance_balanced")}
                </button>
                <button
                  className={cn(
                    "flex-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none transition",
                    performanceMode === "performance" ? "bg-accent text-accentText" : "text-frost/70 hover:text-frost"
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
