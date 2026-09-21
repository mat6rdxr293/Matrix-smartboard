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
    <div className="glass relative z-50 grid min-h-[60px] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 overflow-visible rounded-[20px] border border-white/10 px-4 py-2 shadow-soft">
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold tracking-[-0.01em]" title={lessonTitle}>{subjectName}</div>
          <div className="mt-0.5 truncate text-[11px] text-frost/45">{schoolName} · кабинет {roomName} · {grade} класс</div>
        </div>
      </div>

      <div className="flex items-center justify-center">
        <div className="relative flex items-center rounded-[14px] border border-white/10 bg-white/[0.045] p-0.5 shadow-inner">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => onChangeTab(tab.id)}
              className={cn(
                "relative min-w-[104px] overflow-hidden rounded-[11px] px-4 py-2 text-[12px] font-semibold transition-colors",
                currentTab === tab.id ? "text-accentText" : "text-frost/55 hover:text-frost/90"
              )}
            >
              {currentTab === tab.id && (
                <motion.span
                  layoutId="topbar-tab-pill"
                  className="absolute inset-0 rounded-[11px] bg-accent"
                  transition={{ type: "spring", stiffness: 480, damping: 38 }}
                />
              )}
              <span className="relative z-10">{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-w-0 items-center justify-end gap-1.5">
        {showTimerControls && (
          <div className="flex h-9 min-w-[58px] items-center justify-center rounded-xl border border-white/10 bg-white/[0.035] px-2.5 text-[12px] font-semibold tabular-nums text-frost/70">
            {formatTime(seconds)}
          </div>
        )}

        {showPresentationControls && (
          <>
            <Button
              variant={presenterMode ? "accent" : "ghost"}
              size="sm"
              onClick={onTogglePresenter}
              disabled={officeManaged}
              className="h-9 rounded-xl px-3 text-[11px]"
            >
              <Tv size={15} className="mr-1.5" /> {tl("notes")}
            </Button>
            <Button
              variant={slideshowOpen ? "accent" : "ghost"}
              size="sm"
              onClick={onToggleSlideshow}
              disabled={slideshowDisabled}
              className="h-9 rounded-xl px-3 text-[11px]"
            >
              <Play size={15} className="mr-1.5" /> {tl("slideshow")}
            </Button>
            {officeManaged && <Badge className="bg-white/10">{m365BadgeLabel}</Badge>}
          </>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={handleFullscreen}
          aria-label={tl("fullscreen")}
          title={tl("fullscreen")}
          className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.035] p-0 text-frost/65 hover:bg-white/[0.07] hover:text-frost"
        >
          <Expand size={17} />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={onCompleteLesson}
          className="inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-white/10 bg-white/[0.035] px-3 text-[11px] font-semibold text-frost/75 hover:bg-white/[0.07] hover:text-frost"
          aria-label={tl("finish_lesson")}
          title={tl("finish_lesson_title")}
        >
          <SquareCheckBig size={15} />
          <span>{tl("finish_lesson")}</span>
        </Button>

        <div ref={settingsRef} className="relative">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-label={tl("settings")}
            title={tl("settings")}
            className={cn(
              "inline-flex h-9 w-9 items-center justify-center rounded-xl border p-0 transition",
              settingsOpen
                ? "border-accent/30 bg-accent/15 text-accent shadow-none"
                : "border-white/10 bg-white/[0.035] text-frost/65 hover:bg-white/[0.07] hover:text-frost"
            )}
          >
            <Settings2 size={17} />
          </Button>

          {settingsOpen && (
            <div className="surface-popover absolute right-0 top-[calc(100%+10px)] z-[80] w-[340px] overflow-hidden rounded-[20px] border border-white/10 p-3 shadow-[0_18px_50px_rgba(0,0,0,0.24)] backdrop-blur-xl">
              <div className="mb-3 flex items-center justify-between px-1">
                <div>
                  <div className="text-[13px] font-semibold">{tl("settings")}</div>
                  <div className="mt-0.5 text-[10px] text-frost/45">{subjectName} · {grade} класс</div>
                </div>
              </div>

              <div className="mb-3">
                <div className="mb-1.5 px-1 text-[10px] font-semibold text-frost/45">{tl("lesson_controls")}</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {showTimerControls && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={onToggleRunning}
                        aria-label={running ? tl("pause") : tl("play")}
                        className="h-10 justify-start rounded-xl border border-white/5 bg-white/[0.035] px-3 text-[11px] font-medium"
                      >
                        {running ? <Pause size={15} /> : <Play size={15} />}
                        <span className="ml-2">{running ? tl("pause") : tl("play")}</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={onReset}
                        aria-label={tl("reset")}
                        className="h-10 justify-start rounded-xl border border-white/5 bg-white/[0.035] px-3 text-[11px] font-medium"
                      >
                        <RefreshCw size={15} />
                        <span className="ml-2">{tl("reset")}</span>
                      </Button>
                    </>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onOpenHistory}
                    aria-label={tl("history")}
                    className="h-10 justify-start rounded-xl border border-white/5 bg-white/[0.035] px-3 text-[11px] font-medium"
                  >
                    <History size={15} />
                    <span className="ml-2">{tl("history")}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onChangeRoom}
                    aria-label={tl("change_room")}
                    className="h-10 justify-start rounded-xl border border-white/5 bg-white/[0.035] px-3 text-[11px] font-medium"
                  >
                    <DoorOpen size={15} />
                    <span className="ml-2">{tl("change_room")}</span>
                  </Button>
                </div>
              </div>

              <div className="mb-3 overflow-hidden rounded-[14px] border border-white/10 bg-white/[0.025]">
                <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="text-[11px] font-medium text-frost/70">{tl("appearance")}</div>
                  <div className="flex rounded-[10px] bg-black/5 p-0.5 dark:bg-white/5">
                    <button
                      type="button"
                      aria-pressed={theme === "light"}
                      aria-label={tl("theme_light")}
                      className={cn(
                        "flex h-7 min-w-[72px] items-center justify-center gap-1.5 rounded-[8px] px-2 text-[10px] font-semibold transition",
                        theme === "light" ? "bg-accent text-accentText shadow-sm" : "text-frost/55 hover:text-frost"
                      )}
                      onClick={() => setTheme("light")}
                    >
                      <Sun size={13} /> {tl("theme_light")}
                    </button>
                    <button
                      type="button"
                      aria-pressed={theme === "dark"}
                      aria-label={tl("theme_dark")}
                      className={cn(
                        "flex h-7 min-w-[72px] items-center justify-center gap-1.5 rounded-[8px] px-2 text-[10px] font-semibold transition",
                        theme === "dark" ? "bg-accent text-accentText shadow-sm" : "text-frost/55 hover:text-frost"
                      )}
                      onClick={() => setTheme("dark")}
                    >
                      <Moon size={13} /> {tl("theme_dark")}
                    </button>
                  </div>
                </div>

                <div className="h-px bg-white/10" />

                <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="text-[11px] font-medium text-frost/70">{tl("language")}</div>
                  <div className="flex rounded-[10px] bg-black/5 p-0.5 dark:bg-white/5">
                    <button
                      type="button"
                      className={cn(
                        "h-7 min-w-[66px] rounded-[8px] px-2 text-[10px] font-semibold transition",
                        locale === "ru" ? "bg-accent text-accentText shadow-sm" : "text-frost/55 hover:text-frost"
                      )}
                      onClick={() => setLocale("ru")}
                    >
                      {tl("language_ru")}
                    </button>
                    <button
                      type="button"
                      className={cn(
                        "h-7 min-w-[66px] rounded-[8px] px-2 text-[10px] font-semibold transition",
                        locale === "kk" ? "bg-accent text-accentText shadow-sm" : "text-frost/55 hover:text-frost"
                      )}
                      onClick={() => setLocale("kk")}
                    >
                      {tl("language_kk")}
                    </button>
                    <button
                      type="button"
                      className={cn(
                        "h-7 min-w-[66px] rounded-[8px] px-2 text-[10px] font-semibold transition",
                        locale === "en" ? "bg-accent text-accentText shadow-sm" : "text-frost/55 hover:text-frost"
                      )}
                      onClick={() => setLocale("en")}
                    >
                      {tl("language_en")}
                    </button>
                  </div>
                </div>
              </div>

              <div className="mb-3 overflow-hidden rounded-[14px] border border-white/10 bg-white/[0.025]">
                <div className="flex items-center justify-between px-3 py-2.5">
                  <span className="text-[11px] font-medium text-frost/70">{tl("services")}</span>
                  <div className="flex items-center gap-3 text-[10px] font-semibold">
                    <span className="inline-flex items-center gap-1.5 text-frost/60">
                      <span className={cn("h-1.5 w-1.5 rounded-full bg-frost/25", apiStatus?.ai && "bg-emerald-500")} />
                      {tl("ai")}
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-frost/60">
                      <span className={cn("h-1.5 w-1.5 rounded-full bg-frost/25", apiStatus?.ocr && "bg-emerald-500")} />
                      {tl("ocr")}
                    </span>
                  </div>
                </div>
              </div>

              <div>
                <div className="mb-1.5 px-1 text-[10px] font-semibold text-frost/45">{tl("performance_mode")}</div>
                <div className="grid grid-cols-3 rounded-[12px] border border-white/10 bg-white/[0.025] p-0.5">
                  {(["quality", "balanced", "performance"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={cn(
                        "h-8 rounded-[10px] px-2 text-[10px] font-semibold transition",
                        performanceMode === mode ? "bg-accent text-accentText shadow-sm" : "text-frost/55 hover:text-frost"
                      )}
                      onClick={() => onChangePerformanceMode(mode)}
                    >
                      {mode === "quality"
                        ? tl("performance_quality")
                        : mode === "balanced"
                          ? tl("performance_balanced")
                          : tl("performance_performance")}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
