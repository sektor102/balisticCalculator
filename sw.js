const CACHE = 'wardogs-fast-fire-v6-ocr2';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './ocr-v2.js'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({type:'window'});
    for (const client of clients) {
      try { await client.navigate(client.url); } catch (_) {}
    }
  })());
});

async function injectOCR(response) {
  const html = await response.text();
  const patched = html.includes('ocr-v2.js')
    ? html
    : html.replace('</body>', '<script src="./ocr-v2.js?v=2"></script></body>');
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('content-type','text/html; charset=utf-8');
  return new Response(patched,{status:response.status,statusText:response.statusText,headers});
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const isPage = event.request.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/balisticCalculator/');

  if (isPage) {
    event.respondWith((async () => {
      let response;
      try {
        response = await fetch(event.request);
        const cache = await caches.open(CACHE);
        cache.put(event.request, response.clone());
      } catch (_) {
        response = await caches.match(event.request) || await caches.match('./index.html');
      }
      return injectOCR(response);
    })());
    return;
  }

  event.respondWith(fetch(event.request).then(response => {
    const copy=response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request)));
});
