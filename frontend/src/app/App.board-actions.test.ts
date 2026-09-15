import { describe, expect, it } from "vitest";
// @ts-expect-error Vitest/Vite supports raw imports; this project does not include vite/client declarations.
import source from "./App.tsx?raw";

describe("board quick actions layout", () => {
  it("keeps exercise and AI assistant controls in normal layout instead of overlaying the board", () => {
    expect(source).not.toContain('className="absolute bottom-4 right-4 flex gap-2"');
    expect(source).toContain('data-testid="board-quick-actions"');
    expect(source).toMatch(/data-testid="board-quick-actions"[\s\S]{0,180}className="[^"]*justify-end[^"]*"/);
  });
});
