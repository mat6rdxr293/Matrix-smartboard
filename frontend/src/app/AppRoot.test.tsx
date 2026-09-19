// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";

const api = vi.hoisted(() => ({
  currentSchool: vi.fn(), listRooms: vi.fn(), activeLesson: vi.fn(),
  register: vi.fn(), login: vi.fn(), logout: vi.fn(), createRoom: vi.fn(),
  createLesson: vi.fn(), completeLesson: vi.fn(), resumeLesson: vi.fn(), listLessons: vi.fn(),
}));

vi.mock("./session/api", () => ({ sessionApi: api }));
vi.mock("./App", () => ({
  default: ({ lesson, onComplete }: { lesson: { id: string }; onComplete: () => void }) => (
    <div data-testid="workspace">{lesson.id}<button onClick={onComplete}>finish</button></div>
  ),
}));

import AppRoot from "./AppRoot";

const school = { id: "school-1", name: "Школа №11", createdAt: 1 };
const room = { id: "room-1", schoolId: school.id, name: "20", createdAt: 2 };
const lesson = {
  id: "lesson-1", schoolId: school.id, roomId: room.id, roomName: room.name,
  grade: 7, subjectId: "physics", status: "active", startedAt: 3, updatedAt: 4, endedAt: null,
};

const mount = () => render(<I18nProvider><AppRoot /></I18nProvider>);

describe("AppRoot", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    } as Storage;
    vi.stubGlobal("localStorage", storage);
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
    api.listRooms.mockResolvedValue([room]);
    api.activeLesson.mockResolvedValue(null);
    api.listLessons.mockResolvedValue([]);
  });

  it("shows authentication when no school session exists", async () => {
    api.currentSchool.mockRejectedValue({ status: 401, detail: "unauthorized" });
    mount();
    expect(await screen.findByRole("heading", { name: "Аккаунт школы" })).toBeInTheDocument();
  });

  it("asks for the cabinet when the device has no binding", async () => {
    api.currentSchool.mockResolvedValue(school);
    mount();
    expect(await screen.findByRole("heading", { name: "Выберите кабинет" })).toBeInTheDocument();
  });

  it("offers to resume a bound room lesson and opens it", async () => {
    localStorage.setItem(`practice.room.${school.id}`, room.id);
    api.currentSchool.mockResolvedValue(school);
    api.activeLesson.mockResolvedValue(lesson);
    api.resumeLesson.mockResolvedValue(lesson);
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Вернуться к уроку" }));
    await waitFor(() => expect(api.resumeLesson).toHaveBeenCalledWith(lesson.id));
    expect(await screen.findByTestId("workspace")).toHaveTextContent(lesson.id);
  });

  it("completes the old lesson when starting new from the refresh modal", async () => {
    localStorage.setItem(`practice.room.${school.id}`, room.id);
    api.currentSchool.mockResolvedValue(school);
    api.activeLesson.mockResolvedValue(lesson);
    api.completeLesson.mockResolvedValue({ ...lesson, status: "completed" });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Начать новый" }));
    await waitFor(() => expect(api.completeLesson).toHaveBeenCalledWith(lesson.id));
    expect(await screen.findByRole("heading", { name: "Выберите класс" })).toBeInTheDocument();
  });

  it("selects a board profile before creating a lesson", async () => {
    localStorage.setItem(`practice.room.${school.id}`, room.id);
    api.currentSchool.mockResolvedValue(school);
    api.createLesson.mockResolvedValue(lesson);
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "7 класс" }));
    expect(await screen.findByRole("heading", { name: "Выберите предмет" })).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Физика" }));
    expect(await screen.findByRole("heading", { name: "Выберите доску" })).toBeInTheDocument();
    expect(api.createLesson).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Текстовая" }));
    await waitFor(() => expect(api.createLesson).toHaveBeenCalledWith(room.id, 7, "physics"));
    expect(localStorage.getItem(`practice.lesson.${lesson.id}.boardProfile`)).toBe("textual");
    expect(await screen.findByTestId("workspace")).toHaveTextContent(lesson.id);
  });
});
