import { describe, expect, it } from "vitest";
// @ts-expect-error Vitest/Vite supports raw imports; this project does not include vite/client declarations.
import source from "./App.tsx?raw";

describe("board quick actions layout", () => {
  it("places exercise and AI assistant actions inside the single board toolbar row", () => {
    expect(source).not.toContain('data-testid="board-quick-actions"');
    expect(source).toContain("onToggleTask={() => setTaskOpen((v) => !v)}");
    expect(source).toContain("onToggleAssistant={() => setAssistantOpen((v) => !v)}");
  });
  it("fills the viewport below the lesson header without a reserved bottom chin", () => {
    expect(source).not.toContain('h-[calc(100vh-140px)]');
    expect(source).toContain('className="h-screen overflow-hidden px-1 py-2"');
    expect(source).toContain('className="mx-auto flex h-full w-full max-w-[1850px] min-h-0 flex-col gap-3"');
    expect(source).toContain('className="relative min-h-0 flex-1"');
  });

});
