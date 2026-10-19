// Service worker do PWA DataGeo PR.
// - Navegação: rede primeiro, cai no index em cache quando offline.
// - /assets/* (nomes com hash do Vite): cache primeiro, imutáveis.
// - Ícones, SVGs e fontes do Google: stale-while-revalidate.
// - Dados (public/data, Supabase, APIs, tiles) passam direto: são grandes
//   ou ao vivo, e o cache HTTP do navegador já cuida deles.
const VERSION = 'v1';
const SHELL_CACHE = `datageo-shell-${VERSION}`;
const ASSET_CACHE = `datageo-assets-${VERSION}`;
const STATIC_CACHE = `datageo-static-${VERSION}`;
const KEEP = new Set([SHELL_CACHE, ASSET_CACHE, STATIC_CACHE]);
const ASSET_LIMIT = 150;

const SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
  '/logo.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

const STATIC_EXT = /\.(?:svg|png|jpe?g|webp|ico|woff2?)$/i;
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('datageo-') && !KEEP.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (request.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith(networkFirstPage(request));
    return;
  }

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/assets/')) {
      event.respondWith(cacheFirst(request, ASSET_CACHE));
    } else if (url.pathname.startsWith('/icons/') || (!url.pathname.startsWith('/data/') && STATIC_EXT.test(url.pathname))) {
      event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
    }
    return;
  }

  if (FONT_HOSTS.has(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
  }
});

async function networkFirstPage(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && new URL(request.url).pathname === '/') cache.put('/', response.clone());
    return response;
  } catch (err) {
    return (await cache.match(request, { ignoreSearch: true })) || (await cache.match('/')) || Response.error();
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    trimCache(cache, ASSET_LIMIT);
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached || Response.error());
  return cached || network;
}

async function trimCache(cache, limit) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - limit; i += 1) await cache.delete(keys[i]);
}
