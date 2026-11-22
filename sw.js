// Offline cache: serve from cache, refresh in the background.
const CACHE = "casino-v33";
const CORE = ["./", "index.html", "roulette.html", "poker.html", "online.html", "slots.html", "historique.html", "boutique.html", "casier.html", "defis.html", "rangs.html", "classement.html", "app.js", "boot.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  // "reload" skips the browser's own cache, so a new version really downloads the new files
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// only the app's own files, its fonts and the online-play library are cached;
// matchmaking calls for online play must always go to the network
const CACHEABLE = /^(fonts\.googleapis\.com|fonts\.gstatic\.com|unpkg\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)$/;

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin && !CACHEABLE.test(url.hostname)) return;
  // the version file tells the app that an update is online: never answered from the cache
  if (url.pathname.endsWith("/version.json")) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => {
      if (r && (r.ok || r.type === "opaque")) c.put(e.request, r.clone());
      return r;
    }).catch(() => hit);
    return hit || net;
  }));
});
