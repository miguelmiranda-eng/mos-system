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

// Recarga iniciada por la app (no por el usuario). Marca la bandera que el
// guard de beforeunload en App.js consulta para NO mostrar el dialogo
// "¿Quieres volver a cargar el sitio?": ese dialogo es para cierres a mano,
// no para una actualizacion que decidimos nosotros.
export function programmaticReload() {
  window.__mosProgrammaticReload = true;
  window.location.reload();
}

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
    programmaticReload();
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
  const IDLE_MS = 2 * 60 * 1000;
  let running = null;
  let reloading = false;
  let pending = false;

  const readMainHash = async () => {
    const res = await fetch(`/asset-manifest.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const j = await res.json();
    return (j.files && j.files["main.js"]) || null;
  };

  // Ultima interaccion real del usuario. Recargar encima de alguien que esta
  // trabajando (modal abierto, filtros, un escaneo a medias) le tira el estado
  // de la SPA aunque no salga ningun dialogo; se espera a un momento seguro.
  let lastActivity = Date.now();
  const touch = () => { lastActivity = Date.now(); };
  ["pointerdown", "keydown", "wheel", "touchstart"].forEach((ev) =>
    window.addEventListener(ev, touch, { passive: true, capture: true }),
  );

  // window.__mosBusy lo levanta la pantalla que tenga trabajo sin confirmar
  // (p. ej. el carrito de surtido de la PDA con cajas escaneadas).
  const isBusy = () => {
    if (window.__mosBusy) return true;
    const el = document.activeElement;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && !!el.value;
  };
  const isSafeMoment = () =>
    document.visibilityState === "hidden" ||
    (Date.now() - lastActivity >= IDLE_MS && !isBusy());

  const applyIfSafe = () => {
    if (!pending || reloading || !isSafeMoment()) return;
    reloading = true;
    programmaticReload();
  };

  const check = async () => {
    if (reloading) return;
    try {
      const main = await readMainHash();
      if (!main) return;
      if (running === null) { running = main; return; }
      if (main !== running) pending = true;
      applyIfSafe();
    } catch {
      /* sin red: se reintenta en el siguiente ciclo */
    }
  };

  check();
  setInterval(check, CHECK_MS);
  // Con actualizacion pendiente, el mejor momento es cuando la pestaña deja de
  // verse: el usuario vuelve y ya esta en el bundle nuevo, sin notarlo.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") applyIfSafe();
    // Al volver a primer plano: en la PDA suspendida los timers se congelan.
    else check();
  });
})();
