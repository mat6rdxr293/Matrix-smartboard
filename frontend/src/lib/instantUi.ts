import { isNativeApp } from "@/lib/apiClient";

/**
 * A board app on a 4K panel: the WebView is composited at full resolution by a phone-class GPU,
 * which manages under 20 frames a second while anything moves. A 200 ms slide is then three or
 * four jerky steps, so on such screens interface changes happen at once instead.
 */
export const instantUi = (() => {
  if (typeof window === "undefined" || !isNativeApp()) return false;
  const ratio = window.devicePixelRatio || 1;
  const pixels = window.screen.width * ratio * window.screen.height * ratio;
  return pixels >= 3840 * 2160 * 0.9;
})();
