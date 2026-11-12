/* ClipMoment — service worker : rend le site installable et l'ouvre même sans réseau.
   Stratégie « réseau d'abord » : on sert toujours la dernière version mise en ligne,
   la copie en cache ne sert que hors connexion. L'API, Supabase, les polices et les vidéos ne sont jamais mises en cache. */
const CACHE = 'clipmoment-v1';
const SHELL = ['/', '/index.html', '/app.html', '/tarifs.html', '/fonctionnalites.html', '/exemples.html', '/contact.html', '/404.html',
  '/assets/style.css', '/assets/site.css', '/assets/core.js', '/assets/site.js', '/assets/app.js', '/assets/engine.js', '/assets/render.js',
  '/assets/sound.js', '/assets/mock.js', '/assets/config.js', '/manifest.webmanifest', '/assets/icons/icon-192.png', '/assets/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // API, Supabase, CDN : réseau direct
  if (req.headers.has('range') || /\.(mp4|webm|mov)$/i.test(url.pathname) || url.pathname === '/admin.html') return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(async () => (await caches.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? (await caches.match('/app.html')) : Response.error())));
});
