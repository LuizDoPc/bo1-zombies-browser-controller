// kbnet: engine-side half of the network transport. Injected into KisakBlack-web.mjs (mp/build.mjs), so it runs in
// every thread (page and engine pthreads) and backs the wasm imports added by mp/patch-wasm.mjs. State lives in the
// shared wasm memory: a control block at KBNET_CTRL and three packet rings the page allocates (net.js).
//   ctrl (i32): [0] magic  [1] out ring  [2] in ring for sock 0 (client)  [3] in ring for sock 1 (server)
//               [4] flags (1 = log)  [5] sent  [6] received  [7] dropped  [8] expected players (lobby)
//   ring: [0] lock [1] head [2] tail [3] slots, then slots of KBNET_SLOT bytes: [0] len, +4 netadr (16 bytes),
//         +32 data (up to KBNET_SLOT - 32)
// Remote peers are type-4 (IP) addresses 10.66.0.<n>:28960; anything else stays on the engine's own paths.
var KBNET_CTRL = 768, KBNET_MAGIC = 0x4B424E54, KBNET_SLOT = 2048;
function kbnetLock(r) { while (Atomics.compareExchange(HEAP32, r >> 2, 0, 1) !== 0); }
function kbnetUnlock(r) { Atomics.store(HEAP32, r >> 2, 0); }
function kbnetPush(r, adr, data, len) {
  if (len > KBNET_SLOT - 32) return false;
  kbnetLock(r);
  var h = HEAP32[(r >> 2) + 1], t = HEAP32[(r >> 2) + 2], n = HEAP32[(r >> 2) + 3], ok = h - t < n;
  if (ok) {
    var s = r + 16 + (h % n) * KBNET_SLOT;
    HEAP32[s >> 2] = len;
    HEAPU8.copyWithin(s + 4, adr, adr + 16);
    HEAPU8.copyWithin(s + 32, data, data + len);
    HEAP32[(r >> 2) + 1] = h + 1;
  }
  kbnetUnlock(r);
  return ok;
}
function kb_net_send(adr, data, len) {
  var c = KBNET_CTRL >> 2;
  if (HEAP32[c] !== KBNET_MAGIC || HEAP32[adr >> 2] !== 4) return;
  if (kbnetPush(HEAP32[c + 1], adr, data, len)) Atomics.add(HEAP32, c + 5, 1); else Atomics.add(HEAP32, c + 7, 1);
  if (HEAP32[c + 4] & 1) console.log('KBNET send to ' + HEAPU8.subarray(adr + 4, adr + 8).join('.') + ' len=' + len);
}
function kb_net_recv(sock, from, msg) {
  var c = KBNET_CTRL >> 2;
  if (HEAP32[c] !== KBNET_MAGIC || (sock !== 0 && sock !== 1)) return 0;
  var r = HEAP32[c + 2 + sock];
  if (!r || Atomics.load(HEAP32, (r >> 2) + 1) === Atomics.load(HEAP32, (r >> 2) + 2)) return 0;
  kbnetLock(r);
  var h = HEAP32[(r >> 2) + 1], t = HEAP32[(r >> 2) + 2], n = HEAP32[(r >> 2) + 3], got = 0;
  if (t !== h) {
    var s = r + 16 + (t % n) * KBNET_SLOT, len = HEAP32[s >> 2], max = HEAP32[(msg + 16) >> 2];
    if (len <= max) {
      HEAPU8.copyWithin(HEAP32[(msg + 8) >> 2], s + 32, s + 32 + len);
      HEAP32[(msg + 20) >> 2] = len;
      HEAPU8.copyWithin(from, s + 4, s + 20);
      got = 1;
    } else Atomics.add(HEAP32, c + 7, 1);
    HEAP32[(r >> 2) + 2] = t + 1;
  }
  kbnetUnlock(r);
  if (got) {
    Atomics.add(HEAP32, c + 6, 1);
    if (HEAP32[c + 4] & 1) console.log('KBNET recv sock=' + sock + ' from ' + HEAPU8.subarray(from + 4, from + 8).join('.') + ' len=' + len);
  }
  return got;
}
// "host" -> 10.66.0.1, "peer<n>" -> 10.66.0.<n>, "a.b.c.d[:port]" -> that IP; anything else -> the engine's own parse.
function kb_net_resolve(name, adr) {
  var s = UTF8ToString(name), m, ip;
  if (s === 'host') ip = [10, 66, 0, 1];
  else if ((m = /^peer(\d+)$/.exec(s))) ip = [10, 66, 0, +m[1]];
  else if ((m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)(?::(\d+))?$/.exec(s))) ip = [+m[1], +m[2], +m[3], +m[4]];
  else return 0;
  HEAPU8.fill(0, adr, adr + 16);
  HEAP32[adr >> 2] = 4;
  HEAPU8.set(ip, adr + 4);
  HEAPU8[adr + 8] = 28960 >> 8; HEAPU8[adr + 9] = 28960 & 255;  // port, network byte order
  return 1;
}
// getnumexpectedplayers(): at least the lobby's player count, so the host's zombies script waits for every player.
function kb_net_expected(count) {
  var c = KBNET_CTRL >> 2;
  return HEAP32[c] === KBNET_MAGIC ? Math.max(count, HEAP32[c + 8]) : count;
}
// Assert_MyHandler(file, line, ...) asks this first: in co-op (the page set up the control block) log the assert once
// per site and carry on, as a retail build would; solo play keeps its asserts.
var kbnetAsserts = {};
function kb_net_assert(file, line) {
  if (HEAP32[KBNET_CTRL >> 2] !== KBNET_MAGIC) return 0;
  var key = file + ':' + line;
  if (!kbnetAsserts[key]) { kbnetAsserts[key] = 1; console.warn('KBNET assert skipped: ' + UTF8ToString(file) + ':' + line); }
  return 1;
}
