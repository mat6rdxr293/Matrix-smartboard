import { useSyncExternalStore } from "react";
import type { GuideKind } from "./guides";

/**
 * Which guide is open, if any. Any screen can open help without passing props down to it.
 * `anchor` is a heading slug or a section number such as "8".
 */
export type HelpState = { kind: GuideKind; anchor: string | null } | null;

let state: HelpState = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function openHelp(kind: GuideKind, anchor: string | null = null) {
  state = { kind, anchor };
  emit();
}

export function closeHelp() {
  if (!state) return;
  state = null;
  emit();
}

declare global {
  interface Window {
    /** Asked by the Android back button: true when the page closed something itself. */
    __matrixBack?: () => boolean;
  }
}

if (typeof window !== "undefined") {
  window.__matrixBack = () => {
    if (!state) return false;
    closeHelp();
    return true;
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useHelpState = () => useSyncExternalStore(subscribe, () => state, () => null);
