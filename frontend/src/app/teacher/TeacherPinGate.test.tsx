// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import TeacherPinGate from "./TeacherPinGate";

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

  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      subtle: {
        digest: vi.fn(async (_algorithm: string, data: BufferSource) => {
          const bytes = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          return bytes.slice().buffer;
        }),
      },
    },
  });
});

afterEach(() => cleanup());

describe("TeacherPinGate", () => {
  it("creates a PIN once and requires it on later access", async () => {
    const firstUnlock = vi.fn();
    const first = render(
      <I18nProvider>
        <TeacherPinGate storageKey="teacher.pin" onUnlock={firstUnlock} />
      </I18nProvider>,
    );

    fireEvent.change(screen.getByLabelText("PIN учителя"), { target: { value: "1234" } });
    fireEvent.change(screen.getByLabelText("Повторите PIN"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить PIN" }));

    await waitFor(() => expect(firstUnlock).toHaveBeenCalledTimes(1));
    expect(window.localStorage.getItem("teacher.pin")).toBe("31323334");

    first.unmount();

    const secondUnlock = vi.fn();
    render(
      <I18nProvider>
        <TeacherPinGate storageKey="teacher.pin" onUnlock={secondUnlock} />
      </I18nProvider>,
    );

    fireEvent.change(screen.getByLabelText("PIN учителя"), { target: { value: "9999" } });
    fireEvent.click(screen.getByRole("button", { name: "Открыть панель" }));
    await screen.findByText("Неверный PIN");
    expect(secondUnlock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("PIN учителя"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Открыть панель" }));
    await waitFor(() => expect(secondUnlock).toHaveBeenCalledTimes(1));
  });
});

