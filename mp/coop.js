// coop.js: co-op lobby UI on the map pages (loaded by play.js; the networking is net.js).
// The map page gets a "Play with friends" button: it opens a new lobby, ?lobby=<room>, and that page's address is the
// invite link. The lobby panel walks everyone through it: share the link, press Play (the map downloads while you
// wait), the host presses Start. Until the start, the page's "Click to start" waits, so nobody begins a solo game by
// accident; after it, everyone's game connects to the host's and round 1 waits for all the players.
import { startLobby } from './net.js';
const query = new URLSearchParams(location.search);
const room = query.get('lobby') ?? query.get('host') ?? query.get('join');
const mapName = document.querySelector('#game')?.getAttribute('aria-label') ?? document.title;
const style = document.createElement('style');
style.textContent = `
  #coop { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 50; width: min(30em, calc(100vw - 32px));
    box-sizing: border-box; background: rgba(8,8,8,.88); color: #e8e8e8; border: 1px solid #5a5a5a; border-radius: 8px;
    padding: 12px 14px; font: 14px/1.45 system-ui, sans-serif; display: grid; gap: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.5); }
  #coop h2 { margin: 0; font-size: 15px; font-weight: 600; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  #coop .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  #coop input { font: inherit; background: #151515; color: #eee; border: 1px solid #4a4a4a; border-radius: 4px; padding: 3px 7px; min-width: 0; }
  #coop .link { flex: 1; font-size: 12px; color: #bbb; }
  #coop .code { font: 600 15px ui-monospace, monospace; letter-spacing: .05em; user-select: all; }
  #coop button { font: inherit; cursor: pointer; background: #333; color: #eee; border: 1px solid #666; border-radius: 4px; padding: 3px 12px; }
  #coop button.go { background: #2f6b2f; border-color: #57a057; font-weight: 600; padding: 6px 16px; }
  #coop button.go:hover { background: #3a823a; }
  #coop button:disabled { opacity: .55; cursor: default; }
  #coop button.go:disabled:hover { background: #2f6b2f; }
  #coop li .right { display: flex; gap: 8px; align-items: center; }
  #coop button.rm { font-size: 11px; padding: 0 6px; background: none; color: #bbb; border-color: #555; }
  #coop .kb-pad-focus { outline: 2px solid #ff3b2b; outline-offset: 2px; }
  #coop ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 3px; }
  #coop li { display: flex; justify-content: space-between; gap: 8px; padding: 3px 8px; background: rgba(255,255,255,.05); border-radius: 4px; }
  #coop li .st { color: #aaa; }
  #coop li .st.ok { color: #8fd18f; }
  #coop .step { font-size: 13px; color: #ddd; }
  #coop .dim { color: #aaa; font-size: 12px; }
  #coop .warn { color: #f0c060; }
  #coop .big { font-size: 15px; font-weight: 600; color: #fff; }
  body[data-screen=playing] #coop.quiet { display: none; }
  #coop-friends { display: none; }
  body[data-screen=landing] #coop-friends:not([hidden]) { display: inline-block; }`;
document.head.append(style);

function newRoom() {
  const a = new Uint8Array(8); crypto.getRandomValues(a);
  return Array.from(a, b => 'abcdefghijkmnpqrstuvwxyz23456789'[b & 31]).join('');
}
function pageUrl(lobbyId) {
  const url = new URL(location.href);
  for (const k of ['host', 'join', 'players', 'peer', 'lobby']) url.searchParams.delete(k);
  if (lobbyId) url.searchParams.set('lobby', lobbyId);
  return url.href;
}
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
// Offline (no network, or the site's server out of reach while this page came from the offline copy, sw.js): solo
// play only, co-op is hidden. A HEAD request never comes from sw.js's copy, so it tells whether the server answers.
let offline = navigator.onLine === false;
const offlineListeners = new Set();
const setOffline = v => { if (offline !== v) { offline = v; for (const f of offlineListeners) f(); } };
const probe = () => fetch(new URL('sw.js', document.baseURI), { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout?.(4000) })
  .then(() => setOffline(false), () => setOffline(true));
addEventListener('offline', () => setOffline(true));
addEventListener('online', probe);
const firstProbe = probe();
setInterval(() => { if (offline) probe(); }, 15000);

// "Offline play" (Options, per map, off by default): mp/sw.js keeps the game's code on this device as it is fetched (the
// maps themselves already stay after their download), so a map with it on starts with no connection. The code (engine,
// scripts) is shared by all maps; each map's own files (its page, shader lists, loading video) are kept only while that
// map has it on. Turning it on also keeps them now; off forgets that map's files, and the last map off removes the worker.
const OFFLINE_KEEP = ['index.html', 'landing.js', 'app.webmanifest', 'vendor/qrcode.js', 'vendor/jsQR.js',
  ...['kbcoop/maps/kbcoop/_hooks.gsc', 'kbcoop/maps/kbcoop/_kbcoop.gsc', '_stack/maps/_modstack.gsc', '_stack/maps/_zombiemode_ffotd.gsc'].map(f => 'coop-mod/' + f)];
const maps = import('./maps.js');
const offlineKey = slug => 'bo1z-offline:' + slug;
// this map's own files: prefixes (paths) for sw.js, and the ones to fetch now
function mapFiles(m) {
  const page = m.BASE + m.map.slug;  // its pages (kino.html, kino, kino-horde.html) and its folder (kino/)
  const pipelines = m.BASE + `artifacts/${warmName()}-pipelines.json`, video = `${m.packBase}web/video/${m.map.zone}_load`;
  return { prefixes: [page, pipelines, m.map.programs, video], urls: [pipelines, m.map.programs, video + '.av1.webm', video + '.webm'] };
}
async function offlineCache(on) {
  if (!navigator.serviceWorker) return;
  try {
    const m = await maps, mine = mapFiles(m);
    if (on) {
      await navigator.serviceWorker.register(new URL('sw.js', document.baseURI));
      const reg = await navigator.serviceWorker.ready;
      // and what this page's download worker loaded before the switch (its fetches aren't in this page's list)
      const worker = [m.workerUrl(m.BASE + 'engine-download-worker.js'), m.manifestUrl,
        ...['download-worker.js', 'maps.js', 'sha256.js', 'dxs.js', 'opfs-icase.js', 'opus-worker.js', 'capability-worker.js'].map(f => m.BASE + f),
        // and what the game itself loads once it runs, so this map starts offline without being played online first
        ...['audio-worklet.js', 'artifacts/KisakBlack-web.mjs'].map(f => m.BASE + f)];
      const urls = [location.href, ...[...OFFLINE_KEEP, ...worker, ...mine.urls].map(u => new URL(u, document.baseURI).href),
        ...performance.getEntriesByType('resource').map(e => e.name)];
      reg.active?.postMessage({ type: 'bo1z-keep', page: location.href, urls, map: { slug: m.map.slug, prefixes: mine.prefixes } });
    } else if (m.MAP_LIST.some(x => option(offlineKey(x.slug)))) {
      // other maps still have it on: forget only this one's files
      (await navigator.serviceWorker.getRegistration(new URL('sw.js', document.baseURI)))?.active
        ?.postMessage({ type: 'bo1z-forget', slug: m.map.slug, prefixes: mine.prefixes });
    } else {
      try { localStorage.removeItem('bo1z-offline'); } catch { /* storage off */ }  // the old every-map setting
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
      for (const k of await caches.keys()) if (k.startsWith('bo1z-offline')) await caches.delete(k);
    }
  } catch (e) { console.warn('offline play:', e); }
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const names = list => list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;

// The map page starts only on an explicit choice: "Play solo" (the page's own start button, relabelled) or "Play with
// friends" (a lobby). play.js would start on any key or click, and right away after a pick on the map-select page
// (__kisakLandingPick); on the landing screen only the buttons count. "Click to start" later is unchanged.
Object.defineProperty(globalThis, '__kisakLandingPick', { configurable: true, get: () => false, set() {} });
const playButton = document.getElementById('play');
const onLanding = () => document.body.dataset.screen === 'landing';
const PLAY_LABEL = room ? 'Get ready' : 'Play solo';
function relabel() {
  if (onLanding() && playButton?.textContent === 'Press any key to start') playButton.textContent = PLAY_LABEL;
}
if (playButton) {
  new MutationObserver(relabel).observe(playButton, { childList: true, characterData: true, subtree: true });
  new MutationObserver(relabel).observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });
  relabel();
}
document.addEventListener('keydown', event => {
  if (onLanding() && !event.target.closest?.('input, textarea, button, select, #settings')) event.stopPropagation();
}, true);
document.addEventListener('click', event => {
  if (onLanding() && !event.target.closest?.('button, a, input, select, label, details, #settings, #coop')) event.stopPropagation();
}, true);

