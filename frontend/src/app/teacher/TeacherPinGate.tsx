import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";

const hashPin = async (pin: string) => {
  const bytes = new TextEncoder().encode(pin);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
};

export default function TeacherPinGate({
  storageKey,
  onUnlock,
}: {
  storageKey: string;
  onUnlock: () => void;
}) {
  const { tl } = useI18n();
  const [configured, setConfigured] = useState(false);
  const [ready, setReady] = useState(false);
  const [pin, setPin] = useState("");
  const [repeatPin, setRepeatPin] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setConfigured(!!window.localStorage.getItem(storageKey));
    setReady(true);
    setPin("");
    setRepeatPin("");
    setError(null);
  }, [storageKey]);

  const normalizePin = (value: string) => value.replace(/\D/g, "").slice(0, 8);

  const submit = async () => {
    setError(null);
    if (!/^\d{4,8}$/.test(pin)) {
      setError(tl("teacher_pin_requirements"));
      return;
    }

    if (!configured) {
      if (pin !== repeatPin) {
        setError(tl("teacher_pin_mismatch"));
        return;
      }
      const digest = await hashPin(pin);
      window.localStorage.setItem(storageKey, digest);
      setConfigured(true);
      onUnlock();
      return;
    }

    const expected = window.localStorage.getItem(storageKey);
    const actual = await hashPin(pin);
    if (!expected || expected !== actual) {
      setError(tl("teacher_pin_invalid"));
      setPin("");
      return;
    }
    onUnlock();
  };

  if (!ready) return null;

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form
        className="surface-popover w-full max-w-[360px] rounded-[18px] border border-white/10 p-5 shadow-soft"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="text-[16px] font-semibold text-frost">{tl("teacher_pin_title")}</div>
        <div className="mt-1.5 text-[12px] leading-5 text-frost/50">
          {configured ? tl("teacher_pin_enter") : tl("teacher_pin_create")}
        </div>

        <input
          autoFocus
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(event) => setPin(normalizePin(event.target.value))}
          placeholder="••••"
          aria-label={tl("teacher_pin_title")}
          className="mt-4 h-11 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-center text-lg tracking-[0.35em] text-frost outline-none focus:border-accent/60"
        />

        {!configured && (
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={repeatPin}
            onChange={(event) => setRepeatPin(normalizePin(event.target.value))}
            placeholder="••••"
            aria-label={tl("teacher_pin_repeat")}
            className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-center text-lg tracking-[0.35em] text-frost outline-none focus:border-accent/60"
          />
        )}

        <div className="mt-2 min-h-[18px] text-[11px]">
          {error ? <span className="text-ember">{error}</span> : <span className="text-frost/35">{tl("teacher_pin_requirements")}</span>}
        </div>

        <Button type="submit" className="mt-2 h-10 w-full rounded-xl" disabled={!pin}>
          {configured ? tl("teacher_pin_open") : tl("teacher_pin_save")}
        </Button>
      </form>
    </div>
  );
}

