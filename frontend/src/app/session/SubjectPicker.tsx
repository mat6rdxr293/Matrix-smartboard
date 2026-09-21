import { ArrowLeft, BookOpen, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { useI18n, type LocaleCode } from "@/i18n";
import { getSubjectsForGrade, type CurriculumSubjectId, type Grade } from "./curriculum";

type SubjectPickerProps = {
  grade: Grade;
  locale: LocaleCode;
  loading?: boolean;
  error?: string | null;
  onSelectSubject: (subjectId: CurriculumSubjectId) => void;
  onBack: () => void;
};

export default function SubjectPicker({ grade, locale, loading = false, error, onSelectSubject, onBack }: SubjectPickerProps) {
  const subjects = getSubjectsForGrade(grade);
  const { tl } = useI18n();

  return (
    <main className="session-shell">
      <section className="w-full max-w-[1680px]">
        <div>
          <Button
            variant="ghost"
            onClick={onBack}
            className="h-10 rounded-xl border border-white/10 bg-white/[0.025] px-3 text-[12px] text-frost/65 hover:bg-white/[0.06] hover:text-frost"
          >
            <ArrowLeft size={16} className="mr-2" />
            {tl("subject_back")}
          </Button>
        </div>

        <div className="mx-auto mt-10 w-full max-w-[1320px] lg:mt-14">
          <div className="mx-auto max-w-[720px] text-center">
            <div className="mb-4 flex items-center justify-center gap-2.5 text-[11px] font-semibold text-frost/35">
              <span className="h-1.5 w-12 rounded-full bg-accent" />
              <span className="h-1.5 w-12 overflow-hidden rounded-full bg-white/10">
                <motion.span
                  className="block h-full w-full origin-left rounded-full bg-accent"
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1], delay: 0.12 }}
                />
              </span>
              <span className="h-1.5 w-12 rounded-full bg-white/10" />
              <motion.span
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.24, delay: 0.2 }}
              >
                2 / 3
              </motion.span>
            </div>

            <h1 className="text-4xl font-bold tracking-[-0.035em] text-frost sm:text-5xl">{tl("subject_choose")}</h1>
            <p className="mx-auto mt-3 max-w-[660px] text-sm leading-6 text-frost/50 sm:text-[15px]">
              {tl("subject_available_count", { grade, count: subjects.length })}
            </p>
          </div>

          {error && (
            <p role="alert" className="mx-auto mt-6 max-w-2xl rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-center text-sm text-danger">
              {error}
            </p>
          )}

          <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {subjects.map((subject) => {
              const name = locale === "kk" ? subject.nameKk : locale === "en" ? subject.nameEn : subject.nameRu;
              return (
                <button
                  key={subject.id}
                  type="button"
                  aria-label={name}
                  disabled={loading}
                  className="session-subject-card group relative flex min-h-[118px] items-center gap-4 rounded-[18px] px-4 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait disabled:opacity-55"
                  onClick={() => onSelectSubject(subject.id)}
                >
                  <span
                    className="grid h-11 w-11 shrink-0 place-items-center rounded-[13px]"
                    style={{ backgroundColor: `${subject.accent}18`, color: subject.accent }}
                  >
                    <BookOpen size={21} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold text-frost">{name}</span>
                    <span className="mt-1 block text-[11px] text-frost/40">{tl("subject_open_lesson")}</span>
                  </span>
                  <ChevronRight size={17} className="shrink-0 translate-x-1 text-frost/25 transition duration-200 group-hover:translate-x-0 group-hover:text-accent" />
                </button>
              );
            })}
          </div>
        </div>
      </section>
    </main>
  );
}
