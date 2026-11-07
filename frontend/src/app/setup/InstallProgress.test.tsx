// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n";
import InstallProgress, { appendInstallOutput, installStage } from "./InstallProgress";

afterEach(cleanup);

describe("installer progress", () => {
  it("folds a redrawn progress bar into one line and drops escape codes", () => {
    const redraw = (n: number) =>
      `pulling e9758e589d44:  ${n}% \u2595\u2588\u2588 \u258f ${n * 30} MB/3.2 GB  6.5 MB/s   7m10s\u001b[K\u001b[?25h\u001b[?2026l\u001b[?2026h\u001b[?25l\u001b[A\u001b[1Gpulling manifest \u001b[K`;
    let lines = ["[5/7] Configuring local AI (Ollama)", "qwen2.5:7b is already downloaded"];
    for (let n = 10; n < 14; n += 1) lines = appendInstallOutput(lines, redraw(n));
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(/^pulling e9758e589d44:\s+13% .*390 MB\/3\.2 GB\s+6\.5 MB\/s\s+7m10s$/);

    lines = appendInstallOutput(lines, "Downloading Ollama: 10 MB of 1,540 MB (1%)");
    lines = appendInstallOutput(lines, "Downloading Ollama: 20 MB of 1,540 MB (1%)");
    expect(lines.slice(-1)).toEqual(["Downloading Ollama: 20 MB of 1,540 MB (1%)"]);
    expect(lines).toHaveLength(4);
  });

  it("keeps the stage line when the log is trimmed", () => {
    let lines = ["[4/7] Installing Python backend"];
    for (let n = 0; n < 200; n += 1) lines = appendInstallOutput(lines, `Collecting package-${n}`);
    expect(lines).toHaveLength(120);
    expect(installStage(lines)?.step).toBe(4);
    expect(lines[lines.length - 1]).toBe("Collecting package-199");
  });

  it("takes the latest [n/total] stage from the log", () => {
    expect(installStage(["noise"])).toBeNull();
    expect(installStage([
      "[1/7] Checking Windows prerequisites",
      "Python 3.11+ not found; installing Python 3.13 with winget",
      "[2/7] Preparing service directories",
      "done",
    ])).toEqual({ step: 2, total: 7, title: "Preparing service directories" });
  });

  it("shows the stage under way and how many are done", () => {
    render(
      <I18nProvider>
        <InstallProgress lines={["[1/7] a", "[3/7] Downloading Matrix Smartboard from GitHub"]} running failed={false} done={false} lastOutputAt={Date.now()} />
      </I18nProvider>,
    );
    expect(screen.getByText("Этап 3 из 7: Downloading Matrix Smartboard from GitHub")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
  });
});
