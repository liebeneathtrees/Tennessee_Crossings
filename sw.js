/* Service worker for the Tennessee Crossing Trip Planner (built from the Trip Planner Starter Kit 1.4.4).
 *
 * Goal: with no signal, the planner opens, every card,
 * chapter, and trip works, and map areas the visitor looked at or chose to save still show.
 * Adapted from the field guides' service worker (kit 2.x), which is proven on real phones.
 *
 * Caches
 *   shell : the page, its libraries and fonts, the icons
 *   tiles : map tiles (capped so storage can't grow without limit)
 *
 * Bump VERSION when this file's behavior changes. The page itself always tries the
 * network first (with a short timeout), so updates to the HTML arrive on the next visit
 * that has signal. Trips live in the browser's own storage, not here, so clearing these
 * caches never touches a trip.
 */
const VERSION = 'v2';  // v1 (October 15, 2026): first offline release. v2 (kit 1.0.0): Esri and OpenTopoMap tiles.
const PREFIX = 'tnx-planner-';
const SHELL_CACHE = PREFIX + 'shell-' + VERSION;
const TILE_CACHE = PREFIX + 'tiles-v2';
const MAX_TILES = 2000;           // total tiles kept (map tiles are roughly 10 to 40 KB each)
const MAX_REQUEST_TILES = 1000;   // most tiles one "save" request may ask for
const NAV_TIMEOUT_MS = 4000;      // weak signal: give up on the network after this long

const PRECACHE = [
  './',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/leaflet.markercluster.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.2/Sortable.min.js',
  'https://fonts.googleapis.com/css2?family=Alegreya:ital,wght@0,500;0,700;1,500&family=Alegreya+Sans:ital,wght@0,400;0,500;0,700;1,400&display=swap'
];
// Tile servers, from shared/tiles.json: host -> the subdomain saved tiles are stored under ('' = none).
const TILE_HOSTS = {"server.arcgisonline.com": "", "tile.opentopomap.org": "a"};
const STATIC_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

// A 1x1 transparent PNG, shown in place of a tile that isn't saved and can't be fetched.
const BLANK_TILE = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));

function tileHost(hostname) { return Object.keys(TILE_HOSTS).find(h => hostname === h || hostname.endsWith('.' + h)); }
function isTile(url) { return !!tileHost(url.hostname); }
// Some servers serve the same tile from a., b., and c.; store each tile under one key.
function tileKey(u) {
  const url = new URL(String(u)); const h = tileHost(url.hostname);
  if (h && TILE_HOSTS[h] && url.hostname !== h) url.hostname = TILE_HOSTS[h] + '.' + h;
  return url.href;
}
// Ask with CORS so the saved copy is readable and small in the storage budget. A server that
// refuses CORS still gets its tile shown (and saved) the ordinary way.
async function fetchTile(u) {
  try { return await fetch(new Request(u, { mode: 'cors', credentials: 'omit' })); }
  catch (err) { return fetch(new Request(u, { mode: 'no-cors', credentials: 'omit' })); }
}
const usable = res => res && (res.ok || res.type === 'opaque');
async function putSafe(cache, key, res) { try { await cache.put(key, res); return true; } catch (err) { return false; } }

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // One failed URL (for example, no signal during install) must not block installing.
    await Promise.allSettled(PRECACHE.map(async u => {
      const isCross = /^https?:/.test(u);
      const req = new Request(u, isCross ? { mode: 'cors', credentials: 'omit' } : {});
      const res = await fetch(req);
      if (res && res.ok) await cache.put(req, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // Older shell caches, and tile caches from earlier map styles, are removed.
    await Promise.all(names.filter(n => n.startsWith(PREFIX) && n !== SHELL_CACHE && n !== TILE_CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req).then(res => { clearTimeout(timer); resolve(res); }, err => { clearTimeout(timer); reject(err); });
  });
}

async function networkFirstNavigation(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetchWithTimeout(req, NAV_TIMEOUT_MS);
    if (res && res.ok) await cache.put('./', res.clone());
    return res;
  } catch (err) {
    const cached = (await cache.match(req, { ignoreSearch: true })) || (await cache.match('./'));
    if (cached) return cached;
    return new Response('You are offline and the planner has not been saved on this device yet. Open it once with a connection, then it will work offline.',
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function cacheFirstWithRefresh(req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req);
  if (hit) {
    // Refresh in the background so the next visit has the newest copy.
    fetch(req).then(res => { if (res && res.ok) cache.put(req, res); }).catch(() => {});
    return hit;
  }
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) await cache.put(req, res.clone());
    return res;
  } catch (err) {
    return Response.error();
  }
}

async function trimTiles(cache) {
  const keys = await cache.keys();
  const extra = keys.length - MAX_TILES;
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]); // oldest first
}

async function tileHandler(req) {
  const cache = await caches.open(TILE_CACHE);
  const key = tileKey(req.url);
  const hit = await cache.match(key);
  if (hit) return hit;
  try {
    const res = await fetchTile(req.url);
    if (usable(res) && await putSafe(cache, key, res.clone())) trimTiles(cache);
    return res;
  } catch (err) {
    return new Response(BLANK_TILE, { status: 200, headers: { 'Content-Type': 'image/png' } });
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate' && url.origin === self.location.origin) event.respondWith(networkFirstNavigation(req));
  else if (isTile(url)) event.respondWith(tileHandler(req));
  else if (url.origin === self.location.origin || STATIC_HOSTS.includes(url.hostname)) event.respondWith(cacheFirstWithRefresh(req));
});

// ---- Messages from the page ----
async function cacheTiles(urls, port) {
  const cache = await caches.open(TILE_CACHE);
  const list = Array.from(new Set(urls.map(tileKey))).filter(u => {
    try { return isTile(new URL(u)); } catch (e) { return false; }
  }).slice(0, MAX_REQUEST_TILES);
  let done = 0, failed = 0, i = 0;
  const total = list.length;
  const post = m => { if (port) port.postMessage(m); };
  post({ type: 'PROGRESS', done, failed, total });
  async function worker() {
    while (i < list.length) {
      const u = list[i++];
      try {
        if (!(await cache.match(u))) {
          const res = await fetchTile(u);
          if (!(usable(res) && await putSafe(cache, u, res))) failed++;
        }
      } catch (err) { failed++; }
      done++;
      post({ type: 'PROGRESS', done, failed, total });
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  await trimTiles(cache);
  post({ type: 'DONE', done, failed, total });
}

async function reportStatus(port) {
  const shell = await caches.open(SHELL_CACHE);
  const tiles = await caches.open(TILE_CACHE);
  const pageSaved = !!(await shell.match('./'));
  const tileCount = (await tiles.keys()).length;
  if (port) port.postMessage({ type: 'STATUS', pageSaved, tileCount, maxTiles: MAX_TILES, version: VERSION });
}

self.addEventListener('message', event => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];
  if (data.type === 'CACHE_TILES' && Array.isArray(data.urls)) {
    event.waitUntil(cacheTiles(data.urls, port));
  } else if (data.type === 'CLEAR_TILES') {
    event.waitUntil(caches.delete(TILE_CACHE).then(() => { if (port) port.postMessage({ type: 'CLEARED' }); }));
  } else if (data.type === 'STATUS') {
    event.waitUntil(reportStatus(port));
  } else if (data.type === 'CACHE_PAGE') {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(SHELL_CACHE);
        const res = await fetch('./', { cache: 'reload' });
        if (res && res.ok) await cache.put('./', res);
      } catch (err) { /* offline: nothing to save right now */ }
      if (port) port.postMessage({ type: 'PAGE_SAVED' });
    })());
  }
});
