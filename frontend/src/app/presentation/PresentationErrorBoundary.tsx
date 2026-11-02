import { Component, type ErrorInfo, type ReactNode } from "react";
import type { Slide } from "./Slides";

type Props = {
  slide?: Slide;
  resetKey: string;
  children: ReactNode;
};

type State = { error: Error | null };

const plainMath = (value: string) =>
  value
    .replace(/\\\\\((.*?)\\\\\)/gs, "$1")
    .replace(/\\\\\[(.*?)\\\\\]/gs, "$1")
    .replace(/\$\$(.*?)\$\$/gs, "$1")
    .replace(/\$(.*?)\$/gs, "$1")
    .replace(/\\\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, "($1)/($2)")
    .replace(/\\\\sqrt\s*\{([^{}]+)\}/g, "√($1)")
    .replace(/\\\\(?:tilde|widetilde)\s*\{?([^{}\s]+)\}?/g, "$1~")
    .replace(/\\\\(?:text|mathrm|mathbf|mathit)\s*\{([^{}]+)\}/g, "$1")
    .replace(/\\\\int/g, "∫")
    .replace(/\\\\cdot/g, "·")
    .replace(/\\\\[A-Za-z]+/g, "")
    .replace(/[{}]/g, "");

export default class PresentationErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Presentation renderer failed", error, info);
  }

  componentDidUpdate(prevProps: Props) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;

    const slide = this.props.slide;
    const lines = (slide?.elements ?? [])
      .filter((element) => element.type === "text" || element.type === "math")
      .map((element) =>
        element.type === "text" ? plainMath(element.text) : plainMath(element.fallbackText || element.latex),
      )
      .filter(Boolean);

    return (
      <div className="flex h-full min-h-0 items-center justify-center rounded-2xl border border-white/10 bg-[#0A0E14] p-6">
        <div className="w-full max-w-4xl rounded-2xl border border-white/10 bg-[#111823] p-8 text-frost">
          <div className="mb-6 text-3xl font-semibold">{slide?.title || "Презентация"}</div>
          <div className="space-y-4 text-xl leading-relaxed text-frost/85">
            {(lines.length ? lines : [slide?.content || "Слайд временно открыт в режиме совместимости."]).map((line, index) => (
              <div key={index}>• {line}</div>
            ))}
          </div>
        </div>
      </div>
    );
  }
}
