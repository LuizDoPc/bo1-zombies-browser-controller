// Builds overlay/: files that serve.py and tools-make-static.py use instead of site/'s, for multiplayer.
//   overlay/artifacts/KisakBlack-web.wasm  network and gamepad hooks (mp/patch-wasm.mjs)
//   overlay/artifacts/KisakBlack-web.mjs   loader + engine-side transport (mp/kbnet-runtime.js) and gamepad support
//                                          (mp/kbpad-runtime.js) wired to those imports
//   overlay/net.js                         page-side transport (mp/net.js)
//   overlay/coop.js                        co-op UI on the map pages (mp/coop.js)
// Run: node mp/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const MP = path.dirname(new URL(import.meta.url).pathname), ROOT = path.resolve(MP, '..');
const SITE = path.join(ROOT, 'site'), OUT = path.join(ROOT, 'overlay');
execFileSync(process.execPath, ['--max-old-space-size=16000', path.join(MP, 'patch-wasm.mjs')], { stdio: 'inherit' });
function patch(text, old, neu) {
  if (text.split(old).length !== 2) throw new Error('patch no longer applies: ' + old.slice(0, 80));
  return text.replace(old, neu);
}
let mjs = fs.readFileSync(path.join(SITE, 'artifacts/KisakBlack-web.mjs'), 'utf8');
const runtime = fs.readFileSync(path.join(MP, 'kbnet-runtime.js'), 'utf8') + fs.readFileSync(path.join(MP, 'kbpad-runtime.js'), 'utf8');
mjs = patch(mjs, 'function assignWasmImports(){wasmImports={',
  runtime + '\nfunction assignWasmImports(){wasmImports={kb_net_send,kb_net_recv,kb_net_resolve,kb_net_expected,kb_net_assert,kb_pad_frame,');
// Browsers without JSPI (Safari): mp/jspi-polyfill.js, in the loader and (overlay/, imported first by play.js) on the page.
mjs = patch(mjs, 'function assignWasmImports(){', fs.readFileSync(path.join(MP, 'jspi-polyfill.js'), 'utf8') + '\nfunction assignWasmImports(){');
// Expose the KB_Cbuf export on Module, next to the engine's other KB_ exports.
mjs = patch(mjs, '_KB_Input=Module["_KB_Input"]=wasmExports["KB_Input"];',
  '_KB_Input=Module["_KB_Input"]=wasmExports["KB_Input"];Module["_KB_Cbuf"]=wasmExports["KB_Cbuf"];');
// WebGPU without the pipelined executor (?cvar.r_webgpu_pipeline=0): the shader warm-up state only exists in pipelined
// mode, but the packet sweep still calls the warm-up pump ("undefined is not an object (evaluating 'w.released')").
mjs = patch(mjs, 'warmPump(extra=0){', 'warmPump(extra=0){if(!this.warm)return;');
mjs = patch(mjs, 'warmEndCheck(cap=Math.max(1,Number(globalThis.KISAK_WEBGPU_WARM_INFLIGHT)||4)){', 'warmEndCheck(cap=Math.max(1,Number(globalThis.KISAK_WEBGPU_WARM_INFLIGHT)||4)){if(!this.warm)return;');
// ?invariant=1 (opt-in): mark every WGSL position output @invariant. The engine draws a depth-only pass, then colour
// with depth "equal"; that needs bit-identical positions from different shaders, which WGSL only promises for
// @invariant positions. Without it Safari's compiler can differ in the last bit and the equal test fails along
// triangle edges (black lines that follow the geometry). The renderer worker reads the page's query here.
mjs = patch(mjs, 'const flags={KISAK_WEBGPU_SYNC_PIPELINES:',
  'if(/[?&]invariant=1/.test(qs)&&typeof GPUDevice!=="undefined"&&!GPUDevice.prototype.kbInvariant){const csm=GPUDevice.prototype.createShaderModule;' +
  'GPUDevice.prototype.kbInvariant=true;GPUDevice.prototype.createShaderModule=function(d){return csm.call(this,d&&typeof d.code==="string"?' +
  '{...d,code:d.code.replace(/@builtin\\(position\\)(?!\\s*@invariant)/g,"@builtin(position) @invariant")}:d)};console.log("WEB_GPU invariant positions on")}' +
  'const flags={KISAK_WEBGPU_SYNC_PIPELINES:');
