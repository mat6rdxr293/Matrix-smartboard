import { ArrowLeft, History, MessageSquare, PenLine, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getSubjectsForGrade } from "./curriculum";
import type { Lesson, LessonSummary, Room } from "./types";

type LessonHistoryProps = {
  room: Room;
  lessons: LessonSummary[];
  loading?: boolean;
  error?: string | null;
  onOpenLesson: (lesson: Lesson) => void;
  onBack: () => void;
};

export default function LessonHistory({ room, lessons, loading = false, error, onOpenLesson, onBack }: LessonHistoryProps) {
  return (
    <main className="session-shell grid-overlay items-start py-8">
      <section className="w-full max-w-5xl">
        <div className="mb-7 flex items-center justify-between gap-4">
          <Button variant="outline" onClick={onBack}><ArrowLeft size={17} className="mr-2" />К выбору класса</Button>
          <span className="text-sm font-semibold text-frost/60">Кабинет {room.name}</span>
        </div>
        <div className="mb-7">
          <p className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.18em] text-accent"><History size={17} />Архив кабинета</p>
          <h1 className="mt-2 text-3xl font-bold text-frost">История уроков</h1>
        </div>
        {error && <p role="alert" className="mb-4 text-danger">{error}</p>}
        {loading ? (
          <div className="glass rounded-2xl p-8 text-center text-frost/55">Загружаем уроки…</div>
        ) : lessons.length === 0 ? (
          <div className="glass rounded-2xl p-10 text-center text-frost/55">В этом кабинете пока нет сохранённых уроков.</div>
        ) : (
          <div className="space-y-3">
            {lessons.map((lesson) => {
              const subject = getSubjectsForGrade(lesson.grade).find((item) => item.id === lesson.subjectId);
              const date = new Date(lesson.startedAt).toLocaleString("ru-RU", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
              return (
                <article key={lesson.id} className="glass flex flex-col gap-4 rounded-2xl p-5 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-bold text-frost">{lesson.grade} класс · {subject?.nameRu ?? lesson.subjectId}</h2>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${lesson.status === "active" ? "bg-accent/15 text-accent" : "bg-white/10 text-frost/55"}`}>{lesson.status === "active" ? "Идёт сейчас" : "Завершён"}</span>
                    </div>
                    <p className="mt-1 text-sm text-frost/45">{date}</p>
                    <div className="mt-3 flex gap-4 text-xs text-frost/50"><span className="flex items-center gap-1"><PenLine size={14} />{lesson.boardOperationsCount ?? 0} действий</span><span className="flex items-center gap-1"><MessageSquare size={14} />{lesson.chatMessagesCount ?? 0} сообщений</span></div>
                  </div>
                  <Button variant={lesson.status === "active" ? "accent" : "outline"} onClick={() => onOpenLesson(lesson)}><Play size={16} className="mr-2" />Открыть урок</Button>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
