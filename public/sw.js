// Service worker Pencatat Laporan v2.
//
// Pelajaran dari insiden 2026-11-02: halaman HTML JANGAN di-cache-first.
// HTML hasil build Next merujuk chunk JS ber-hash; HTML lama + chunk baru
// (atau sebaliknya) membuat halaman macet di "Memuat..." karena JS gagal
// dimuat. Karena itu:
// - Navigasi & aset non-hash: network-first, cache hanya cadangan offline.
// - Chunk _next/ (hash di URL = isinya tidak pernah berubah): cache-first, aman.
// - API (/api/*): TIDAK pernah di-cache, selalu dari jaringan.
const CACHE = "pencatat-laporan-v3";
const SHELL = ["/", "/manifest.json", "/logo-dark.png", "/logo-light.png", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.pathname.startsWith("/api/")) return;

  // Chunk hash: isinya abadi, cache-first aman dan cepat.
  if (url.pathname.startsWith("/_next/")) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            return res;
          })
      )
    );
    return;
  }

  // Selain itu (termasuk navigasi "/"): jaringan dulu, cache hanya bila offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }).then((cached) => cached || caches.match("/")))
  );
});