// ?depthBias=<factor> (opt-in, for diagnosing shadow acne): multiplies the polygon offset the engine sets for shadow
// map draws. WebGPU's depthBias unit depends on the depth format, and depth24plus is implementation-defined, so the
// same GL offset can mean less in one browser (Safari draws black, acne-striped lamp shadows).
mjs = patch(mjs, 'const flags={KISAK_WEBGPU_SYNC_PIPELINES:',
  'globalThis.KB_DEPTH_BIAS_SCALE=Number((/[?&]depthBias=([0-9.]+)/.exec(qs)||[])[1])||1;if(globalThis.KB_DEPTH_BIAS_SCALE!==1)console.log("WEB_GPU depth bias x"+globalThis.KB_DEPTH_BIAS_SCALE);' +
  'const flags={KISAK_WEBGPU_SYNC_PIPELINES:');
mjs = patch(mjs, 'depthBias:Math.round(this.depthBias[1]),depthBiasSlopeScale:this.depthBias[0]',
  'depthBias:Math.round(this.depthBias[1]*(globalThis.KB_DEPTH_BIAS_SCALE||1)),depthBiasSlopeScale:this.depthBias[0]*(globalThis.KB_DEPTH_BIAS_SCALE||1)');
// ?proxyAlways=1 (opt-in, for diagnosing Safari shadows): shaders sample depth textures (shadow maps) through an
// r32float copy that is only redrawn when the depth texture's version changes; this redraws it on every use.
// ?noCache=1 (opt-in): proxyAlways plus no reuse of bind groups, sample views, per-pass draw state or converted
// vertex data: everything derived is rebuilt for each draw. Slow; for telling a stale-cache bug from anything else.
// ?noArenas=1 (opt-in): upload through queue writes instead of the pool of mapped staging buffers.
mjs = patch(mjs, 'const flags={KISAK_WEBGPU_SYNC_PIPELINES:',
  'if(/[?&]noArenas=1/.test(qs))globalThis.KISAK_WEBGPU_NO_MAPPED_ARENAS=1;globalThis.KB_NO_CACHE=/[?&]noCache=1/.test(qs);' +
  'globalThis.KB_PROXY_ALWAYS=globalThis.KB_NO_CACHE||/[?&]proxyAlways=1/.test(qs);' +
  'if(globalThis.KB_PROXY_ALWAYS)console.log("WEB_GPU depth proxy redrawn on every use");if(globalThis.KB_NO_CACHE)console.log("WEB_GPU no derived-state caches");' +
  'const flags={KISAK_WEBGPU_SYNC_PIPELINES:');
