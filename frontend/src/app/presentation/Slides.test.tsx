// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";

vi.mock("@/lib/apiClient", () => ({
  backendAssetUrl: (value: string) => value,
}));

import Slides, { type Slide } from "./Slides";

const slides: Slide[] = [
  {
    id: 1,
    title: "Первообразная",
    content: "",
    notes: "Комментарий",
    backgroundColor: "#0A0E14",
    elements: [
      {
        id: "title",
        type: "text",
        x: 78,
        y: 48,
        w: 805,
        h: 64,
        text: "Свойства первообразных",
        fontSize: 31,
        color: "#F4F7FB",
      },
      {
        id: "formula",
        type: "math",
        x: 82,
        y: 180,
        w: 796,
        h: 64,
        latex: "F(x)=G(x)+C",
        fallbackText: "F(x)=G(x)+C",
        fontSize: 25,
        color: "#F4F7FB",
      },
    ],
  },
];

describe("Slides legacy WebView compatibility", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders without ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);

    render(
      <I18nProvider>
        <div style={{ width: 1280, height: 720 }}>
          <Slides
            slides={slides}
            index={0}
            onChange={vi.fn()}
            presenterMode={false}
          />
        </div>
      </I18nProvider>,
    );

    expect(screen.getByText("Свойства первообразных")).toBeInTheDocument();
    expect(screen.getByText("Первообразная")).toBeInTheDocument();
  });

  it("does not crash on an invalid slide index", () => {
    render(
      <I18nProvider>
        <Slides
          slides={slides}
          index={9}
          onChange={vi.fn()}
          presenterMode={false}
        />
      </I18nProvider>,
    );

    expect(document.body.textContent).toBeTruthy();
  });
});
