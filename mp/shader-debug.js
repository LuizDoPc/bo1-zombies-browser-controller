// Opt-in WGSL rewrites for the renderer worker, for chasing Safari-only black patches (Safari compiles WebGPU shaders
// with Metal's relaxed math and fast math functions; Chrome compiles them precisely). build.mjs puts this function
// into the renderer worker's source when the page has ?nanDebug=1 or ?safeMath=1, and calls it with those switches.
//   ?nanDebug=1  (2: self-test, a NaN in every first texture sample) fragment shaders paint a pixel by the kind of operation that first produced a NaN in it:
//                red log2, green exp2, blue pow, yellow inverseSqrt or division, cyan normalize, magenta texture
//                sample, white other arithmetic, orange a NaN/inf output with none of those seen
//   ?safeMath=1  keep the special values that fast math may get wrong out of log2/pow/normalize/exp2, and turn a
//                NaN or infinite fragment output into 0
function kbShaderRewrite(opts) {
  const csm = GPUDevice.prototype.createShaderModule;
  const OPS = [['log2', 1], ['exp2', 2], ['pow', 3], ['inverseSqrt', 4], ['normalize', 5], ['textureSample', 6]];
  const HELPERS = `
fn kb_bad1(v: f32) -> bool { return (bitcast<u32>(v) & 0x7f800000u) == 0x7f800000u; }
fn kb_nan1(v: f32) -> bool { let b = bitcast<u32>(v); return (b & 0x7f800000u) == 0x7f800000u && (b & 0x7fffffu) != 0u; }
fn kb_nan4(v: vec4<f32>) -> bool { return kb_nan1(v.x) || kb_nan1(v.y) || kb_nan1(v.z) || kb_nan1(v.w); }
fn kb_safe_log2(v: f32) -> f32 { return log2(max(abs(v), 1e-30f)); }
fn kb_safe_pow(a: f32, b: f32) -> f32 { return exp2(clamp(b * log2(max(a, 1e-30f)), -126f, 126f)); }
fn kb_safe_exp2(v: f32) -> f32 { return exp2(clamp(v, -126f, 126f)); }
fn kb_safe_norm(v: vec3<f32>) -> vec3<f32> { return v * inverseSqrt(max(dot(v, v), 1e-30f)); }
fn kb_scrub(v: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(select(v.x, 0f, kb_bad1(v.x)), select(v.y, 0f, kb_bad1(v.y)), select(v.z, 0f, kb_bad1(v.z)), select(v.w, 1f, kb_bad1(v.w)));
}
var<private> kb_dbg: u32;
`;
  const COLORS = ['1f, 0f, 0f', '0f, 1f, 0f', '0f, 0f, 1f', '1f, 1f, 0f', '0f, 1f, 1f', '1f, 0f, 1f', '1f, 1f, 1f', '1f, 0.5f, 0f'];
  function rewrite(code) {
    if (!/@fragment/.test(code) || !/fn kb_bytecode_main_u0028_\(\)/.test(code) || !/_gl_FragData_0_/.test(code)) return code;
    let lines = code.split('\n');
    if (opts.safeMath) {
      lines = lines.map(l => l
        .replace(/\blog2\(abs\(([^()]*)\)\)/g, 'kb_safe_log2($1)')
        .replace(/\blog2\(([^()]*)\)/g, 'kb_safe_log2($1)')
        .replace(/\bpow\(abs\(([^()]*)\), ([^()]*)\)/g, 'kb_safe_pow(abs($1), $2)')
        .replace(/\bexp2\(([^()]*)\)/g, 'kb_safe_exp2($1)')
        .replace(/\bnormalize\(([^()]*\.xyz)\)/g, 'kb_safe_norm($1)'));
    }
    if (opts.nanDebug === 2) {  // self-test: a NaN in the first texture sample, so lit surfaces should turn magenta
      const i = lines.findIndex(l => /^\s+let _e\d+ = textureSample/.test(l));
      if (i >= 0) lines[i] = lines[i].replace(/;$/, ' * bitcast<f32>(0x7fc00000u + 0u * u32(unnamed.kb_alpha_func));');
    }
    if (opts.nanDebug) {
      const letOp = new Map(), out = [];
      let inMain = false;
      for (const l of lines) {
        if (/^fn kb_bytecode_main_u0028_\(\)/.test(l)) inMain = true;
        else if (/^fn /.test(l)) inMain = false;
        const m = /^(\s+)let (_e\d+) = (.*);$/.exec(l);
        let cat = 0;
        if (m) {
          for (const [op, c] of OPS) if (m[3].includes(op === 'textureSample' ? op : op + '(')) { cat = c; break; }
          if (!cat && / \/ /.test(m[3])) cat = 4;
          if (!cat) for (const r of m[3].match(/_e\d+/g) || []) if (letOp.has(r)) { cat = letOp.get(r); break; }
          if (cat) letOp.set(m[2], cat);
        }
        out.push(l);
        if (!inMain) continue;
        // register and local writes: ps_rN_[iu] = ...; (f32) / ps_rN_ = ...; (vec4) / local_N = ...; (f32)
        const w = /^(\s+)(ps_r\d+_\[\du\]|ps_r\d+_|local_\d+) = (.*);$/.exec(l);
        if (!w) continue;
        let c = 0;
        for (const [op, k] of OPS) if (w[3].includes(op === 'textureSample' ? op : op + '(')) { c = k; break; }
        if (!c && / \/ /.test(w[3])) c = 4;
        if (!c) for (const r of w[3].match(/_e\d+/g) || []) if (letOp.has(r)) { c = letOp.get(r); break; }
        if (!c) c = 7;
        const v = /\[\du\]$/.test(w[2]) || /^local_/.test(w[2]) ? `kb_nan1(${w[2]})` : `kb_nan4(${w[2]})`;
        if (/^local_/.test(w[2]) && !/inverseSqrt|1f \/|e\+?38|0000000f/.test(w[3])) continue;  // locals other than rsq/rcp results may be vectors
        out.push(`${w[1]}if (kb_dbg == 0u && ${v}) { kb_dbg = ${c}u; }`);
      }
      lines = out;
    }
    code = lines.join('\n');
    // end of the translated bytecode: the fragment colour is final here, before the alpha test
    const end = /(fn kb_bytecode_main_u0028_\(\) \{[\s\S]*?)(\n    return;\n\})/;
    let tail = '';
    if (opts.nanDebug) tail += COLORS.map((col, i) => `\n    if (kb_dbg == ${i + 1}u) { _gl_FragData_0_ = vec4<f32>(${col}, 1f); }`).join('') +
      `\n    if (kb_dbg == 0u && (kb_bad1(_gl_FragData_0_.x) || kb_bad1(_gl_FragData_0_.y) || kb_bad1(_gl_FragData_0_.z))) { _gl_FragData_0_ = vec4<f32>(${COLORS[7]}, 1f); }`;
    if (opts.safeMath) tail += '\n    _gl_FragData_0_ = kb_scrub(_gl_FragData_0_);';
    if (!end.test(code)) return code;
    code = code.replace(end, (all, body, ret) => body + tail + ret);
    // helpers after the last top-level declaration that precedes the first function
    const firstFn = code.search(/^fn /m);
    return code.slice(0, firstFn) + HELPERS + '\n' + code.slice(firstFn);
  }
  let n = 0;
  GPUDevice.prototype.createShaderModule = function (d) {
    if (d && typeof d.code === 'string') {
      const code = rewrite(d.code);
      if (code !== d.code) { d = { ...d, code }; n++; }
    }
    return csm.call(this, d);
  };
  setTimeout(() => console.log('WEB_GPU shader rewrite ' + JSON.stringify(opts) + ' applied to ' + n + ' shaders so far'), 30000);
  console.log('WEB_GPU shader rewrite on ' + JSON.stringify(opts));
}
