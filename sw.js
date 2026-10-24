/* Service Worker：离线缓存应用外壳与 CDN 库；同步接口（GitHub / Gitee API）永不缓存 */
const VERSION = 'tj-v2.0.0';
const SHELL = ['./', './index.html', './js/core.js', './js/sync.js', './js/ocr.js', './js/app.js', './manifest.webmanifest', './icons/icon-192.png', './icons/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== 'tj-cdn').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (/api\.github\.com|gitee\.com|githubusercontent\.com/.test(url.host)) return; // 同步数据直连网络
  if (url.origin === location.origin) {
    if (url.pathname.includes('/tessdata/')) { e.respondWith(cacheFirst(req, 'tj-cdn')); return; }
    // 应用外壳：网络优先（保证更新），离线时用缓存
    e.respondWith(fetch(req).then(res => { if (res.ok) { const cp = res.clone(); caches.open(VERSION).then(c => c.put(req, cp)); } return res; }).catch(() => caches.match(req).then(r => r || caches.match('./index.html'))));
    return;
  }
  if (/npmmirror\.com|jsdelivr\.net|unpkg\.com/.test(url.host)) e.respondWith(cacheFirst(req, 'tj-cdn'));
});
async function cacheFirst(req, name) {
  const c = await caches.open(name);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') c.put(req, res.clone());
  return res;
}
