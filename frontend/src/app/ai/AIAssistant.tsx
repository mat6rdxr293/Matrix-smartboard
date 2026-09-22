import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import MathText from "@/components/MathText";
import { useI18n } from "@/i18n";
import { MessageSquareText } from "lucide-react";
import type { AiMode } from "./api";

export type AssistantMessage = {
  id: string;
  role: "assistant" | "student" | "system";
  text: string;
  mode?: string;
  timestamp: string;
};

type AIAssistantProps = {
  messages: AssistantMessage[];
  onContinue?: () => void;
  canContinue?: boolean;
  loading?: boolean;
  lowPowerMode?: boolean;
  ocrEnabled?: boolean;
  onRecognizeBoard?: () => Promise<string>;
  onSubmitRecognized?: (mode: AiMode, text: string) => void;
};

export default function AIAssistant({
  messages,
  onContinue,
  canContinue,
  loading,
  lowPowerMode = false,
  ocrEnabled = false,
  onRecognizeBoard,
  onSubmitRecognized,
}: AIAssistantProps) {
  const { tl } = useI18n();
  const [recognizing, setRecognizing] = useState(false);
  const [recognitionError, setRecognitionError] = useState<string | null>(null);
  const [pendingMode, setPendingMode] = useState<AiMode | null>(null);
  const [recognizedText, setRecognizedText] = useState("");
  const historyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = historyRef.current;
    if (!node || messages.length === 0) return;
    node.scrollTop = node.scrollHeight;
  }, [messages]);

  const labelForMode = (mode?: string) => {
    if (!mode) return "";
    switch (mode) {
      case "hint":
        return tl("hint");
      case "check":
        return tl("solution_check");
      case "solution":
        return tl("full_solution");
      case "continue":
        return tl("continuation");
      default:
        return mode;
    }
  };

  const recognize = async (mode: AiMode) => {
    if (!onRecognizeBoard || recognizing || loading) return;
    setRecognitionError(null);
    setRecognizing(true);
    try {
      const text = (await onRecognizeBoard()).trim();
      if (!text) throw new Error(tl("ocr_not_available"));
      setPendingMode(mode);
      setRecognizedText(text);
    } catch (error) {
      setRecognitionError(error instanceof Error ? error.message : tl("ocr_not_available"));
    } finally {
      setRecognizing(false);
    }
  };

  const retryRecognition = () => {
    if (pendingMode) void recognize(pendingMode);
  };

  const confirmRecognition = () => {
    const text = recognizedText.trim();
    if (!pendingMode || !text || !onSubmitRecognized) return;
    const mode = pendingMode;
    setPendingMode(null);
    setRecognizedText("");
    setRecognitionError(null);
    onSubmitRecognized(mode, text);
  };

  const cancelRecognition = () => {
    setPendingMode(null);
    setRecognizedText("");
    setRecognitionError(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {onContinue && canContinue && !pendingMode && (
        <div className="flex justify-end pb-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 rounded-lg border border-white/10 bg-white/[0.025] px-2.5 text-[11px] font-medium"
            onClick={onContinue}
            disabled={loading || recognizing}
          >
            {tl("continue")}
          </Button>
        </div>
      )}

      <div ref={historyRef} className="scrollbar-hide min-h-0 flex-1 overflow-y-auto pr-1">
        {messages.length === 0 ? (
          <div className="flex h-full min-h-[170px] items-center justify-center px-6">
            <div className="max-w-[280px] text-center">
              <div className="mx-auto grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/[0.025] text-frost/35">
                <MessageSquareText size={18} />
              </div>
              <div className="mt-3 text-[13px] font-medium text-frost/55">{tl("assistant_empty")}</div>
              <div className="mt-1.5 text-[12px] leading-5 text-frost/35">
                {tl("assistant_board_hint")}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5 py-1">
            {messages.map((msg) => {
              const isStudent = msg.role === "student";
              const bubbleClass = isStudent
                ? "max-w-[86%] rounded-[16px] rounded-br-[5px] border border-accent/25 bg-accent/10 px-3 py-2.5 text-[13px] leading-5 text-frost"
                : "max-w-[86%] rounded-[16px] rounded-bl-[5px] border border-white/10 bg-graphite px-3 py-2.5 text-[13px] leading-5 text-frost";

              const bubble = (
                <div className={bubbleClass}>
                  <div className="mb-1.5 flex items-center gap-2 text-[10px] text-frost/38">
                    <span className="font-medium text-frost/55">
                      {isStudent ? tl("student") : tl("assistant")}
                    </span>
                    {labelForMode(msg.mode) && <span>{labelForMode(msg.mode)}</span>}
                    <span className="ml-auto shrink-0">{msg.timestamp}</span>
                  </div>
                  {msg.text.trim() === tl("thinking") ? (
                    <div className="thinking-shimmer">{tl("thinking")}</div>
                  ) : (
                    <MathText text={msg.text} className="text-frost/90" />
                  )}
                </div>
              );

              if (lowPowerMode) {
                return (
                  <div key={msg.id} className={isStudent ? "flex justify-end" : "flex justify-start"}>
                    {bubble}
                  </div>
                );
              }

              return (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.16 }}
                  className={isStudent ? "flex justify-end" : "flex justify-start"}
                >
                  {bubble}
                </motion.div>
              );
            })}
          </div>
        )}
      </div>

      {pendingMode && (
        <div className="mt-3 border-t border-white/10 pt-3">
          <div className="text-[12px] font-medium text-frost/70">{tl("recognized_board_title")}</div>
          <div className="mt-1 text-[11px] text-frost/45">{tl("recognized_board_question")}</div>
          <textarea
            value={recognizedText}
            onChange={(event) => setRecognizedText(event.target.value)}
            className="mt-2 min-h-[112px] w-full resize-none rounded-xl border border-white/10 bg-white/[0.025] p-3 text-[12px] leading-5 text-frost outline-none focus:border-accent/55"
            aria-label={tl("recognized_board_title")}
          />
          <div className="mt-2 grid grid-cols-[1fr_1.25fr_auto] gap-2">
            <Button data-testid="ocr-confirm" size="sm" onClick={confirmRecognition} disabled={!recognizedText.trim() || loading || recognizing}>
              {tl("recognized_correct")}
            </Button>
            <Button size="sm" variant="outline" onClick={retryRecognition} disabled={loading || recognizing || !ocrEnabled}>
              {recognizing ? tl("recognition_loading") : tl("recognize_again")}
            </Button>
            <Button size="sm" variant="ghost" onClick={cancelRecognition} disabled={loading || recognizing}>
              {tl("cancel")}
            </Button>
          </div>
        </div>
      )}

      {!pendingMode && (
        <div className="mt-3 border-t border-white/10 pt-3">
          <div className="grid grid-cols-[0.9fr_1.2fr_1fr] gap-2">
            <Button
              data-testid="ai-hint"
              variant="outline"
              className="h-10 rounded-xl border-white/12 bg-transparent px-3 text-[12px] font-medium"
              onClick={() => void recognize("hint")}
              disabled={loading || recognizing || !ocrEnabled}
            >
              {tl("hint")}
            </Button>
            <Button
              data-testid="ai-check"
              className="h-10 rounded-xl px-3 text-[12px] font-semibold"
              onClick={() => void recognize("check")}
              disabled={loading || recognizing || !ocrEnabled}
            >
              {tl("check_solution")}
            </Button>
            <Button
              data-testid="ai-full-solution"
              variant="ghost"
              className="h-10 rounded-xl border border-white/10 bg-white/[0.025] px-3 text-[12px] font-medium"
              onClick={() => void recognize("solution")}
              disabled={loading || recognizing || !ocrEnabled}
            >
              {tl("full_solution")}
            </Button>
          </div>
          <div className="mt-2 min-h-[16px] text-[11px]">
            {recognizing && <div className="thinking-shimmer">{tl("recognition_loading")}</div>}
            {recognitionError && <div className="text-ember">{recognitionError}</div>}
            {!ocrEnabled && <div className="text-frost/35">{tl("ocr_not_available")}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
