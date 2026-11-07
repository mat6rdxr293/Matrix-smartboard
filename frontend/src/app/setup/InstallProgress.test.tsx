// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n";
import InstallProgress, { installStage } from "./InstallProgress";

afterEach(cleanup);

describe("installer progress", () => {
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
