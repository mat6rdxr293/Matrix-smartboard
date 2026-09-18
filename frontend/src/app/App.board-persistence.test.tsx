// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import { ThemeProvider } from "@/app/theme/ThemeProvider";

const mocks = vi.hoisted(() => ({
  loadBoardReplay: vi.fn(),
  appendBoardReplay: vi.fn(),
  loadChat: vi.fn(),
  getStatus: vi.fn(),
  boardProps: null as any,
}));

vi.mock("@/app/board/replayApi", async () => {
  const actual = await vi.importActual<typeof import("@/app/board/replayApi")>("@/app/board/replayApi");
  return { ...actual, loadBoardReplay: mocks.loadBoardReplay, appendBoardReplay: mocks.appendBoardReplay };
});
vi.mock("@/app/session/api", () => ({ sessionApi: { loadChat: mocks.loadChat } }));
vi.mock("@/app/ai/api", () => ({ getStatus: mocks.getStatus, callAi: vi.fn() }));
vi.mock("@/app/layout/TopBar", () => ({
  default: ({ onCompleteLesson }: { onCompleteLesson: () => void }) => (
    <button onClick={onCompleteLesson}>complete lesson</button>
  ),
}));
vi.mock("@/app/board/BoardCanvas", () => ({
  default: (props: any) => {
    mocks.boardProps = props;
    return <button data-testid="draw-stroke" onClick={() => props.onReplayOp({
      op: "add",
      stroke: { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], color: "#fff", width: 2, mode: "draw" },
      ts: 1,
    })}>draw</button>;
  },
}));
vi.mock("@/app/tasks/TaskPanel", () => ({ default: () => null }));
vi.mock("@/app/ai/AIAssistant", () => ({ default: () => null }));
vi.mock("@/components/MathText", () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));

import App from "./App";

const school = { id: "s1", name: "School", createdAt: 1 };
const room = { id: "r1", schoolId: "s1", name: "101", createdAt: 1 };
const lesson = { id: "l1", schoolId: "s1", roomId: "r1", roomName: "101", grade: 7, subjectId: "physics", status: "active", startedAt: 1, updatedAt: 1, endedAt: null } as const;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const mount = (onComplete = vi.fn()) => render(
  <ThemeProvider><I18nProvider><App school={school} room={room} lesson={lesson as any}
    onComplete={onComplete} onOpenHistory={vi.fn()} onChangeRoom={vi.fn()} /></I18nProvider></ThemeProvider>
);

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.boardProps = null;
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(), key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as Storage;
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  mocks.loadChat.mockResolvedValue([]);
  mocks.getStatus.mockResolvedValue({ ok: true, ai: false, ocr: false });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })),
  });
  Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: vi.fn(() => `id-${Math.random()}`) });
});
afterEach(() => cleanup());

describe("board replay persistence", () => {
  it("uses a light board for a new lesson when the saved application theme is light", async () => {
    window.localStorage.setItem("practice.appearance.theme", "light");
    mocks.loadBoardReplay.mockResolvedValue({ operations: [] });
    mount();

    await waitFor(() => expect(mocks.boardProps).not.toBeNull());
    expect(mocks.boardProps.initialBgColor).toBe("#FFFFFF");
  });

  it("keeps strokes added while the initial replay request is still loading", async () => {
    const loading = deferred<{ operations: any[] }>();
    mocks.loadBoardReplay.mockReturnValueOnce(loading.promise);
    mocks.appendBoardReplay.mockResolvedValue({ ok: true });
    mount();

    await waitFor(() => expect(mocks.loadBoardReplay).toHaveBeenCalledWith("l1"));
    fireEvent.click(screen.getByTestId("draw-stroke"));
    loading.resolve({ operations: [] });

    await waitFor(() => expect(mocks.boardProps.initialStrokes).toHaveLength(1));
    expect(mocks.boardProps.initialStrokes[0].points).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  });

  it("waits for an already-running board flush before completing the lesson", async () => {
    mocks.loadBoardReplay.mockResolvedValue({ operations: [] });
    const saving = deferred<{ ok: boolean }>();
    mocks.appendBoardReplay.mockReturnValueOnce(saving.promise);
    const onComplete = vi.fn();
    mount(onComplete);
    await waitFor(() => expect(mocks.loadBoardReplay).toHaveBeenCalled());

    for (let i = 0; i < 24; i += 1) fireEvent.click(screen.getByTestId("draw-stroke"));
    await waitFor(() => expect(mocks.appendBoardReplay).toHaveBeenCalled());
    fireEvent.click(screen.getByText("complete lesson"));
    await Promise.resolve();
    expect(onComplete).not.toHaveBeenCalled();

    saving.resolve({ ok: true });
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });
  it("keeps the local backup after pagehide even when sendBeacon accepts the request", async () => {
    mocks.loadBoardReplay.mockResolvedValue({ operations: [] });
    mocks.appendBoardReplay.mockResolvedValue({ ok: true });
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: sendBeacon });
    mount();
    await waitFor(() => expect(mocks.loadBoardReplay).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("draw-stroke"));
    const key = "school.s1.room.r1.lesson.l1.backup.boardReplayQueue";
    expect(window.localStorage.getItem(key)).not.toBeNull();
    window.dispatchEvent(new Event("pagehide"));

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(key)).not.toBeNull();
  });
});
