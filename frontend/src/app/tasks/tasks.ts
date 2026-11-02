export type TaskCheck = {
  status: "ok" | "fixed" | "wrong" | "unverified";
  note?: string;
};

export type Task = {
  id: number;
  title: string;
  problem: string;
  tags: string[];
  kind?: "test" | "open" | "calc";
  answer?: string;
  solution?: string | null;
  options?: string[];
  level?: 1 | 2 | 3 | null;
  check?: TaskCheck | null;
};
