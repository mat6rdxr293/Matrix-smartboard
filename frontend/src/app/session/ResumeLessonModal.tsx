import { BookOpenCheck, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getSubjectsForGrade } from "./curriculum";
import type { Lesson } from "./types";

type ResumeLessonModalProps = {
  lesson: Lesson;
  loading?: boolean;
  onResume: () => void;
  onStartNew: () => void;
};

export default function ResumeLessonModal({ lesson, loading = false, onResume, onStartNew }: ResumeLessonModalProps) {
  const subject = getSubjectsForGrade(lesson.grade).find((item) => item.id === lesson.subjectId);
  const started = new Date(lesson.startedAt).toLocaleString("ru-RU", { day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/70 p-4 backdrop-blur-sm" role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="resume-title" className="glass w-full max-w-md rounded-[26px] border-white/15 p-6 shadow-2xl sm:p-7">
        <div className="mb-5 grid h-12 w-12 place-items-center rounded-xl bg-accent/15 text-accent"><BookOpenCheck size={25} /></div>
        <h2 id="resume-title" className="text-2xl font-bold text-frost">Продолжить последний урок?</h2>
        <p className="mt-2 text-sm leading-relaxed text-frost/60">В кабинете остался незавершённый урок. Доска, история изменений и чат с ассистентом сохранены.</p>
        <div className="my-5 rounded-xl border border-white/10 bg-white/5 p-4">
          <div className="font-semibold text-frost">{lesson.grade} класс · {subject?.nameRu ?? lesson.subjectId}</div>
          <div className="mt-1 text-xs text-frost/45">Начат {started}</div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Button variant="accent" className="h-11" disabled={loading} onClick={onResume}>Вернуться к уроку</Button>
          <Button variant="outline" className="h-11" disabled={loading} onClick={onStartNew}><Plus size={16} className="mr-2" />Начать новый</Button>
        </div>
      </section>
    </div>
  );
}
