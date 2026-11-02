import React from "react";
import ReactDOM from "react-dom/client";
import "./app/styles/globals.css";
import { I18nProvider } from "@/i18n";
import { ThemeProvider } from "@/app/theme/ThemeProvider";
import AndroidSetupWizard from "@/app/setup/AndroidSetupWizard";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <AndroidSetupWizard onDone={() => {}} />
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
