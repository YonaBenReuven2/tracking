/* Practice log service worker: lets the app open without a connection.
 * Network first, so a new version shows up as soon as you're online; the cached copy is
 * only used when the network fails. index.html loads its CSS and JS with a ?v= number;
 * when those files change, that number (and SHELL below) goes up. GitHub API calls are never touched or cached.
 * Other apps on the same github.io site have their own caches; this only ever deletes
 * caches whose names start with its own prefix. */
const PREFIX = 'practicelog-';
const CACHE = PREFIX + 'v4';
const SHELL = ['./', 'index.html', 'style.css?v=4', 'core.js?v=4', 'github.js?v=4', 'app.js?v=4', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    // no-cache: always check with the server (cheap when nothing changed), so a new
    // version shows up straight after a push instead of up to ten minutes later.
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});
