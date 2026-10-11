// sw.js: "Offline play" (an option, off by default: coop.js registers this worker when it's turned on, and removes it
// when it's turned off).
// The map packs already live in the browser's file storage (the download worker's OPFS copy), so what a page needs
// offline is its own code: the pages, scripts, engine, manifests and shader warm-up lists. Every request still goes to
// the network first, so online nothing changes; a successful response is also kept here, and served when the network
// fails. A map played once (packs downloaded, its code fetched) then starts with no connection, solo only (coop.js).
// Not kept: the pack parts (already in OPFS, and far too big), telemetry, and partial (Range) responses; but each
// map's loading video (pack/web/video, 2-8 MB, streamed by the player in ranges) is kept whole and served in ranges.
// Offline play is turned on per map: the code (engine, scripts, art) is shared, but a map's own files (its pages, shader
// lists, loading video: big) are kept only for maps that have it on. Each page sends its map's path prefixes
// (bo1z-keep), kept in the cache as CONFIG; bo1z-forget drops a map and its files. Whatever is already kept is still
// served offline either way.
// To retire it, deploy a sw.js whose install handler unregisters (see deploy-update.txt).
const CACHE = 'bo1z-offline-1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));

const isVideo = url => /\/pack\/web\/video\/[^/]+\.webm$/.test(url.pathname);
const CONFIG = new URL('offline-maps.config', location.href).href;  // { <slug>: [path prefixes] }
let config = null;
const readConfig = async () => config ??= await (await (await caches.open(CACHE)).match(CONFIG))?.json().catch(() => null) ?? {};
async function writeConfig(c) {
  config = c;
  await (await caches.open(CACHE)).put(CONFIG, new Response(JSON.stringify(c), { headers: { 'Content-Type': 'application/json' } }));
}
// one map's own files: its pages (kino.html, the clean /kino), shader lists, loading video
const mapFile = url => /\/artifacts\/[^/]+-(pipelines|programs)\.json$/.test(url.pathname) || isVideo(url) ||
  (/\.html$/.test(url.pathname) && !/\/index\.html$/.test(url.pathname)) || /\/[^/.]+$/.test(url.pathname);
async function wanted(url) {
  if (!mapFile(url)) return true;
  return Object.values(await readConfig()).some(prefixes => prefixes.some(p => url.pathname.startsWith(p)));
}
const kept = url => url.origin === location.origin && !/\/telemetry(\.jsonl)?$/.test(url.pathname) &&
  (!/\/pack\//.test(url.pathname) || /\/pack\/web-manifest[^/]*\.json$/.test(url.pathname) || isVideo(url));

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || !kept(url)) return;  // straight to the network
  if (isVideo(url)) return e.respondWith(video(req, url, e));
  if (req.headers.has('range')) return;
  e.respondWith(handle(req, url, e));
});

// The loading video: the player asks for ranges, which can't be kept; a whole copy is fetched once beside them, and
// offline the ranges come from that copy. (Without the video the engine would wait for it at the end of loading.)
async function video(req, url, e) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    e.waitUntil((async () => {
      if (await cache.match(url.href) || !await wanted(url)) return;
      const whole = await fetch(url.href);
      if (whole.status === 200) await cache.put(url.href, whole);
    })().catch(() => {}));
    return res;
  } catch (err) {
    const hit = await cache.match(url.href);
    if (!hit) throw err;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '');
    if (!m) return hit;
    const buf = await hit.arrayBuffer(), size = buf.byteLength;
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    return new Response(buf.slice(start, end + 1), { status: 206, headers: {
      'Content-Type': hit.headers.get('Content-Type') || 'video/webm', 'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' } });
  }
}

