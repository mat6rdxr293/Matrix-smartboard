// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";

import GradePicker from "./GradePicker";
import LessonHistory from "./LessonHistory";
import ResumeLessonModal from "./ResumeLessonModal";
import SubjectPicker from "./SubjectPicker";
import type { Lesson, Room, School } from "./types";

const school: School = { id: "school-1", name: "Школа №11", createdAt: 1 };
const room: Room = { id: "room-1", schoolId: school.id, name: "20", createdAt: 2 };
const lesson: Lesson = {
  id: "lesson-1", schoolId: school.id, roomId: room.id, roomName: room.name,
  grade: 7, subjectId: "physics", status: "active", startedAt: 3, updatedAt: 4, endedAt: null,
};

describe("lesson entry flow", () => {
  it("selects a class before showing its allowed subjects", () => {
    const onSelectGrade = vi.fn();
    const { rerender } = render(
      <I18nProvider>
        <GradePicker school={school} room={room} onSelectGrade={onSelectGrade} onOpenHistory={() => {}} onLogout={() => {}} onChangeRoom={() => {}} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "6 класс" }));
    expect(onSelectGrade).toHaveBeenCalledWith(6);

    rerender(<I18nProvider><SubjectPicker grade={6} locale="ru" onSelectSubject={() => {}} onBack={() => {}} /></I18nProvider>);
    expect(screen.getByRole("button", { name: /Естествознание/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Физика/ })).not.toBeInTheDocument();

    rerender(<I18nProvider><SubjectPicker grade={7} locale="ru" onSelectSubject={() => {}} onBack={() => {}} /></I18nProvider>);
    expect(screen.getByRole("button", { name: /Физика/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Естествознание/ })).not.toBeInTheDocument();
  });

  it("exposes both resume decisions in a modal", () => {
    const onResume = vi.fn();
    const onStartNew = vi.fn();
    render(<I18nProvider><ResumeLessonModal lesson={lesson} onResume={onResume} onStartNew={onStartNew} /></I18nProvider>);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Вернуться к уроку" }));
    fireEvent.click(screen.getByRole("button", { name: "Начать новый" }));
    expect(onResume).toHaveBeenCalledOnce();
    expect(onStartNew).toHaveBeenCalledOnce();
  });

  it("opens a selected lesson from room history", () => {
    const onOpenLesson = vi.fn();
    render(<I18nProvider><LessonHistory room={room} lessons={[lesson]} onOpenLesson={onOpenLesson} onBack={() => {}} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Открыть урок/ }));
    expect(onOpenLesson).toHaveBeenCalledWith(lesson);
  });
});
