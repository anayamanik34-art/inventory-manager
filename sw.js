// Offline support for the app shell, and opening the app from a low-stock notification.
const CACHE = "eksoch-inventory-manager-v1";
const SHELL = ["./", "index.html", "styles.css", "app.js", "pro-codes.js", "manifest.webmanifest", "privacy.html",
  "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first, so updates show up right away; the cache is the offline fallback.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html"))),
  );
});

// Clicking a low-stock notification opens (or focuses) the app on the low-stock list.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL("./#products/low", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    const win = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (win) { win.navigate(target).catch(() => {}); return win.focus(); }
    return self.clients.openWindow(target);
  }));
});