async function handle(req, url, e) {
  try {
    const res = await fetch(req);
    // a 404 is kept too: some files are optional (artifacts/<map>-programs.json exists only for Five), and the engine
    // reads a 404 as "none", but a failed fetch as a crash
    if ((res.status === 200 || res.status === 404) && res.type === 'basic') e.waitUntil(keep(req, url, res.clone()));
    return res;
  } catch (err) {
    const cache = await caches.open(CACHE);
    // a page's own query (?lobby=..., ?mobile=1) doesn't change the page itself
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' }) ??
      (req.mode === 'navigate' && url.pathname.endsWith('/') ? await cache.match(new URL('index.html', url)) : undefined);
    if (!hit) throw err;
    return hit;
  }
}

// A page loaded before this worker controlled it (the first visit) fetched its files past it: the page sends their
// URLs once it has loaded (the registration snippet), and they're kept the same way. Mostly from the HTTP cache.
self.addEventListener('message', e => {
  if (e.data?.type === 'bo1z-forget') return e.waitUntil(forget(e.data.slug, e.data.prefixes ?? []));
  if (e.data?.type !== 'bo1z-keep') return;
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    if (e.data.map) await writeConfig({ ...await readConfig(), [e.data.map.slug]: e.data.map.prefixes });
    for (const href of new Set(e.data.urls)) {
      const url = new URL(href, location.href), page = href === e.data.page;
      if (url.origin !== location.origin || !kept(url)) continue;
      const key = page ? url.origin + url.pathname : url.href;
      if (await cache.match(key)) continue;
      try {
        const res = await fetch(url.href);
        if (res.status === 200 || res.status === 404) await keep(page ? { mode: 'navigate' } : new Request(url.href), url, res);
      } catch { /* offline already: nothing to keep */ }
    }
  })());
});

// a map turned off: drop its prefixes and its own files (unless another map that's on shares them)
async function forget(slug, prefixes) {
  const c = { ...await readConfig() }; delete c[slug];
  await writeConfig(c);
  const cache = await caches.open(CACHE);
  for (const req of await cache.keys()) {
    const url = new URL(req.url);
    if (req.url !== CONFIG && mapFile(url) && prefixes.some(p => url.pathname.startsWith(p)) && !await wanted(url)) await cache.delete(req);
  }
}

// Versioned code (?v=<hash>, the static build's engine and co-op scripts) replaces its older versions, so the cache
// holds one engine, not one per deploy. The versions go together (an old loader with a new engine doesn't start), and
// the page reaches the engine only on Play: so the first file of a new version seen here fetches the whole set, and a
// page updated online and then started offline finds the engine to match. The engine's threads load the loader
// without ?v= (new URL("KisakBlack-web.mjs", import.meta.url)), so a new version refreshes that copy too.
const VERSIONED = ['artifacts/KisakBlack-web.mjs', 'artifacts/KisakBlack-web.wasm', 'net.js', 'coop.js'];
const THREAD_LOADER = 'artifacts/KisakBlack-web.mjs';
async function keep(req, url, res) {
  try {
    if (!await wanted(url)) return;
    const cache = await caches.open(CACHE), v = url.searchParams.get('v');
    let fresh = false;
    if (v != null)
      for (const old of await cache.keys()) {
        const o = new URL(old.url);
        if (o.pathname === url.pathname && o.searchParams.has('v') && o.searchParams.get('v') !== v) { await cache.delete(old); fresh = true; }
      }
    // a page is kept once, without its query (?lobby=... would otherwise add a copy per lobby)
    await cache.put(req.mode === 'navigate' ? url.origin + url.pathname : req, res);
    if (v == null) return;
    for (const f of VERSIONED) {
      const u = new URL(f + '?v=' + encodeURIComponent(v), location.href);
      if (u.pathname === url.pathname || await cache.match(u.href)) continue;
      const r = await fetch(u.href).catch(() => null);
      if (r?.status === 200) { await keep(new Request(u.href), u, r); fresh = true; }
    }
    const loader = new URL(THREAD_LOADER, location.href).href;
    if (fresh || !await cache.match(loader)) {
      const r = await fetch(loader, { cache: 'no-cache' }).catch(() => null);
      if (r?.status === 200) await cache.put(loader, r);
    }
  } catch { /* storage full or off: online play doesn't need this */ }
}
