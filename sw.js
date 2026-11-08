// Service worker: keeps the app's own files on the device so Reader opens instantly and works offline
// (saved articles are in IndexedDB). Feed fetches ("fetch" next to the page) always go to the network.
// Paths are relative to where Reader is served (its own site's root, or /reader/ on another site).
// Bump VERSION whenever any file below changes, so devices pick up the new copy.
const VERSION = "reader-v40";
const SHELL = ["./", "index.html", "style.css", "js/parse.js", "js/store.js", "js/app.js", "js/account.js", "js/config.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("reader-") && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const scope = new URL(self.registration.scope).pathname;
  if (e.request.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith(scope) || url.pathname === scope + "fetch") return;
  // Network first, so updates show up when online; the saved copy when offline
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("./")))
  );
});
