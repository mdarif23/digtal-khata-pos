import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient.js";
import  "./index.css";
import App from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
  </StrictMode>
);

// PWA app-shell (Phase 3): a tiny hand-rolled service worker keeps the SPA
// loadable after a refresh while the device is offline (transactions
// themselves live in IndexedDB, not the SW cache).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // SW is an enhancement — registration failure never blocks the POS.
    });
  });
}