// The pipelined renderer runs in its own worker, built from a blob that only carries the `flags` above: the
// KB_* switches set next to them (proxyAlways, depthBias, invariant) never reached it and did nothing there.
// Pass them into the worker's source too (?invariant=1 has to wrap the worker's own GPUDevice).
// ?nanDebug=1 / ?safeMath=1 (opt-in, Safari black patches): WGSL rewrites in mp/shader-debug.js, run in the renderer worker.
mjs = patch(mjs, 'function assignWasmImports(){', fs.readFileSync(path.join(MP, 'shader-debug.js'), 'utf8') + '\nfunction assignWasmImports(){');
mjs = patch(mjs, 'const src=Object.entries(flags).map(',
  'const kbInvariant=function(){const csm=GPUDevice.prototype.createShaderModule;GPUDevice.prototype.createShaderModule=function(d){return csm.call(this,d&&typeof d.code==="string"?' +
  '{...d,code:d.code.replace(/@builtin\\(position\\)(?!\\s*@invariant)/g,"@builtin(position) @invariant")}:d)};console.log("WEB_GPU invariant positions on (renderer)")};' +
  // ?gpuProbe=1 (opt-in, for finding which shaders draw something): the renderer worker records each pipeline's
  // shader hashes and, over BroadcastChannel "kbprobe", reports the ones drawn ({seen}) and skips chosen ones ({skip}).
  'const kbProbe=function(){const h=s=>{let x=2166136261;for(let i=0;i<s.length;i++){x^=s.charCodeAt(i);x=Math.imul(x,16777619)}return(x>>>0).toString(16)};' +
  'const P=GPUDevice.prototype,E=GPURenderPassEncoder.prototype,codes=new Map(),mods=new WeakMap(),pipes=new WeakMap();' +
  'let said=0;const csm=P.createShaderModule;P.createShaderModule=function(d){const k=h(d.code);codes.set(k,d.code);if(!said++)console.log("WEB_GPU probe nudge="+globalThis.KB_PROBE_NUDGE+" first="+k);' +
  'if(globalThis.KB_PROBE_NUDGE&&globalThis.KB_PROBE_NUDGE.split(",").includes(k))d={...d,code:d.code.replace(/return VertexOutput\\(([^;]*)\\);/,(all,a)=>' +
  '"return VertexOutput("+a.replace(/(_e\\d+)(?=[^,]*$)/,"vec4<f32>($1.x,$1.y,$1.z*(1f-"+(globalThis.KB_PROBE_NUDGE_BY||"0.000003")+"),$1.w)")+");")},console.log("WEB_GPU probe nudged "+k);' +
  'const m=csm.call(this,d);mods.set(m,k);return m};' +
  'const name=d=>(d.fragment?mods.get(d.fragment.module):"none")+"/"+mods.get(d.vertex.module);' +
  'const descs=new Map(),note=(d,p)=>{const n=name(d);pipes.set(p,n);const z=d.depthStencil;descs.set(n,[z?.depthCompare,z?.depthWriteEnabled,z?.depthBias,(d.fragment?.targets||[]).map(t=>t&&t.format+":"+(t.writeMask??15)+":"+(t.blend?t.blend.color.srcFactor+"/"+t.blend.color.dstFactor+"/"+t.blend.color.operation:"-")).join(","),d.primitive?.cullMode])};' +
  'const crp=P.createRenderPipeline;P.createRenderPipeline=function(d){const p=crp.call(this,d);note(d,p);return p};' +
  'const crpa=P.createRenderPipelineAsync;P.createRenderPipelineAsync=function(d){return crpa.call(this,d).then(p=>{note(d,p);return p})};' +
  'let trace=null,passN=0,vid=0;const brp=GPUCommandEncoder.prototype.beginRenderPass;GPUCommandEncoder.prototype.beginRenderPass=function(d){passN++;' +
  'if(trace&&trace.length<trace.max)trace.push(["pass",passN,(d.colorAttachments||[]).map(a=>a&&(a.view.kbId||(a.view.kbId=++vid))+":"+a.loadOp).join(","),d.depthStencilAttachment?(d.depthStencilAttachment.view.kbId||(d.depthStencilAttachment.view.kbId=++vid))+":"+d.depthStencilAttachment.depthLoadOp:"-"]);return brp.call(this,d)};' +
  'let skip=new Set(),seen=new Map(),skipping=false;const sp=E.setPipeline;E.setPipeline=function(p){const n=pipes.get(p)||"?";' +
  'skipping=skip.has(n)||skip.has(n.split("/")[0]);seen.set(n,(seen.get(n)||0)+1);if(trace&&trace.length<trace.max)trace.push([n,...(descs.get(n)||[])]);return sp.call(this,p)};' +
  'for(const f of["draw","drawIndexed","drawIndirect","drawIndexedIndirect"]){const o=E[f];E[f]=function(...a){if(!skipping)return o.apply(this,a)}}' +
  'const bc=new BroadcastChannel("kbprobe");bc.onmessage=e=>{const m=e.data;if(m.skip)skip=new Set(m.skip);if(m.reset)seen=new Map();' +
  'if(m.trace){trace=[];trace.max=m.trace;setTimeout(()=>{bc.postMessage({trace});trace=null},m.ms||500)}if(m.seen)bc.postMessage({seen:[...seen]});if(m.code)bc.postMessage({code:codes.get(m.code)})};console.log("WEB_GPU probe on (renderer)")};' +
  'const kbRewrite={nanDebug:Number((/[?&]nanDebug=([12])/.exec(qs)||[])[1])||0,safeMath:/[?&]safeMath=1/.test(qs)};' +
  'const src=(/[?&]invariant=1/.test(qs)?"("+kbInvariant+")();\\n":"")+(kbRewrite.nanDebug||kbRewrite.safeMath?"("+kbShaderRewrite+")("+JSON.stringify(kbRewrite)+");\\n":"")+(/[?&]gpuProbe=1/.test(qs)?"("+kbProbe+")();\\n":"")+Object.entries({...flags,KB_PROXY_ALWAYS:!!globalThis.KB_PROXY_ALWAYS,' +
  'KB_NO_CACHE:!!globalThis.KB_NO_CACHE,KB_DEPTH_BIAS_SCALE:globalThis.KB_DEPTH_BIAS_SCALE||1,' +
  'KB_PROBE_NUDGE:(/[?&]probeNudge=([0-9a-f,]+)/.exec(qs)||[])[1]||"",KB_PROBE_NUDGE_BY:(/[?&]probeNudgeBy=([0-9.e-]+)/.exec(qs)||[])[1]||""}).map(');
