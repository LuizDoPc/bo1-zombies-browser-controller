// signal-server.mjs: a self-hosted stand-in for Metered realtime messaging, enough for bo1z co-op signaling (net.js).
// It speaks the same WebSocket protocol subset net.js uses:
//   server -> client: welcome { peerId, expiresAt, serverTime, maxMessageSize, metadata? }, ack, error,
//                     presence { channel, joined: [{ peerId }], left: [{ peerId }] }, message { channel, from, data }
//   client -> server: subscribe { channel, requestId }, unsubscribe { channel, requestId },
//                     publish { channel, data, requestId }  (to the channel's other subscribers)
// No dependencies (plain Node 18+). Messages are relayed, never stored.
//
//   node mp/signal-server.mjs [port]           listens on 127.0.0.1:<port> (default 8787), any path
//   ICE_SERVERS='[{"urls":"turn:..."}]'        optional: TURN servers handed out in welcome.metadata.iceServers
//   ORIGINS='https://example.com,...'          optional: only accept pages from these origins
//
// Put it behind your web server's TLS (nginx: see turn-setup.txt / README) and point net.js at it:
// SIGNAL_URL = 'wss://your.host/bo1z-signal' (or ?signal=wss://your.host/bo1z-signal on the page URL).
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8787);
const ICE = process.env.ICE_SERVERS ? JSON.parse(process.env.ICE_SERVERS) : null;
const ORIGINS = process.env.ORIGINS ? process.env.ORIGINS.split(',') : null;
const MAX = 65536;
const channels = new Map();  // channel -> Set of clients

function frame(text) {
  const data = Buffer.from(text), n = data.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255])
    : Buffer.concat([Buffer.from([0x81, 127]), (b => (b.writeBigUInt64BE(BigInt(n)), b))(Buffer.alloc(8))]);
  return Buffer.concat([head, data]);
}
const send = (c, obj) => { if (!c.closed) c.socket.write(frame(JSON.stringify(obj))); };

function leave(c, channel) {
  const set = channels.get(channel);
  if (!set?.delete(c)) return;
  if (!set.size) channels.delete(channel);
  for (const o of set) send(o, { type: 'presence', channel, joined: [], left: [{ peerId: c.peerId }] });
}
function onMessage(c, text) {
  let m; try { m = JSON.parse(text); } catch { return send(c, { type: 'error', code: 'bad_json', message: 'not JSON' }); }
  const channel = typeof m.channel === 'string' && m.channel.length <= 200 ? m.channel : null;
  if (m.type === 'subscribe' && channel) {
    const set = channels.get(channel) ?? channels.set(channel, new Set()).get(channel);
    send(c, { type: 'ack', requestId: m.requestId, ok: true });
    send(c, { type: 'presence', channel, joined: [...set].map(o => ({ peerId: o.peerId })), left: [] });
    if (!set.has(c)) for (const o of set) send(o, { type: 'presence', channel, joined: [{ peerId: c.peerId }], left: [] });
    set.add(c); c.channels.add(channel);
  } else if (m.type === 'unsubscribe' && channel) {
    leave(c, channel); c.channels.delete(channel);
    send(c, { type: 'ack', requestId: m.requestId, ok: true });
  } else if (m.type === 'publish' && channel) {
    if (!c.channels.has(channel)) return send(c, { type: 'error', requestId: m.requestId, code: 'not_subscribed', message: 'subscribe first' });
    for (const o of channels.get(channel) ?? []) if (o !== c) send(o, { type: 'message', channel, from: c.peerId, data: m.data });
    send(c, { type: 'ack', requestId: m.requestId, ok: true });
  } else send(c, { type: 'error', requestId: m.requestId, code: 'unsupported', message: `unsupported: ${m.type}` });
}

const server = http.createServer((req, res) => { res.writeHead(426, { 'content-type': 'text/plain' }); res.end('WebSocket only\n'); });
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (ORIGINS && !ORIGINS.includes(req.headers.origin))) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const c = { socket, peerId: 'peer_' + crypto.randomBytes(8).toString('hex'), channels: new Set(), closed: false, alive: true };
  let buf = Buffer.alloc(0), parts = [];
  const close = () => { if (c.closed) return; c.closed = true; for (const ch of c.channels) leave(c, ch); socket.destroy(); };
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80;
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX) return close();
      if (buf.length < off + (masked ? 4 : 0) + len) return;
      const mask = masked ? buf.subarray(off, off + 4) : null; off += masked ? 4 : 0;
      const data = Buffer.from(buf.subarray(off, off + len)); buf = buf.subarray(off + len);
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      if (op === 8) return close();
      if (op === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); continue; }
      if (op === 10) { c.alive = true; continue; }
      if (op === 1 || op === 0) { parts.push(data); if (fin) { const text = Buffer.concat(parts).toString(); parts = []; onMessage(c, text); } }
    }
  });
  socket.on('close', close); socket.on('error', close);
  send(c, { type: 'welcome', peerId: c.peerId, expiresAt: null, serverTime: Math.floor(Date.now() / 1000), maxMessageSize: MAX, ...(ICE ? { metadata: { iceServers: ICE } } : {}) });
  c.ping = setInterval(() => { if (c.closed) return clearInterval(c.ping); if (!c.alive) return close(); c.alive = false; socket.write(Buffer.from([0x89, 0])); }, 30000);
});
server.listen(PORT, '127.0.0.1', () => console.log(`bo1z signal server on 127.0.0.1:${PORT}`));
