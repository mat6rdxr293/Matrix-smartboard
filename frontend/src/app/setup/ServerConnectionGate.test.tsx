// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import ServerConnectionGate from "./ServerConnectionGate";
import type { SavedServerConnectionResult } from "./androidSetup";

describe("ServerConnectionGate", () => {
  it("shows human-readable diagnostics for an unreachable discovered server", () => {
    const result: SavedServerConnectionResult = {
      ok: false,
      reason: "server-found-unreachable",
      serverName: "Главный сервер",
      serverUrl: "https://192.168.1.20:8443",
      checks: {
        savedAddress: "failed",
        discovery: "ok",
        identity: "failed",
        backend: "failed",
      },
    };

    render(
      <I18nProvider>
        <ServerConnectionGate
          checking={false}
          result={result}
          onRetry={vi.fn()}
          onConfigure={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Сервер недоступен")).toBeInTheDocument();
    expect(screen.getByText("Главный сервер")).toBeInTheDocument();
    expect(screen.getByText("Сервер найден, но прямое соединение заблокировано или недоступно.")).toBeInTheDocument();
    expect(screen.getByText("Сохранённый адрес")).toBeInTheDocument();
    expect(screen.getByText("Поиск в локальной сети")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Повторить/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Настроить подключение/ })).toBeInTheDocument();
  });
});