// The page's "Click to resume" hint (play.js shows it whenever the mouse isn't captured in game) also shows to someone
// happily playing with a controller. It now reads "Click to capture the mouse" and only shows while the mouse moves
// over the page, fading out 2.5 s after it stops.
const hint = document.getElementById('resume-hint');
if (hint) {
  hint.textContent = 'Click to capture the mouse';
  style.textContent += `
    #resume-hint { transition: opacity .4s; }
    body:not(.kb-mouse-moving) #resume-hint { opacity: 0; }`;
  let still = 0;
  document.addEventListener('mousemove', () => {
    if (document.pointerLockElement) return;
    document.body.classList.add('kb-mouse-moving');
    clearTimeout(still);
    still = setTimeout(() => document.body.classList.remove('kb-mouse-moving'), 2500);
  });
  document.documentElement.addEventListener('mouseleave', () => { clearTimeout(still); document.body.classList.remove('kb-mouse-moving'); });
}

// Options: "Low graphics" (a bundle of the engine's own quality settings, plus at most 0.5 render pixels per CSS
// pixel instead of the screen's density, e.g. 2 on a Retina Mac) and "Flat lighting" (r_fullbright: no lighting at all). Saved per browser and applied when the map starts:
// engine.js passes globalThis.__kbCvars to the engine before ?cvar.<name> from the URL, which still wins.
const LOW_GRAPHICS = { sm_enable: 0, r_picmip_manual: 1, r_picmip: 2, r_picmip_bump: 2, r_picmip_spec: 2,
  r_lodScaleRigid: 2, r_lodScaleSkinned: 2, r_distortion: 0, cg_brass: 0 };
const option = key => { try { return localStorage.getItem(key) === '1'; } catch { return false; } };
function applyGraphics() {
  const low = option('bo1z-lowgfx'), flat = option('bo1z-flatlight');
  // off sends null (reset to default): the engine keeps archived cvars like r_picmip in its saved config
  const reset = Object.fromEntries(Object.keys(LOW_GRAPHICS).map(k => [k, null]));
  globalThis.__kbCvars = { ...(low ? LOW_GRAPHICS : reset), r_fullbright: flat ? 1 : null };
  // render resolution: canvas.js multiplies the window size by the screen's pixel density (canvas.js patch); Low caps it
  // at 0.5 render pixels per CSS pixel, which canvas.js's own 800x600 minimum then bounds (about 960x600 on a laptop)
  globalThis.__kbMaxDensity = low ? 0.5 : undefined;
}
applyGraphics();
// a map page with offline play on keeps its files again a moment after it has loaded (new versions, a new sw.js)
maps.then(m => {
  // Offline play was one setting for every map before (bo1z-offline): it carries over to each map page opened
  try { if (localStorage.getItem('bo1z-offline') === '1' && localStorage.getItem(offlineKey(m.map.slug)) == null) localStorage.setItem(offlineKey(m.map.slug), '1'); } catch { /* storage off */ }
  if (!option(offlineKey(m.map.slug))) return;
  const later = () => setTimeout(() => offlineCache(true), 3000);
  if (document.readyState === 'complete') later(); else addEventListener('load', later, { once: true });
});
// Changed after the engine started (co-op players wait at "Click to start" with the map loaded): apply what the engine
// takes live; texture detail and render resolution only change when a map loads.
const LIVE = ['sm_enable', 'r_lodScaleRigid', 'r_lodScaleSkinned', 'r_distortion', 'cg_brass', 'r_fullbright'];
function applyLive() {
  if (!globalThis.kbCmd || !globalThis.__kbState?.engine) return;
  for (const k of LIVE) {
    const v = globalThis.__kbCvars[k];
    kbCmd(v === null || v === undefined ? `reset ${k}` : `set ${k} ${v}`).catch(() => {});
  }
}
// Options: a panel in the middle of the screen, opened by an "Options" button beside Play (the page's own corner menu
// is hidden), reachable with a controller. "All maps": Fullscreen, Low graphics, Flat lighting. "This map": mouse
// sensitivity and volume (play.js keeps them per map), Offline play, and the map's mods / Hell mode fields (play.js adds
// those before the note, so they land in this section).
const settings = document.getElementById('settings');
const settingsBody = settings?.querySelector('.settings-body');
const closeOptions = () => { if (settings?.open) { settings.open = false; document.getElementById('kb-options')?.focus({ preventScroll: true }); } };
style.textContent += `
  #settings > summary { display: none; }
  #settings[hidden] { display: none !important; }
  #settings[open] { position: fixed; inset: 0; z-index: 45; width: auto; display: grid; place-items: center; background: rgba(0,0,0,.55); }
  #settings[open] .settings-body { width: min(27em, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; box-sizing: border-box;
    margin: 0; padding: 16px 20px 12px; background: rgba(10,10,10,.95); border: 1px solid #444; font-size: .85rem; }
  .settings-body .kb-opt-head { display: flex; justify-content: space-between; align-items: center; font-size: 1.1rem; letter-spacing: .14em; }
  .settings-body .kb-opt-head button { font: inherit; font-size: .8rem; letter-spacing: .12em; text-transform: uppercase; color: #eee;
    background: none; border: 1px solid #666; padding: 4px 14px; cursor: pointer; }
  .settings-body h3 { margin: 16px 0 8px; padding-bottom: 3px; border-bottom: 1px solid #333; color: #999; font-size: .72rem; font-weight: normal; letter-spacing: .14em; }
  .settings-body .kb-pad-focus { outline: 2px solid #ff3b2b; outline-offset: 3px; }
  #kb-options, #kb-maps { display: none; }
  body[data-screen=landing] #kb-options:not([hidden]), body[data-screen=ready] #kb-options:not([hidden]),
  body[data-screen=landing] #kb-maps:not([hidden]) { display: inline-block; }`;