mjs = patch(mjs, 'if(texture.proxy?.generation===texture.generation&&texture.proxy.version===(texture.depthVersion||0))return texture.proxy.view;',
  'if(!globalThis.KB_PROXY_ALWAYS&&texture.proxy?.generation===texture.generation&&texture.proxy.version===(texture.depthVersion||0))return texture.proxy.view;');
// Stand-in pipelines while the right one compiles (Safari compiles far slower than Chrome, so it draws with these
// for a long time; this, not the depth-copy cache, is what put black, blocky, acne-like patches on sun-shadowed
// surfaces there):
// - A draw that samples a shadow map runs a "compare" variant of its program, which tests the r32float depth copy
//   against the fragment's depth. Its stand-in was the plain program's pipeline, which reads that copy as a colour,
//   so the raw shadow-map depth became the light factor. Use only compare pipelines with the same compare mask
//   (another filter mask or another cull mode), else skip the draw like any other missing pipeline.
// - "Near" stand-ins ignored polygon offset too. The colour pass tests depth "equal" against the depth prepass, so
//   a stand-in with a different offset than the prepass fails that test in patches, and a shadow caster without its
//   offset puts acne in the shadow map. Near stand-ins may now differ only in cull mode and winding.
mjs = patch(mjs, 'p[4]=p[5]="";return p.filter(x=>x[0]!=="o").join("|")}', 'p[4]=p[5]="";return p.join("|")}');
mjs = patch(mjs, 'const base=this.program.compareBase;if(base)compareFallback=this.pipelines.get(base.key+key.slice(this.program.key.length));' +
  'if(!compareFallback&&!globalThis.KISAK_WEBGPU_NO_FALLBACK)compareFallback=this.nearPipelines?.get(this.nearKey(key))||base&&this.nearPipelines?.get(this.nearKey(base.key+key.slice(this.program.key.length)));',
  'const base=this.program.compareBase;if(!globalThis.KISAK_WEBGPU_NO_FALLBACK){const rest=key.slice(this.program.key.length),near=this.nearPipelines,cmask=this.program.key.replace(/l[0-9a-f]+$/,"l");' +
  'compareFallback=near?.get(this.nearKey(key));if(!compareFallback&&base)for(const v of base.compareVariants.values())' +
  'if(v!==base&&v!==this.program&&v.key.startsWith(cmask)&&!v.ps.compareFailed&&(compareFallback=this.pipelines.get(v.key+rest)||near?.get(this.nearKey(v.key+rest))))break}');
// Depth-proxy cache: a whole-texture depth copy (copyTextureToTexture) wrote the destination without bumping its
// depthVersion, so a shader sampling the destination kept getting the r32float copy made before.
mjs = patch(mjs, 'this.commandEncoder().copyTextureToTexture({texture:source.gpu,mipLevel:sourceLevel,origin:sourceOrigin,aspect},{texture:dest.gpu,mipLevel:destLevel,origin:destOrigin,aspect},size)}',
  'this.commandEncoder().copyTextureToTexture({texture:source.gpu,mipLevel:sourceLevel,origin:sourceOrigin,aspect},{texture:dest.gpu,mipLevel:destLevel,origin:destOrigin,aspect},size);' +
  'if(dest.format.startsWith("depth")){dest.depthVersion=(dest.depthVersion||0)+1;this.stats.depthCopies=(this.stats.depthCopies||0)+1}}');
// ?noCache=1 (see above).
mjs = patch(mjs, 'if(hit)return previous.group;', 'if(hit&&!globalThis.KB_NO_CACHE)return previous.group;');
mjs = patch(mjs, 'if(!this.groups.has(key)){', 'if(globalThis.KB_NO_CACHE||!this.groups.has(key)){');
mjs = patch(mjs, 'texture.sampleView||=texture.gpu.createView({dimension})',
  '(globalThis.KB_NO_CACHE?texture.gpu.createView({dimension}):texture.sampleView||=texture.gpu.createView({dimension}))');
