import type { Task } from "@/app/tasks/tasks";
import MathText from "@/components/MathText";
import { useI18n } from "@/i18n";

export type TaskPanelProps = {
  task: Task;
};

export default function TaskPanel({ task }: TaskPanelProps) {
  const { tl } = useI18n();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-1 pb-4">
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-frost/40">{tl("task_id", { id: task.id })}</div>
          <div className="mt-1 text-[18px] font-semibold leading-tight tracking-[-0.02em] text-frost">
            <MathText text={task.title} />
          </div>
        </div>
        <div className="mt-4 text-[14px] leading-6 text-frost/78">
          <MathText text={task.problem} className="text-frost/90" />
        </div>
      </div>

      <div className="mt-auto border-t border-white/10 px-1 pt-4 text-[12px] leading-5 text-frost/45">
        {tl("solve_on_board_ai")}
      </div>
    </div>
  );
}