if (settingsBody) {
  const note = settingsBody.querySelector('#settings-note');
  const check = (key, text, title, onchange) => {
    const box = el('input', { type: 'checkbox', checked: option(key) });
    box.onchange = () => { try { localStorage.setItem(key, box.checked ? '1' : '0'); } catch { /* not kept */ } onchange(box.checked); };
    return el('label', { className: 'check', title }, box, ' ' + text);
  };
  const graphics = () => { applyGraphics(); applyLive(); };
  const done = el('button', { type: 'button', textContent: 'Done' });
  done.onclick = closeOptions;
  settingsBody.prepend(el('div', { className: 'kb-opt-head' }, el('span', {}, 'Options'), done),
    el('h3', {}, 'All maps'),
    ...[document.getElementById('fullscreen')?.closest('label'),
      check('bo1z-lowgfx', 'Low graphics', 'Faster on slow machines: no dynamic shadows, lower texture detail, simpler distant models, lower render resolution. Shadows and models change right away; texture detail and resolution when the map starts.', graphics),
      check('bo1z-flatlight', 'Flat lighting', 'No lighting at all: fastest, but the map looks flat and fully lit.', graphics)].filter(Boolean),
    el('h3', {}, `This map · ${mapName}`));  // the sensitivity and volume rows follow
  if (navigator.serviceWorker) maps.then(m => settingsBody.insertBefore(check(offlineKey(m.map.slug), 'Offline play',
    `Keep ${mapName} on this device, so it starts without an internet connection once you have played it: solo, or co-op with players on the same Wi-Fi.`,
    offlineCache), note));
  settings.addEventListener('click', e => { if (e.target === settings) closeOptions(); });  // outside the panel
  document.addEventListener('keydown', e => { if (settings.open && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeOptions(); } }, true);
}
// Fullscreen applies to every map (play.js saves it with each map's settings; this shared copy wins)
{
  const box = document.getElementById('fullscreen');
  try {
    const saved = localStorage.getItem('bo1z-fullscreen');
    if (box && saved != null) box.checked = saved === '1'; else if (box) localStorage.setItem('bo1z-fullscreen', box.checked ? '1' : '0');
  } catch { /* storage off */ }
  box?.addEventListener('input', () => { try { localStorage.setItem('bo1z-fullscreen', box.checked ? '1' : '0'); } catch { /* not kept */ } });
}

// No second "Click to start": the explicit "Play solo" / "Get ready" choice was the user's click, so once the map is
// ready (and, in a lobby, the host has started) the game starts by itself, the way a controller press on "Click to
// start" does: without capturing the mouse (the first click in game captures it, "Click to capture the mouse") and
// with audio resumed on the strength of that earlier click, or on the next click/key if the browser wants a fresh one.
{
  let chosen = false, started = false;
  playButton?.addEventListener('click', () => { if (onLanding()) chosen = true; }, true);
  const auto = () => {
    if (!chosen || started || document.body.dataset.screen !== 'ready' || !playButton || playButton.hidden || playButton.disabled) return;
    // in a lobby, only once the host has started (the lobby's own hold on the button can come a moment too late)
    if (room && (!globalThis.kbnet?.started || globalThis.kbnet.hostLeft)) return;
    started = true;
    globalThis.__kbPadPress = true; try { playButton.click(); } finally { setTimeout(() => { globalThis.__kbPadPress = false; }, 0); }
  };
  new MutationObserver(auto).observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });
  if (playButton) new MutationObserver(auto).observe(playButton, { attributes: true, attributeFilter: ['disabled', 'hidden'] });
  setInterval(auto, 500);
}

// Fetch the map's shader warm-up list (artifacts/<map>-pipelines.json, 11-26 MB) as soon as the player chooses, in
// parallel with the map download: the renderer only asks for it at the end of loading and stops waiting after 10 s,
// so on a slow link it started with nothing warmed. The renderer's own fetch then comes from the HTTP cache.
// Same name rule as the renderer (KISAK_WEBGPU_MAP): "kino" for Kino, the zone name for the others, else "five".
function warmName() {
  const zone = document.documentElement.dataset.map || location.pathname;
  return /kino|theater/i.test(zone) ? 'kino' : (/zombie_(?!pentagon)\w+/i.exec(zone) || ['five'])[0].toLowerCase();
}
playButton?.addEventListener('click', () => {
  if (!onLanding() || /[?&]renderer=webgl2/.test(location.search) || globalThis.__kbSeedFetched) return;
  globalThis.__kbSeedFetched = true;
  fetch(new URL(`artifacts/${warmName()}-pipelines.json`, document.baseURI)).then(r => r.arrayBuffer()).catch(() => {});
}, true);

// Fullscreen (Options) needs a user gesture too, and the game now starts without one: enter it on the "Play solo" /
// "Get ready" click instead, with the Escape key lock play.js takes in fullscreen (Escape then reaches the game).
playButton?.addEventListener('click', () => {
  const box = document.getElementById('fullscreen');
  if (!onLanding() || !box?.checked || document.fullscreenElement || !document.documentElement.requestFullscreen) return;
  document.documentElement.requestFullscreen().then(() => {
    const state = globalThis.__kbState;
    return navigator.keyboard?.lock?.(['Escape']).then(() => { if (state) state.keyboardLock = 'locked'; }, () => {});
  }, () => {});
}, true);

