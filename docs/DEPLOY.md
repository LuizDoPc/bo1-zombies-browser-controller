# Deploying from scratch, and changing things

This repository holds only our own code. A deployment is built in three layers:

```
site/      upstream's site, downloaded: pages, loader, engine, shader seeds, art, map packs   (tools-fetch-*.py)
overlay/   our files, plus upstream's engine and loader with our patches applied             (node mp/build.mjs)
static/    site/ + overlay/ + the page patches from serve.py, ready for any web server       (tools-make-static.py)
```

`site/` is never modified. `overlay/` and `static/` can be rebuilt from it at any time.

## What you need

- **Disk:**
  - about 9.3 GB for `site/`, almost all of it the map packs;
  - about 9 GB more for `static/`, where the packs are re-cut into 8 MiB slices. Unchanged files are hard links into
    `site/`, so keep both on the same filesystem.
- **Tools:**
  - Python 3, standard library only;
  - Node.js 18 or newer (tested with 24);
  - npm, for the three build dependencies.
- **A web server:**
  - HTTPS, because browsers turn off WebGPU, SharedArrayBuffer and OPFS on plain `http://` other than localhost;
  - two headers on every file, `Cross-Origin-Opener-Policy: same-origin` and
    `Cross-Origin-Embedder-Policy: require-corp`. The engine needs them for SharedArrayBuffer.
