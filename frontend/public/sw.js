/* MOS PDA service worker — enables PWA install + a basic offline app shell.
   Network-first for navigations/static GETs; never caches API mutations. */
const CACHE = "mos-pda-v4";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      // Purge every old cache bucket so a new deploy can't be masked by stale
      // assets cached under a previous version.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  )
);

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // leave POST/PUT/DELETE to the network

  const url = new URL(request.url);
  // Don't cache API traffic — picking must always hit the live backend.
  if (url.pathname.includes("/api/")) return;

  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(async () => {
        // Offline fallback. Must ALWAYS resolve to a Response object:
        // resolving to undefined throws "Failed to convert value to 'Response'"
        // and the app gets stuck on a network-error page until the SW is
        // manually unregistered (seen when the backend/frontend was down).
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") {
          const shell =
            (await caches.match("/pda")) ||
            (await caches.match("/")) ||
            (await caches.match("/index.html"));
          if (shell) return shell;
        }
        return new Response("Sin conexión con el servidor. Reintenta en unos segundos.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      })
  );
});

/* ── Alertas push del WMS (Web Push/VAPID) ──────────────────────────────────
   El backend manda {title, body, url, tag} en incidencias ROJAS de stock y en
   el resumen del job nocturno. Tocar la notificación enfoca/abre el WMS. */
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* texto plano */ }
  event.waitUntil(
    self.registration.showNotification(data.title || "MOS WMS", {
      body: data.body || "",
      tag: data.tag || "wms-alerta",
      icon: "/prosper_logo.jpg",
      badge: "/prosper_logo.jpg",
      data: { url: data.url || "/wms" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/wms";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) { c.navigate(url); return c.focus(); }
      }
      return clients.openWindow(url);
    })
  );
});