// Controller on the start screens: the D-pad / left stick moves between the buttons (Play solo, Play with friends,
// Options, Map select, the lobby's buttons), highlighted like a mouse hover, and A presses the highlighted one; holding
// a direction repeats. In Options: up and down move between the settings, left and right change a slider or number,
// A toggles or presses, B closes. Browsers don't count a controller press as a user gesture, so where sound needs one it
// starts with the next click, tap or key.
style.textContent += `
  .option.kb-pad-focus { color: #fff; text-shadow: 0 0 8px #ff3b2b, 0 0 2px #000; }`;
{
  let held = { a: true, b: true, dir: null }, repeatAt = 0, choice = null, optChoice = 0, marked = null, running = false;
  const mark = e => { if (marked !== e) { marked?.classList.remove('kb-pad-focus'); e?.classList.add('kb-pad-focus'); marked = e; } };
  const usable = b => b && !b.hidden && !b.disabled && b.offsetParent;
  const press = b => { globalThis.__kbPadPress = true; try { b.click(); } finally { setTimeout(() => { globalThis.__kbPadPress = false; }, 0); } };
  const poll = now => {
    requestAnimationFrame(poll);
    const pad = [...(navigator.getGamepads?.() ?? [])].find(p => p && p.connected), screen = document.body.dataset.screen;
    if (!pad) { mark(null); return; }
    const button = i => !!pad.buttons[i]?.pressed, x = pad.axes[0] ?? 0, y = pad.axes[1] ?? 0;
    const dir = button(12) || y < -0.5 ? 'up' : button(13) || y > 0.5 ? 'down' : button(14) || x < -0.5 ? 'left' : button(15) || x > 0.5 ? 'right' : null;
    let step = null;
    if (dir && (dir !== held.dir || now >= repeatAt)) { step = dir; repeatAt = now + (dir !== held.dir ? 400 : 120); }
    const a = button(0) && !held.a, b = button(1) && !held.b;
    held = { a: button(0), b: button(1), dir };
    const modal = settings?.open && !settings.hidden ? settingsBody : friendsBox?.open ? friendsBox.card : null;
    if (modal) {
      const items = [...modal.querySelectorAll('button, input')].filter(usable);
      if (!items.length) return;
      if (step === 'up' || step === 'down') {
        optChoice = (Math.min(optChoice, items.length - 1) + (step === 'down' ? 1 : -1) + items.length) % items.length;
        items[optChoice].scrollIntoView({ block: 'nearest' });
      }
      const item = items[Math.min(optChoice, items.length - 1)];
      if ((step === 'left' || step === 'right') && (item.type === 'range' || item.type === 'number')) {
        if (step === 'right') item.stepUp(); else item.stepDown();
        item.dispatchEvent(new Event('input', { bubbles: true })); item.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (a && (item.type === 'checkbox' || item.tagName === 'BUTTON')) item.click();
      if (a && item.type === 'text') item.focus();  // the on-screen keyboard, where there is one
      if (b) { if (modal === settingsBody) closeOptions(); else friendsBox.hide(); }
      mark(item.type === 'checkbox' ? item.closest('label') ?? item : item);
      return;
    }
    const items = ['landing', 'ready', 'error'].includes(screen)
      ? [...document.querySelectorAll('#coop button, #overlay .actions button')].filter(usable) : [];
    if (!items.length) { mark(null); return; }
    if (!items.includes(choice)) choice = items.includes(playButton) ? playButton : items[0];
    if (step) choice = items[(items.indexOf(choice) + (step === 'up' || step === 'left' ? -1 : 1) + items.length) % items.length];
    mark(items.length > 1 ? choice : null);
    // marks the press as a controller press for engine.js (start without pointer lock, audio on the next gesture)
    if (a) press(choice);
  };
  const start = () => { if (!running) { running = true; requestAnimationFrame(poll); } };
  addEventListener('gamepadconnected', start);
  if ([...(navigator.getGamepads?.() ?? [])].some(Boolean)) start();
}

// Keep the screen on while playing: on iPad, controller input doesn't reset the system's idle timer, and as the screen
// heads for auto-lock Safari stops delivering controller updates (fixed by a tap). A screen wake lock keeps it awake;
// it's dropped whenever the page is hidden, so it's taken again on every return to the page and on input.
{
  let lock = null;
  const want = () => document.visibilityState === 'visible' && ['ready', 'playing'].includes(document.body.dataset.screen);
  const take = () => {
    if (lock || !want() || !navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then(l => { lock = l; l.addEventListener('release', () => { lock = null; }); }, () => {});
  };
  document.addEventListener('visibilitychange', take);
  for (const type of ['pointerdown', 'keydown']) addEventListener(type, take, { capture: true, passive: true });
  addEventListener('gamepadconnected', take);
  new MutationObserver(take).observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });
  setInterval(take, 5000);
}

// ?paddebug=1: a live on-screen panel for controllers that stop responding (iPad), since such devices often have no
// console: what the Gamepad API reports and how fresh it is, focus/visibility, the last touch, and the engine's side.
if (query.get('paddebug') === '1') {
  const panel = el('pre', { id: 'kb-paddebug' });
  panel.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:60;margin:0;padding:6px 8px;background:rgba(0,0,0,.75);color:#9f9;font:11px/1.35 ui-monospace,monospace;pointer-events:none;white-space:pre';
  document.body.append(panel);
  let lastTouch = 0, events = '';
  for (const type of ['pointerdown', 'touchstart', 'keydown', 'mousedown']) addEventListener(type, () => { lastTouch = performance.now(); }, { capture: true, passive: true });
  for (const type of ['gamepadconnected', 'gamepaddisconnected', 'blur', 'focus']) addEventListener(type, () => { events = (type + ' @' + Math.round(performance.now() / 1000) + 's ' + events).slice(0, 120); });
  // focus moving between page elements (or to nothing) right before the controller stalls would be the trigger
  const describe = e => !e ? 'none' : e === document.body ? 'body' : e.tagName.toLowerCase() + (e.id ? '#' + e.id : '');
  for (const type of ['focusin', 'focusout']) document.addEventListener(type, ev => { events = (type + ' ' + describe(ev.target) + ' @' + Math.round(performance.now() / 1000) + 's ' + events).slice(0, 120); }, true);
  setInterval(() => {
    const now = performance.now(), all = [...(navigator.getGamepads?.() ?? [])], g = all.find(p => p && p.connected);
    const eng = globalThis.__kbpad?.pad?.();
    panel.textContent = [
      `pads ${all.map(p => p ? (p.connected ? 'c' : 'd') : '-').join('')}  ${g ? g.id.slice(0, 28) + ' (' + g.mapping + ')' : 'none'}`,
      g ? `update age ${Math.round(now - g.timestamp)} ms  buttons [${g.buttons.map((b, i) => b.pressed ? i : -1).filter(i => i >= 0)}]  axes ${Array.from(g.axes, a => a.toFixed(2)).join(' ')}` : '',
      `focus ${document.hasFocus()}  active ${document.activeElement === document.body ? 'body' : (document.activeElement?.tagName.toLowerCase() ?? 'none') + (document.activeElement?.id ? '#' + document.activeElement.id : '')}  visible ${document.visibilityState}  last touch ${lastTouch ? Math.round((now - lastTouch) / 1000) + ' s ago' : 'never'}`,
      eng ? `engine gpad_enabled ${eng.gpad_enabled} present ${eng.gpad_present}  sticks ${eng.sticks.map(v => v.toFixed(2)).join(' ')}` : 'engine: not running',
      `screen ${document.body.dataset.screen}  wakeLock ${navigator.wakeLock ? 'yes' : 'no'}  ${events}`,
    ].filter(Boolean).join('\n');
  }, 200);
}

// Keep the game canvas focused while playing (?padfocus=0 turns it off). iPad Safari only feeds a controller to the
// page while its web view is first responder; when page focus drifts away it can give that up, and the controller then
// drives Safari's own interface (tabs, address bar) until the screen is tapped. Nothing else needs focus during play.
if (query.get('padfocus') !== '0') setInterval(() => {
  const canvas = document.getElementById('game');
  if (canvas && document.body.dataset.screen === 'playing' && document.activeElement !== canvas) canvas.focus({ preventScroll: true });
}, 500);

