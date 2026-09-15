import { motion } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Task } from "@/app/tasks/tasks";
import MathText from "@/components/MathText";

export type SlideItem = {
  id: number;
  title: string;
};

type SidebarProps = {
  slides: SlideItem[];
  currentSlide: number;
  onSelectSlide: (index: number) => void;
  tasks: Task[];
  selectedTaskId: number;
  onSelectTask: (id: number) => void;
};

export default function Sidebar({
  slides,
  currentSlide,
  onSelectSlide,
  tasks,
  selectedTaskId,
  onSelectTask,
}: SidebarProps) {
  return (
    <div className="flex h-full flex-col gap-4">
      <div className="glass rounded-2xl p-4 shadow-soft">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-frost/70">Слайды урока</h3>
          <Badge>План</Badge>
        </div>
        <div className="flex flex-col gap-2">
          {slides.map((slide, idx) => {
            const active = idx === currentSlide;
            return (
              <motion.button
                key={slide.id}
                whileHover={{ x: 4 }}
                className={cn(
                  "flex items-center justify-between rounded-xl border px-3 py-2 text-left text-sm transition",
                  active
                    ? "border-neon/40 bg-white/10 text-frost"
                    : "border-white/10 bg-transparent text-frost/70 hover:border-white/30"
                )}
                onClick={() => onSelectSlide(idx)}
              >
                <span>{slide.title}</span>
                <span className="text-xs text-frost/50">{idx + 1}</span>
              </motion.button>
            );
          })}
        </div>
      </div>
      <div className="glass flex-1 rounded-2xl p-4 shadow-soft">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-frost/70">Карточки 15 заданий</h3>
          <Badge>Практика</Badge>
        </div>
        <div className="scrollbar-hide grid max-h-[44vh] grid-cols-1 gap-2 overflow-auto pr-1">
          {tasks.map((task) => {
            const active = task.id === selectedTaskId;
            return (
              <button
                key={task.id}
                className={cn(
                  "rounded-xl border px-3 py-2 text-left text-sm transition",
                  active
                    ? "border-accent/60 bg-accent/10"
                    : "border-white/10 hover:border-white/30"
                )}
                onClick={() => onSelectTask(task.id)}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold">#{task.id}</span>
                  <span className="text-xs text-frost/60"><MathText text={task.tags[0]}/></span>
                </div>
                <div className="text-xs text-frost/70"><MathText text={task.title}/></div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
