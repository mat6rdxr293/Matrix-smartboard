import type { CurriculumSubjectId } from "@/app/session/curriculum";

export type BoardProfile = "analytical" | "textual" | "universal";

export type BoardProfileConfig = {
  id: BoardProfile;
  name: string;
  description: string;
  hint: string;
  backgroundPattern: "grid" | "lines";
  graphTools: boolean;
  humanitiesTools: boolean;
};

export const BOARD_PROFILES: BoardProfileConfig[] = [
  {
    id: "analytical",
    name: "Аналитическая",
    description: "Для математики, физики и точных дисциплин.",
    hint: "Клетка · графики · линейка",
    backgroundPattern: "grid",
    graphTools: true,
    humanitiesTools: false,
  },
  {
    id: "textual",
    name: "Текстовая",
    description: "Для языков, истории и работы с текстом.",
    hint: "Линии · маркер · подчёркивание",
    backgroundPattern: "lines",
    graphTools: false,
    humanitiesTools: true,
  },
  {
    id: "universal",
    name: "Универсальная",
    description: "Полный набор инструментов без ограничений.",
    hint: "Графики · маркер · все инструменты",
    backgroundPattern: "grid",
    graphTools: true,
    humanitiesTools: true,
  },
];

export const getBoardProfileConfig = (profile: BoardProfile) =>
  BOARD_PROFILES.find((item) => item.id === profile) ?? BOARD_PROFILES[2];

export const isBoardProfile = (value: unknown): value is BoardProfile =>
  value === "analytical" || value === "textual" || value === "universal";

export const inferBoardProfileForSubject = (subjectId: CurriculumSubjectId): BoardProfile => {
  if (["math", "algebra", "geometry", "physics"].includes(subjectId)) return "analytical";
  if (["kazakh", "russian", "english"].includes(subjectId)) return "textual";
  return "universal";
};

