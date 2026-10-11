# bo1z co-op and fixes


Changes to [BO1 Zombies](https://vel.gg/bo1z) (Black Ops zombies in the browser: the "Kisak Black" WebGPU + WASM
engine), as a patch set that builds on a copy of the site:
- online co-op: lobbies, invite links and codes, a self-hostable signaling server, TURN relays;
- joining a game in progress (a small game-script mod);
- same-Wi-Fi co-op with no connection (QR codes) and per-map offline play;
- controller support through the engine's own gamepad code;
- an Options panel (Low graphics, Flat lighting, fullscreen, sensitivity, volume);
- Safari support (a JSPI stand-in) and loading-freeze fixes;
- debugging switches for the WebGPU renderer.

## What is (not) here

Only code and docs written for this project. Nothing from the game or from the site itself is included:
- **The site (`site/`).** That is upstream's loader, engine and pages, and the game data packs (Activision's original
  Call of Duty: Black Ops data). You bring your own copy, and the build patches it.
- **The mod-stack scripts the co-op mod needs** (`mods/_stack/maps/_modstack.gsc`, `_zombiemode_ffotd.gsc`). The build
  copies them from the site's own `pack/mods/_stack/`.
- **The home-screen icons.** `mp/icons-default/` is a plain original icon. Put your own in `mp/icons/` (ignored by git)
  to use those instead.
- **The lobby services.** Signaling and TURN keys are the deployer's, in `mp/net-config.json` (ignored by git; see
  `mp/net-config.example.json`).

`mp/build.mjs` and `serve.py` patch upstream's files by exact text match. Their match strings quote short pieces of
upstream's loader and page code, so a patch stops with "patch no longer applies" when upstream changes that code.

## Building

**Full walkthrough, from downloading upstream to a running server, and how to change things: [`docs/DEPLOY.md`](DEPLOY.md).**
In short:

    python3 tools-fetch-site.py   # upstream's pages, scripts and engine into site/
    python3 tools-fetch-packs.py  # the map packs (~9.2 GB)
    cd mp && npm ci && cd ..      # binaryen (wasm patching), qrcode-generator, jsqr
    cp mp/net-config.example.json mp/net-config.json   # then fill in your keys (or leave it out: no online lobbies)
    node mp/build.mjs             # writes overlay/: the patched engine and loader, plus the co-op files
    python3 serve.py              # local server, http://localhost:8000/bo1z/ (serves overlay/ over site/)
    python3 tools-make-static.py  # or: static/, a copy for any static host (docs/deploy-update.txt)

More deployment notes are in `docs/`:
- nginx headers (`nginx-coop-coep.conf`);
- self-hosted signaling, ntfy and TURN (`*-setup.txt`);
- telemetry (`telemetry-setup.txt`);
- the co-op design notes (`notes-multiplayer.md`).

## Running it

    python3 serve.py            # listens on 0.0.0.0:8000, open http://localhost:8000/bo1z/

Use a browser with WebGPU (recent Chrome/Edge). The server sends the COOP/COEP headers the engine needs and records the client's
diagnostics (`/bo1z/telemetry`: crash records with the engine log tail, errors, frame stats) to `telemetry.jsonl`
(`--no-telemetry` turns that off). On localhost the client fetches packs from the same origin, not from cdn.vel.gg.