// Phones and tablets get "Desktop required" (no touch controls). A controller on that screen lifts it: remember it for
// this tab and reload (the capabilities.js patch then lets the device through). Safari may only reveal a controller
// after a button press, without a fresh "connected" event for one it already knew, so the screen also polls.
{
  const blocked = () => document.body.dataset.screen === 'error' && /controller/.test(document.getElementById('error-message')?.textContent ?? '');
  const lift = () => {
    if (!blocked()) return;
    try { sessionStorage.setItem('bo1z-controller', '1'); } catch { /* storage off: ?mobile=1 still works */ }
    location.reload();
  };
  addEventListener('gamepadconnected', lift);
  const timer = setInterval(() => {
    if (document.body.dataset.screen && !blocked() && document.body.dataset.screen !== 'error') { clearInterval(timer); return; }
    if ([...(navigator.getGamepads?.() ?? [])].some(p => p && p.connected)) lift();
  }, 250);
}

// Co-op game-script fixes (mp/mods, served as coop-mod/): written into this map's storage, where the engine reads mods
// from, and stacked with fs_mods (globalThis.__kbMods, the engine.js patch in serve.py). Co-op pages only: solo games
// stay retail. kbcoop: a player joining a game in progress spectates, then respawns at the end of the round (instead of
// being stuck at the map's origin). The mod-stack hooks (mods/_stack) are the pack's own files; a pack that ships them
// (Hell mode) keeps its copy.
const COOP_MOD = [['kbcoop/maps/kbcoop/_hooks.gsc', true], ['kbcoop/maps/kbcoop/_kbcoop.gsc', true],
  ['_stack/maps/_modstack.gsc', false], ['_stack/maps/_zombiemode_ffotd.gsc', false]];
async function installCoopMod() {
  try {
    const m = await maps;
    const files = await (await (await navigator.storage.getDirectory()).getDirectoryHandle(m.map.opfs, { create: true }))
      .getDirectoryHandle('files', { create: true });
    const writes = [];
    for (const [rel, replace] of COOP_MOD) {
      const parts = ['mods', ...rel.split('/')], name = parts.pop();
      let dir = files;
      for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
      if (!replace && await dir.getFileHandle(name).then(() => true, () => false)) continue;
      const res = await fetch(new URL('coop-mod/' + rel, document.baseURI));
      if (!res.ok) throw new Error(`coop-mod/${rel}: HTTP ${res.status}`);
      writes.push([dir, name, await res.arrayBuffer()]);
    }
    for (const [dir, name, bytes] of writes) await writeFile(dir, name, bytes);
    globalThis.__kbMods = ['kbcoop'];
  } catch (e) { console.warn('co-op mod not installed:', e); }
}
// Safari has no createWritable on the page: a worker writes with a sync access handle instead
async function writeFile(dir, name, bytes) {
  const handle = await dir.getFileHandle(name, { create: true });
  if (handle.createWritable) { const w = await handle.createWritable(); await w.write(bytes); await w.close(); return; }
  const src = `onmessage = async e => { try { const h = await e.data.handle.createSyncAccessHandle(); h.truncate(0); h.write(new Uint8Array(e.data.bytes), { at: 0 }); h.flush(); h.close(); postMessage(null); } catch (err) { postMessage(String(err)); } };`;
  const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  try {
    const err = await new Promise(resolve => { worker.onmessage = e => resolve(e.data); worker.onerror = e => resolve(e.message || 'worker failed'); worker.postMessage({ handle, bytes }); });
    if (err) throw new Error(err);
  } finally { worker.terminate(); }
}
if (room) installCoopMod();

if (!room) {
  // "Play with friends" next to "Play solo" on the map page
  const friends = el('button', { id: 'coop-friends', className: 'option', type: 'button', textContent: 'Play with friends' });
  // online: create a lobby or join one by its code; offline: straight to a same-Wi-Fi lobby
  friends.onclick = () => { if (offline) location.assign(pageUrl(newRoom())); else friendsPanel().show(); };
  document.querySelector('#overlay .actions')?.append(friends);
  const sync = () => { friends.textContent = offline ? 'Play with friends (same Wi-Fi)' : 'Play with friends'; };
  offlineListeners.add(sync); sync();
} else lobbyUi();
// "Options" (the panel above) and "Map select" (back to the list of maps) beside the Play buttons; Map select only on
// the start screen and outside a lobby (the lobby has "Leave lobby")
{
  const actions = document.querySelector('#overlay .actions');
  const optionsBtn = el('button', { id: 'kb-options', className: 'option', type: 'button', textContent: 'Options' });
  optionsBtn.onclick = () => { if (settings) settings.open = true; };
  const mapsBtn = el('button', { id: 'kb-maps', className: 'option', type: 'button', textContent: 'Map select', hidden: !!room });
  mapsBtn.onclick = () => location.assign(new URL('./', document.baseURI).href);
  if (settings) actions?.append(optionsBtn);
  actions?.append(mapsBtn);
}

// Joining by code (an installed web app has no address bar to paste an invite link into): "Play with friends" offers to
// create a lobby or join one with its code. The lobby shows the code as <map>-<room> (kino-ab3k9xq2); an invite link
// pasted in works too. A code for another map opens that map's page.
async function lobbyCode(roomId) { return `${(await maps).map.slug}-${roomId}`; }
async function joinCode(text) {
  const m = await maps;
  let slug = null, roomId = null;
  try {
    const url = new URL(text.trim());
    roomId = url.searchParams.get('lobby') ?? url.searchParams.get('join');
    slug = /\/([a-z]+)(?:\.html)?$/.exec(url.pathname)?.[1] ?? null;
  } catch {
    const code = /^(?:([a-z]+)-)?([a-z2-9]{8})$/.exec(text.trim().toLowerCase().replace(/\s+/g, ''));
    if (code) [, slug, roomId] = code;
  }
  if (!roomId || !/^[\w-]{1,32}$/.test(roomId)) throw new Error('That isn’t a lobby code: it looks like kino-ab3k9xq2.');
  if (slug && slug !== m.map.slug && m.MAP_LIST.some(x => x.slug === slug))
    return location.assign(new URL(`${slug}.html?lobby=${roomId}`, document.baseURI).href);
  location.assign(pageUrl(roomId));
}
let friendsBox = null;
function friendsPanel() {
  if (friendsBox) return friendsBox;
  const close = el('button', { type: 'button', textContent: 'Close' });
  const create = el('button', { type: 'button', className: 'kb-go', textContent: 'Create a lobby' });
  create.onclick = () => location.assign(pageUrl(newRoom()));
  const code = el('input', { placeholder: 'lobby code, e.g. kino-ab3k9xq2', spellcheck: false, autocapitalize: 'off', autocomplete: 'off' });
  const join = el('button', { type: 'button', textContent: 'Join' });
  const err = el('div', { className: 'kb-err' });
  const go = () => joinCode(code.value).catch(e => { err.textContent = e.message; });
  join.onclick = go;
  code.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') go(); });
  const card = el('div', { className: 'kb-card' },
    el('div', { className: 'kb-opt-head' }, el('span', {}, 'Play with friends'), close),
    el('p', {}, 'Start a new lobby and invite your friends:'), create,
    el('p', {}, 'Or join a friend’s lobby with its code (or invite link):'),
    el('div', { className: 'kb-join' }, code, join), err);
  const shade = el('div', { id: 'kb-friends', hidden: true }, card);
  shade.addEventListener('click', e => { if (e.target === shade) friendsBox.hide(); });
  document.body.append(shade);
  friendsBox = {
    card, get open() { return !shade.hidden; },
    show() { err.textContent = ''; shade.hidden = false; },
    hide() { shade.hidden = true; document.getElementById('coop-friends')?.focus({ preventScroll: true }); },
  };
  close.onclick = () => friendsBox.hide();
  document.addEventListener('keydown', e => { if (friendsBox.open && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); friendsBox.hide(); } }, true);
  return friendsBox;
}
style.textContent += `
  #kb-friends { position: fixed; inset: 0; z-index: 45; display: grid; place-items: center; background: rgba(0,0,0,.55); }
  #kb-friends[hidden] { display: none; }
  #kb-friends .kb-card { width: min(27em, calc(100vw - 32px)); box-sizing: border-box; padding: 16px 20px; background: rgba(10,10,10,.95);
    border: 1px solid #444; color: #f2f2f2; font-size: .85rem; letter-spacing: .06em; display: grid; gap: 10px; }
  #kb-friends .kb-opt-head { display: flex; justify-content: space-between; align-items: center; font-size: 1.1rem; letter-spacing: .14em; text-transform: uppercase; }
  #kb-friends p { margin: 6px 0 0; color: #bbb; }
  #kb-friends button { font: inherit; font-size: .8rem; letter-spacing: .12em; text-transform: uppercase; color: #eee; background: none;
    border: 1px solid #666; padding: 6px 14px; cursor: pointer; }
  #kb-friends button.kb-go { border-color: #ff3b2b; padding: 8px 14px; }
  #kb-friends .kb-join { display: flex; gap: 8px; }
  #kb-friends input { flex: 1; min-width: 0; font: inherit; background: #151515; color: #eee; border: 1px solid #555; padding: 6px 8px; letter-spacing: .04em; }
  #kb-friends .kb-err { color: #f0c060; }
  #kb-friends .kb-err:empty { display: none; }
  #kb-friends .kb-pad-focus { outline: 2px solid #ff3b2b; outline-offset: 3px; }`;

