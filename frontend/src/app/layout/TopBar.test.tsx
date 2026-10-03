// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import { ThemeProvider } from "@/app/theme/ThemeProvider";
import TopBar from "./TopBar";

const callbacks = {
  onTogglePresenter: vi.fn(),
  onToggleRunning: vi.fn(),
  onReset: vi.fn(),
  onChangeTab: vi.fn(),
  onToggleSlideshow: vi.fn(),
  onChangePerformanceMode: vi.fn(),
  onCompleteLesson: vi.fn(),
  onOpenHistory: vi.fn(),
  onChangeRoom: vi.fn(),
};

const props = {
  apiStatus: { ok: true, ai: true, ocr: true },
  lessonTitle: "Алгебра",
  presenterMode: false,
  running: true,
  seconds: 61,
  currentTab: "tasks",
  tabs: [{ id: "tasks", label: "Задания" }, { id: "slides", label: "Презентация" }],
  slideshowOpen: false,
  performanceMode: "balanced" as const,
  schoolName: "ОСШГ №11",
  roomName: "20",
  grade: 11,
  subjectName: "Алгебра",
  ...callbacks,
};

const mount = () => render(
  <ThemeProvider>
    <I18nProvider>
      <TopBar {...props} />
    </I18nProvider>
  </ThemeProvider>,
);

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
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
});

describe("TopBar lesson UI", () => {
  it("keeps the lesson header focused on primary actions", () => {
    mount();
    expect(screen.getByText("01:01")).toBeInTheDocument();
    expect(screen.queryByText("Открытый урок")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Полный экран" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Завершить" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Настройки" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Пауза" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Сброс" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "История" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Сменить кабинет" })).not.toBeInTheDocument();
  });

  it("moves secondary lesson actions into settings", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));

    fireEvent.click(screen.getByRole("button", { name: "Пауза" }));
    fireEvent.click(screen.getByRole("button", { name: "Сброс" }));
    fireEvent.click(screen.getByRole("button", { name: "История" }));
    fireEvent.click(screen.getByRole("button", { name: "Сменить кабинет" }));

    expect(callbacks.onToggleRunning).toHaveBeenCalledOnce();
    expect(callbacks.onReset).toHaveBeenCalledOnce();
    expect(callbacks.onOpenHistory).toHaveBeenCalledOnce();
    expect(callbacks.onChangeRoom).toHaveBeenCalledOnce();
  });

  it("switches the application theme from settings", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));

    const lightButton = screen.getByRole("button", { name: "Светлая" });
    expect(lightButton).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(lightButton);

    expect(lightButton).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });
});
