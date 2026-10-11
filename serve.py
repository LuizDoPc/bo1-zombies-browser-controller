#!/usr/bin/env python3
# Local server for the archived https://vel.gg/bo1z mirror in site/. Run: python3 serve.py [port], open
# http://localhost:8000/bo1z/ in a browser with WebGPU (Chrome/Edge). Stands in for the site's Cloudflare Worker:
#   - cross-origin isolation headers (the engine uses SharedArrayBuffer/pthreads)
#   - clean page URLs (/bo1z/kino -> kino.html)
#   - pack transport parts: <pack file>?part=k is bytes [k*chunk, (k+1)*chunk) of the archived original file
#   - Range requests (load cinematics)
#   - /bo1z/telemetry: the client's diagnostics (telemetry.js), appended as JSON lines to telemetry.jsonl;
#     pass --no-telemetry to turn it off
#   - ?cvar.<name>=<value> on a map page sets an engine cvar at startup (engine.js patch), e.g. ?cvar.r_picmip=1
#   - overlay/ (built by mp/build.mjs: multiplayer wasm/loader/net.js) is served ahead of site/
#   - /bo1z/signal/: WebRTC signaling for net.js, a small subset of the ntfy pub/sub API (POST /signal/<topic>,
#     GET /signal/<topic>[,<topic>...]/sse?since=<unix time>, GET /signal/<topic>/json?poll=1)
#   - ?lobby=<room> on a map page: co-op lobby (coop.js/net.js); kbCmd('<console command>') runs engine commands
#   --no-patches serves every file exactly as archived
import os, re, sys, json, time, threading, mimetypes
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlsplit, unquote, parse_qs
SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'site')
OVERLAY = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'overlay')
PREFIX = '/bo1z/'
TELEMETRY = None if '--no-telemetry' in sys.argv else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'telemetry.jsonl')
telemetry_lock = threading.Lock()
# Patches applied to files as they are served: path under site/ -> [(old, new)]. Each old string must occur once.
PATCHES = {} if '--no-patches' in sys.argv else {
    'engine.js': [
                  # co-op game-script fixes (coop.js: globalThis.__kbMods, the kbcoop mod) stack on top of the player's mods
                  ("    else if (settings.mods?.length) args.splice(args.indexOf('+devmap'), 0, '+set', 'fs_mods', settings.mods.join(' '));",
                   "    else if (settings.mods?.length) args.splice(args.indexOf('+devmap'), 0, '+set', 'fs_mods', settings.mods.join(' '));"
                   " if (globalThis.__kbMods?.length) { const i = args.lastIndexOf('fs_mods');"
                   " if (i > 0 && args[i - 1] === '+set') args[i + 1] = [args[i + 1], ...globalThis.__kbMods].join(' ');"
                   " else args.splice(args.indexOf('+devmap'), 0, '+set', 'fs_mods', globalThis.__kbMods.join(' ')); }"),
                  # ?cvar.<name>=<value> passes "+set <name> <value>" to the engine (before devmap), e.g. ?cvar.r_picmip=1
                  ("'+set', 'r_customMode', `${canvas.width}x${canvas.height}`);",
                   "'+set', 'r_customMode', `${canvas.width}x${canvas.height}`);"
                   # page options (coop.js: Low graphics / Flat lighting) as globalThis.__kbCvars, before ?cvar. so the URL wins;
                   # null resets the cvar to its default (the engine saves archived cvars, so turning an option off must undo it)
                   " for (const [k, v] of Object.entries(globalThis.__kbCvars ?? {})) args.splice(args.indexOf('+devmap'), 0, ...(v === null ? ['+reset', k] : ['+set', k, String(v)]));"
                   " for (const [k, v] of new URLSearchParams(location.search)) if (/^cvar\\.\\w+$/.test(k))"
                   " args.splice(args.indexOf('+devmap'), 0, '+set', k.slice(5), v);"
                   # co-op: the lobby name (net.js) is the player's name from the start
                   " if (globalThis.kbnet?.me?.name) args.splice(args.indexOf('+devmap'), 0, '+set', 'name', globalThis.kbnet.me.name);"),
                  # multiplayer: kbCmd() for console commands; on a co-op page (?lobby=, or the old ?host=/?join=) the
                  # lobby (net.js) gets the engine
                  ("    state.timings.wasmReady = performance.now();",
                   "    state.timings.wasmReady = performance.now();"
                   " globalThis.kbCmd = text => import('./net.js').then(n => n.cmd(module, text)); globalThis.__kbState = state; globalThis.__kbModule = module;"
                   " if (/[?&](lobby|host|join)=/.test(location.search)) import('./net.js').then(n => n.attach(module));"),
                  # a controller press on "Click to start" (coop.js) is no user gesture: start without the pointer lock and
                  # without waiting for audio, which resumes on the next click, tap or key (engine.js has CRLF line endings)
                  ("      const lock = input.lock();\r\n      const audio = context.resume();\r\n      try {\r\n        await Promise.all([lock, audio]);",
                   "      const gesture = !globalThis.__kbPadPress && (navigator.userActivation?.isActive ?? true);\r\n      const lock = gesture && !globalThis.__kbNoPointerLock ? input.lock() : Promise.resolve();\r\n"
                   "      const audio = context.resume();\r\n"
                   "      if (!gesture) for (const type of ['pointerdown', 'keydown']) addEventListener(type, () => context.resume(), { once: true });\r\n"
                   "      try {\r\n        await Promise.all([lock, gesture ? audio : null]);"),
                  # the audio worklet node is created once its module has loaded; a start before that (or a browser that refused
                  # the worklet) ran into "audioNode.port" on undefined: start silent instead, and log it
                  ("      ++audioGeneration;\r\n      if (nativeAudio) {",
                   "      ++audioGeneration;\r\n      if (nativeAudio && !audioNode) log('KISAK_BROWSER audio-worklet missing at start: playing without sound', true);\r\n"
                   "      if (nativeAudio && audioNode) {"),
                  # start-hold race: a release sent before the engine reached its intro hold was lost and the game stayed
                  # paused ("playing" page, paused=1). Re-send it when the hold begins after the page already released.
                  ("    if (/KISAK_BROWSER intro-(hold|release)/.test(message)) state.timings[/hold/.test(message) ? 'introHeld' : 'introRun'] ??= performance.now();",
                   "    if (/KISAK_BROWSER intro-(hold|release)/.test(message)) state.timings[/hold/.test(message) ? 'introHeld' : 'introRun'] ??= performance.now();"
                   " if (/KISAK_BROWSER intro-hold/.test(message) && state.introReleased) module?._KB_Input(7, 1, 0);"),
                  # The engine also keeps the hold while its own copy of the load cinematic runs; skipping the page's video
                  # (start clicked before it ended) left that one running and the game paused. If the engine hasn't
                  # released 1.5 s after the page did, press a key: the engine skips its cinematic on a key (CL_KeyEvent).
                  ("state.introReleased = true; state.timings.introRelease = performance.now(); module._KB_Input(7, 1, 0);",
                   "state.introReleased = true; state.timings.introRelease = performance.now(); module._KB_Input(7, 1, 0);"
                   " setTimeout(() => { if (!state.timings.introRun && module) { module._KB_Input(0, 13, 1); module._KB_Input(0, 13, 0); } }, 1500);")],
    # multiplayer: co-op UI (Options "Host co-op", host/join banners)
    'play.js': [("import { map, packBase, workerUrl, BASE, horde as hordePage } from './maps.js';",
                 "import { map, packBase, workerUrl, BASE, horde as hordePage } from './maps.js'; import('./coop.js');"),
                # no-JSPI browsers (Safari): install the JSPI polyfill (mp/jspi-polyfill.js) before capabilities.js checks for it
                ("import { createEngine, rendererRoute, rendererChoice, glslPack } from './engine.js';",
                 "import './jspi-polyfill.js'; import { createEngine, rendererRoute, rendererChoice, glslPack } from './engine.js';"),
                # the map page waits for an explicit "Play solo" / "Play with friends" (coop.js): no start right after a pick
                # on the map list, and no "any key / click starts" on the landing screen ("Click to start" keeps it)
                ("      if (globalThis.__kisakLandingPick) { delete globalThis.__kisakLandingPick; begin(); }",
                 "      delete globalThis.__kisakLandingPick;"),
                ("  if (!['landing', 'ready'].includes(state.screen) || play.hidden || play.disabled) return false;",
                 "  if (state.screen !== 'ready' || play.hidden || play.disabled) return false;"),
                # a controller press on "Click to start" (coop.js sets __kbPadPress) starts without capturing the mouse
                ("  locking = true; play.disabled = true;", "  locking = true; play.disabled = true; const padPress = !!globalThis.__kbPadPress || !!globalThis.__kbNoPointerLock;"),
                ("    if (document.pointerLockElement !== canvas) throw new Error('The mouse was not captured.');",
                 "    if (!padPress && document.pointerLockElement !== canvas) throw new Error('The mouse was not captured.');")],
    # controller on the map list: D-pad / left stick up and down move between the maps and the Hell mode toggle, A picks
    'landing.js': [("addEventListener('popstate', () => location.reload());",
                    "addEventListener('popstate', () => location.reload());"
                    " { const items = () => [...stage.querySelectorAll('a[data-pick]'), toggle]; let held = { a: true, move: true }, repeatAt = 0, running = false;"
                    " const poll = now => { requestAnimationFrame(poll); if (picked) return;"
                    " const pad = [...(navigator.getGamepads?.() ?? [])].find(p => p && p.connected); if (!pad) return;"
                    " const button = i => !!pad.buttons[i]?.pressed, y = pad.axes[1] ?? 0, up = button(12) || y < -0.5, down = button(13) || y > 0.5, a = button(0);"
                    " const list = items(); let i = list.indexOf(document.activeElement);"
                    " if (i < 0) i = Math.max(0, list.findIndex(e => e.dataset?.pick === selected?.id));"
                    " if ((up || down) && now >= repeatAt) { i = (i + (down ? 1 : -1) + list.length) % list.length; list[i].focus(); repeatAt = now + (held.move ? 180 : 400); }"
                    " if (!up && !down) repeatAt = 0;"
                    " if (a && !held.a) list[i].click();"
                    " held = { a, move: up || down }; };"
                    " const start = () => { if (!running) { running = true; requestAnimationFrame(poll); } };"
                    " addEventListener('gamepadconnected', start); if ([...(navigator.getGamepads?.() ?? [])].some(Boolean)) start(); }")],

    'artifacts/KisakBlack-web.mjs': [
                  # Kino/Moon WebGPU load freeze: kbVideo copied each cinematic frame into the wasm heap on the main thread, and
                  # VideoFrame.copyTo of a GPU-decoded frame is a synchronous GPU readback (RasterImplementation::ReadbackImagePixels).
                  # While the GPU process is busy compiling the WebGPU executor's pipelines (cold shader cache), every readback
                  # blocked the page for seconds, and the engine's proxied calls to the main thread with it. The copy now runs in
                  # its own worker (VideoFrame is transferable, the heap is shared); same busy-bit protocol (w[0] odd while
                  # copying). Without a worker it falls back to the original main-thread copy.
                  # Chrome/macOS: the engine stalled when the cinematic closed, because close() waits for the busy bit and a copy
                  # never finished. Closing a slot now aborts a pending copy (terminates the worker, clears the bit), and a copy
                  # that hasn't finished in 5 s does the same; after 10 of those, cinematic frames are no longer copied.
                  # globalThis.__kbVideoDiag() reports the copier and slot state.
                  ("let scratch=null,scratchCtx=null;async function copyFrame(s,now,meta){",
                   "let copier,copyId=0;const copying=new Map();"
                   "const copierMain=()=>{let scratch=null,scratchCtx=null;onmessage=async e=>{const m=e.data,frame=m.frame,t0=performance.now();let w=null,err=null,fmt=null;"
                   "try{w=new Int32Array(m.buffer,m.shared,10);fmt=frame.format;const width=m.width,height=m.height,cw=width>>1,ch=height>>1,dst=new Uint8Array(m.buffer,m.dst,width*height+2*cw*ch);"
                   "if(frame.format===\"I420\"&&frame.visibleRect?.width===width&&frame.visibleRect?.height===height){await frame.copyTo(dst,{rect:frame.visibleRect,layout:[{offset:0,stride:width},{offset:width*height,stride:cw},{offset:width*height+cw*ch,stride:cw}]})}"
                   "else if(frame.format===\"NV12\"&&frame.visibleRect?.width===width&&frame.visibleRect?.height===height){const tmp=new Uint8Array(width*height+2*cw*ch);await frame.copyTo(tmp,{rect:frame.visibleRect,layout:[{offset:0,stride:width},{offset:width*height,stride:width}]});dst.set(tmp.subarray(0,width*height));for(let i=0,uv=width*height,cb=width*height,cr=cb+cw*ch;i<cw*ch;++i)dst[cb+i]=tmp[uv+2*i],dst[cr+i]=tmp[uv+2*i+1]}"
                   "else{if(!scratch||scratch.width!==width||scratch.height!==height){scratch=new OffscreenCanvas(width,height);scratchCtx=scratch.getContext(\"2d\",{willReadFrequently:true})}scratchCtx.drawImage(frame,0,0,width,height);const rgb=scratchCtx.getImageData(0,0,width,height).data,cb=width*height,cr=cb+cw*ch;for(let y=0;y<height;++y)for(let x=0;x<width;++x){const p=(y*width+x)*4,r=rgb[p],g=rgb[p+1],b=rgb[p+2];dst[y*width+x]=16+.257*r+.504*g+.098*b|0;if(!(x&1)&&!(y&1)){const c=(y>>1)*cw+(x>>1);dst[cb+c]=128-.148*r-.291*g+.439*b|0;dst[cr+c]=128+.439*r-.368*g-.071*b|0}}}"
                   "w[1]=m.frameNo}catch(e){err=String(e?.message??e)}finally{try{frame.close()}catch{}if(w)Atomics.store(w,0,m.seq+2);postMessage({id:m.id,err,fmt,ms:Math.round(performance.now()-t0)})}}};"
                   "const copyStat={done:0,failed:0,timeouts:0,lastErr:null,lastFmt:null,maxMs:0};"
                   "const copyRelease=()=>{for(const c of copying.values()){clearTimeout(c.timer);Atomics.store(c.w,0,c.seq+2)}copying.clear()};"
                   "const copyAbort=why=>{if(!copying.size)return;console.warn(\"[kbVideo] frame copy \"+why+\"; restarting the copy worker\");"
                   "try{copier?.terminate()}catch{}copier=copyStat.timeouts>=10?\"off\":undefined;copyRelease()};"
                   "const copyTimeout=id=>{if(!copying.has(id))return;++copyStat.timeouts;copyAbort(\"stuck for 5 s\")};"
                   "globalThis.__kbVideoDiag=()=>({copier:copier===undefined?\"none\":copier===null?\"failed\":copier===\"off\"?\"off\":\"ok\",sent:copyId,...copyStat,"
                   "pending:[...copying.values()].map(c=>({ageMs:Math.round(performance.now()-c.t),seq:c.seq})),"
                   "slots:slots.map((s,i)=>s&&{i,closed:s.closed,w:Array.from(words(s)),t:s.video?.currentTime,paused:s.video?.paused,ended:s.video?.ended,rs:s.video?.readyState,src:String(s.video?.currentSrc??\"\").slice(-50)})});"
                   "function copyOff(s,meta){if(copier===\"off\")return true;if(copier===undefined){copier=null;try{copier=new Worker(URL.createObjectURL(new Blob([\"(\"+copierMain+\")()\"],{type:\"text/javascript\"})),{name:\"kbVideo-copy\"});"
                   "copier.onmessage=e=>{const r=e.data,c=copying.get(r.id);if(c){clearTimeout(c.timer);copying.delete(r.id)}++copyStat.done;copyStat.lastFmt=r.fmt;copyStat.maxMs=Math.max(copyStat.maxMs,r.ms);if(r.err){++copyStat.failed;copyStat.lastErr=r.err;console.warn(\"[kbVideo] frame copy failed\",r.err)}};"
                   "copier.onerror=e=>{console.warn(\"[kbVideo] copy worker failed\",e.message);copier=null;copyRelease()}}"
                   "catch(e){console.warn(\"[kbVideo] copy worker unavailable\",e)}}if(!copier)return false;"
                   "const w=words(s);if(s.closed||Atomics.load(w,0)&1)return true;const t=meta?.mediaTime??s.video.currentTime;let frame;"
                   "try{frame=new VideoFrame(s.video,{timestamp:Math.round(t*1e6)})}catch(e){return false}"
                   "const seq=Atomics.load(w,0),id=++copyId;Atomics.store(w,0,seq+1);copying.set(id,{w,seq,t:performance.now(),timer:setTimeout(copyTimeout,5000,id)});"
                   "try{copier.postMessage({id,frame,buffer:wasmMemory.buffer,shared:s.shared,dst:w[7],width:w[5],height:w[6],seq,frameNo:Math.max(1,Math.min(s.frames,Math.round(t*s.fps)+1))},[frame])}"
                   "catch(e){clearTimeout(copying.get(id)?.timer);copying.delete(id);frame.close();Atomics.store(w,0,seq);return false}return true}"
                   "function copyFrame(s,now,meta){return copyOff(s,meta)?Promise.resolve():copyFrameMain(s,now,meta)}"
                   "let scratch=null,scratchCtx=null;async function copyFrameMain(s,now,meta){"),
                  ("const ack=()=>Atomics.load(words(s),0)&1?setTimeout(ack,5):words(s)[4]=4",
                   "const ack=()=>Atomics.load(words(s),0)&1?(copyAbort(\"pending at close\"),setTimeout(ack,5)):words(s)[4]=4")],
    # Stall reports: after 2 periods (20 s) with no presented frames, the periodic record also carries the engine log tail
    # and the cinematic copy state (sent at most 3 times), so a load that stops can be diagnosed from telemetry.jsonl.
    'telemetry.js': [("    send('periodic', { frames: drainFrames(), ...sample() });",
                      "    const frames = drainFrames(); quietPeriods = frames && frames.count === 0 ? quietPeriods + 1 : 0;"
                      " const stall = quietPeriods >= 2 && quietPeriods % 2 === 0 && stallsSent < 3 ? (++stallsSent, { stall: { log: tail(),"
                      " video: (() => { try { return globalThis.__kbVideoDiag?.() ?? null; } catch (error) { return { error: String(error) }; } })(),"
                      " timings: state.timings } }) : {};"
                      # audioRing: when the audio at the mixer ring's read position is due to play, relative to now (about 0 when
                      # healthy; about -1370 ms if the worklet reads one 65536-frame lap behind), for the Safari audio delay
                      " const audioRing = (() => { try { const m = globalThis.__kbModule, b = m.HEAPF32.buffer, l = new Uint32Array(b, m._KB_AudioRing(), 7);"
                      " const cap = l[0], read = new Uint32Array(b, l[2], 1)[0], write = new Uint32Array(b, l[3], 1)[0], mix = new Float64Array(b, l[5], cap), now = Date.now();"
                      " return { queued: write - read, dueAtReadMs: Math.round(mix[read % cap] - now), dueAtNewestMs: Math.round(mix[(write - 1) % cap] - now),"
                      " dueHalfLapAheadMs: Math.round(mix[(read + cap / 2) % cap] - now) }; } catch (error) { return { error: String(error) }; } })();"
                      # pad: what the Gamepad API reports (stale timestamp = Safari stopped updating it) and what the engine
                      # has (gpad_enabled/present, the pad state kbpad-runtime fills), for controllers that stop working
                      " const pad = (() => { try { const all = [...(navigator.getGamepads?.() ?? [])], g = all.find(p => p && p.connected);"
                      " return { slots: all.map(p => p ? (p.connected ? 'c' : 'd') : '-').join(''), id: g?.id ?? null, mapping: g?.mapping ?? null,"
                      " ageMs: g ? Math.round(performance.now() - g.timestamp) : null, pressed: g ? g.buttons.map((b, i) => b.pressed ? i : -1).filter(i => i >= 0) : null,"
                      " axes: g ? Array.from(g.axes, a => Math.round(a * 100) / 100) : null, engine: globalThis.__kbpad?.pad?.() ?? null,"
                      " hidden: document.hidden }; } catch (error) { return { error: String(error) }; } })();"
                      " send('periodic', { frames, ...sample(), ...stall, audioRing, pad });"),
                     ("  function periodic() {", "  let quietPeriods = 0, stallsSent = 0;\n  function periodic() {")],
    # Audio latency cap: on Safari the mixer's ring held a constant ~1 s backlog (rendered ahead before output started,
    # then kept at that size). More than 200 ms queued: skip ahead and keep the newest 50 ms. Normal play holds ~50 ms.
    # Low graphics (coop.js) caps the render resolution: canvas.js sizes the game at window size x devicePixelRatio
    # (up to 1920x1440, so about 2x on a Retina Mac); globalThis.__kbMaxDensity caps that density.
    'canvas.js': [("  const density = Math.min(devicePixelRatio || 1, 1920 / width, 1440 / height);",
                   "  const density = Math.min(devicePixelRatio || 1, 1920 / width, 1440 / height, globalThis.__kbMaxDensity ?? Infinity);")],
    # Phones and tablets: no touch controls, so they still need a controller. With one connected (or remembered for
    # this tab after one appeared on the "Desktop required" screen, coop.js), or with ?mobile=1, the check passes.
    'capabilities.js': [("  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||",
                         "  let kbController = false; try { kbController = sessionStorage.getItem('bo1z-controller') === '1'"
                         " || new URLSearchParams(location.search).get('mobile') === '1' || [...(navigator.getGamepads?.() ?? [])].some(Boolean); } catch { /* storage off */ }\n"
                         # no pointer lock (iPhone): no-op stand-ins, since input.js/play.js call them (canvas taps re-lock), and
                         # __kbNoPointerLock tells engine.js/play.js that a start without the mouse captured is fine
                         "  if (!Element.prototype.requestPointerLock) { globalThis.__kbNoPointerLock = true; Element.prototype.requestPointerLock = function () { return Promise.resolve(); }; }\n"
                         "  if (!Document.prototype.exitPointerLock) Document.prototype.exitPointerLock = function () {};\n"
                         "  if (!kbController && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||"),
                        ("      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))",
                         "      !kbController && (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))"),
                        ("    return { kind: 'mobile', message: 'Five is built for a desktop computer with a keyboard and mouse. Open this link in a current Chrome, Edge or Firefox on your desktop.' };",
                         "    return { kind: 'mobile', message: 'Five is built for a desktop computer with a keyboard and mouse. On this device, connect a game controller and press a button on it to play, or open this link on a desktop.' };"),
                        # with a controller, pointer lock (mouse aiming) isn't needed
                        ("    [Element.prototype.requestPointerLock && Document.prototype.exitPointerLock, 'pointer lock for mouse aiming'],",
                         "    [kbController || !globalThis.__kbNoPointerLock, 'pointer lock for mouse aiming'],")],
    'audio-worklet.js': [("    const fill = this.monotonic ? (write - read) >>> 0 : (write - read + this.capacity) % this.capacity;",
                          "    let fill = this.monotonic ? (write - read) >>> 0 : (write - read + this.capacity) % this.capacity;"
                          " if (fill > 9600) { const skip = fill - 2400; read = this.monotonic ? (read + skip) >>> 0 : (read + skip) % this.capacity;"
                          " fill -= skip; this.port.postMessage({ type: 'discarded', frames: skip }); }")],
}
# Home-screen web app (Share > Add to Home Screen on iPad/iPhone): it runs without Safari's interface, which otherwise
# takes a controller over after a while (switching tabs, focusing the address bar). mp/app.webmanifest + mp/icons.
WEBAPP_HEAD = ('<meta name="theme-color" content="#000000">',
               '<meta name="theme-color" content="#000000"><link rel="manifest" href="app.webmanifest">'
               '<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">'
               '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">'
               '<meta name="apple-mobile-web-app-title" content="Zombies"><link rel="apple-touch-icon" href="icons/icon-180.png">')
