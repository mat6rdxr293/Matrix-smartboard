// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import { DEFAULT_PRESENTATION_SOURCE } from "@/app/presentation/presentationSource";

const apiFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/apiClient", () => ({
  apiFetch,
  backendAssetUrl: (value: string) => value,
}));

import TeacherDashboard from "./TeacherDashboard";

const mount = () =>
  render(
    <I18nProvider>
      <TeacherDashboard
        subjectId="physics"
        tasks={[{ id: 1, title: "Второй закон Ньютона", problem: "F = ma", tags: ["динамика"] }]}
        slides={[{ id: 1, title: "Сила", content: "F = ma", notes: "", elements: [] }]}
        presentationSource={DEFAULT_PRESENTATION_SOURCE}
        onChangeTasks={vi.fn()}
        onChangeSlides={vi.fn()}
        onChangePresentationSource={vi.fn()}
        onClose={vi.fn()}
        siteBackground={{ mode: "solid", color: "#0A0E14", gradient: "", image: "" }}
        onChangeSiteBackground={vi.fn()}
        autosaveInfo={{ intervalSec: 8, lastServerSaveAt: null, lastLocalBackupAt: null }}
        fullPage
      />
    </I18nProvider>,
  );

describe("TeacherDashboard simplified navigation", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetch.mockImplementation(async (path: string) => {
      if (path.includes("/api/m365/status")) {
        return { ok: true, json: async () => ({ configured: false, connected: false }) } as Response;
      }
      if (path.includes("/api/board/replays")) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (path.includes("/api/ai/history")) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });
  });

  it("starts from a simple home screen and keeps task navigation clear", async () => {
    mount();

    expect(screen.getByRole("heading", { name: "Что хотите подготовить?" })).toBeInTheDocument();
    expect(screen.queryByText("Панель учителя")).not.toBeInTheDocument();
    expect(screen.getByText("Физика · заданий: 1 · слайдов: 1")).toBeInTheDocument();
    expect(screen.queryByText(/Основные функции находятся здесь/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Дополнительные возможности сохранены/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Сохранить" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Закрыть" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Действия с презентацией")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Задания/ }));
    expect(await screen.findByText("Редактор задания")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Второй закон Ньютона")).toBeInTheDocument();
    const back = screen.getByRole("button", { name: "Назад: Задания" });
    fireEvent.click(back);
    expect(screen.queryByRole("button", { name: "Назад: Задания" })).not.toBeInTheDocument();
    expect((await screen.findAllByRole("heading", { name: "Что хотите подготовить?" })).length).toBeGreaterThan(0);
  });

  it("keeps all presentation tools reachable", async () => {
    mount();

    fireEvent.click(screen.getByRole("button", { name: /^Презентация/ }));
    expect(await screen.findByRole("button", { name: "Загрузить PowerPoint" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Назад: Презентация" })).toBeInTheDocument();
    expect(screen.getByLabelText("Действия с презентацией")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Дополнительные возможности" }));
    const alternateImport = screen.getByText("Другие варианты импорта PowerPoint");
    fireEvent.click(alternateImport);
    expect(screen.getByRole("button", { name: "Импортировать с редактируемыми элементами" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Импортировать элементы отдельно" })).toBeInTheDocument();

    fireEvent.click(screen.getAllByText(/Microsoft 365/)[0]);
    expect(screen.getByRole("button", { name: "Подключить Microsoft 365" })).toBeInTheDocument();

    fireEvent.click(screen.getAllByText(/Office Viewer/)[0]);
    expect(screen.getByRole("button", { name: "Импортировать файл" })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Действия с презентацией"));
    expect(screen.getByRole("button", { name: "Скачать PowerPoint" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сохранить PPTX на сервер" })).toBeInTheDocument();
  });

  it("keeps lesson replay and AI history reachable", async () => {
    mount();

    fireEvent.click(screen.getByRole("button", { name: /^История урока/ }));
    expect(await screen.findByText("История работы ИИ")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Назад: История урока" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Действия с презентацией")).not.toBeInTheDocument();
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  });

});
