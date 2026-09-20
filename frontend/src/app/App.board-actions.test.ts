import { describe, expect, it } from "vitest";
// @ts-expect-error Vitest/Vite supports raw imports; this project does not include vite/client declarations.
import source from "./App.tsx?raw";

describe("board quick actions layout", () => {
  it("places exercise and AI assistant actions inside the single board toolbar row", () => {
    expect(source).not.toContain('data-testid="board-quick-actions"');
    expect(source).toContain("onToggleTask={!freeBoardMode && taskData.length ? toggleTaskPanel : undefined}");
    expect(source).toContain("onToggleAssistant={toggleAssistantPanel}");
  });

  it("enables free board mode automatically without task cards", () => {
    expect(source).toContain("const freeBoardForced = taskData.length === 0");
    expect(source).toContain("const freeBoardMode = freeBoardForced || freeBoardRequested");
    expect(source).toContain("if (freeBoardMode) setTaskOpen(false)");
  });

  it("renders free board mode as a task card", () => {
    expect(source).toContain('aria-pressed={freeBoardMode}');
    expect(source).toContain('onClick={toggleFreeBoardMode}');
    expect(source).toContain('{tl("free_board_mode")}');
    expect(source).toContain('freeBoardMode\n                                ? "w-full rounded-xl border border-accent/60 bg-accent/10 px-3 py-2.5 text-left"');
  });

  it("raises the floating panel that the user interacts with", () => {
    expect(source).toContain('onPointerDownCapture={() => setFocusedFloatingPanel("task")}');
    expect(source).toContain('onPointerDownCapture={() => setFocusedFloatingPanel("assistant")}');
    expect(source).toContain('zIndex: focusedFloatingPanel === "task" ? 40 : 30');
    expect(source).toContain('zIndex: focusedFloatingPanel === "assistant" ? 40 : 30');
  });
  it("fills the viewport below the lesson header without a reserved bottom chin", () => {
    expect(source).not.toContain('h-[calc(100vh-140px)]');
    expect(source).toContain('className="h-screen overflow-hidden px-1 pt-2"');
    expect(source).toContain('className="mx-auto flex h-full w-full max-w-[1920px] min-h-0 flex-col gap-3"');
    expect(source).toContain('className="relative min-h-0 flex-1"');
  });

});