**Fixed (serve.py patch):** on the default WebGPU renderer, Kino and Moon (any map, in principle) could freeze while
loading. The live site does the same (seen 2026-10-09 on Chrome 154 / Apple M3). The engine glue copied each load
cinematic frame into the wasm heap on the page's main thread, and `VideoFrame.copyTo` of a GPU-decoded frame is a
synchronous GPU readback. With a cold shader cache, the GPU process is busy compiling the WebGPU executor's pipelines,
so each readback blocked the page for seconds, along with the engine's calls proxied to the main thread. `serve.py` now
patches `artifacts/KisakBlack-web.mjs` to do that copy in its own worker. `--no-patches` brings the freeze back
(reproduce it by clearing Chrome's `DawnWebGPUCache`/`GPUPersistentCache`). On Chrome/macOS a copy could also never
finish, and closing the cinematic waits for the pending copy, so the engine stopped ~16 s into the load while the page
stayed responsive. Closing now aborts a pending copy (restarting the worker), and so does any copy older than 5 s.
When no frame is presented for 20 s, the telemetry record includes the engine log tail and `__kbVideoDiag()` (patched `telemetry.js`).

Engine cvars can be set from the page URL with `?cvar.<name>=<value>` (a `serve.py` patch to `engine.js`; `--no-patches`
serves every file exactly as archived), e.g.
`/bo1z/kino?cvar.r_picmip=1&cvar.r_picmip_manual=1` for lower-resolution textures.

**Browsers without JSPI (Safari):** the engine is an Emscripten JSPI build, but only two wasm imports really wait for a
promise, so `mp/jspi-polyfill.js` stands in for `WebAssembly.Suspending`/`promising` when the browser lacks them.
`InitializeWebGPU` is the one that matters: its async part (starting the WebGPU executor) runs before the renderer
thread enters wasm, and the import returns that result. `ReadWebGPUPixelsJS` (a D3D readback path not reached in normal
play; screenshots read back another way) returns black. `mp/build.mjs` injects the file into the loader, and a `serve.py`
patch makes `play.js` import it first, so the JSPI check in `capabilities.js` passes. Browsers with JSPI are unchanged;
the console says `KISAK_JSPI native` or `KISAK_JSPI polyfill (...)`. `?nojspi=1` simulates a browser without JSPI in Chrome.

## Co-op multiplayer (WebRTC)

The engine keeps BO1's client/server netcode but its socket layer was compiled out: solo play is a local server and
client talking through in-memory loopback queues. `mp/` adds a transport for remote players:

- `mp/patch-wasm.mjs` (binaryen) patches the engine wasm: every sender's empty "IP address" branch calls
  `kb_net_send`, `NET_GetLoopPacket` asks `kb_net_recv` first, `NET_StringToAdr` resolves `host`/`peerN`,
  `CL_Connect_f` accepts IP addresses (it was loopback-only), `getnumexpectedplayers()` returns the lobby's player
  count, and a `KB_Cbuf` export runs console commands. Co-op clients take paths solo play never does, and this build
  stops on any debug assert (the retail game had them compiled out): on co-op pages asserts are logged
  (`KBNET assert skipped`) and the engine carries on; solo play is unchanged. Specific fixes for crashes seen in co-op:
  zero quaternions (`UnitQuatToAxis`), missing effect materials (`Material_GetTechnique`), and other players' models
  not set up yet (`CachedTag_*`, "Cannot find dobj on entity", Kino).
- `mp/kbnet-runtime.js` (injected into the engine loader) backs those imports with packet rings in the shared wasm
  memory; `mp/net.js` (page) moves the packets over WebRTC data channels (unordered, no retransmits, like UDP).
  Remote peers are `10.66.0.<n>:28960` to the engine; the host is `10.66.0.1`.
- Lobby (`mp/net.js` + `mp/coop.js`): "Play with friends" on a map page opens `<map>?lobby=<room>`; that address is
  the invite link. Every page in the room connects to every other one over WebRTC (a reliable "lobby" channel for
  names and status, an unreliable "game" channel for engine packets). The player who joined first hosts (the next one
  takes over if they leave before the start). Everyone presses Play to download while they wait ("Click to start"
  is held until the start); the host presses Start, the host's game holds round 1 until everyone in the start list is
  in (minus anyone who leaves; "Start without them" stops waiting), and the others connect as soon as their map is up.
  Late arrivals join the running game and spawn next round. Names go to the engine's `name` cvar. Max 4 players.
- Signaling (connection setup only): the Metered realtime-messaging WebSocket protocol, Metered's service by default
  (`signal`/`signalKey` in the site's `net-config.json`, a publishable key; built from `mp/net-config.json`, see `mp/net-config.example.json`). `mp/signal-server.mjs` is a dependency-free self-hosted
  server for the same protocol subset (`?signal=wss://host/path`). `?signal=ntfy` uses ntfy pub/sub instead
  (`?ntfy=<url>`; `serve.py` has an ntfy-compatible endpoint at `/bo1z/signal`).
- NAT traversal: STUN plus Metered TURN relays (credentials fetched from `turnApi` in `net-config.json`, or handed out on connect);
  `?relay=1` forces the relay, `?turnapi=0` turns it off.

Build: `cd mp && npm install` once, then `node mp/build.mjs` (writes `overlay/`). `serve.py` serves `overlay/` ahead
of `site/`, and `tools-make-static.py` copies it into `static/`.

Also patched for this (engine.js, both builds): a start-hold race that could leave the game paused after "Click to
start" (the release now repeats if the engine's hold starts late, and a key press skips the engine's copy of the load
cinematic if it still blocks the release 1.5 s later).

## Controller

Pair a controller (Xbox, PlayStation, Switch Pro...) with the computer, open a map, press any button on it, and click
"Click to start" as usual. Keyboard and mouse keep working alongside it. This uses the engine's own controller code:
the PC game's gamepad support survived in the engine (stick movement and aiming with its aim assist in `CL_CreateCmd`,
the `gpad_*` dvars, `bindaxis` and the stick/button configs `thumbstick_default.cfg`/`buttons_default.cfg` in the
fastfiles), but the Windows layer that fed it (XInput polling, `IN_GamepadsMove`, `CL_GamepadButtonEvent`) was gone.

