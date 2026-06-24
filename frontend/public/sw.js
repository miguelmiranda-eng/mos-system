/* MOS PDA service worker — enables PWA install + a basic offline app shell.
   Network-first for navigations/static GETs; never caches API mutations. */
const CACHE = "mos-pda-v2";

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
      .catch(() =>
        caches.match(request).then((r) => r || caches.match("/pda") || caches.match("/"))
      )
  );
});
