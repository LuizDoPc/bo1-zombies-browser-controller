# Multiplayer transport: findings (2026-10-09)

## Status: working (2026-10-09)

Two-player co-op over WebRTC works, tested headless (two Chromium profiles, GTX 1080) on Five: on `serve.py` and on
the static build (ntfy signaling), through the co-op UI. The host's `status` shows the joiner at `10.66.0.<n>:28960`,
both spawn in round 1 with 500 points, the joiner's movement is accepted by the server; ping 40-165 ms on one machine.
How it is built: README "Co-op multiplayer". Engine source reference: https://github.com/MisaDev4/bo1-zombies-decompiled
(the Kisak BO1 engine; the web port's src/web is not in it).

What it took beyond the hook plan below:
- `CL_Connect_f` only connected to loopback addresses: patched to accept type 4.
- Late joiners spectate until the next round (zombies scripts), so the host waits: `getnumexpectedplayers()` (no party
  in KB: it counted only connected clients) now returns `max(connected, lobby player count)`.
- A client-only boot (`+connect` without `+devmap`) asserts decoding the gamestate (msg_mp.cpp bitChanged): the joiner
  loads the map itself first, then releases its start hold and connects (net.js).
- A held host ("Click to start") runs no server frames: joiners wait (cl_connectionAttempts 1000).
- Start-hold race in engine.js (a release before the engine's hold, or the engine's copy of the load cinematic still
  running) could leave the game paused: patched for everyone.
- `0.peerjs.com` closes the socket on relayed messages now; signaling uses ntfy.sh instead.

Fixed 2026-10-09: the host crashed (UnitQuatToAxis assert, zero quat in CG_AddPlayerWeapon) when both players spawned while it sat at "Click to start"; the assert is patched out (patch-wasm.mjs step 7).

TURN 2026-10-09: net.js fetches relay credentials from Metered (net-config.json turnApi, ?turnapi=, ?relay=1 forces the relay); tested forced-relay co-op on Five.

Lobby 2026-10-09: `?lobby=<room>` with a full WebRTC mesh (lobby + game channels), host = first to join (server
clock), synchronized start (Play held until Start; round 1 waits for the start list), late joiners, names, host-left
handling, max 4. Signaling over the Metered realtime-messaging protocol (Metered by default, `mp/signal-server.mjs`
self-hosted stand-in). Tested headless: 3 players incl. a late joiner on serve.py, 2 players on the static build,
host migration before start, host leaving mid-game, a full game over signal-server.mjs, Kino and Nacht with
every connection forced through the TURN relay. Fixed on the way: Kino dropped co-op games ("CachedTag_UpdateTagInternal:
Cannot find dobj on entity", patch step 9); a crashed page kept advertising its dead game, so a reloaded lobby
waited for "the next round" forever (now a crashed host ends the game for everyone and can't be elected).

All ten maps pass a two-player lobby game, and a Chromium host with a Firefox joiner works (2026-10-09). On co-op pages debug asserts are logged and skipped (patch
step 10), as in a retail build.

Open: voice chat, gamepad, real cross-network play with friends (only tested on one machine, relay forced),
self-hosted signaling deployment (signal-server-setup.txt).

Static analysis of `site/artifacts/KisakBlack-web.wasm` (9.6 MB). The binary keeps its **name section** (11,693 named
functions, demangled C++ signatures), so engine functions can be found by name. Tools: binaryen `wasm-dis` (text
format) and wabt 1.0.36 `wasm-decompile` (pseudo-C). wabt 1.0.42 dropped the decompiler and the wabt npm build crashes
on this module.

## How solo play talks to itself

The engine keeps the full Quake 3 / CoD client-server split. Solo zombies is a local server plus one local client
that talk through the **loopback queues**:

- `loopbacks` at address `135783616`: 2 queues x 20360 bytes (index 0 = into the client, 1 = into the server).
  Each queue: 16 slots x 1272 bytes (`data[1264]`, `datalen` at +1264, `port` at +1268), then `get`/`send` counters
  at +20352/+20356.
- Only 2 queues exist, so a remote player can't pose as a second local (splitscreen) client.

## Send path

`NET_SendPacket` is inlined into every sender. Each switches on `netadr_t.type`:

| type | meaning | what happens |
|---|---|---|
| 0, 1 | bot, bad | dropped |
| 2 | loopback | copied into `loopbacks[...]` |
| 3, 4+ | broadcast, **IP** | address copied to the stack, then **nothing**: the socket send was compiled out |

Senders that reach the loopback queue (each needs the type>=3 branch hooked):
- `NET_OutOfBandData(netsrc_t, netadr_t, uchar const*, int)`: connectionless packets
- `NET_OutOfBandPrint(netsrc_t, netadr_t, char const*)`: connectionless text (getchallenge, connect, ...)
- `Netchan_Transmit(netchan_t*, int, char*, bool)`: sequenced game traffic
- `Netchan_TransmitNextFragment(netchan_t*)`: fragments of large messages (gamestate)
- `Netchan_Process(netchan_t*, msg_t*)`: 2 references, not analyzed yet
- `SV_SendClientVoiceData(client_t*)`: voice, can be ignored

## Receive path

`Com_ServerPacketEvent()` and `Com_ClientPacketEvent()` poll only `NET_GetLoopPacket(netsrc_t, netadr_t*, msg_t*)`.
There is no socket read anywhere. `NET_GetLoopPacket` always reports the sender as type 2 (loopback), with the stored
port. `msg_t`: data pointer at +8, cursize at +20.
`SV_ConnectionlessPacket` is inlined into `Com_ServerPacketEvent` (it calls `SV_DirectConnect`).

## Addresses

- `netadr_t`: `type` (int) at +0, IPv4 bytes at +4..+7, port (u16, network byte order) at +8. Zeroed fields at
  +4..+15.
- Types: 0 bot, 1 bad, 2 loopback, 3 broadcast, 4 IP (`NET_AdrToString` prints type 4 as `a.b.c.d:port`).
- `NET_StringToAdr` is **stubbed**: only `localhost` resolves (to loopback). Every other string becomes type 1 and is
  dropped, so `connect <anything>` can't work without a patch.

## Server side

- `SV_DirectConnect` looks intact: bans, `EXE_SERVERISFULL`, `Com_GetPrivateClients`, `ClientConnect`,
  `Netchan_Setup`. No Steam/online-service call in it.
- `SV_AddTestClient` / `addtestclient` exists (server-side bot player), plus `kisak_testclient` (0 in engine.js) and a
  demo client. Good first test of whether a zombies game accepts a second player at all.

## Hook plan

Binary patch with binaryen (JS API), applied by `serve.py` / `tools-make-static.py` like the other patches:

1. New wasm imports: `kb_net_send(sock, adr*, data*, len)`, `kb_net_recv(sock, from*, msg*) -> int`,
   `kb_net_resolve(name*, adr*) -> int`.
2. Send: in each sender above, point the type>=3 branch at a call to `kb_net_send`.
3. Receive: `NET_GetLoopPacket` asks `kb_net_recv` first. A remote packet comes back with a type-4 `from` address.
4. Resolve: `NET_StringToAdr` asks `kb_net_resolve` for non-`localhost` names (e.g. `peer1` -> `10.0.0.1:28960`).
5. JS side (`.mjs` imports): SharedArrayBuffer rings between the engine threads (server/client pthreads, which can't
   touch WebRTC) and the main thread. The main thread moves packets over the transport.
6. Transport: BroadcastChannel first (two tabs on one machine, no network), then WebRTC data channels
   (`ordered: false, maxRetransmits: 0`), a small signaling step, and STUN/TURN.
7. Game flow: the host runs `devmap` as now with room for more players. A joining client boots without `devmap` and
   runs `connect peer1`. Open questions: player limit dvars, party/session checks, whether a client-only boot loads the
   map from the gamestate.

## Next experiments

1. `addtestclient` on a running zombies map (needs a `?cmd=` passthrough like `?cvar.`): does a second player spawn
   and play?
2. Proof-of-concept patch: imports plus logging only (log every type>=3 send), to prove the binaryen surgery and the
   import wiring work across the pthreads.
3. Two tabs over BroadcastChannel: tab B connects to tab A.
