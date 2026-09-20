// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import AIAssistant from "./AIAssistant";

beforeEach(() => {
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

afterEach(() => cleanup());

describe("AIAssistant board recognition flow", () => {
  it("recognizes the board first and sends only after confirmation", async () => {
    const recognize = vi.fn().mockResolvedValue("x^2 = 4\nx = 2");
    const submit = vi.fn();

    render(
      <I18nProvider>
        <AIAssistant
          messages={[]}
          ocrEnabled
          onRecognizeBoard={recognize}
          onSubmitRecognized={submit}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /подсказка|кеңес/i }));

    await waitFor(() => expect(recognize).toHaveBeenCalledTimes(1));
    const recognized = await screen.findByRole("textbox", { name: /распознано с доски|тақтадан танылған/i });
    expect(recognized).toHaveValue("x^2 = 4\nx = 2");
    expect(submit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /верно, отправить|дұрыс, жіберу/i }));
    expect(submit).toHaveBeenCalledWith("hint", "x^2 = 4\nx = 2");
  });

  it("lets the user correct OCR text before sending it", async () => {
    const recognize = vi.fn().mockResolvedValue("x=3");
    const submit = vi.fn();

    render(
      <I18nProvider>
        <AIAssistant
          messages={[]}
          ocrEnabled
          onRecognizeBoard={recognize}
          onSubmitRecognized={submit}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /проверить решение|шешімді тексеру/i }));
    const recognized = await screen.findByRole("textbox", { name: /распознано с доски|тақтадан танылған/i });
    fireEvent.change(recognized, { target: { value: "x = 5" } });
    fireEvent.click(screen.getByRole("button", { name: /верно, отправить|дұрыс, жіберу/i }));

    expect(submit).toHaveBeenCalledWith("check", "x = 5");
  });

  it("can rerun recognition before confirmation", async () => {
    const recognize = vi.fn()
      .mockResolvedValueOnce("x=2")
      .mockResolvedValueOnce("x=4");

    render(
      <I18nProvider>
        <AIAssistant
          messages={[]}
          ocrEnabled
          onRecognizeBoard={recognize}
          onSubmitRecognized={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /полное решение|толық шешім/i }));
    await screen.findByDisplayValue("x=2");
    fireEvent.click(screen.getByRole("button", { name: /нет, распознать снова|жоқ, қайта тану/i }));

    await screen.findByDisplayValue("x=4");
    expect(recognize).toHaveBeenCalledTimes(2);
  });

  it("formats markdown and LaTeX in both student and assistant bubbles", () => {
    render(
      <I18nProvider>
        <AIAssistant
          messages={[
            {
              id: "student-1",
              role: "student",
              text: "**Мой ответ:** \\(x=2\\)",
              timestamp: "12:00",
            },
            {
              id: "assistant-1",
              role: "assistant",
              text: "**Первая ошибка:** не обнаружена.",
              timestamp: "12:01",
            },
          ]}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Мой ответ:").tagName).toBe("STRONG");
    expect(screen.getByText("Первая ошибка:").tagName).toBe("STRONG");
    expect(document.querySelectorAll(".katex").length).toBeGreaterThan(0);
  });
});
