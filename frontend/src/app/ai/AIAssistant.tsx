import { motion } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import MathText from "@/components/MathText";
import { useI18n } from "@/i18n";

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
    <div className="glass flex h-full flex-col rounded-2xl p-4 shadow-soft">
      <div className="mb-3 flex items-center justify-end gap-2">
        {onContinue && canContinue && (
          <Button size="sm" variant="outline" onClick={onContinue} disabled={loading}>
            {tl("continue")}
          </Button>
        )}
        <Badge>{tl("history")}</Badge>
      </div>
      <div className="scrollbar-hide flex-1 space-y-3 overflow-auto pr-1">
        {messages.length === 0 ? (
          <div className="text-sm text-frost/50">{tl("history_will_appear_after_first_hint")}</div>
        ) : (
          messages.map((msg) => {
            const className =
              msg.role === "assistant"
                ? "rounded-xl border border-white/10 bg-white/5 p-3 text-sm"
                : "rounded-xl border border-accent/40 bg-accent/10 p-3 text-sm";
            const content = (
              <>
                <div className="mb-1 flex items-center justify-between text-xs text-frost/50">
                  <span>{msg.role === "assistant" ? tl("assistant") : tl("student")}</span>
                  <span>
                    {labelForMode(msg.mode)} {msg.timestamp}
                  </span>
                </div>
                {msg.text.trim() === tl("thinking") ? (
                  <div className="thinking-shimmer">{tl("thinking")}</div>
                ) : (
                  <MathText text={msg.text} className="text-frost/90" />
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
              <motion.div key={msg.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className={className}>
                {content}
              </motion.div>
            );
          })
        )}
      </div>
    </div>
  );
}