if PATCHES:
    for page in ('index.html', 'kino.html', 'five.html', 'riese.html', 'nacht.html', 'verruckt.html', 'shinonuma.html',
                 'ascension.html', 'cotd.html', 'shangrila.html', 'moon.html'):
        PATCHES.setdefault(page, []).append(WEBAPP_HEAD)
# Signaling (ntfy subset): topic -> [message dicts], kept 10 minutes
signal_topics, signal_cond, signal_seq = {}, threading.Condition(), [0]

def patched(full):
    # the same patch table applies whether the file comes from overlay/ or site/
    rel = os.path.relpath(full, OVERLAY if full.startswith(OVERLAY + os.sep) else SITE).replace(os.sep, '/')
    if rel not in PATCHES: return None
    raw = open(full, 'rb').read()
    try: text, encoding = raw.decode('utf-8'), 'utf-8'
    except UnicodeDecodeError: text, encoding = raw.decode('latin-1'), 'latin-1'  # landing.js ("Verr\xfcckt")
    for old, new in PATCHES[rel]:
        if text.count(old) != 1: raise RuntimeError(f'patch for {rel} no longer applies: {old!r}')
        text = text.replace(old, new)
    return text.encode(encoding)
CHUNK = 8388608  # manifest "transport": {"chunk": 8388608}
TYPES = {'.webmanifest': 'application/manifest+json', '.png': 'image/png', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json',
         '.webp': 'image/webp', '.webm': 'video/webm', '.css': 'text/css', '.html': 'text/html; charset=utf-8'}

