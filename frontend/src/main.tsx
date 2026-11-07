import React from "react";
import ReactDOM from "react-dom/client";
import AppRoot from "./app/AppRoot";
import "./app/styles/globals.css";
import { I18nProvider } from "@/i18n";
import { ThemeProvider } from "@/app/theme/ThemeProvider";
import { HelpHost } from "@/app/help/HelpScreen";
import { isNativeApp } from "@/lib/apiClient";
import { instantUi } from "@/lib/instantUi";

// On the board the WebView sits over the native ink layer, so a backdrop blur has nothing of the
// board to blur, yet a panel GPU redoes it at 4K on every frame of every animation.
if (isNativeApp()) document.body.classList.add("native-app");
if (instantUi) document.body.classList.add("instant-ui");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <AppRoot />
        <HelpHost />
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>
);
