import type { Grade, CurriculumSubjectId } from "./curriculum";
import type { BoardOperation, ChatMessage, Lesson, LessonSummary, Room, School } from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(detail);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: init.body ? { "Content-Type": "application/json", ...init.headers } : init.headers,
  });
  if (!response.ok) {
    let detail = `Запрос не выполнен (${response.status})`;
    try {
      const body = await response.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      // The status is still preserved when an upstream proxy returns plain text.
    }
    throw new ApiError(response.status, detail);
  }
  return response.json() as Promise<T>;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

export const sessionApi = {
  async register(schoolName: string, password: string): Promise<School> {
    return (await post<{ school: School }>("/api/auth/register-school", { school_name: schoolName, password })).school;
  },
  async login(schoolName: string, password: string): Promise<School> {
    return (await post<{ school: School }>("/api/auth/login-school", { school_name: schoolName, password })).school;
  },
  async logout(): Promise<void> {
    await post("/api/auth/logout");
  },
  async currentSchool(): Promise<School> {
    return (await request<{ school: School }>("/api/auth/session")).school;
  },
  async listRooms(): Promise<Room[]> {
    return (await request<{ items: Room[] }>("/api/rooms")).items;
  },
  async createRoom(name: string): Promise<Room> {
    return (await post<{ room: Room }>("/api/rooms", { name })).room;
  },
  async listLessons(roomId: string): Promise<LessonSummary[]> {
    return (await request<{ items: LessonSummary[] }>(`/api/rooms/${roomId}/lessons`)).items;
  },
  async activeLesson(roomId: string): Promise<Lesson | null> {
    return (await request<{ lesson: Lesson | null }>(`/api/rooms/${roomId}/active-lesson`)).lesson;
  },
  async createLesson(roomId: string, grade: Grade, subjectId: CurriculumSubjectId): Promise<Lesson> {
    return (await post<{ lesson: Lesson }>(`/api/rooms/${roomId}/lessons`, { grade, subject_id: subjectId })).lesson;
  },
  async getLesson(lessonId: string): Promise<Lesson> {
    return (await request<{ lesson: Lesson }>(`/api/lessons/${lessonId}`)).lesson;
  },
  async completeLesson(lessonId: string): Promise<Lesson> {
    return (await post<{ lesson: Lesson }>(`/api/lessons/${lessonId}/complete`)).lesson;
  },
  async resumeLesson(lessonId: string): Promise<Lesson> {
    return (await post<{ lesson: Lesson }>(`/api/lessons/${lessonId}/resume`)).lesson;
  },
  async loadBoard(lessonId: string): Promise<BoardOperation[]> {
    return (await request<{ operations: BoardOperation[] }>(`/api/lessons/${lessonId}/board`)).operations;
  },
  async appendBoard(lessonId: string, operations: BoardOperation[]): Promise<void> {
    await post(`/api/lessons/${lessonId}/board/operations`, { operations });
  },
  async loadChat(lessonId: string): Promise<ChatMessage[]> {
    return (await request<{ items: ChatMessage[] }>(`/api/lessons/${lessonId}/chat`)).items;
  },
};