- **Optional, for online co-op:**
  - a signaling service: a [Metered](https://www.metered.ca) account, or your own server with `mp/signal-server.mjs`;
  - a TURN relay: Metered, or your own coturn. Without one, players behind strict NATs or on mobile networks can't
    connect.

  Same-Wi-Fi co-op needs neither.

## 1. Download upstream

    python3 tools-fetch-site.py     # pages, scripts, engine, shader seeds, art, map manifests (~180 MB)
    python3 tools-fetch-packs.py    # the map packs, Hell-mode packs included (831 files, ~9.2 GB); add a number for
                                    # more parallel downloads, e.g. "tools-fetch-packs.py 12"

`tools-fetch-site.py`:
- follows references from the pages, and also starts from the file list the site had on 2026-10-09, because some
  names are only built at runtime (`artifacts/<scenario>-pipelines.json`, the per-map art);
- ends with a list of "references not on the site". These are fragments the crawl guesses from code, and they're
  normal;
- fails only if the engine, the pages or the main manifest are missing.

`tools-fetch-packs.py`:
- stores every pack file decoded, checked against the SHA-256 in its manifest;
- skips files already present and correct, so re-running it resumes an interrupted download or re-verifies one;
- fetches the Hell-mode manifests (`<map>/pack/web-manifest-horde.json`) first, since the map manifests don't list
  them.

Both write into `site/` next to the scripts. `tools-fetch-site.py --out DIR` writes elsewhere, for example to compare
a fresh download with the copy you have.

## 2. Configure and build

    cd mp && npm ci && cd ..
    cp mp/net-config.example.json mp/net-config.json      # then edit; see "Lobby services" below
    node mp/build.mjs

`mp/build.mjs` does the following:
- runs `mp/patch-wasm.mjs`, which patches the engine wasm with binaryen: the network transport, controller input and a
  few crash fixes;
- applies its text patches to the engine loader `artifacts/KisakBlack-web.mjs`;
- copies the co-op files into `overlay/`;
- adds `coop-mod/` (our game-script mod, plus the mod-stack hooks it needs from `site/pack/mods/_stack/`);
- adds the web-app icons (`mp/icons/` if you made one, else `mp/icons-default/`);
- adds `net-config.json`.

If upstream changed something a patch depends on, the build stops with `patch no longer applies: <the text it looked
for>`. See "When upstream updates" below.

**Try it locally** before deploying:

    python3 serve.py            # http://localhost:8000/bo1z/ (port: "serve.py 8080")

`serve.py`:
- serves `overlay/` over `site/`, applies the page patches as it serves, and sends the two headers;
- stands in for upstream's CDN, serving packs from `site/`;
- records the clients' diagnostics to `telemetry.jsonl`.

Flags: `--no-telemetry`, `--no-patches` (serves `site/` exactly as downloaded) and `--quiet`.

From another machine, use an SSH tunnel (`ssh -L 8000:localhost:8000 thehost`, then open localhost) or put HTTPS in
front of it. Plain `http://<lan-ip>:8000` is not a secure context.

## 3. Build the static copy and deploy it

    python3 tools-make-static.py     # rebuilds static/ from scratch

What `static/` contains:
- `site/` with `overlay/` on top, and `serve.py`'s page patches written into the files;
- the packs cut into the CDN's layout, `<file>.br/<k>` (plain 8 MiB slices), with the client pointed at them on the
  same origin, so no file is over 25 MiB;
- `.gz` copies of the large text files, for nginx's `gzip_static`;
- a `_headers` file with COOP/COEP, which Cloudflare Pages and Netlify read.

The engine, loader, `net.js` and `coop.js` load as `...?v=<hash of the build>`, so browsers never mix an old cached
copy with new code.

It runs from any path, a domain root or a subfolder. Open a subfolder with its trailing slash.

**nginx:** `docs/nginx-coop-coep.conf` is a complete `location` block. It sets:
- the two headers;
- `Cache-Control: no-cache` (a cheap 304 when unchanged, and updates apply at once);
- `gzip_static`;
- MIME types, including `.mjs` as `text/javascript`. Stock nginx doesn't know `.mjs`, and browsers refuse the engine
  module served as `application/octet-stream`.

Put the folder on the server:

    rsync -a static/ SERVER:/srv/bo1z/            # first time: everything, packs included (~9 GB)

Check it:
- `curl -sI https://your.domain/bo1z/` prints both `cross-origin-*` headers;
- `curl -sI https://your.domain/bo1z/artifacts/KisakBlack-web.mjs` says `text/javascript`;
- a map loads and plays in Chrome.

**Updating a deployment** only needs the code, because the packs don't change between builds. The commands are in
`docs/deploy-update.txt`: `rsync --exclude='pack/'`, or the code-only `bo1z-code.tar.gz` unpacked over the folder.

## Lobby services (`net-config.json`)

The page reads `net-config.json` next to it at startup. The build copies yours from `mp/net-config.json`, and you can
also edit the copy on the server directly.

| key | what |
|---|---|
| `signal` | signaling WebSocket URL: Metered realtime messaging (`wss://rms.metered.ca/v1`) or your `signal-server.mjs` (`wss://your.domain/bo1z-signal`) |
| `signalKey` | Metered realtime-messaging **publishable** key, with the Subscribe, Publish and Presence permissions; `signal-server.mjs` ignores it |
| `turnApi` | URL returning an `iceServers` list (Metered's TURN credentials API: `https://<app>.metered.live/api/v1/turn/credentials?apiKey=...`), fetched when a page opens |
| `turn` | a fixed TURN server instead or as well: `{ "urls": "turn:host:3478", "username": "u", "credential": "p" }` |
| `ntfy` | ntfy server for `?signal=ntfy` (default `https://ntfy.sh`) |

**Every value ends up in the browser**, so use only keys that are public by design:
- the signaling key is publishable;
- the TURN credentials endpoint only hands out short-lived relay logins. Its cost is relay bandwidth billed to your
  account, so set a usage limit there.

**Without the file**, online lobbies say "This site has no lobby service set up". Solo play and same-Wi-Fi co-op work
regardless.

**Self-hosting instead of Metered:**
- signaling: `docs/signal-server-setup.txt`. `mp/signal-server.mjs` has no dependencies, speaks the same protocol
  subset, and runs behind nginx as a WebSocket location;
- TURN: `docs/turn-setup.txt`, using coturn;
- ntfy: `docs/ntfy-setup.txt`.

Before switching everyone over, try a server out with `?signal=wss://...` in a lobby link; everyone in the lobby must
use the same one.

**Telemetry** (optional): `docs/telemetry-setup.txt`. Without an endpoint, the client probes `telemetry`, gets a 404
and stays quiet.

## When upstream updates

1. Re-run `tools-fetch-site.py` and `tools-fetch-packs.py`. The packs only re-download what changed.
2. Run `node mp/build.mjs`. If a patch no longer applies, the error quotes the text it looked for. Find the same spot
   in the new file and update the patch's match string and replacement (see "How the patches work" below), or drop
   the patch if upstream fixed the issue itself.
3. Run `python3 serve.py` and play: solo, an online lobby with two browsers, and a controller if you use one.
4. Rebuild `static/` and deploy.

`mp/patch-wasm.mjs` finds engine functions by name in the wasm's name section. A rebuilt upstream engine usually keeps
its names, but if a function was renamed or restructured, the patch stops with a message saying which one.

## Changing things

### Where things are

| file | what |
|---|---|
| `mp/net.js` | page-side networking: lobby, WebRTC connections, signaling, and moving game packets between the engine and the data channels |
| `mp/coop.js` | the UI added to the map pages: Play solo / Play with friends, the lobby panel, invite codes and QR codes, Options, controller navigation of the menus, offline play |
| `mp/kbnet-runtime.js` | engine-side networking, injected into the loader: packet rings in the shared wasm memory, behind the imports `patch-wasm.mjs` adds |
| `mp/kbpad-runtime.js` | controller support, injected into the loader: reads the Gamepad API into the engine's own (PC) gamepad code |
| `mp/patch-wasm.mjs` | the wasm patches: network hooks, the controller hook, `KB_Cbuf` (console commands from JS), and fixes for asserts and crashes seen in co-op |
| `mp/build.mjs` | the loader text patches (Safari/JSPI, renderer fixes, loading-video fix, debugging switches) and the overlay build |
| `mp/jspi-polyfill.js` | runs the engine on browsers without JSPI (Safari) |
| `mp/sw.js` | the service worker for per-map offline play |
| `mp/shader-debug.js` | opt-in WGSL rewrites for chasing Safari rendering bugs (`?nanDebug=`, `?safeMath=`) |
| `mp/mods/kbcoop/` | game-script mod: players joining a game in progress spectate, then respawn at the end of the round |
| `mp/signal-server.mjs` | self-hosted signaling server |
| `serve.py` | the local server, and `PATCHES`: text patches to upstream's pages and scripts (`engine.js`, `play.js`, `landing.js`, `telemetry.js`, `canvas.js`, `capabilities.js`, `audio-worklet.js`) |
| `tools-make-static.py` | the static build |
| `docs/notes-multiplayer.md` | design notes on co-op |

### How the patches work

Upstream's code is never edited in place. Every change is "find this exact text, replace it with that":
- **loader** (`artifacts/KisakBlack-web.mjs`): `patch(mjs, old, new)` in `mp/build.mjs`. `old` must occur exactly
  once, or the build stops.
- **other upstream files**: `PATCHES` in `serve.py`, a list of `(old, new)` pairs per file. `serve.py` applies them
  when serving, and `tools-make-static.py` writes them into `static/`.
- **engine** (`artifacts/KisakBlack-web.wasm`): `mp/patch-wasm.mjs` edits the compiled code with binaryen. It adds
  imports and exports, and wraps or redirects calls inside named functions.

To add a patch:
1. Find a short, distinctive piece of the original. Upstream ships these files minified, so search the file in
   `site/`.
2. Add the pair to `mp/build.mjs` or `serve.py`, with a comment on why.
3. Rebuild and reload.

Prefer behaviour behind a URL switch (`/[?&]name=1/.test(qs)` in the loader, or `URLSearchParams` in page code) when
you're testing something, or when it changes defaults.

Code that has to run inside the engine's threads goes into the loader. The runtime files are concatenated into it
by `mp/build.mjs`. The renderer runs in its own worker on WebGPU's pipelined path, and that worker only sees what the
loader puts into its source (see `kbInvariant` and `kbShaderRewrite` in `mp/build.mjs`).

### Game-script mods

The engine reads mods from the map's browser storage (OPFS) at `files/mods/<name>/` when they're listed in
`fs_mods`. `coop.js` writes `mp/mods/` there on co-op pages and adds `kbcoop` to `fs_mods` (the `engine.js` patch in
`serve.py`), so solo games stay retail.

A mod hooks in from `maps/<mod>/_hooks.gsc`:

    register() { maps\_modstack::add( "_zombiemode_ffotd::main_end", maps\yourmod\_yourmod::main_end ); }

This uses the site's mod stack (`pack/mods/_stack/maps/_modstack.gsc`). A script compile error stops the map with the
engine's error, and the browser console has the details.

### Debugging switches

All are off by default, set from the page URL:
- `?cvar.<name>=<value>` sets an engine cvar, e.g. `?cvar.sm_enable=0` turns shadows off;
- `?renderer=webgl2` uses the WebGL2 renderer instead of WebGPU;
- `?padlog=1` logs controller events;
- `?relay=1` forces the TURN relay;
- `?signal=manual` gives a same-Wi-Fi lobby while online.

Renderer:
- `?gpuProbe=1`: lists drawn shaders, skips chosen ones, traces passes (BroadcastChannel `kbprobe`);
- `?nanDebug=1`: colours pixels that became NaN by the operation that caused it;
- `?safeMath=1`: guards fast-math special cases;
- `?invariant=1`, `?noCache=1`, `?proxyAlways=1`, `?depthBias=<x>`, `?noArenas=1`.

The comments in `mp/build.mjs` explain each one.

The page defines `kbCmd('<console command>')` once the engine is up, e.g. `kbCmd('set r_fullbright 1')`.

### Testing tips

- **Headless Chromium can't present WebGPU frames.** Screenshots come out black even though the game runs. For
  screenshots, run headful under Xvfb with `--enable-unsafe-webgpu --enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan
  --use-angle=vulkan --ignore-gpu-blocklist`.
- **Two browser profiles** in one machine make a working online lobby, which is enough to test co-op.
- **Telemetry:** with `serve.py` running, `telemetry.jsonl` collects each client's errors, the engine log tail on a
  crash, and frame stats.
