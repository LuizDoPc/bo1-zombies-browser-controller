// JSPI polyfill, for browsers without WebAssembly.Suspending / WebAssembly.promising (Safari).
// The loader is an Emscripten JSPI build, but only two wasm imports really wait for a promise:
//   __asyncjs__InitializeWebGPU    once, on the pthread that owns the game canvas (BrowserCreateContext): starts the
//                                  pipelined WebGPU executor (or requests the device) and waits for it
//   __asyncjs__ReadWebGPUPixelsJS  one D3D GetRenderTargetData path under WebGPU (movie capture, probe generation);
//                                  not reached in normal play, and screenshots (checked) read back another way
// Everything else JSPI touches (pthread entry points, main) never suspends. So without JSPI:
//   - new WebAssembly.Suspending(f) calls f directly, WebAssembly.promising(f) returns f's result (or throw) as a promise;
//   - InitializeWebGPU's async part runs before the canvas thread enters wasm. That thread is chosen and the call's
//     argument predicted from the engine arguments, parsed as main() does (+set r_webgpu / r_webgpu_pipeline /
//     r_smp_backend), which the page sends along with the thread start. The import then returns that result;
//   - ReadWebGPUPixelsJS leaves the destination untouched (zeroed) and warns once.
// Browsers with JSPI are left alone (nothing is hooked). ?nojspi=1 on a map page simulates a browser without it.
// This file runs twice: imported first by play.js, so capabilities.js's JSPI check passes, and inside the loader
// (mp/build.mjs), where it also hooks the loader's pthread start. It must stay valid as both a module and a block.
(() => {
  const WA = globalThis.WebAssembly;
  if (typeof WA !== 'object') return;
  const say = m => console.log('KISAK_JSPI ' + m);
  const page = typeof document !== 'undefined';
  let hooked = false;
  function install(why) {
    if (!WA.Suspending?.kbPolyfill) {
      function Suspending(f) {
        if (!new.target) throw new TypeError('WebAssembly.Suspending must be called with new');
        if (typeof f !== 'function') throw new TypeError('WebAssembly.Suspending: argument must be a function');
        return function (...args) {
          const r = f.apply(this, args);
          if (r && typeof r.then === 'function') {
            r.then(null, () => {});
            throw new Error('KISAK_JSPI: ' + (f.name || 'an import') + ' waits for a promise; this browser has no JSPI');
          }
          return r;
        };
      }
      Suspending.kbPolyfill = true;
      const promising = f => function (...args) {
        try { return Promise.resolve(f.apply(this, args)); } catch (e) { return Promise.reject(e); }
      };
      Object.defineProperty(WA, 'Suspending', { value: Suspending, writable: true, configurable: true });
      Object.defineProperty(WA, 'promising', { value: promising, writable: true, configurable: true });
      globalThis.KISAK_JSPI_POLYFILL = why;
      if (page) say('polyfill (' + why + ')');
    }
    if (typeof Asyncify !== 'undefined' && !hooked) { hooked = true; hookLoader(); }
  }
  // ?nojspi=1: the page also starts its pthread workers through a stub that sets KISAK_JSPI_SIMULATE first (hookLoader)
  if (page ? /[?&]nojspi=1/.test(location.search) : globalThis.KISAK_JSPI_SIMULATE) install('simulated, ?nojspi=1');
  else if (typeof WA.Suspending !== 'function' || typeof WA.promising !== 'function') install('no native JSPI');
  else if (page && !globalThis.KISAK_JSPI_LOGGED) { globalThis.KISAK_JSPI_LOGGED = true; say('native'); }
  // With native JSPI nothing below runs: the loader is untouched.

  function hookLoader() {
    let gpu = null, run = null, warned = false;
    const instrument = Asyncify.instrumentWasmImports;
    Asyncify.instrumentWasmImports = imports => {
      if (imports.__asyncjs__InitializeWebGPU) imports.__asyncjs__InitializeWebGPU = pipeline => {
        if (gpu && gpu.pipeline === pipeline) return gpu.result;
        err('KISAK_JSPI InitializeWebGPU(' + pipeline + ') was not prepared before the thread started (predicted ' +
          JSON.stringify(gpu && gpu.pipeline) + ')');
        out('WEB_GPU_FALLBACK jspi-polyfill-unprepared');
        return 0;
      };
      if (imports.__asyncjs__ReadWebGPUPixelsJS) imports.__asyncjs__ReadWebGPUPixelsJS = (x, y, w, h) => {
        if (!warned) { warned = true; err('KISAK_JSPI WebGPU pixel readback (' + w + 'x' + h + ') needs JSPI; returning black'); }
      };
      return instrument(imports);
    };
    if (!ENVIRONMENT_IS_PTHREAD) {
      // engine.js passes the arguments to callMain (noInitialRun), which starts main()'s thread synchronously
      let args = programArgs, inMain = false;
      const callMain = Module.callMain;
      if (callMain) Module.callMain = (a = []) => {
        args = a.slice(); inMain = true;
        try { return callMain(a); } finally { inMain = false; }
      };
      if (/^simulated/.test(globalThis.KISAK_JSPI_POLYFILL)) {
        // the workers have native JSPI: replace the pthread pool (created before this runs) with workers that simulate
        const blob = text => URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
        const stub = blob('import ' + JSON.stringify(blob('globalThis.KISAK_JSPI_SIMULATE = 1;')) + ';import ' +
          JSON.stringify(new URL('KisakBlack-web.mjs', import.meta.url).href) + ';');
        PThread.allocateUnusedWorker = () => {
          const worker = new Worker(stub, { type: 'module', name: 'em-pthread' });
          PThread.unusedWorkers.push(worker);
          return worker;
        };
        for (const worker of PThread.unusedWorkers.splice(0)) { worker.terminate(); PThread.allocateUnusedWorker(); }
      }
      const load = PThread.loadWasmModuleToWorker;
      PThread.loadWasmModuleToWorker = worker => {
        const post = worker.postMessage;
        worker.postMessage = function (msg, transfer) {
          // main()'s thread gets the canvas first and later hands it to the renderer thread
          if (msg && msg.cmd === 2) msg.kbJspi = { args, main: inMain };
          return post.call(this, msg, transfer);
        };
        return load(worker);
      };
      return;
    }
    const receive = PThread.receiveOffscreenCanvases;
    PThread.receiveOffscreenCanvases = function (data) { run = data.kbJspi || null; return receive.call(this, data); };
    const entry = invokeEntryPoint;
    invokeEntryPoint = async (ptr, arg) => {
      if (run?.args && Module.canvas && !gpu) {
        const set = {};
        for (let i = 0; i + 2 < run.args.length; ++i) if (run.args[i] === '+set') set[run.args[i + 1]] = String(run.args[i + 2]);
        const webgpu = set.r_webgpu === undefined ? 0 : set.r_webgpu[0] !== '0' || set.r_webgpu.length > 1;
        const pipeline = parseInt(set.r_webgpu_pipeline ?? '0', 10) || 0;
        // main()'s thread hands the canvas to the backend thread unless r_smp_backend is 0 (engine.js: Firefox route)
        if (webgpu && (!run.main || set.r_smp_backend === '0')) {
          say('preparing WebGPU (pipeline=' + pipeline + ') before the renderer thread starts');
          gpu = { pipeline, result: await __asyncjs__InitializeWebGPU(pipeline) };
        }
      }
      return entry(ptr, arg);
    };
  }
})();
