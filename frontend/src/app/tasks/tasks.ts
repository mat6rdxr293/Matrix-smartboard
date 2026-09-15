import tasksData from "./tasks.data.json";

export type Task = {
  id: number;
  title: string;
  problem: string;
  tags: string[];
};

export const tasks: Task[] = (tasksData as Task[]).map((task) => ({
  ...task,
  tags: Array.isArray(task.tags) ? task.tags : [],
}));
