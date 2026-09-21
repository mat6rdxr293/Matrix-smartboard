import { ChevronRight, Expand, History, LogOut, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { GRADES, type Grade } from "./curriculum";
import type { Room, School } from "./types";

type GradePickerProps = {
  school: School;
  room: Room;
  onSelectGrade: (grade: Grade) => void;
  onOpenHistory: () => void;
  onLogout: () => void;
  onChangeRoom: () => void;
};

export default function GradePicker({ school, room, onSelectGrade, onOpenHistory, onLogout, onChangeRoom }: GradePickerProps) {
  const { locale, setLocale, tl } = useI18n();

  const handleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => undefined);
    } else {
      document.exitFullscreen().catch(() => undefined);
    }
  };

  return (
    <main className="session-shell">
      <section className="w-full max-w-[1680px]">
        <header className="session-topbar flex flex-col gap-3 rounded-[20px] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            <span className="min-w-0 truncate text-[13px] font-semibold text-frost">{school.name}</span>
            <span className="hidden h-4 w-px bg-white/10 sm:block" aria-hidden="true" />
            <span className="flex items-center gap-2 text-[12px] text-frost/55">
              <MapPin size={15} />
              {tl("home_room", { room: room.name })}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex h-9 items-center rounded-xl border border-white/10 bg-white/[0.025] p-0.5">
              {(["ru", "kk", "en"] as const).map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => setLocale(code)}
                  aria-pressed={locale === code}
                  className={cn(
                    "h-7 min-w-[44px] rounded-[9px] px-2 text-[10px] font-semibold transition",
                    locale === code ? "bg-accent text-accentText" : "text-frost/55 hover:bg-white/[0.05] hover:text-frost"
                  )}
                >
                  {code === "ru" ? "RU" : code === "kk" ? "ҚАЗ" : "EN"}
                </button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleFullscreen}
              aria-label={tl("fullscreen")}
              title={tl("fullscreen")}
              className="h-9 w-9 rounded-xl border border-white/10 bg-white/[0.025] p-0 text-frost/70 hover:bg-white/[0.06] hover:text-frost"
            >
              <Expand size={16} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenHistory}
              className="h-9 rounded-xl border border-white/10 bg-white/[0.025] px-3 text-[11px] text-frost/70 hover:bg-white/[0.06] hover:text-frost"
            >
              <History size={15} className="mr-1.5" />
              {tl("home_history")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onChangeRoom}
              className="h-9 rounded-xl border border-white/10 bg-white/[0.025] px-3 text-[11px] text-frost/70 hover:bg-white/[0.06] hover:text-frost"
            >
              {tl("home_change_room")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onLogout}
              aria-label={tl("home_logout")}
              title={tl("home_logout")}
              className="h-9 w-9 rounded-xl border border-transparent p-0 text-frost/50 hover:border-white/10 hover:bg-white/[0.05] hover:text-frost"
            >
              <LogOut size={16} />
            </Button>
          </div>
        </header>

        <div className="mx-auto mt-10 w-full max-w-[1320px] lg:mt-14">
          <div className="mx-auto max-w-[720px] text-center">
            <div className="mb-4 flex items-center justify-center gap-2.5 text-[11px] font-semibold text-frost/35">
              <span className="h-1.5 w-12 overflow-hidden rounded-full bg-white/10">
                <motion.span
                  className="block h-full w-full origin-left rounded-full bg-accent"
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1], delay: 0.08 }}
                />
              </span>
              <span className="h-1.5 w-12 rounded-full bg-white/10" />
              <span className="h-1.5 w-12 rounded-full bg-white/10" />
              <motion.span
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.24, delay: 0.18 }}
              >
                1 / 3
              </motion.span>
            </div>

            <h1 className="text-4xl font-bold tracking-[-0.035em] text-frost sm:text-5xl">{tl("home_choose_grade")}</h1>
            <p className="mx-auto mt-3 max-w-[660px] text-sm leading-6 text-frost/50 sm:text-[15px]">
              {tl("home_choose_grade_description")}
            </p>
          </div>

          <div className="mt-8 grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-12">
            {GRADES.map((grade, index) => (
              <button
                key={grade}
                type="button"
                aria-label={`${grade} ${tl("home_grade_label")}`}
                className={`session-grade-card group relative min-h-[170px] overflow-hidden rounded-[20px] px-5 py-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent xl:col-span-2 ${index >= 6 ? ["xl:col-start-2", "xl:col-start-4", "xl:col-start-6", "xl:col-start-8", "xl:col-start-10"][index - 6] : ""}`}
                onClick={() => onSelectGrade(grade)}
              >
                <ChevronRight
                  size={18}
                  className="absolute right-4 top-4 translate-x-1 text-accent opacity-0 transition duration-200 group-hover:translate-x-0 group-hover:opacity-100"
                />
                <span className="block text-[46px] font-bold leading-none tracking-[-0.045em] text-frost transition group-hover:text-accent">
                  {grade}
                </span>
                <span className="mt-4 block text-[11px] font-semibold uppercase tracking-[0.14em] text-frost/40">{tl("home_grade_label")}</span>
              </button>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
