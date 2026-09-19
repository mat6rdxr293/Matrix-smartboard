import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import MathText from "@/components/MathText";
import { useI18n } from "@/i18n";
import { MessageSquareText } from "lucide-react";

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
};

export default function AIAssistant({ messages, onContinue, canContinue, loading, lowPowerMode = false }: AIAssistantProps) {
  const { tl } = useI18n();

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      {onContinue && canContinue && (
        <div className="flex justify-end pb-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 rounded-lg border border-white/10 bg-white/[0.025] px-2.5 text-[11px] font-medium"
            onClick={onContinue}
            disabled={loading}
          >
            {tl("continue")}
          </Button>
        </div>
      )}

      <div className="scrollbar-hide min-h-0 flex-1 overflow-auto">
        {messages.length === 0 ? (
          <div className="flex h-full min-h-[220px] items-center justify-center px-6">
            <div className="max-w-[280px] text-center">
              <div className="mx-auto grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/[0.025] text-frost/35">
                <MessageSquareText size={18} />
              </div>
              <div className="mt-3 text-[13px] font-medium text-frost/55">Пока пусто</div>
              <div className="mt-1.5 text-[12px] leading-5 text-frost/35">
                {tl("history_will_appear_after_first_hint")}
              </div>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-white/10">
            {messages.map((msg) => {
              const className =
                msg.role === "assistant"
                  ? "py-3.5 text-[13px]"
                  : "border-l-2 border-l-accent/50 bg-accent/[0.045] px-3 py-3.5 text-[13px]";
              const content = (
                <>
                  <div className="mb-2 flex items-center justify-between gap-3 text-[10px] text-frost/38">
                    <span className="font-medium text-frost/50">{msg.role === "assistant" ? tl("assistant") : tl("student")}</span>
                    <span className="shrink-0">
                      {labelForMode(msg.mode)}{labelForMode(msg.mode) ? " · " : ""}{msg.timestamp}
                    </span>
                  </div>
                  {msg.text.trim() === tl("thinking") ? (
                    <div className="thinking-shimmer">{tl("thinking")}</div>
                  ) : (
                    <MathText text={msg.text} className="text-frost/88" />
                  )}
                </>
              );

              if (lowPowerMode) {
                return (
                  <div key={msg.id} className={className}>
                    {content}
                  </div>
                );
              }

              return (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18 }}
                  className={className}
                >
                  {content}
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
