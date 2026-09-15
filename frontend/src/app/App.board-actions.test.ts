import { describe, expect, it } from "vitest";
// @ts-expect-error Vitest/Vite supports raw imports; this project does not include vite/client declarations.
import source from "./App.tsx?raw";

describe("board quick actions layout", () => {
  it("places exercise and AI assistant actions inside the single board toolbar row", () => {
    expect(source).not.toContain('data-testid="board-quick-actions"');
    expect(source).toContain("onToggleTask={() => setTaskOpen((v) => !v)}");
    expect(source).toContain("onToggleAssistant={() => setAssistantOpen((v) => !v)}");
  });
});