mjs = patch(mjs, 'const pass=this.pass,last=this.passState;', 'if(globalThis.KB_NO_CACHE)this.passState={vertexBuffers:[],vertexOffsets:[]};const pass=this.pass,last=this.passState;');
mjs = patch(mjs, 'if(shadow.dirtyHi>shadow.dirtyLo){', 'if(globalThis.KB_NO_CACHE){shadow.dirtyLo=0;shadow.dirtyHi=source.bytes.length}if(shadow.dirtyHi>shadow.dirtyLo){');
// A map's loading video that can't load (offline without a copy, a network error): the engine takes the page's intro
// <video> over ("adopt") and only listened for its error from then on, so a video that had already failed, or whose
// <source>s all failed (their errors don't reach the video's own listener), never ended: the map stayed at "Loading"
// forever. Report it as the error state (w[4]=3), as a video that fails after the takeover does.
mjs = patch(mjs, 'onFrame(s);if(adopt){if(video.ended||intro.finished){status(s);w[1]=s.frames;w[4]=2}else{',
  'onFrame(s);if(adopt){const noSource=()=>{if(!s.closed&&(video.error||video.networkState===3)){w[4]=3;console.warn("[kbVideo] no source",name)}};' +
  'video.addEventListener("error",noSource,true);if(video.ended||intro.finished){status(s);w[1]=s.frames;w[4]=2}else if(video.error||video.networkState===3){noSource()}else{');
fs.mkdirSync(path.join(OUT, 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'artifacts/KisakBlack-web.mjs'), mjs);
fs.copyFileSync(path.join(MP, 'net.js'), path.join(OUT, 'net.js'));
// the site's lobby services (signaling, TURN): mp/net-config.json, the deployer's own (see mp/net-config.example.json);
// without it the build has none, and online lobbies say so
if (fs.existsSync(path.join(MP, 'net-config.json'))) fs.copyFileSync(path.join(MP, 'net-config.json'), path.join(OUT, 'net-config.json'));
else { fs.rmSync(path.join(OUT, 'net-config.json'), { force: true }); console.warn('no mp/net-config.json: the build has no lobby services (see mp/net-config.example.json)'); }
fs.copyFileSync(path.join(MP, 'coop.js'), path.join(OUT, 'coop.js'));
fs.copyFileSync(path.join(MP, 'jspi-polyfill.js'), path.join(OUT, 'jspi-polyfill.js'));
fs.copyFileSync(path.join(MP, 'pad-test.html'), path.join(OUT, 'pad-test.html'));  // controller bisect page (iPad stalls)
fs.copyFileSync(path.join(MP, 'sw.js'), path.join(OUT, 'sw.js'));  // "Offline play" (coop.js registers it when turned on)
// co-op game-script fixes (mp/mods: the kbcoop mod), served as coop-mod/ with the mod-stack hooks it needs (the site's
// own pack/mods/_stack files, for map packs that lack them); coop.js writes them into the map's storage on a co-op page
fs.rmSync(path.join(OUT, 'coop-mod'), { recursive: true, force: true });
fs.cpSync(path.join(MP, 'mods'), path.join(OUT, 'coop-mod'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'coop-mod/_stack/maps'), { recursive: true });
for (const f of ['_modstack.gsc', '_zombiemode_ffotd.gsc'])
  fs.copyFileSync(path.join(SITE, 'pack/mods/_stack/maps', f), path.join(OUT, 'coop-mod/_stack/maps', f));
// offline co-op codes (coop.js): QR drawing (qrcode-generator, MIT) and camera scanning (jsQR, Apache-2.0), loaded on use
fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });
fs.copyFileSync(path.join(MP, 'node_modules/qrcode-generator/qrcode.js'), path.join(OUT, 'vendor/qrcode.js'));
fs.copyFileSync(path.join(MP, 'node_modules/jsqr/dist/jsQR.js'), path.join(OUT, 'vendor/jsQR.js'));
fs.copyFileSync(path.join(MP, 'node_modules/jsqr/LICENSE'), path.join(OUT, 'vendor/LICENSE-jsQR.txt'));
// home-screen web app: manifest + icons (serve.py adds the manifest link and iOS tags to the pages)
fs.copyFileSync(path.join(MP, 'app.webmanifest'), path.join(OUT, 'app.webmanifest'));
// (mp/icons/ when present, e.g. icons cut from the game's own art; else the original mp/icons-default/)
const ICONS = path.join(MP, fs.existsSync(path.join(MP, 'icons')) ? 'icons' : 'icons-default');
fs.mkdirSync(path.join(OUT, 'icons'), { recursive: true });
for (const f of fs.readdirSync(ICONS)) fs.copyFileSync(path.join(ICONS, f), path.join(OUT, 'icons', f));
console.log('overlay built:', fs.readdirSync(OUT, { recursive: true }).filter(f => fs.statSync(path.join(OUT, f)).isFile()).join(', '));