class H(BaseHTTPRequestHandler):
    def headers_common(self, ctype, length):
        self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(length))
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Accept-Ranges', 'bytes'); self.send_header('Cache-Control', 'no-cache')

    def resolve(self, path):
        if path in ('/', '/bo1z'): return 'redirect'
        if not path.startswith(PREFIX): return None
        raw = unquote(path[len(PREFIX):])
        if '\\' in raw or ':' in raw: return None  # Windows drive/UNC paths are not URLs in the game tree
        rel = os.path.normpath(raw or 'index.html').lstrip('/')
        if rel.startswith('..'): return None
        full = os.path.join(OVERLAY, rel)
        if not os.path.isfile(full): full = os.path.join(SITE, rel)
        if os.path.isdir(full): full = os.path.join(full, 'index.html') if os.path.exists(os.path.join(full, 'index.html')) else full + '.html'
        if not os.path.isfile(full) and os.path.isfile(full + '.html'): full += '.html'
        return full if os.path.isfile(full) else None

    def do_POST(self):
        if (m := re.fullmatch(re.escape(PREFIX) + r'signal/([\w-]{1,80})', urlsplit(self.path).path)):
            body = self.rfile.read(min(int(self.headers.get('Content-Length') or 0), 65536)).decode('utf-8', 'replace')
            with signal_cond:
                signal_seq[0] += 1
                now = time.time()
                msg = {'id': f'{signal_seq[0]:x}', 'time': int(now), 'event': 'message', 'topic': m.group(1), 'message': body}
                for t, q in list(signal_topics.items()):
                    q[:] = [x for x in q if x['time'] > now - 600]
                    if not q: del signal_topics[t]
                signal_topics.setdefault(m.group(1), []).append(msg)
                signal_cond.notify_all()
            out = json.dumps(msg).encode()
            self.send_response(200); self.headers_common('application/json', len(out)); self.end_headers(); self.wfile.write(out); return
        if urlsplit(self.path).path == PREFIX + 'telemetry':
            body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
            if TELEMETRY:
                with telemetry_lock, open(TELEMETRY, 'ab') as f: f.write(body.replace(b'\n', b' ') + b'\n')
            self.send_response(204); self.end_headers(); return
        self.send_error(405)

    def do_HEAD(self): self.do_GET(head=True)

    def do_GET(self, head=False):
        url = urlsplit(self.path)
        if (m := re.fullmatch(re.escape(PREFIX) + r'signal/([\w,-]{1,400})/(sse|json)', url.path)):
            topics, since = m.group(1).split(','), int(parse_qs(url.query).get('since', ['0'])[0] or 0)
            pick = lambda after: sorted((x for t in topics for x in signal_topics.get(t, []) if x['time'] >= since and int(x['id'], 16) > after), key=lambda x: int(x['id'], 16))
            if m.group(2) == 'json':  # poll (net.js only uses it to detect this server)
                with signal_cond: body = ''.join(json.dumps(x) + '\n' for x in pick(0)).encode()
                self.send_response(200); self.headers_common('application/x-ndjson', len(body)); self.end_headers()
                if not head: self.wfile.write(body)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream'); self.send_header('Cache-Control', 'no-cache')
            self.send_header('Cross-Origin-Resource-Policy', 'same-origin'); self.end_headers()
            if head: return
            last = 0
            try:
                self.wfile.write(b'event: open\ndata: {"event":"open"}\n\n'); self.wfile.flush()
                while True:
                    with signal_cond:
                        signal_cond.wait_for(lambda: pick(last), timeout=25)
                        msgs = pick(last)
                    for x in msgs: last = int(x['id'], 16); self.wfile.write(b'data: ' + json.dumps(x).encode() + b'\n\n')
                    if not msgs: self.wfile.write(b'event: keepalive\ndata: {"event":"keepalive"}\n\n')
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError): pass
            self.close_connection = True
            return
        if url.path == PREFIX + 'telemetry':
            body = json.dumps({'enabled': bool(TELEMETRY), 'build': 'bo1z-archive'}).encode()
            self.send_response(200); self.headers_common('application/json', len(body)); self.end_headers()
            if not head: self.wfile.write(body)
            return
        full = self.resolve(url.path)
        if full == 'redirect':
            self.send_response(302); self.send_header('Location', PREFIX); self.end_headers(); return
        if not full: self.send_error(404); return
        data = patched(full)
        size = len(data) if data is not None else os.path.getsize(full); start, end = 0, size
        part = parse_qs(url.query).get('part')
        status = 200
        if part is not None:
            k = int(part[0]); start, end = k * CHUNK, min(size, (k + 1) * CHUNK)
            if start >= size: self.send_error(416); return
        elif (m := re.match(r'bytes=(\d*)-(\d*)$', self.headers.get('Range', ''))):
            a, b = m.groups()
            if a: start, end = int(a), (int(b) + 1 if b else size)
            else: start, end = size - int(b), size
            end = min(end, size); status = 206
        ext = os.path.splitext(full)[1]
        self.send_response(status)
        self.headers_common(TYPES.get(ext) or mimetypes.guess_type(full)[0] or 'application/octet-stream', end - start)
        if status == 206: self.send_header('Content-Range', f'bytes {start}-{end - 1}/{size}')
        self.end_headers()
        if head: return
        if data is not None:
            self.wfile.write(data[start:end]); return
        with open(full, 'rb') as f:
            f.seek(start); left = end - start
            try:
                while left > 0:
                    b = f.read(min(left, 1 << 20))
                    if not b: break
                    self.wfile.write(b); left -= len(b)
            except (BrokenPipeError, ConnectionResetError): pass

    def log_message(self, fmt, *args):
        if '--quiet' not in sys.argv: super().log_message(fmt, *args)

if __name__ == '__main__':
    port = int(next((a for a in sys.argv[1:] if a.isdigit()), 8000))
    print(f'serving {SITE} on 0.0.0.0:{port}, open http://localhost:{port}{PREFIX}')
    ThreadingHTTPServer(('0.0.0.0', port), H).serve_forever()
