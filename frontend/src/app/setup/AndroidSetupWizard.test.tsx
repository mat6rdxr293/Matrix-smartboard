// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n";
import AndroidSetupWizard from "./AndroidSetupWizard";

describe("Android first setup language", () => {
  it("shows language selection before server setup and applies the chosen locale", () => {
    render(
      <I18nProvider>
        <AndroidSetupWizard onDone={() => {}} />
      </I18nProvider>,
    );

    expect(screen.getByText("Выберите язык")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Русский/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Қазақша/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /English/ })).toBeInTheDocument();
    expect(screen.queryByText("First setup")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /English/ }));

    expect(screen.getByText("First setup")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Find server/ })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
  });
});