async function lobbyUi() {
  // offline: players on the same Wi-Fi swap codes instead (net.js); decided once, when the lobby opens
  await firstProbe;
  const net = startLobby({ manual: offline });
  const link = pageUrl(net.room);
  // the address bar shows the invite link (old ?host=/?join= links become ?lobby=)
  if (location.href !== link) history.replaceState(null, '', link);

  const linkBox = el('input', { className: 'link', readOnly: true, value: link });
  linkBox.onfocus = () => linkBox.select();
  const copy = el('button', { type: 'button', textContent: 'Copy invite link' });
  copy.onclick = () => {
    linkBox.select();
    (navigator.clipboard?.writeText(link) ?? Promise.reject()).catch(() => document.execCommand('copy'));
    copy.textContent = 'Copied!'; setTimeout(() => { copy.textContent = 'Copy invite link'; }, 2000);
  };
  const nameBox = el('input', { value: net.me.name, maxLength: 15, size: 14, placeholder: 'your name' });
  nameBox.onchange = () => { net.setName(nameBox.value); nameBox.value = net.me.name; };
  // typing a name must not reach the game's "press any key" prompt
  for (const t of ['keydown', 'keyup', 'keypress']) nameBox.addEventListener(t, e => { e.stopPropagation(); if (t === 'keydown' && e.key === 'Enter') nameBox.blur(); });
  // back to this map's start screen (Play solo / Play with friends)
  const leave = el('button', { type: 'button', textContent: 'Leave lobby' });
  leave.onclick = () => location.assign(pageUrl(null));
  const list = el('ul');
  const step = el('div', { className: 'step' });
  const startBtn = el('button', { type: 'button', className: 'go' });
  startBtn.onclick = () => { net.start(); render(); };
  const waitBtn = el('button', { type: 'button', textContent: 'Start without them' });
  waitBtn.onclick = () => net.startNow();
  const backBtn = el('button', { type: 'button', className: 'go', textContent: 'Back to the lobby' });
  backBtn.onclick = () => location.reload();
  const soloBtn = el('button', { type: 'button', className: 'go', textContent: 'Play solo instead' });
  soloBtn.onclick = () => location.assign(pageUrl(null));
  const status = el('div', { className: 'dim' });
  const code = await lobbyCode(net.room);
  const copyCode = el('button', { type: 'button', textContent: 'Copy code' });
  copyCode.onclick = () => {
    (navigator.clipboard?.writeText(code) ?? Promise.reject()).catch(() => {});
    copyCode.textContent = 'Copied!'; setTimeout(() => { copyCode.textContent = 'Copy code'; }, 2000);
  };
  // the code, for friends who join from "Play with friends" (an installed app has no address bar)
  const codeRow = el('div', { className: 'row' }, el('span', { className: 'dim' }, 'Lobby code'), el('strong', { className: 'code' }, code), copyCode);
  const inviteRow = el('div', { className: 'row' }, linkBox, copy);
  const bar = el('div', { id: 'coop' },
    el('h2', {}, el('span', {}, `Co-op lobby · ${mapName}`)),
    inviteRow, codeRow,
    el('div', { className: 'row' }, el('span', { className: 'dim' }, 'Your name'), nameBox),
    list, step,
    el('div', { className: 'row' }, startBtn, waitBtn, backBtn, soloBtn, leave),
    status);
  document.body.append(bar);
  // typing in the lobby's boxes must not reach the game's "press any key" prompt
  for (const t of ['keydown', 'keyup', 'keypress']) bar.addEventListener(t, e => { if (e.target.tagName === 'INPUT') e.stopPropagation(); });
  const lan = net.manual ? lanPanel(net) : null;
  if (lan) { bar.insertBefore(lan.box, list); bar.classList.add('wide'); }

  const SCREEN = { landing: ['in the lobby', ''], download: ['downloading…', ''], loading: ['loading…', ''], ready: ['ready', 'ok'],
    playing: ['in game', 'ok'], error: ['game stopped', ''] };
  const play = document.getElementById('play');
  let held = null;  // the Play button's label while the lobby holds "Click to start"
  let lastHostName = 'The host';  // remembered for "… left the game"
  function render() {
    const started = net.started, host = net.hostId(), iAmHost = host === net.me.id, screen = document.body.dataset.screen;
    const people = net.inRoom(), max = net.MAX_PLAYERS;
    const myIndex = people.findIndex(p => p.id === net.me.id);
    const full = myIndex >= max && !started?.players.includes(net.me.id);
    const hostName = people.find(p => p.id === host)?.name ?? 'the host';
    if (hostName !== 'the host') lastHostName = hostName;
    const able = people.filter(p => p.screen !== 'error').slice(0, max);  // a page whose game stopped is left out of the start
    const notReady = able.filter(p => p.id !== net.me.id && p.screen !== 'ready').map(p => p.name);
    const meReady = screen === 'ready';
    const connecting = [...net.members.values()].filter(m => m.lobby?.readyState !== 'open').length;

    list.replaceChildren(...people.map((p, i) => {
      const [label, cls] = i >= max && !started?.players.includes(p.id) ? ['lobby full', ''] : SCREEN[p.screen] ?? [p.screen ?? '', ''];
      // the host can remove a player before the start (someone who never gets ready would hold the start forever)
      const remove = iAmHost && !started && p.id !== net.me.id ? el('button', { type: 'button', className: 'rm', textContent: 'Remove', title: `Remove ${p.name} from the lobby` }) : '';
      if (remove) remove.onclick = () => net.kick(p.id);
      // and hand hosting to them (online lobbies: offline, the others are only connected to the current host)
      const promote = remove && !net.manual ? el('button', { type: 'button', className: 'rm', textContent: 'Make host', title: `${p.name} hosts the game instead of you` }) : '';
      if (promote) promote.onclick = () => net.makeHost(p.id);
      return el('li', {},
        el('span', {}, `${p.id === host ? '★ ' : ''}${p.name}${p.id === net.me.id ? ' (you)' : ''}${p.id === host ? ' · host' : ''}`),
        el('span', { className: 'right' }, el('span', { className: `st ${cls}` }, label), promote, remove));
    }));
    if (!people.length) list.replaceChildren(el('li', {}, el('span', { className: 'st' }, 'Joining the lobby…')));
    lan?.render(full);

    if (!nameBox.value && document.activeElement !== nameBox) nameBox.value = net.me.name;
    // what to do next, for this player ("press Play" names the page's own button)
    const playLabel = `click “${(held ?? play?.textContent ?? 'Play').trim().toLowerCase().replace(/^./, c => c.toUpperCase())}” below`;
    let text = '', big = false;
    if (net.removed) { text = 'The host removed you from this lobby.'; big = true; }
    else if (net.hostLeft || (started && net.isHost() && screen === 'error')) {
      const why = net.isHost() ? 'Your game stopped' : net.hostLeft === 'stopped' ? `${lastHostName}'s game stopped` : `${lastHostName} left the game`;
      text = `${why}, so this game is over. ${screen === 'playing' ? 'Press Esc, then go' : 'Go'} back to the lobby to play again.`; big = true;
    }
    else if (screen === 'error') { text = 'Your game stopped. Go back to the lobby to rejoin.'; big = true; }
    else if (offline && !started && !net.manual) { text = 'You’re offline: co-op needs an internet connection. The lobby reconnects by itself when you’re back online, or play solo now.'; big = true; }
    else if (full) text = `This lobby is full (${max} players).`;
    else if (net.manual && !started && people.length < 2 && lan.role !== 'joiner')
      text = 'Offline co-op, for players on the same Wi-Fi: one of you invites, the others scan the invite and show back their reply.';
    else if (!started) {
      if (screen === 'landing') { text = iAmHost && people.length < 2 ? `Send the invite link to your friends, then ${playLabel}: the map downloads while you wait.` : `${playLabel.replace(/^c/, 'C')}: the map downloads while you wait.`; big = !iAmHost || people.length >= 2; }
      else if (screen === 'download' || screen === 'loading') text = 'Downloading and loading the map… you can keep this tab in the background.';
      else if (iAmHost) text = people.length < 2 ? 'Waiting for friends to open the invite link. You can also start alone.' : notReady.length ? `Waiting for ${names(notReady)} to get ready. The game starts once everyone is ready; remove a player who isn’t coming.` : 'Everyone is ready!';
      else text = `Waiting for ${hostName} to start the game.`;
    } else if (!net.isHost() && screen === 'landing') { text = `The game has started: ${playLabel} to join!`; big = true; }
    else if (screen === 'ready') { text = 'Starting…'; big = true; }
    else if (screen === 'download' || screen === 'loading') text = 'The game has started: it will join as soon as the map has loaded.';
    else if (!started.players.includes(net.me.id)) text = 'You joined a game in progress: you spawn at the next round.';
    step.textContent = text; step.className = big ? 'step big' : 'step'; step.hidden = !text;

    inviteRow.hidden = codeRow.hidden = full || net.hostLeft || offline || net.manual || net.removed;
    soloBtn.hidden = !(net.removed || (offline && !started && !net.manual));
    startBtn.hidden = !iAmHost || !!started || full || (offline && !net.manual) || net.removed;
    // Start only once everyone (the host too) is ready
    startBtn.disabled = !net.canStart();
    startBtn.textContent = !meReady ? 'Start (get ready first)' : notReady.length ? `Start (waiting for ${plural(notReady.length, 'player')})`
      : able.length < 2 ? 'Start alone' : `Start (${plural(able.length, 'player')})`;
    leave.hidden = !!net.removed;
    const waiting = started && net.isHost() && !net.waitedEnough && !net.hostLeft ? started.players.length - net.expected() : 0;
    const missing = started && net.isHost() ? started.players.filter(p => p !== net.me.id && !net.members.get(p)?.lobby) : [];
    waitBtn.hidden = !(started && net.isHost() && missing.length && !net.waitedEnough);
    backBtn.hidden = !net.hostLeft && screen !== 'error';
    status.className = net.signalError ? 'warn' : 'dim';
    status.textContent = net.manual && connecting ? (lan.role === 'joiner' ? 'Waiting for the host to use your reply…' : 'Waiting for their reply…')
      : net.signalError === 'not-configured' ? 'This site has no lobby service set up (net-config.json), so online lobbies can\'t connect.'
      : net.signalError ? `Can't reach the lobby service right now (${net.signalError}); retrying…`
      : connecting ? `Connecting to ${plural(connecting, 'player')}…`
      : started && net.isHost() && missing.length ? `${plural(missing.length, 'player')} left before joining.` : '';
    status.hidden = !status.textContent;
    void waiting;
    // out of the way during play, once this player is in the game
    bar.classList.toggle('quiet', !!started && !net.hostLeft && (net.isHost() || net.stats.recv > 0));

    // hold "Click to start" until the host starts, so nobody begins a solo game
    if (screen === 'ready' && (!started || full) && play && !play.hidden) {
      if (held == null) held = play.textContent;
      play.disabled = true; play.textContent = full ? 'Lobby full' : net.hostId() === net.me.id ? 'Press Start above' : 'Waiting for the host';
    } else if (held != null) {
      if (screen === 'ready') { play.disabled = false; play.textContent = held; }
      held = null;
    }
  }
  net.onChange(render);
  offlineListeners.add(render);
  // re-check right when the page reaches "Click to start", before anyone can press it
  new MutationObserver(render).observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });
  setInterval(render, 500);
  render();
}

