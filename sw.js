/* Service worker do Ecossistema Emocional.
   Necessário para instalar como app (PWA) e permite funcionar offline.
   Estratégia: network-first (sempre busca a versão mais nova quando online,
   caindo para o cache só offline) — assim novas publicações aparecem na hora. */
const CACHE = 'ecossistema-v16';
const ASSETS = [
  '.',
  'index.html',
  'style.css',
  'noise.js',
  'polar.js',
  'app.js',
  'pwa.js',
  'coracao.html',
  'coracao.css',
  'coracao.js',
  'composicao.html',
  'composicao.css',
  'composicao.js',
  'joguinho.html',
  'joguinho.css',
  'joguinho.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => {})
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // network-first: pega o mais recente; se offline, usa o cache.
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || (req.mode === 'navigate' ? caches.match('index.html') : undefined)))
  );
});
