import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import App from "@/App";
import ErrorBoundary from "@/components/ErrorBoundary";

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

// PWA: register the service worker so the PDA picker is installable + offline-shell.
if ("serviceWorker" in navigator) {
  // Auto-update: cuando un SW nuevo (nuevo deploy) toma el control, recarga UNA
  // vez para que el iPad/PDA levanten el bundle nuevo sin reinstalar la PWA a
  // mano. El guard `hadController` evita recargar en la primera instalacion
  // (cuando aun no habia SW controlando) y `reloading` evita bucles.
  let reloading = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading || !hadController) return;
    reloading = true;
    window.location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => { if (reg.update) reg.update(); }) // fuerza chequeo de version en cada arranque
      .catch(() => {});
  });
}
