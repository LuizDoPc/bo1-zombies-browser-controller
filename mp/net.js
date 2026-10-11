// net.js: page-side half of co-op (engine side: mp/kbnet-runtime.js, wasm hooks: mp/patch-wasm.mjs; UI: mp/coop.js).
//
// Lobby: everyone opens the same <map>.html?lobby=<room>. Each page connects to every other page in the room over
// WebRTC (two data channels per pair: "lobby", ordered and reliable, for lobby state; "game", unordered without
// retransmits, for engine packets: the netcode is built for UDP). The player who joined the room first hosts; if
// they leave before the start, the next one takes over. The host presses Start: from then on the host is fixed, its
// game holds round 1 until everyone in the start list is in (getnumexpectedplayers), and the others connect to it as
// soon as their own copy of the map has loaded. Someone who arrives after the start joins that game (spectating until
// the next round, as the zombies scripts do).
//
// Engine addresses: the host is 10.66.0.1 to the joiners ("connect host"); the host numbers the joiners itself,
// 10.66.0.2 and up (player ids are large random numbers, only the host's engine needs the short form).
//
// Signaling only sets up the connections (one offer and one answer per pair). It speaks the Metered realtime-messaging
// WebSocket protocol (welcome / subscribe / presence / publish): Metered's service, or mp/signal-server.mjs, a
// self-hosted stand-in for the same subset; the site's net-config.json says which (?signal=wss://your.host/path
// overrides it). ?signal=ntfy uses an ntfy pub/sub server instead (net-config.json "ntfy", or ?ntfy=<url>, e.g.
// serve.py's http://localhost:8000/bo1z/signal).
//
// Offline (coop.js: no network, the page came from the offline copy, mp/sw.js), or ?signal=manual: no signaling
// service at all, for players on the same Wi-Fi. The two players swap the offer and the answer themselves, as codes
// (QR or text, coop.js): the host makes an invite, the other player uses it and shows back a reply, the host uses the
// reply. No STUN or TURN either: only the devices' own (LAN) addresses go in the codes. Joiners connect to the host
// only, so each one's player list shows the host and themselves.
const MAX_PLAYERS = 4;  // zombies takes 4 players
const CTRL = 768, MAGIC = 0x4B424E54, SLOT = 2048, SLOTS = 512, PORT = 28960;
// The site's services are deploy settings, in net-config.json next to the pages (mp/net-config.example.json;
// mp/build.mjs copies mp/net-config.json into the build when there is one). Without it online lobbies have no
// signaling service and say so; same-Wi-Fi lobbies (no services at all) still work.
//   signal     signaling WebSocket URL: Metered realtime messaging (wss://rms.metered.ca/v1) or a signal-server.mjs
//   signalKey  publishable Metered realtime-messaging key (https://www.metered.ca), public by design; it needs the
//              Subscribe, Publish and Presence permissions. signal-server.mjs ignores it.
//   turnApi    TURN credentials endpoint returning an iceServers list (Metered), fetched when the page starts
//   turn       a fixed TURN server, { "urls": "turn:host:3478", "username": "u", "credential": "p" }
//   ntfy       ntfy server for ?signal=ntfy (default https://ntfy.sh)
// STUN finds each browser's public address; when NATs block a direct path (mobile carriers, strict routers) a TURN
// relay is needed. The TURN credentials key is public too (it only hands out relay credentials); the cost is relay
// bandwidth on that account. ?turnapi=<url> replaces turnApi, ?turnapi=0 turns it off; ?turn=turn:host:3478&turnuser=
// &turnpass= add a fixed relay. ?relay=1 forces every connection through the relay (to test it).
const log = (...a) => console.log('KBNET', ...a);
const query = new URLSearchParams(location.search);
const CONFIG = fetch(new URL('net-config.json', import.meta.url), { cache: 'no-cache' })
  .then(r => r.ok ? r.json() : {}).catch(() => ({})).then(c => (c && typeof c === 'object' ? c : {}));

