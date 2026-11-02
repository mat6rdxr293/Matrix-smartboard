import { backendAssetUrl } from "@/lib/apiClient";
﻿import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import MathText from "@/components/MathText";
import MathFormula from "@/components/MathFormula";
import { useI18n } from "@/i18n";

export type SlideElement =
  | {
      id: string;
      type: "text";
      x: number;
      y: number;
      w: number;
      h: number;
      text: string;
      fontSize?: number;
      fontFamily?: string;
      fontWeight?: "normal" | "medium" | "semibold" | "bold";
      color?: string;
      strokeColor?: string;
      strokeWidth?: number;
      align?: "left" | "center" | "right";
      padding?: number;
      paddingLeft?: number;
      paddingRight?: number;
      paddingTop?: number;
      paddingBottom?: number;
      rotation?: number;
    }
  | {
      id: string;
      type: "math";
      x: number;
      y: number;
      w: number;
      h: number;
      latex: string;
      fallbackText: string;
      fontSize?: number;
      color?: string;
      align?: "left" | "center" | "right";
      display?: boolean;
      rotation?: number;
    }
  | {
      id: string;
      type: "image";
      x: number;
      y: number;
      w: number;
      h: number;
      src: string;
      rotation?: number;
    }
  | {
      id: string;
      type: "shape";
      shape: "rect" | "round" | "ellipse";
      x: number;
      y: number;
      w: number;
      h: number;
      fill?: string;
      strokeColor?: string;
      strokeWidth?: number;
      rotation?: number;
    };

export type Slide = {
  id: number;
  title: string;
  content: string;
  notes: string;
  elements?: SlideElement[];
  background?: string;
  backgroundColor?: string;
};

type SlidesProps = {
  slides: Slide[];
  index: number;
  onChange: (next: number) => void;
  presenterMode: boolean;
  enableHotkeys?: boolean;
};

const BASE_W = 960;
const BASE_H = 540;