- `mp/kbpad-runtime.js` (injected into the engine loader) reimplements that feeder from the PC source: deadzones and
  trigger thresholds from the `gpad_*` dvars, axis events into the engine's axis bindings, and button events through
  the key bindings (`+attack` with its analog value, the pause menu, menus...). The page thread polls the Gamepad API
  ("standard" layout: the first connected pad) every 8 ms into shared memory; the engine reads it each frame, from
  `BrowserPollInput` (hooked in `mp/patch-wasm.mjs`, which also checks the engine data addresses the runtime uses).
- Default layout (`buttons_default`): RT fire, LT aim, RB lethal grenade, LB special grenade, A jump, B stance, X
  use/reload, Y switch weapon, R3 melee, L3 sprint, D-pad action slots, Start pause menu, Back scoreboard; left stick
  moves, right stick looks.
- `gpad_enabled` (the PC game's "use gamepad" option: sticks count, on-screen hints show controller buttons) follows
  the device in use: on with the controller, off again with a key or mouse press. The first time a pad appears the
  button and stick configs are executed, as the PC game did for a profile with the gamepad on.
- One addition to the PC behaviour: in menus the D-pad and left stick send the arrow keys. The PC menus only move
  between items with the arrow keys or the mouse, so a controller could otherwise only press the first item.
- Left out: rumble (the engine's rumble code is gone), developer chords (devgui on Back+Start, noclip...).
- `?padlog=1` logs controller events (`KBPAD ...`) to the console.

## Static build

    python3 tools-make-static.py    # writes static/ (rebuilds it from scratch)
    tar -cf - --transform 's,^static,bo1z-static,' static | gzip -1 > bo1z-static.tar.gz   # to deploy elsewhere
    tar -cf - --exclude='static/pack' --exclude='static/*/pack' --transform 's,^static,bo1z-static,' static | gzip -9 > bo1z-code.tar.gz   # code only, to update a deploy (docs/deploy-update.txt)

`static/` runs on any static host, with no `serve.py`. Deploy the folder's contents at any path: a domain root or a
subdirectory (open the subdirectory URL with its trailing slash). `index.html` is the map-select screen; the build drops
its `<base href="/bo1z/">`, the only thing that tied the site to `/bo1z/`.
- The pack files are cut into the CDN's layout, `<file>.br/<k>` (plain 8 MiB slices), and `maps.js` points the client
  at them on the same origin. Whole files over 8 MiB (`common_zombie.ff`) are sliced too, with a part list added to
  the copied manifests, so no file is over 25 MiB.
- The landing page links to `<map>.html`, so the host needs no clean-URL routing.
- `serve.py`'s patches (`?cvar.` in `engine.js`, the cinematic copy worker in `artifacts/KisakBlack-web.mjs`, stall reports in `telemetry.js`) are written into the copied files. `site/` is untouched, and
  unchanged files are hard links into it, so only the slices (~9 GB) take extra space.
- The engine loader, engine, `net.js` and `coop.js` are loaded as `...?v=<hash of the build>`, so after an update a
  browser can't mix cached old copies with new ones.
- `_headers` sets COOP/COEP for every path, which the engine needs (SharedArrayBuffer). Cloudflare Pages and Netlify read it; on other
  hosts set those two headers in their config. GitHub Pages can't set headers, and the archive is far over its
  size limit anyway.
- No telemetry endpoint: the client probes it, gets a 404 and turns telemetry off.
