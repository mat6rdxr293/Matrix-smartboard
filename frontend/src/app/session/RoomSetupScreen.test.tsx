// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import RoomSetupScreen from "./RoomSetupScreen";

const school = { id: "school-1", name: "ОСШГ №11", createdAt: 1 };
const rooms = [
  { id: "room-1", schoolId: school.id, name: "28", createdAt: 2 },
  { id: "room-2", schoolId: school.id, name: "31", createdAt: 3 },
];

describe("RoomSetupScreen", () => {
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

  it("shows rooms in the wide picker and opens room creation only in a modal", () => {
    render(
      <I18nProvider>
        <RoomSetupScreen
          school={school}
          rooms={rooms}
          onSelectRoom={vi.fn()}
          onCreateRoom={vi.fn()}
          onLogout={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("button", { name: /28/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /31/ })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/номер или название/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /новый кабинет/i }));
    expect(screen.getByRole("dialog", { name: /новый кабинет/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/номер или название/i)).toBeInTheDocument();
  });

  it("creates a room from the modal and trims the entered name", async () => {
    const onCreateRoom = vi.fn().mockResolvedValue(undefined);
    render(
      <I18nProvider>
        <RoomSetupScreen
          school={school}
          rooms={rooms}
          onSelectRoom={vi.fn()}
          onCreateRoom={onCreateRoom}
          onLogout={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /новый кабинет/i }));
    fireEvent.change(screen.getByPlaceholderText(/номер или название/i), {
      target: { value: "  42  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /^создать$/i }));

    await waitFor(() => expect(onCreateRoom).toHaveBeenCalledWith("42"));
  });

  it("closes the create modal with Escape", () => {
    render(
      <I18nProvider>
        <RoomSetupScreen
          school={school}
          rooms={rooms}
          onSelectRoom={vi.fn()}
          onCreateRoom={vi.fn()}
          onLogout={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /новый кабинет/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
