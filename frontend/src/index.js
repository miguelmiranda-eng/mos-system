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
      .then((reg) => { if (reg.update) reg.update(); }) // chequeo de version al arrancar
      .catch(() => {});
  });
}

// ── Auto-actualizacion tras un deploy ────────────────────────────────────────
// Las PDAs del almacen dejan la app ABIERTA todo el dia: sin esto se quedan con
// el bundle viejo hasta que alguien las refresca a mano.
// OJO: no sirve apoyarse en reg.update()/controllerchange, porque /sw.js es un
// archivo estatico IDENTICO entre builds — el navegador nunca ve un SW nuevo.
// Lo que si cambia en cada build es el hash del bundle en asset-manifest.json,
// asi que se compara contra el que esta corriendo.
(function autoUpdateOnDeploy() {
  const CHECK_MS = 3 * 60 * 1000;
  let running = null;
  let reloading = false;

  const readMainHash = async () => {
    const res = await fetch(`/asset-manifest.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const j = await res.json();
    return (j.files && j.files["main.js"]) || null;
  };

  // No recargar encima de alguien que esta tecleando (un escaneo a medias se
  // perderia). Se pospone al siguiente chequeo.
  const isBusy = () => {
    const el = document.activeElement;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && !!el.value;
  };

  const check = async () => {
    if (reloading) return;
    try {
      const main = await readMainHash();
      if (!main) return;
      if (running === null) { running = main; return; }
      if (main !== running && !isBusy()) {
        reloading = true;
        window.location.reload();
      }
    } catch {
      /* sin red: se reintenta en el siguiente ciclo */
    }
  };

  check();
  setInterval(check, CHECK_MS);
  // Al volver a primer plano: en la PDA suspendida los timers se congelan.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
})();