// ---- offline co-op: invite and reply codes (net.js manual mode), shown as QR codes and text
const loadScript = src => new Promise((resolve, reject) => {
  const tag = el('script', { src: new URL(src, document.baseURI).href });
  tag.onload = resolve; tag.onerror = () => reject(new Error(`Couldn't load ${src}: turn on Offline play while online first`));
  document.head.append(tag);
});
async function drawQr(canvas, text) {
  if (!globalThis.qrcode) await loadScript('vendor/qrcode.js');
  const q = globalThis.qrcode(0, 'L'); q.addData(text, 'Byte'); q.make();
  const n = q.getModuleCount(), quiet = 4, scale = Math.max(2, Math.floor(280 / (n + 2 * quiet)));
  canvas.width = canvas.height = (n + 2 * quiet) * scale;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height); g.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) g.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
}
// Camera scan of a code: the browser's BarcodeDetector where it has one, else jsQR on video frames.
async function scanQr() {
  const video = el('video', { muted: true, playsInline: true });
  const cancel = el('button', { type: 'button', textContent: 'Cancel' });
  const shade = el('div', { id: 'coop-scan' }, el('div', { className: 'dim' }, 'Point the camera at the other screen’s code'), video, cancel);
  document.body.append(shade);
  let stream = null, stop = false;
  cancel.onclick = () => { stop = true; };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = stream; await video.play();
    let detector = null;
    try { if ((await globalThis.BarcodeDetector?.getSupportedFormats())?.includes('qr_code')) detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch { /* none */ }
    if (!detector && !globalThis.jsQR) await loadScript('vendor/jsQR.js');
    const canvas = document.createElement('canvas'), g = canvas.getContext('2d', { willReadFrequently: true });
    while (!stop) {
      await new Promise(r => setTimeout(r, 150));
      if (!video.videoWidth) continue;
      let text = null;
      if (detector) text = (await detector.detect(video).catch(() => []))[0]?.rawValue;
      else {
        const k = Math.min(1, 900 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * k); canvas.height = Math.round(video.videoHeight * k);
        g.drawImage(video, 0, 0, canvas.width, canvas.height);
        text = globalThis.jsQR(g.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })?.data;
      }
      if (text && /BO1Z/.test(text)) return text;
    }
    return null;
  } finally {
    stream?.getTracks().forEach(t => t.stop());
    shade.remove();
  }
}
function lanPanel(net) {
  const extra = document.createElement('style');
  extra.textContent = `
    #coop .lan { display: grid; gap: 8px; }
    #coop.wide { width: min(38em, calc(100vw - 32px)); max-height: calc(100dvh - 24px); overflow-y: auto; }
    #coop .lan .pair { display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: start; }
    #coop .lan .pair > div { display: grid; gap: 8px; min-width: 0; }
    #coop .lan canvas { width: min(200px, 34vw); image-rendering: pixelated; border-radius: 4px; }
    #coop .lan .err { color: #f0c060; }
    #coop-scan { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.92); display: grid; place-content: center; justify-items: center; gap: 12px; padding: 16px; }
    #coop-scan video { width: min(640px, 92vw); max-height: 70vh; border-radius: 8px; }
    #coop-scan button { font: 15px system-ui, sans-serif; padding: 6px 18px; }
    #coop-scan .dim { color: #ccc; font: 15px system-ui, sans-serif; }`;
  document.head.append(extra);
  const err = el('div', { className: 'err' });
  const fail = e => { err.textContent = e.page ? `${e.message}: open that map, then use the invite there.` : (e.message || String(e)); };
  const codeBlock = () => {
    const canvas = el('canvas'), box = el('input', { className: 'link', readOnly: true });
    box.onfocus = () => box.select();
    const copy = el('button', { type: 'button', textContent: 'Copy code' });
    copy.onclick = () => { box.select(); (navigator.clipboard?.writeText(box.value) ?? Promise.reject()).catch(() => document.execCommand('copy')); copy.textContent = 'Copied!'; setTimeout(() => { copy.textContent = 'Copy code'; }, 2000); };
    // the QR code on the left, the steps on the right
    const pair = (...steps) => el('div', { className: 'pair' }, canvas, el('div', {}, ...steps));
    return { row: el('div', { className: 'row' }, box, copy), pair, async show(code) { box.value = code; await drawQr(canvas, code).catch(fail); } };
  };
  const input = (placeholder, go, label) => {
    const box = el('input', { className: 'link', placeholder });
    const use = el('button', { type: 'button', textContent: label });
    const run = async text => { err.textContent = ''; use.disabled = true; try { await go(text.trim()); box.value = ''; } catch (e) { fail(e); } finally { use.disabled = false; } };
    use.onclick = () => run(box.value);
    box.addEventListener('keydown', e => { if (e.key === 'Enter') run(box.value); });
    const scan = el('button', { type: 'button', textContent: 'Scan' });
    scan.hidden = !navigator.mediaDevices?.getUserMedia;
    scan.onclick = async () => { err.textContent = ''; try { const t = await scanQr(); if (t) await run(t); } catch (e) { fail(e); } };
    return el('div', { className: 'row' }, box, scan, use);
  };
  const state = { role: null };
  // the host: one open invite at a time
  const inviteCode = codeBlock();
  const inviteBtn = el('button', { type: 'button', className: 'go', textContent: 'Invite a player' });
  const inviteStep = el('div', { className: 'lan', hidden: true }, inviteCode.pair(
    el('div', { className: 'dim' }, '1. The other player opens this map, chooses “Play with friends (same Wi-Fi)”, and scans this invite (or pastes the code).'),
    inviteCode.row,
    el('div', { className: 'dim' }, '2. Then scan or paste their reply:'),
    input('reply code', async code => { await net.useCode(code); inviteStep.hidden = true; }, 'Connect')));
  inviteBtn.onclick = async () => {
    err.textContent = ''; inviteBtn.disabled = true;
    try { state.role = 'host'; const code = await net.invite(); inviteStep.hidden = false; await inviteCode.show(code); }
    catch (e) { fail(e); } finally { inviteBtn.disabled = false; }
  };
  const hostPart = el('div', { className: 'lan' }, inviteBtn, inviteStep);
  // an invited player: use the invite, show the reply
  const replyCode = codeBlock();
  const replyStep = el('div', { className: 'lan', hidden: true }, replyCode.pair(
    el('div', { className: 'dim' }, 'Show this reply to the host: they scan it, or paste the code.'), replyCode.row));
  const joinPart = el('div', { className: 'lan' },
    el('div', { className: 'dim' }, 'Invited? Scan or paste the invite:'),
    input('invite code', async code => { const reply = await net.useCode(code); state.role = 'joiner'; replyStep.hidden = false; await replyCode.show(reply); }, 'Join'),
    replyStep);
  const box = el('div', { className: 'lan' }, hostPart, joinPart, err);
  return {
    box,
    get role() { return state.role; },
    render(full) {
      const connected = [...net.members.values()].some(m => m.lobby?.readyState === 'open');
      hostPart.hidden = state.role === 'joiner' || full || !!net.hostLeft || (connected && net.hostId() !== net.me.id);
      inviteBtn.textContent = net.openInvite ? 'New invite' : connected ? 'Invite another player' : 'Invite a player';
      if (!net.openInvite) inviteStep.hidden = true;
      // once someone is connected, this page's role is settled
      joinPart.hidden = state.role === 'host' || (connected && state.role !== 'joiner') || (state.role === 'joiner' && connected);
    },
  };
}
