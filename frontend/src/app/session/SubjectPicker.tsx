import { ArrowLeft, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getSubjectsForGrade, type CurriculumSubjectId, type Grade } from "./curriculum";

type SubjectPickerProps = {
  grade: Grade;
  locale: "ru" | "kk";
  loading?: boolean;
  error?: string | null;
  onSelectSubject: (subjectId: CurriculumSubjectId) => void;
  onBack: () => void;
};

export default function SubjectPicker({ grade, locale, loading = false, error, onSelectSubject, onBack }: SubjectPickerProps) {
  const subjects = getSubjectsForGrade(grade);
  return (
    <main className="session-shell grid-overlay items-start py-8 sm:items-center">
      <section className="w-full max-w-5xl">
        <Button variant="outline" onClick={onBack} className="mb-7"><ArrowLeft size={17} className="mr-2" />Назад к классам</Button>
        <div className="mb-7 text-center">
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-accent">Шаг 2 из 2 · {grade} класс</p>
          <h1 className="mt-2 text-3xl font-bold text-frost sm:text-4xl">Выберите предмет</h1>
          <p className="mt-2 text-frost/55">Для {grade} класса доступно предметов: {subjects.length}</p>
        </div>
        {error && <p role="alert" className="mx-auto mb-4 max-w-xl rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-center text-sm text-rose-200">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {subjects.map((subject) => {
            const name = locale === "kk" ? subject.nameKk : subject.nameRu;
            return (
              <button
                key={subject.id}
                type="button"
                aria-label={name}
                disabled={loading}
                className="glass group flex min-h-28 items-center gap-4 rounded-2xl p-5 text-left transition hover:-translate-y-0.5 hover:border-white/20 disabled:cursor-wait disabled:opacity-55"
                onClick={() => onSelectSubject(subject.id)}
              >
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl" style={{ backgroundColor: `${subject.accent}20`, color: subject.accent }}><BookOpen size={24} /></span>
                <span><span className="block text-lg font-bold text-frost group-hover:text-white">{name}</span><span className="mt-1 block text-xs text-frost/45">Открыть новый урок</span></span>
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}
