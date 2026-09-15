import type { Grade, CurriculumSubjectId } from "./curriculum";
import type { Stroke } from "@/app/board/boardEngine";

export type School = {
  id: string;
  name: string;
  createdAt: number;
};

export type Room = {
  id: string;
  schoolId: string;
  name: string;
  createdAt: number;
};

export type LessonStatus = "active" | "completed";

export type Lesson = {
  id: string;
  schoolId: string;
  roomId: string;
  roomName?: string;
  grade: Grade;
  subjectId: CurriculumSubjectId;
  status: LessonStatus;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  boardOperationsCount?: number;
  chatMessagesCount?: number;
};

export type LessonSummary = Lesson;

export type ChatMessage = {
  sequence: number;
  clientMessageId: string;
  role: "student" | "assistant";
  text: string;
  mode?: string | null;
  status: "ok" | "error";
  createdAt: number;
};

export type BoardOperation = {
  sequence?: number;
  clientOperationId?: string;
  client_operation_id?: string;
  op: "add" | "undo" | "redo" | "clear";
  stroke?: Stroke;
  ts?: number;
};