export default function Slides({ slides, index, onChange, presenterMode, enableHotkeys = true }: SlidesProps) {
  const { tl } = useI18n();
  const slide = slides[index];
  const stageWrapRef = useRef<HTMLDivElement | null>(null);
  const [stageScale, setStageScale] = useState(1);

  useEffect(() => {
    if (!enableHotkeys) return;
    const handler = (e: KeyboardEvent) => {
      if (["ArrowRight", "PageDown"].includes(e.key)) {
        onChange(Math.min(slides.length - 1, index + 1));
      }
      if (["ArrowLeft", "PageUp"].includes(e.key)) {
        onChange(Math.max(0, index - 1));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enableHotkeys, index, onChange, slides.length]);

  useLayoutEffect(() => {
    const wrap = stageWrapRef.current;
    if (!wrap) return;
    const update = () => {
      const rect = wrap.getBoundingClientRect();
      const scale = Math.min(rect.width / BASE_W, rect.height / BASE_H) || 1;
      setStageScale(Math.max(0.05, Math.min(1, scale)));
    };

    update();
    const first = window.setTimeout(update, 0);
    const second = window.setTimeout(update, 120);
    window.addEventListener("resize", update);
    return () => {
      window.clearTimeout(first);
      window.clearTimeout(second);
      window.removeEventListener("resize", update);
    };
  }, []);

  if (!slide) {
    return (
      <div className="glass flex h-full items-center justify-center rounded-2xl p-6 text-sm text-frost/45 shadow-glass">
        {tl("no_slides")}
      </div>
    );
  }

  const hasElements = !!(slide.elements && slide.elements.length > 0);
  const hasBackground = !!slide.background;
  const showStage = hasElements || hasBackground;
  const spx = (value: number) => value * stageScale;

  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="glass flex h-full min-w-0 flex-[2] flex-col rounded-2xl p-6 shadow-glass">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-frost/50">
              {tl("slide_current_total", { current: index + 1, total: slides.length })}
            </div>
            <h2 className="text-2xl font-semibold">{slide.title}</h2>
          </div>
        </div>

        {showStage ? (
          <div ref={stageWrapRef} className="relative flex flex-1 items-center justify-center overflow-hidden">
            <div
              className="relative shrink-0 rounded-xl border border-white/10 bg-white/5 shadow-soft"
              style={{
                width: spx(BASE_W),
                height: spx(BASE_H),
                backgroundColor: slide.backgroundColor ?? "#0A0E14",
                backgroundImage: hasBackground ? `url(${backendAssetUrl(slide.background)})` : undefined,
                backgroundSize: "cover",
                backgroundPosition: "center",
                backgroundRepeat: "no-repeat",
              }}
            >
              {slide.elements?.map((el) =>
                el.type === "text" ? (
                  <div
                    key={el.id}
                    className="absolute"
                    style={{
                      left: spx(el.x),
                      top: spx(el.y),
                      width: spx(el.w),
                      height: spx(el.h),
                      padding: spx(el.padding ?? 0),
                      paddingLeft: spx(el.paddingLeft ?? el.padding ?? 0),
                      paddingRight: spx(el.paddingRight ?? el.padding ?? 0),
                      paddingTop: spx(el.paddingTop ?? el.padding ?? 0),
                      paddingBottom: spx(el.paddingBottom ?? el.padding ?? 0),
                      fontSize: spx(el.fontSize ?? 22),
                      lineHeight: 1.25,
                      fontFamily: el.fontFamily,
                      fontWeight:
                        el.fontWeight === "medium"
                          ? 500
                          : el.fontWeight === "semibold"
                            ? 600
                            : el.fontWeight === "bold"
                              ? 700
                              : 400,
                      color: el.color ?? "#E7F2FF",
                      textAlign: el.align ?? "left",
                      WebkitTextStroke:
                        el.strokeWidth && el.strokeColor ? `${spx(el.strokeWidth)}px ${el.strokeColor}` : undefined,
                      transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
                      transformOrigin: "center",
                    }}
                  >
                    <MathText text={el.text} />
                  </div>
                ) : el.type === "math" ? (
                  <div
                    key={el.id}
                    className="absolute flex items-center overflow-hidden"
                    style={{
                      left: spx(el.x),
                      top: spx(el.y),
                      width: spx(el.w),
                      height: spx(el.h),
                      fontSize: spx(el.fontSize ?? 26),
                      color: el.color ?? "#E7F2FF",
                      textAlign: el.align ?? "center",
                      justifyContent:
                        el.align === "left" ? "flex-start" : el.align === "right" ? "flex-end" : "center",
                      transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
                      transformOrigin: "center",
                    }}
                  >
                    <MathFormula
                      latex={el.latex}
                      fallbackText={el.fallbackText}
                      display={el.display ?? true}
                      className="w-full"
                    />
                  </div>
                ) : el.type === "image" ? (
                  <img
                    key={el.id}
                    src={backendAssetUrl(el.src)}
                    alt=""
                    className="absolute object-contain"
                    style={{
                      left: spx(el.x),
                      top: spx(el.y),
                      width: spx(el.w),
                      height: spx(el.h),
                      transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
                      transformOrigin: "center",
                    }}
                  />
                ) : (
                  <div
                    key={el.id}
                    className="absolute"
                    style={{
                      left: spx(el.x),
                      top: spx(el.y),
                      width: spx(el.w),
                      height: spx(el.h),
                      backgroundColor: el.fill ?? "transparent",
                      border:
                        el.strokeWidth && el.strokeColor
                          ? `${spx(el.strokeWidth)}px solid ${el.strokeColor}`
                          : "none",
                      borderRadius: el.shape === "ellipse" ? "999px" : el.shape === "round" ? `${spx(24)}px` : `${spx(8)}px`,
                      transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
                      transformOrigin: "center",
                    }}
                  />
                )
              )}
              {!hasElements && slide.content && (
                <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-frost/95">
                  <div className="text-2xl leading-relaxed">
                    <MathText text={slide.content} />
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <motion.div
            key={slide.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
            className="text-lg leading-relaxed text-frost/90"
          >
            {!hasBackground && <MathText text={slide.content} />}
          </motion.div>
        )}

        <div className="mt-auto flex gap-2 pt-6">
          <Button variant="outline" onClick={() => onChange(Math.max(0, index - 1))}>
            {tl("back")}
          </Button>
          <Button variant="accent" onClick={() => onChange(Math.min(slides.length - 1, index + 1))}>
            {tl("forward")}
          </Button>
        </div>
      </div>
      <div className="glass w-[30%] min-w-[220px] max-w-[360px] rounded-2xl p-4 shadow-soft">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-frost/70">{tl("notes")}</h3>
          <Badge>{presenterMode ? tl("speaker") : tl("hidden")}</Badge>
        </div>
        {presenterMode ? (
          <div className="text-sm text-frost/80 whitespace-pre-line">{slide.notes}</div>
        ) : (
          <div className="text-sm text-frost/40">{tl("turn_on_presenter_view_to_see_your_notes")}</div>
        )}
      </div>
    </div>
  );
}
