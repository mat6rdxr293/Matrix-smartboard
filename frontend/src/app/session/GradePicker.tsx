import { Building2, History, LogOut, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  return (
    <main className="session-shell grid-overlay items-start py-8 sm:items-center">
      <section className="w-full max-w-5xl">
        <header className="glass mb-7 flex flex-col gap-4 rounded-2xl p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <span className="flex items-center gap-2 font-semibold text-frost"><Building2 size={17} className="text-accent" />{school.name}</span>
            <span className="flex items-center gap-2 text-frost/65"><MapPin size={17} />Кабинет {room.name}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={onOpenHistory}><History size={16} className="mr-2" />История уроков</Button>
            <Button variant="outline" size="sm" onClick={onChangeRoom}>Сменить кабинет</Button>
            <Button variant="ghost" size="sm" onClick={onLogout} aria-label="Выйти"><LogOut size={17} /></Button>
          </div>
        </header>

        <div className="mb-7 text-center">
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-accent">Шаг 1 из 2</p>
          <h1 className="mt-2 text-3xl font-bold text-frost sm:text-4xl">Выберите класс</h1>
          <p className="mt-2 text-frost/55">Покажем только предметы, которые изучают в этом классе.</p>
        </div>

        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {GRADES.map((grade) => (
            <button
              key={grade}
              type="button"
              aria-label={`${grade} класс`}
              className="glass group aspect-[1.08] rounded-2xl p-3 text-center transition hover:-translate-y-1 hover:border-accent/60 hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onClick={() => onSelectGrade(grade)}
            >
              <span className="block text-4xl font-black text-frost transition group-hover:text-accent">{grade}</span>
              <span className="mt-1 block text-xs font-semibold uppercase tracking-wide text-frost/45">класс</span>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