async function iceServers() {
  const list = [{ urls: 'stun:stun.l.google.com:19302' }], config = await CONFIG;
  if (config.turn) list.push(config.turn);
  if (query.get('turn')) list.push({ urls: query.get('turn').split(','), username: query.get('turnuser') ?? '', credential: query.get('turnpass') ?? '' });
  const api = query.get('turnapi') ?? config.turnApi;
  if (api && api !== '0') {
    try {
      const r = await fetch(api, { cache: 'no-store' });
      if (r.ok) { const got = await r.json(); if (Array.isArray(got)) list.push(...got); }
      else log('TURN credentials: HTTP ' + r.status);
    } catch (e) { log('TURN credentials failed: ' + e.message); }
  }
  log(`ice servers: ${list.map(s => [].concat(s.urls)[0]).join(' ')}`);
  return list;
}

// Browsers slow down with five or more ICE servers (Firefox warns), and Metered's list arrives twice (credentials API
// and the signaling welcome): keep one STUN server and one TURN server per transport (UDP, TCP, TLS).
function pickIce(list) {
  const flat = list.flatMap(s => [].concat(s.urls).map(url => ({ urls: url, username: s.username, credential: s.credential })));
  const first = test => flat.find(s => test(s.urls));
  return [first(u => /^stun:/.test(u)), first(u => /^turn:/.test(u) && !/transport=tcp/.test(u)),
    first(u => /^turn:/.test(u) && /transport=tcp/.test(u)), first(u => /^turns:/.test(u))]
    .filter(Boolean).map(s => s.username == null ? { urls: s.urls } : s);
}

// Player names go into the engine's "name" cvar: keep them short and plain.
export const cleanName = s => String(s ?? '').replace(/[^\w .\-]/g, '').trim().slice(0, 15);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const older = (a, b) => a.joinedAt !== b.joinedAt ? a.joinedAt < b.joinedAt : a.id < b.id;
const shortName = pid => `Player ${String(pid).replace(/\W/g, '').slice(-3)}`;
const randomId = () => 'm' + Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(36).padStart(2, '0')).join('');

