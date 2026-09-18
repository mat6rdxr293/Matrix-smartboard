import React from "react";
import ReactDOM from "react-dom/client";
import AppRoot from "./app/AppRoot";
import "./app/styles/globals.css";
import { I18nProvider } from "@/i18n";
import { ThemeProvider } from "@/app/theme/ThemeProvider";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <AppRoot />
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>
);
