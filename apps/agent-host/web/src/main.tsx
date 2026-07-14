import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { registerSW } from "virtual:pwa-register";
import "@interloom/ui/styles.css";
import "./styles/app.css";
import { App } from "./App.js";
import { ToastProvider } from "./components/Toasts.js";
import { DownloadsProvider } from "./state/DownloadsContext.js";

registerSW({ immediate: true });

const container = document.getElementById("root");
if (!container) throw new Error("Root element #root not found");

createRoot(container).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <DownloadsProvider>
          <App />
        </DownloadsProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
