// Service worker: lets the installed app open and show the matrix, photos and your RFQ list with no signal.
// Online it always uses the network first, so nothing is ever stale while connected.
const V = '__VERSION__', SHELL = 'bm-shell-' + V, DATA = 'bm-data', IMG = 'bm-img';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL)
    .then(c => c.addAll(['/login', '/manifest.webmanifest', '/favicon.svg', '/logos/beckett.png', '/logos/wayne.png', '/icons/icon-192.png']).catch(() => {}))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('bm-shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// phone notifications: show them, and open the RFQ when tapped
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Burner Matrix', { body: d.body || '', tag: d.tag, renotify: !!d.tag,
    icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => new URL(x.url).origin === self.location.origin);
    if (c) return c.navigate(url).then(w => (w || c).focus()).catch(() => self.clients.openWindow(url));
    return self.clients.openWindow(url);
  }));
});
// signing out wipes everything cached on this device
self.addEventListener('message', e => {
  if (e.data === 'logout') e.waitUntil(caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))));
});

async function networkFirst(req, cacheName, key) {
  const c = await caches.open(cacheName);
  try {
    const r = await fetch(req);
    if (r.ok && !r.redirected) c.put(key || req, r.clone());
    return r;
  } catch (err) {
    const m = await c.match(key || req);
    if (m) return m;
    throw err;
  }
}
async function cacheFirst(req, cacheName) {
  const c = await caches.open(cacheName), m = await c.match(req);
  if (m) { fetch(req).then(r => { if (r.ok) c.put(req, r); }).catch(() => {}); return m; }
  const r = await fetch(req);
  if (r.ok || r.type === 'opaque') c.put(req, r.clone());
  return r;
}

self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET') return;
  if (u.origin !== location.origin) {
    if (/(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)) e.respondWith(cacheFirst(req, IMG));
    return;
  }
  const p = u.pathname;
  if (req.mode === 'navigate') {
    if (p === '/' || p === '/index.html') e.respondWith(networkFirst(req, SHELL, '/').catch(() => caches.match('/login')));
    else if (p === '/login') e.respondWith(networkFirst(req, SHELL, '/login'));
    return; // admin and everything else: online only
  }
  if (p === '/burners.json' || p === '/api/me' || p === '/api/rfqs' || p === '/api/customers' || p === '/api/xref') return e.respondWith(networkFirst(req, DATA));
  if (p.startsWith('/photos/') || p.startsWith('/logos/') || p.startsWith('/icons/') || p === '/schema.js' || p === '/favicon.svg') return e.respondWith(cacheFirst(req, IMG));
});
