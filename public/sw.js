/**
 * OpenHaul service worker.
 *
 * The job is narrow and specific: a driver in a yard with no signal must still
 * be able to open the app, scan a VIN, and validate it. Everything here serves
 * that, and nothing here tries to be a general-purpose offline layer.
 *
 * Hand-written rather than generated because the caching rules are few and the
 * consequences of getting them wrong are severe — a stale build swapped in
 * mid-inspection would lose a driver's work.
 */

const VERSION = 'v1';
const SHELL_CACHE = `openhaul-shell-${VERSION}`;
const ASSET_CACHE = `openhaul-assets-${VERSION}`;
const PAGE_CACHE = `openhaul-pages-${VERSION}`;

/**
 * Cached on install. The WASM decoder is the important one: without it,
 * scanning is exactly the thing that stops working when signal does.
 */
const PRECACHE = [
  '/wasm/zxing_reader.wasm',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/offline',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Individually, so one 404 during development does not abort the whole
      // install and leave the worker permanently unregistered.
      await Promise.allSettled(PRECACHE.map((url) => cache.add(url)));
    })(),
  );
  // Deliberately no skipWaiting(). A new worker taking over mid-inspection
  // would swap precached chunks under a running page. The update is applied
  // when the client asks for it — see registerServiceWorker().
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE, PAGE_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  // The page decides when it is safe to take an update.
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

/** Next.js build output is content-hashed, so it is immutable once fetched. */
function isImmutableAsset(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/wasm/') ||
    url.pathname.startsWith('/icons/')
  );
}

function isPageRequest(request) {
  return request.mode === 'navigate';
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

/**
 * Network first, falling back to the last good copy.
 *
 * Pages are per-user and change, so a stale one is worse than a slow one —
 * except when there is no network at all, which is the case this exists for.
 */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match(request);
    if (hit) return hit;

    const offline = await caches.match('/offline');
    if (offline) return offline;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET is cacheable, and only our own origin is ours to cache.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache authentication or mutations. A cached sign-in response would
  // be both wrong and a security problem.
  if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/vin/')) return;
  if (url.pathname === '/login' || url.pathname === '/register') return;

  if (isImmutableAsset(url)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  if (isPageRequest(request)) {
    event.respondWith(networkFirst(request, PAGE_CACHE));
    return;
  }

  // VIN decodes are immutable facts about a vehicle, so a cached answer is
  // always correct and is exactly what makes lookups work offline.
  if (url.pathname.startsWith('/api/vin/decode')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
  }
});