// Offline co-op codes: "BO1Z" + base64url(deflate(JSON)), short enough for a QR code (about 500-700 characters).
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const zip = (bytes, how) => new Response(new Blob([bytes]).stream().pipeThrough(how)).arrayBuffer().then(b => new Uint8Array(b));
async function pack(obj) {
  return 'BO1Z' + b64url(await zip(new TextEncoder().encode(JSON.stringify(obj)), new CompressionStream('deflate-raw')));
}
async function unpack(code) {
  const m = /BO1Z([A-Za-z0-9_-]+)/.exec(String(code).replace(/\s+/g, ''));
  if (!m) throw new Error('That isn’t a co-op code');
  try {
    const raw = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = await zip(Uint8Array.from(raw, c => c.charCodeAt(0)), new DecompressionStream('deflate-raw'));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { throw new Error('That code is incomplete: copy or scan all of it'); }
}

let lobby = null;
// Starts the lobby for ?lobby=<room> (also ?host=/?join=, the old co-op links). Called at page load (coop.js).
export function startLobby({ manual = false } = {}) {
  manual ||= query.get('signal') === 'manual';
  if (lobby) return lobby;
  const room = (query.get('lobby') ?? query.get('host') ?? query.get('join') ?? '').replace(/[^\w-]/g, '').slice(0, 32);
  if (!room) return null;
  let savedName = ''; try { savedName = localStorage.getItem('bo1z-name') ?? ''; } catch { /* storage off */ }
  // A player's id is its signaling address (a string): ntfy uses a random number, Metered assigns one on connect.
  const me = { id: null, name: cleanName(savedName), joinedAt: null, screen: document.body.dataset.screen ?? 'landing' };
  const members = new Map();   // id -> { id, name, joinedAt, screen, pc, lobby, game, attempt, answer, failures, offerer }
  const listeners = new Set();
  const changed = () => { for (const f of listeners) try { f(); } catch (e) { console.error(e); } };
  let ICE = [], started = null, signalError = null;
  const extraIce = [];  // TURN servers the signaling service hands out (Metered)
  const iceReady = manual ? Promise.resolve() : iceServers().then(list => { ICE = list; });
  const stats = { sent: 0, recv: 0, dropped: 0 };

  // ---- lobby state over the "lobby" channels
  const open = m => m?.lobby?.readyState === 'open';
  // players the host removed from the lobby (before the start): left out of the room and the start everywhere
  const kicked = new Set();
  let removed = false;  // this page was removed: it leaves the room and stays out
  // before the start, the host can hand hosting to another player (makeHost); everyone follows it while that player is
  // in the room, and falls back to the oldest player otherwise. Pages learn it from the host's state messages.
  let designated = null;
  const others = () => [...members.values()].filter(m => open(m) && m.joinedAt != null && !kicked.has(m.id));
  // once the game is over (the host left, or its game stopped), stop advertising it: a newcomer would join a game
  // that isn't there and wait for "the next round" forever. A page whose own game stopped doesn't advertise it either.
  const myState = () => ({ t: 'state', name: me.name, joinedAt: me.joinedAt, screen: me.screen, started: hostLeft || me.screen === 'error' ? null : started, host: designated });
  let hostLeft = false;  // 'left' or 'stopped' once the host's game is gone
  const tell = (m, msg) => { if (open(m)) m.lobby.send(JSON.stringify(msg)); };
  const broadcast = msg => { for (const m of members.values()) tell(m, msg); };
  // everyone in the room (us included), in the order they joined
  const inRoom = () => [me, ...others()].filter(p => p.joinedAt != null).sort((a, b) => older(a, b) ? -1 : 1);
  // a page whose game stopped (error screen) can't host
  function hostId() {
    if (started) return started.host;
    if (designated === me.id && me.joinedAt != null && me.screen !== 'error') return me.id;
    const d = designated && others().find(m => m.id === designated);
    if (d && d.screen !== 'error') return d.id;
    let best = me.joinedAt != null && me.screen !== 'error' ? me : null;
    for (const m of others()) if (m.screen !== 'error' && (!best || older(m, best))) best = m;
    return best?.id ?? null;
  }
  function onLobbyMessage(m, msg) {
    m.heard = performance.now();
    if (msg.t === 'ping') return;
    if (msg.t === 'bye') return gone(m);
    if (msg.t === 'ended') { if (started?.host === m.id && !hostLeft) { hostLeft = 'stopped'; changed(); } return; }
    if (msg.t === 'kick') {
      if (started || m.id !== hostId()) return;  // only the host, and only before the start
      if (msg.id === me.id) leaveRoom(); else kicked.add(msg.id);
      changed(); return;
    }
    if (msg.t === 'state') {
      // the host's choice of host (before the start): taken from whoever hosts now
      if (!started && msg.host !== undefined && m.id === hostId()) designated = msg.host;
      Object.assign(m, { name: cleanName(msg.name) || shortName(m.id), joinedAt: msg.joinedAt, screen: msg.screen });
      const h = msg.started && members.get(msg.started.host);
      if (msg.started && !started && h && h.screen !== 'error') applyStart(msg.started);
    } else if (msg.t === 'start' && !started) applyStart(msg);
    changed();
  }
  function applyStart(s) {
    started = { host: s.host, players: s.players, at: s.at };
    log(`started: host ${started.host}, players ${started.players.join(' ')}`);
    engineStarted();
    changed();
  }
  // the host: start with everyone in the lobby, once all of them are ready (their map loaded, waiting at "Click to
  // start"); a player who isn't coming can be removed (kick) instead. Pages whose game stopped are left out.
  const startList = () => inRoom().filter(p => p.screen !== 'error').slice(0, MAX_PLAYERS);
  const canStart = () => !started && !removed && hostId() === me.id && startList().every(p => p.screen === 'ready');
  function start() {
    if (!canStart()) return false;
    const s = { t: 'start', host: me.id, players: startList().map(p => p.id), at: Date.now() };
    broadcast(s); applyStart(s);
    return true;
  }
  function makeHost(id) {
    if (started || removed || hostId() !== me.id || id === me.id || !others().some(m => m.id === id)) return;
    designated = id; broadcast(myState()); changed();
  }
  function kick(id) {
    if (started || hostId() !== me.id || id === me.id) return;
    kicked.add(id); broadcast({ t: 'kick', id }); changed();
  }
  // removed by the host: say bye and drop every connection; seen() and offers are ignored from now on
  function leaveRoom() {
    if (removed) return;
    removed = true; broadcast({ t: 'bye' });
    for (const m of members.values()) m.pc.close();
    members.clear();
  }
  function setName(name) {
    me.name = cleanName(name) || me.name || shortName(me.id);
    try { localStorage.setItem('bo1z-name', me.name); } catch { /* storage off */ }
    broadcast(myState()); engineName(); changed();
  }
  // follow the page's screen (landing / download / loading / ready / playing) for the player list
  setInterval(() => {
    const s = document.body.dataset.screen ?? 'landing';
    if (s !== me.screen) {
      me.screen = s;
      // the host's game stopped: the game is over for everyone
      if (s === 'error' && isHost()) broadcast({ t: 'ended' });
      broadcast(myState()); changed();
    }
  }, 500);

  // ---- signaling
  // Each backend calls joined(id, joinedAt) once it is in the room, seen(id, joinedAt) for another page in the room
  // (offer when it is newer than us), and onSignal(msg, from) for a message to us; send(to, msg) delivers one.
  function joined(myId, at) {
    me.id = myId; me.joinedAt = at; if (!me.name) me.name = shortName(myId);
    log(`in room ${room} as ${myId} since ${at}`); broadcast(myState()); engineName(); changed();
  }
  function seen(pid, at, ours) {
    if (removed || pid === me.id || members.has(pid)) return;
    if (ours === undefined ? older(me, { id: pid, joinedAt: at }) : ours) connect(pid);
  }
  function sendError(e) { if (signalError !== e) { signalError = e; changed(); } }
  const backend = (async () => {
    // (after a tick: joined() reaches the engine state declared further down)
    if (manual) { await null; log('signaling: by hand (offline)'); joined(randomId(), Date.now()); return { send() {} }; }
    const want = query.get('signal'), config = await CONFIG;
    if (want === 'ntfy') return ntfy((query.get('ntfy') || config.ntfy || 'https://ntfy.sh').replace(/\/+$/, ''));
    const url = /^wss?:\/\//.test(want ?? '') ? want : config.signal;
    if (!url) { log('signaling: none (no "signal" in net-config.json)'); sendError('not-configured'); return { send() {} }; }
    return metered(url, config.signalKey ?? '');
  })();
  const send = (to, msg) => backend.then(b => b.send(to, msg));

  // Metered realtime messaging (or signal-server.mjs) over its WebSocket protocol: everything goes on the room channel (a publishable key
  // without the Send permission can't address one peer), each message says who it is for. Presence lists the pages
  // in the room; of each pair, the one with the smaller id offers.
  function metered(url, key) {
    const channel = `bo1z-${room}`;
    let ws, backoff = 1000;
    function open() {
      ws = new WebSocket(key ? `${url}?key=${encodeURIComponent(key)}` : url);
      ws.onmessage = e => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'welcome') {
          backoff = 1000;
          // a reconnect gets a new id: pages connected over WebRTC stay connected, new ones see the new id
          if (me.id == null) joined(m.peerId, m.serverTime); else me.id = m.peerId;
          if (m.metadata?.iceServers?.length) extraIce.push(...m.metadata.iceServers);
          ws.send(JSON.stringify({ type: 'subscribe', channel, requestId: 'sub' }));
        } else if (m.type === 'presence' && m.channel === channel) {
          for (const p of m.joined ?? []) seen(p.peerId, null, me.id < p.peerId);
        } else if (m.type === 'message' && m.channel === channel && m.data?.to === me.id) {
          onSignal(m.data, m.from).catch(err => log('signal error', err));
        } else if (m.type === 'error') { log(`metered: ${m.code} ${m.message}`); sendError(m.code); }
        else if (m.type === 'ack' && m.ok) sendError(null);
      };
      ws.onclose = e => { log(`metered: closed ${e.code}`); setTimeout(open, backoff); backoff = Math.min(backoff * 2, 30000); };
    }
    open();
    log(`signaling: ${url}`);
    let n = 0;
    return { send(to, msg) {
      if (ws.readyState !== WebSocket.OPEN) return void setTimeout(() => this.send(to, msg), 1000);
      ws.send(JSON.stringify({ type: 'publish', channel, data: { ...msg, to }, requestId: `p${++n}` }));
    } };
  }

  // ntfy pub/sub: a room topic for hellos (the server's timestamp on our own hello orders the players) and a topic
  // per page for its offers and answers.
  function ntfy(base) {
    const myId = String(Number(query.get('peer')) || 1 + crypto.getRandomValues(new Uint32Array(1))[0] % 2147483647);
    const topicRoom = `bo1z-${room}`, topic = pid => `bo1z-${room}-${pid}`;
    async function post(t, msg) {
      for (let wait = 2000; ; wait = Math.min(wait * 2, 30000)) {
        const r = await fetch(`${base}/${t}`, { method: 'POST', body: JSON.stringify({ kb: { ...msg, from: myId } }) }).catch(e => (log('signal send failed', e.message), null));
        if (r?.ok) return sendError(null);
        // ntfy.sh limits messages per IP address (HTTP 429): say so, and retry more slowly
        if (r?.status === 429) { sendError('rate-limited'); log('signal send failed: rate limit (429)'); }
        if (!msg.retry) return;
        await sleep(wait);
      }
    }
    log(`signaling: ${base}`);
    const since = Math.floor(Date.now() / 1000) - 2, seenIds = new Set();
    const es = new EventSource(`${base}/${topicRoom},${topic(myId)}/sse?since=${since}`);
    let hello = false;
    es.onopen = () => { if (!hello) { hello = true; post(topicRoom, { type: 'hello', retry: true }); } };
    es.onmessage = e => {
      let n, msg;
      try { n = JSON.parse(e.data); msg = JSON.parse(n.message).kb; } catch { return; }
      if (!msg || seenIds.has(n.id)) return;  // an EventSource reconnect replays from "since"
      seenIds.add(n.id);
      const from = String(msg.from);
      if (msg.type === 'hello') {
        if (from === myId) { if (me.id == null) joined(myId, n.time); }
        // the one who was in the room first offers; a newer page waits for the older ones' offers
        else if (me.id != null) seen(from, n.time);
      } else onSignal(msg, from).catch(err => log('signal error', err));
    };
    return { send: (to, msg) => post(topic(to), msg) };
  }

  async function onSignal(msg, from) {
    await iceReady;
    if (removed) return;
    if (msg.type === 'offer') {
      let m = members.get(from);
      // a resent offer we already answered: the answer may have been lost, send it again
      if (m?.attempt === msg.attempt) { if (m.answer) send(from, { type: 'answer', sdp: m.answer }); return; }
      m?.pc.close();
      m = peer(from, false);
      m.attempt = msg.attempt;
      await m.pc.setRemoteDescription(msg.sdp);
      await m.pc.setLocalDescription(await m.pc.createAnswer());
      m.answer = await gathered(m.pc);
      send(from, { type: 'answer', sdp: m.answer });
    } else if (msg.type === 'answer') {
      const pc = members.get(from)?.pc;
      if (pc?.signalingState === 'have-local-offer') await pc.setRemoteDescription(msg.sdp);
    }
  }

  // A page that closes says bye; one that crashes or loses its network goes quiet: a ping every 3 s, and a peer
  // silent for 15 s has left (WebRTC alone takes about 30 s to notice).
  function gone(m) {
    if (members.get(m.id) !== m) return;
    members.delete(m.id); m.pc.close(); log(`peer ${m.id} left`);
    if (started?.host === m.id && !hostLeft) hostLeft = 'left';
    changed();
  }
  setInterval(() => {
    const now = performance.now();
    for (const m of members.values()) {
      if (!open(m)) continue;
      tell(m, { t: 'ping' });
      if (now - (m.heard ?? now) > 15000) gone(m);
    }
  }, 3000);
  addEventListener('pagehide', () => broadcast({ t: 'bye' }));

  // ---- peer connections
  function peer(pid, offerer) {
    const pc = new RTCPeerConnection({ iceServers: pickIce([...ICE, ...extraIce]), iceTransportPolicy: query.get('relay') === '1' ? 'relay' : 'all' });
    const old = members.get(pid);
    const m = { id: pid, name: old?.name ?? shortName(pid), joinedAt: old?.joinedAt ?? null, screen: old?.screen, pc, lobby: null, game: null, failures: old?.failures ?? 0, offerer };
    members.set(pid, m);
    pc.onconnectionstatechange = () => {
      log(`peer ${pid} ${pc.connectionState}`);
      if (members.get(pid) !== m) return;
      if (pc.connectionState === 'failed') {
        m.failures++;
        // the older side tries again a couple of times (network change, a relay hiccup), then gives up
        if (m.offerer && m.failures < 3 && !manual) setTimeout(() => { if (members.get(pid) === m) connect(pid); }, 3000);
        else members.delete(pid);
      }
      changed();
    };
    const wire = dc => {
      dc.binaryType = 'arraybuffer';
      if (dc.label === 'lobby') {
        m.lobby = dc;
        let announced = false;
        dc.onopen = () => {
          if (announced) return;
          announced = true;
          log(`peer ${pid} lobby open`); m.heard = performance.now(); tell(m, myState()); changed();
        };
        dc.onmessage = e => { try { onLobbyMessage(m, JSON.parse(e.data)); } catch (err) { log('lobby message', err); } };
        // the other page closed or reloaded (a reload comes back with a new id)
        dc.onclose = () => gone(m);
        // Remote channels may already be open when the datachannel event is delivered.
        if (dc.readyState === 'open') dc.onopen();
      } else {
        m.game = dc;
        dc.onmessage = e => deliver(pid, e.data);
      }
    };
    pc.ondatachannel = e => wire(e.channel);
    if (offerer) {
      wire(pc.createDataChannel('lobby'));
      wire(pc.createDataChannel('game', { ordered: false, maxRetransmits: 0 }));
    }
    return m;
  }
  // No trickle ICE: each side waits for its candidates and sends one description that carries them all. Gathering
  // rarely "completes" quickly (TURN over TCP/TLS is slow), so stop half a second after the first relay candidate
  // (by then the direct ones are in too), or after 4 s.
  async function gathered(pc) {
    if (pc.iceGatheringState !== 'complete')
      await new Promise(r => {
        const t = setTimeout(r, 4000), done = () => { clearTimeout(t); r(); };
        pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') done(); });
        pc.addEventListener('icecandidate', e => { if (e.candidate?.type === 'relay') setTimeout(done, 500); });
      });
    return slim(pc.localDescription);
  }
  // ntfy turns messages over 4 KB into file attachments: drop candidates that rarely help (TCP host candidates, then
  // IPv6 ones) until the description fits.
  function slim(desc) {
    let sdp = desc.sdp;
    const drop = re => { if (sdp.length > 3000) sdp = sdp.split('\r\n').filter(l => !(l.startsWith('a=candidate') && re.test(l))).join('\r\n'); };
    drop(/ tcp .* typ host/); drop(/ [0-9a-f]*:[0-9a-f:]+ \d+ typ/);
    return { type: desc.type, sdp };
  }
  // The offer is resent until it is answered, backing off from 5 s to 30 s, for about 3 minutes.
  async function connect(pid) {
    await iceReady;
    members.get(pid)?.pc.close();
    const m = peer(pid, true), attempt = Math.random().toString(36).slice(2);
    changed();
    await m.pc.setLocalDescription(await m.pc.createOffer());
    const offer = await gathered(m.pc);
    for (let wait = 5000, total = 0; m.pc.signalingState === 'have-local-offer' && members.get(pid) === m; total += wait, wait = Math.min(wait * 2, 30000)) {
      if (total > 180000) { members.delete(pid); m.pc.close(); changed(); return; }
      send(pid, { type: 'offer', sdp: offer, attempt });
      await sleep(wait);
    }
  }

  // ---- offline: codes swapped by hand (coop.js shows and reads them)
  // The host's open invite (one at a time: a new one replaces it until it is used)
  let openInvite = null;
  async function invite() {
    if (openInvite && members.get(openInvite) && !open(members.get(openInvite))) { members.get(openInvite).pc.close(); members.delete(openInvite); }
    const pid = randomId(), m = peer(pid, true);
    openInvite = pid; changed();
    await m.pc.setLocalDescription(await m.pc.createOffer());
    const sdp = lanOnly(await gathered(m.pc));
    return pack({ t: 'invite', page: location.pathname, host: me.id, at: me.joinedAt, name: me.name, you: pid, sdp });
  }
  // An invite (this page becomes that player, and gets a reply to show back) or a reply (the host's connection to
  // the player it invited goes up). Returns the reply code, or null.
  async function useCode(code) {
    const msg = await unpack(code);
    if (msg.t === 'invite') {
      if (msg.page !== location.pathname) throw Object.assign(new Error('That invite is for another map'), { page: msg.page });
      if (msg.host === me.id) throw new Error('That’s your own invite: the other player scans it');
      if (others().length) throw new Error('You’re already in a game: leave the lobby first');
      // the invited player's id and a join time after the host's, so the host stays the host
      me.id = msg.you; me.joinedAt = Math.max(Date.now(), msg.at + 1);
      for (const [pid, m] of members) { m.pc.close(); members.delete(pid); }
      openInvite = null;
      const m = peer(msg.host, false);
      Object.assign(m, { joinedAt: msg.at, name: cleanName(msg.name) || shortName(msg.host) });
      await m.pc.setRemoteDescription(msg.sdp);
      await m.pc.setLocalDescription(await m.pc.createAnswer());
      const sdp = lanOnly(await gathered(m.pc));
      changed();
      return pack({ t: 'reply', from: me.id, to: msg.host, sdp });
    }
    if (msg.t === 'reply') {
      if (msg.to !== me.id) throw new Error('That reply is for someone else’s invite');
      const m = members.get(msg.from);
      if (!m || m.pc.signalingState !== 'have-local-offer') throw new Error('That reply is for an old invite: make a new invite');
      await m.pc.setRemoteDescription(msg.sdp);
      if (openInvite === msg.from) openInvite = null;
      changed();
      return null;
    }
    throw new Error('That isn’t a co-op code');
  }
  // Only what a LAN connection uses: UDP candidates (host addresses; there is no STUN/TURN here anyway)
  function lanOnly(desc) {
    return { type: desc.type, sdp: desc.sdp.split('\r\n').filter(l => !(l.startsWith('a=candidate') && !/ udp /i.test(l))).join('\r\n') };
  }

  // ---- engine (attach() at wasmReady)
  let module = null, rings = null, mapLoaded = false, connected = false;
  const heap = () => new Int32Array(module.HEAPF32.buffer), u8 = () => new Uint8Array(module.HEAPF32.buffer);
  const isHost = () => !!started && started.host === me.id;
  // host side: joiner <-> 10.66.0.<n>
  const octets = new Map(), octetPeer = new Map();
  const octetOf = pid => { if (!octets.has(pid)) { let n = 2; while (octetPeer.has(n)) n++; if (n > 254) return 0; octets.set(pid, n); octetPeer.set(n, pid); } return octets.get(pid); };
  // players the host still waits for: the start list, minus anyone who has left since
  const expected = () => started ? started.players.filter(p => p === me.id || open(members.get(p))).length : 0;
  function attach(mod) {
    if (module) return;
    module = mod;
    const ring = () => { const r = module._malloc(16 + SLOTS * SLOT); u8().fill(0, r, r + 16); heap()[(r >> 2) + 3] = SLOTS; return r; };
    rings = { out: ring(), client: ring(), server: ring() };
    const h = heap(), c = CTRL >> 2;
    h[c + 1] = rings.out; h[c + 2] = rings.client; h[c + 3] = rings.server; h[c + 4] = query.get('netlog') === '1' ? 1 : 0;
    Atomics.store(h, c, MAGIC);
    // console commands wait for the map: during engine startup the page thread could block on the command buffer's
    // lock while the engine thread waits on the page (a deadlock)
    addEventListener('kisak-map-loaded', () => { mapLoaded = true; engineName(); engineStarted(); }, { once: true });
    // A MessageChannel loop runs the pump far more often than setInterval's clamp, without a busy loop.
    const mc = new MessageChannel();
    mc.port1.onmessage = () => { pump(); setTimeout(() => mc.port2.postMessage(0), 1); };
    mc.port2.postMessage(0);
    setInterval(() => { if (isHost() && !api.waitedEnough) heap()[(CTRL >> 2) + 8] = expected(); }, 500);
    log('engine attached');
  }
  function engineName() { if (module && mapLoaded) cmd(module, `set name "${me.name}"`); }
  // after the start: the host's game waits for the players; a joiner connects once its own map is up (a client-only
  // boot can't decode the host's gamestate: the map load sets up tables it needs)
  function engineStarted() {
    if (!module || !started) return;
    if (isHost()) { if (!api.waitedEnough) heap()[(CTRL >> 2) + 8] = expected(); return; }
    if (!mapLoaded || connected) return;
    connected = true;
    module._KB_Input(7, 1, 0);  // release the start hold (the page still asks for a click, for the mouse and sound)
    cmd(module, 'set cl_connectionAttempts 1000');
    cmd(module, 'connect host');
    log('connecting to the host');
  }
  const lock = r => { const h = heap(); while (Atomics.compareExchange(h, r >> 2, 0, 1) !== 0); };
  const unlock = r => Atomics.store(heap(), r >> 2, 0);
  // Engine -> network
  function pump() {
    const h = heap(), b = u8(), out = rings.out;
    while (Atomics.load(h, (out >> 2) + 2) !== Atomics.load(h, (out >> 2) + 1)) {
      lock(out);
      const t = h[(out >> 2) + 2], s = out + 16 + (t % SLOTS) * SLOT, len = h[s >> 2];
      const ip = b.subarray(s + 8, s + 12), data = b.slice(s + 32, s + 32 + len);
      h[(out >> 2) + 2] = t + 1;
      unlock(out);
      const to = ip[0] === 10 && ip[1] === 66 && ip[2] === 0 ? (ip[3] === 1 ? started?.host : octetPeer.get(ip[3])) : null;
      const dc = to != null ? members.get(to)?.game : null;
      if (dc?.readyState === 'open') { dc.send(data); stats.sent++; } else stats.dropped++;
    }
  }
  // Network -> engine: packets from the host come from 10.66.0.1, from a joiner 10.66.0.<its number>
  function deliver(from, data) {
    if (!rings) return;
    const r = isHost() ? rings.server : rings.client, h = heap(), b = u8();
    if (data.byteLength > SLOT - 32) { stats.dropped++; return; }
    const ipLast = started && from === started.host ? 1 : octetOf(from);
    if (!ipLast) { stats.dropped++; return; }
    lock(r);
    const hd = h[(r >> 2) + 1], t = h[(r >> 2) + 2];
    if (hd - t < SLOTS) {
      const s = r + 16 + (hd % SLOTS) * SLOT;
      h[s >> 2] = data.byteLength;
      b.fill(0, s + 4, s + 20); h[(s + 4) >> 2] = 4; b.set([10, 66, 0, ipLast], s + 8); b[s + 12] = PORT >> 8; b[s + 13] = PORT & 255;
      b.set(new Uint8Array(data), s + 32);
      h[(r >> 2) + 1] = hd + 1; stats.recv++;
    } else stats.dropped++;
    unlock(r);
  }

  const api = lobby = {
    room, me, members, stats, attach, start, canStart, kick, makeHost, setName, hostId, isHost, expected, inRoom, MAX_PLAYERS, manual, invite, useCode,
    get openInvite() { return openInvite; },
    get hostLeft() { return hostLeft; }, get removed() { return removed; },
    get started() { return started; }, get signalError() { return signalError; }, get attached() { return !!module; },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    cmd: text => module && cmd(module, text),
    engineStats: () => { const h = heap(), c = CTRL >> 2; return { sent: h[c + 5], received: h[c + 6], dropped: h[c + 7] }; },
    // host: stop waiting for missing players (getnumexpectedplayers falls back to the players connected)
    startNow() { api.waitedEnough = true; if (module) heap()[(CTRL >> 2) + 8] = 0; changed(); },
  };
  globalThis.kbnet = api;
  log(`lobby ${room}`);
  return api;
}

// engine.js calls this at wasmReady on a co-op page
export function attach(module) { (lobby ?? startLobby())?.attach(module); }

// Run a console command in the engine (Cbuf_AddText via the KB_Cbuf export).
export function cmd(module, text) {
  const bytes = new TextEncoder().encode(text + '\n\0'), p = module._malloc(bytes.length);
  new Uint8Array(module.HEAPF32.buffer).set(bytes, p);
  module._KB_Cbuf(p);
  module._free(p);
}
