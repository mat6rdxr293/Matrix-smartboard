// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";

const apiFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/apiClient", () => ({
  apiFetch,
}));

import LessonGenerator from "./LessonGenerator";

const generatedLesson = {
  workspace: {
    slides: [
      { id: 1, title: "Логарифмы", content: "", notes: "", elements: [] },
      { id: 2, title: "Свойства", content: "", notes: "", elements: [] },
      { id: 3, title: "Практика", content: "", notes: "", elements: [] },
    ],
    tasks: [
      { id: 1, title: "Задание 1", problem: "log", tags: [], kind: "open" },
      { id: 2, title: "Задание 2", problem: "log", tags: [], kind: "test" },
      { id: 3, title: "Задание 3", problem: "log", tags: [], kind: "open" },
    ],
  },
  meta: {
    textSource: "manual",
    checks: { ok: 3 },
  },
};

const mount = ({
  onApplied = vi.fn(),
  onChangeTasks = vi.fn(),
  onChangeSlides = vi.fn(),
}: {
  onApplied?: (mode: "replace" | "append" | "tasks" | "slides") => void;
  onChangeTasks?: ReturnType<typeof vi.fn>;
  onChangeSlides?: ReturnType<typeof vi.fn>;
} = {}) =>
  render(
    <I18nProvider>
      <LessonGenerator
        currentTasks={[]}
        currentSlides={[]}
        onChangeTasks={onChangeTasks}
        onChangeSlides={onChangeSlides}
        onApplied={onApplied}
      />
    </I18nProvider>,
  );

describe("LessonGenerator flow", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetch.mockImplementation(async (path: string) => {
      if (path === "/api/lesson-generation/sources") {
        return {
          ok: true,
          json: async () => ({ mlDataAvailable: false, books: [] }),
        } as Response;
      }
      if (path === "/api/lesson-generation/jobs") {
        return {
          ok: true,
          json: async () => ({ jobId: "job-1" }),
        } as Response;
      }
      if (path.startsWith("/api/lesson-generation/jobs/job-1")) {
        return {
          ok: true,
          json: async () => ({ status: "done", progress: 100, stage: "done", result: generatedLesson }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
  });

  it("starts with two source cards and no generation form", async () => {
    mount();

    expect(await screen.findByRole("heading", { name: "Как создать урок?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Вставить материал/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Учебник/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Сгенерировать урок" })).not.toBeInTheDocument();
    expect(screen.queryByText("Предпросмотр")).not.toBeInTheDocument();
  });

  it("shows the generated state first and opens preview only on request", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Вставить материал/ }));

    const material = screen.getByPlaceholderText(/Вставьте параграф/);
    fireEvent.change(material, {
      target: {
        value:
          "Логарифм положительного числа определяется как показатель степени. " +
          "Основное логарифмическое тождество и свойства логарифмов используются для преобразования выражений.",
      },
    });

    const generate = screen.getByRole("button", { name: "Сгенерировать урок" });
    expect(generate).toBeEnabled();
    fireEvent.click(generate);

    expect(await screen.findByRole("heading", { name: "Урок сгенерирован" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Показать предпросмотр" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Предпросмотр" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Показать предпросмотр" }));
    expect(await screen.findByRole("heading", { name: "Предпросмотр" })).toBeInTheDocument();
    expect(screen.getByText(/Логарифмы/)).toBeInTheDocument();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      "/api/lesson-generation/jobs",
      expect.objectContaining({ method: "POST" }),
    ));
  });

  it("applies generated lesson and exposes a real settings button", async () => {
    const onApplied = vi.fn();
    const onChangeTasks = vi.fn();
    const onChangeSlides = vi.fn();
    mount({ onApplied, onChangeTasks, onChangeSlides });

    fireEvent.click(await screen.findByRole("button", { name: /Вставить материал/ }));
    fireEvent.change(screen.getByPlaceholderText(/Вставьте параграф/), {
      target: {
        value:
          "Логарифм положительного числа определяется как показатель степени. " +
          "Основное логарифмическое тождество и свойства логарифмов используются для преобразования выражений.",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сгенерировать урок" }));

    expect(await screen.findByRole("heading", { name: "Урок сгенерирован" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Изменить параметры" }));
    expect(await screen.findByPlaceholderText(/Вставьте параграф/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Сгенерировать урок" }));
    expect(await screen.findByRole("heading", { name: "Урок сгенерирован" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Заменить урок" }));
    expect(onChangeTasks).toHaveBeenCalled();
    expect(onChangeSlides).toHaveBeenCalled();
    expect(onApplied).toHaveBeenCalledWith("replace");
  });
});
