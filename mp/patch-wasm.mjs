// Patches the engine wasm with a network transport hook. Reads site/artifacts/KisakBlack-web.wasm, writes
// overlay/artifacts/KisakBlack-web.wasm. Run: node mp/patch-wasm.mjs
//
// The engine's NET_SendPacket was compiled out: every sender switches on netadr_t.type, copies loopback (2) packets
// into the in-memory loopback queues and does nothing for broadcast/IP (>= 3). This adds:
//   import env.kb_net_send(adr*, data*, len)          called from that empty branch in every sender
//   import env.kb_net_recv(sock, from*, msg*) -> int  asked first by NET_GetLoopPacket (1 = a packet was delivered)
//   import env.kb_net_resolve(name*, adr*) -> int     asked first by NET_StringToAdr (1 = resolved)
//   import env.kb_net_expected(count) -> int          wraps getnumexpectedplayers() (lobby player count)
//   export KB_Cbuf(text*)                             Cbuf_AddText(0, text): run console commands from JS
import b from 'binaryen';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'site/artifacts/KisakBlack-web.wasm');
const OUT = path.join(ROOT, 'overlay/artifacts/KisakBlack-web.wasm');

const m = b.readBinary(fs.readFileSync(SRC));
// The features this Emscripten build uses. Not Features.All: that turns on newer encodings (e.g. compact imports)
// that browsers reject.
const F = b.Features;
m.setFeatures(F.MVP | F.Atomics | F.MutableGlobals | F.NontrappingFPToInt | F.SIMD128 | F.BulkMemory | F.BulkMemoryOpt |
  F.SignExt | F.ExceptionHandling | F.ReferenceTypes | F.Multivalue | F.ExtendedConst);
const ids = Object.fromEntries(Object.entries(b).filter(([k, v]) => /Id$/.test(k) && typeof v === 'number').map(([k, v]) => [v, k.replace(/Id$/, '')]));
const info = e => { try { return b.getExpressionInfo(e); } catch { return { id: b.getExpressionId(e) }; } };
const CK = { Block: ['children'], If: ['condition', 'ifTrue', 'ifFalse'], Loop: ['body'], Break: ['condition', 'value'],
  Switch: ['condition', 'value'], Call: ['operands'], CallIndirect: ['target', 'operands'], LocalSet: ['value'],
  GlobalSet: ['value'], Load: ['ptr'], Store: ['ptr', 'value'], Unary: ['value'], Binary: ['left', 'right'],
  Select: ['ifTrue', 'ifFalse', 'condition'], Drop: ['value'], Return: ['value'], MemoryCopy: ['dest', 'source', 'size'],
  MemoryFill: ['dest', 'value', 'size'], AtomicRMW: ['ptr', 'value'], AtomicCmpxchg: ['ptr', 'expected', 'replacement'],
  AtomicWait: ['ptr', 'expected', 'timeout'], AtomicNotify: ['ptr', 'notifyCount'], SIMDExtract: ['vec'],
  SIMDReplace: ['vec', 'value'], SIMDShuffle: ['left', 'right'], SIMDTernary: ['a', 'b', 'c'], SIMDShift: ['vec', 'shift'],
  SIMDLoad: ['ptr'], SIMDLoadStoreLane: ['ptr', 'vec'], MemoryInit: ['dest', 'offset', 'size'], MemoryGrow: ['delta'] };
function kids(e) {
  const i = info(e), out = [];
  for (const k of CK[ids[i.id]] || []) { const v = i[k]; if (Array.isArray(v)) out.push(...v.filter(Boolean)); else if (v) out.push(v); }
  return out;
}
function walk(e, fn, parents = []) { if (!e) return; if (fn(e, parents) === false) return; for (const c of kids(e)) walk(c, fn, [...parents, e]); }
const funcs = []; for (let i = 0; i < m.getNumFunctions(); i++) funcs.push(m.getFunctionByIndex(i));
const byPrefix = p => { const f = funcs.filter(f => b.getFunctionInfo(f).name.startsWith(p)); if (f.length !== 1) throw new Error(`${p}: ${f.length} matches`); return f[0]; };
const nameOf = f => b.getFunctionInfo(f).name;

const i32 = b.i32, none = b.none;
m.addFunctionImport('kb_net_send', 'env', 'kb_net_send', b.createType([i32, i32, i32]), none);
m.addFunctionImport('kb_net_recv', 'env', 'kb_net_recv', b.createType([i32, i32, i32]), i32);
m.addFunctionImport('kb_net_resolve', 'env', 'kb_net_resolve', b.createType([i32, i32]), i32);
m.addFunctionImport('kb_net_expected', 'env', 'kb_net_expected', b.createType([i32]), i32);
m.addFunctionImport('kb_net_assert', 'env', 'kb_net_assert', b.createType([i32, i32]), i32);

// 1. Senders: after the switch's default block (types >= 3), call kb_net_send(adr, data, len).
const SENDERS = ['NET_OutOfBandData(', 'NET_OutOfBandPrint(', 'Netchan_Transmit(', 'Netchan_TransmitNextFragment(',
  'Netchan_Process('];  // SV_SendClientVoiceData (voice) is not hooked
let hooked = 0;
for (const p of SENDERS) {
  const f = byPrefix(p), body = b.getFunctionInfo(f).body;
  const sites = [];
  walk(body, e => {
    const s = info(e);
    if (s.id !== b.SwitchId || s.names.length !== 3 || s.names[0] !== s.names[1]) return;
    // The default block D and its parent P: D holds the switch + loopback branch, P continues with the default code.
    walk(body, (d, pp) => {
      const di = info(d);
      if (di.id !== b.BlockId || di.name !== s.defaultName) return;
      const parent = pp[pp.length - 1], pi = info(parent), at = pi.children.indexOf(d);
      // default code = one store copying the netadr_t out of load(ptr + offset)
      const st = info(pi.children[at + 1]);
      if (st.id !== b.StoreId || info(st.value).id !== b.LoadId) throw new Error(`${nameOf(f)}: unexpected default code`);
      const ld = info(st.value);
      // the loopback branch's memory.copy(slot, data, len) inside D
      let mc = null; walk(d, x => { if (!mc && info(x).id === b.MemoryCopyId) mc = info(x); });
      if (!mc) throw new Error(`${nameOf(f)}: no loopback memory.copy`);
      // data/len must be values computed before the switch: no local.set of them inside D
      const used = [mc.source, mc.size].map(info).filter(x => x.id === b.LocalGetId).map(x => x.index);
      walk(d, x => { const xi = info(x); if (xi.id === b.LocalSetId && used.includes(xi.index)) throw new Error(`${nameOf(f)}: local ${xi.index} set inside the switch block`); });
      sites.push({ parent, at, ld, mc });
    });
  });
  if (!sites.length) throw new Error(`${p}: no address switch`);
  // Insert from the last site backwards so indices stay valid.
  for (const { parent, at, ld, mc } of sites.reverse()) {
    const adr = ld.offset ? m.i32.add(m.copyExpression(ld.ptr), m.i32.const(ld.offset)) : m.copyExpression(ld.ptr);
    b.Block.insertChildAt(parent, at + 1, m.call('kb_net_send', [adr, m.copyExpression(mc.source), m.copyExpression(mc.size)], none));
    hooked++;
  }
  console.log(`send hook: ${nameOf(f)} (${sites.length} site${sites.length > 1 ? 's' : ''})`);
}

// 2./3. Receive and resolve: ask JS first, fall through to the original body.
function prepend(prefix, importName, nargs) {
  const f = byPrefix(prefix), fi = b.getFunctionInfo(f);
  const args = Array.from({ length: nargs }, (_, k) => m.local.get(k, i32));
  b.Function.setBody(f, m.block(null, [m.if(m.call(importName, args, i32), m.return(m.i32.const(1))), fi.body], fi.results));
  console.log(`${importName}: ${fi.name}`);
}
prepend('NET_GetLoopPacket(', 'kb_net_recv', 3);
prepend('NET_StringToAdr(', 'kb_net_resolve', 2);

// 5. CL_Connect_f only goes on to connect when the resolved address is loopback (type 2); anything else drops back to
// "disconnected". Accept IP (type 4) too: `type == 2` becomes `type == 2 || type == 4`. The state it then sets,
// select(4, 5, type & ~2), already sends a getchallenge first for a remote address.
{
  const f = byPrefix('CL_Connect_f('), hits = [];
  walk(b.getFunctionInfo(f).body, e => {
    const i = info(e);
    if (i.id === b.BinaryId && i.op === b.EqInt32 && info(i.right).id === b.ConstId && info(i.right).value === 2 &&
        info(i.left).id === b.LoadId) hits.push(e);
  });
  if (hits.length !== 1) throw new Error(`CL_Connect_f: ${hits.length} "type == 2" compares`);
  const e = hits[0], left = b.Binary.getLeft(e);
  const isIp = m.i32.eq(m.copyExpression(left), m.i32.const(4));
  b.Binary.setOp(e, b.OrInt32);
  b.Binary.setLeft(e, m.i32.eq(left, m.i32.const(2)));
  b.Binary.setRight(e, isIp);
  console.log('connect: CL_Connect_f accepts IP addresses');
}

// 6. getnumexpectedplayers(): KB has no party, so it returns the clients already connected and the zombies start
// ("connected == expected") passes at once. Return kb_net_expected(count) = max(count, the lobby's player count), so
// the host's script waits for everyone before round 1.
{
  const f = byPrefix('G_f_getnumexpectedplayers('), calls = [];
  const addInt = nameOf(byPrefix('Scr_AddInt('));
  walk(b.getFunctionInfo(f).body, e => { const i = info(e); if (i.id === b.CallId && i.target === addInt) calls.push(e); });
  if (calls.length !== 1) throw new Error(`G_f_getnumexpectedplayers: ${calls.length} Scr_AddInt calls`);
  b.Call.setOperandAt(calls[0], 0, m.call('kb_net_expected', [b.Call.getOperandAt(calls[0], 0)], i32));
  console.log('lobby: getnumexpectedplayers -> kb_net_expected');
}

// 7. UnitQuatToAxis asserts the quaternion is unit length. In co-op the host's first frames after both players spawn
// can hand it an all-zero quat (CG_AddPlayerWeapon, view model placement) and the assert kills the engine. A zero quat
// gives the identity matrix in the code after the assert, so skip it: the Assert_MyHandler call becomes "1" (carry on).
{
  const f = byPrefix('UnitQuatToAxis('), calls = [];
  const assert = nameOf(byPrefix('Assert_MyHandler('));
  walk(b.getFunctionInfo(f).body, (e, parents) => { const i = info(e); if (i.id === b.CallId && i.target === assert) calls.push([e, parents.at(-1)]); });
  if (calls.length !== 1) throw new Error(`UnitQuatToAxis: ${calls.length} Assert_MyHandler calls`);
  const [call, parent] = calls[0], pi = info(parent);
  // the call sits as the operand of eqz (if (eqz(Assert_MyHandler(...))) unreachable)
  if (pi.id !== b.UnaryId) throw new Error(`UnitQuatToAxis: assert call under ${ids[pi.id]}`);
  b.Unary.setValue(parent, m.i32.const(1));
  console.log('quat: UnitQuatToAxis no longer asserts on non-unit quats');
}

// 8. Material_GetTechnique asserts it gets a material, and that the material has a technique set. Co-op joiners hit
// both while drawing effects (fx_drawCallback -> R_AddCodeMeshDrawSurf, which already skips a null technique): a
// material without a techset, and (Kino) no material at all. Return null (no technique) for them instead. The
// techset pointer is at Material+176.
{
  const f = byPrefix('Material_GetTechnique('), fi = b.getFunctionInfo(f);
  // (a load from address 176 for a null material is harmless in wasm; either test is enough)
  const noTechSet = m.i32.or(m.i32.eqz(m.local.get(0, i32)), m.i32.eqz(m.i32.load(176, 4, m.local.get(0, i32))));
  b.Function.setBody(f, m.block(null, [m.if(noTechSet, m.return(m.i32.const(0))), fi.body], fi.results));
  console.log('material: Material_GetTechnique returns null for a missing material or techset');
}

// 9. Another player's head tag (CachedTag_GetTagPos: name tags, aim) when their model isn't set up yet on this client
// (they just joined or respawned): CachedTag_UpdateTagInternal drops the whole game with Com_Error ("Cannot find dobj
// on entity", seen on Kino), and the uncached path asserts before falling back to the entity's origin. Keep the last
// known tag position instead, and take the fallback.
{
  const assertName = nameOf(byPrefix('Assert_MyHandler(')), errName = nameOf(byPrefix('Com_Error('));
  const retarget = (prefix, target, pick) => {
    const calls = [];
    walk(b.getFunctionInfo(byPrefix(prefix)).body, e => { const i = info(e); if (i.id === b.CallId && pick(i)) calls.push(e); });
    for (const c of calls) b.Call.setTarget(c, target);
    return calls.length;
  };
  const ai = b.getFunctionInfo(byPrefix('Assert_MyHandler(')), ei = b.getFunctionInfo(byPrefix('Com_Error('));
  m.addFunction('kb_assert_continue', ai.params, ai.results, [], m.i32.const(1));
  m.addFunction('kb_error_ignore', ei.params, ei.results, [], m.nop());
  const n1 = retarget('CachedTag_UpdateTagInternal(', 'kb_error_ignore', i => i.target === errName);
  const n2 = retarget('CachedTag_GetTagPos(', 'kb_assert_continue',
    i => i.target === assertName && info(i.operands[1]).id === b.ConstId && info(i.operands[1]).value === 2646);
  if (n1 !== 2 || n2 !== 1) throw new Error(`cached tag: ${n1} Com_Error, ${n2} asserts`);
  console.log('tags: missing player models no longer end the game (CachedTag_*)');
}

// 12. Escape during a co-op join. A joiner drops its own copy of the map and connects to the host; in between, the
// key handler's Escape case (CL_KeyEvent, cl_keys.cpp) either raises Com_Error "Bad server address" (client neither
// connecting nor in game: a PC menu leftover that kills the game) or, while connecting to a remote server, cancels
// the connection ("Client cancelled connecting to server"). The page sends an Escape whenever the browser releases
// the mouse, and a controller's Start/B can map to it, so both happened mid-join. Ignore both: the Com_Error falls
// through to the main menu as the code after it intends, and the cancel only ever applies to a remote server (solo play
// has its server running locally and never takes that branch).
{
  const errName = nameOf(byPrefix('Com_Error(')), printName = nameOf(byPrefix('Com_Printf(')), discName = nameOf(byPrefix('CL_DisconnectLocalClient('));
  const fn = byPrefix('CL_KeyEvent('), errs = [], cancels = [];
  const isConst = (e, v) => { const i = info(e); return i.id === b.ConstId && (v === undefined || i.value === v); };
  // the cancel: a block where Com_Printf(14, <"Client cancelled ...">) is directly followed by CL_DisconnectLocalClient
  walk(b.getFunctionInfo(fn).body, e => {
    const i = info(e);
    if (i.id === b.CallId && i.target === errName) errs.push(e);
    if (i.id === b.BlockId) for (let k = 0; k + 1 < i.children.length; k++) {
      const a = info(i.children[k]), d = info(i.children[k + 1]);
      if (a.id === b.CallId && a.target === printName && isConst(a.operands[0], 14) && d.id === b.CallId && d.target === discName) cancels.push(i.children[k + 1]);
    }
  });
  if (errs.length !== 1 || cancels.length !== 1) throw new Error(`CL_KeyEvent: ${errs.length} Com_Error, ${cancels.length} cancel calls`);
  if (!m.getFunction('kb_error_ignore')) throw new Error('kb_error_ignore missing (step 9)');
  b.Call.setTarget(errs[0], 'kb_error_ignore');
  const di = b.getFunctionInfo(byPrefix('CL_DisconnectLocalClient('));
  m.addFunction('kb_cancel_ignore', di.params, di.results, [], m.nop());
  b.Call.setTarget(cancels[0], 'kb_cancel_ignore');
  console.log('join: Escape during a co-op join no longer errors or cancels (CL_KeyEvent)');
}

// 10. Debug asserts in co-op: the retail game had them compiled out, this build stops the engine on any of them, and
// a co-op client takes paths solo play never does (other players' entities, effects and models arriving from
// another machine). Steps 7-9 fixed the ones seen; for the rest, Assert_MyHandler first asks kb_net_assert(file,
// line), which (co-op pages only) logs the assert and returns 1: "carry on", as a retail build would. Solo play
// keeps stopping on asserts.
prepend('Assert_MyHandler(', 'kb_net_assert', 2);

// 11. Gamepads. The engine's gamepad consumers survived (CL_CreateCmd's inlined CL_GamepadMove reads the gpad state
// through CL_GamepadAxisValue and GPad_IsActive; GPad_InitAll registers the gpad_* dvars; bindaxis/bindgp*configs
// load the stick and button configs), but the feeder, IN_GamepadsMove (win_input.cpp: XInput polling into s_gamePads,
// axis events, CL_GamepadButtonEvent per button), went with the Win32 layer. mp/kbpad-runtime.js reimplements it from
// the PC source; this adds the per-frame call and exports the engine functions it uses.
//   import env.kb_pad_frame()   called first in BrowserPollInput (the web port's IN_Frame, once per engine frame)
{
  m.addFunctionImport('kb_pad_frame', 'env', 'kb_pad_frame', none, none);
  const f = byPrefix('BrowserPollInput('), fi = b.getFunctionInfo(f);
  b.Function.setBody(f, m.block(null, [m.call('kb_pad_frame', [], none), fi.body], fi.results));
  const EXPORTS = { CL_KeyEvent: 'CL_KeyEvent(', UI_KeyEvent: 'UI_KeyEvent(', UI_GetActiveMenu: 'UI_GetActiveMenu(',
    Demo_HandleInput: 'Demo_HandleInput(', Sys_Milliseconds: 'Sys_Milliseconds(', GPad_IsActive: 'GPad_IsActive(',
    GPad_GetStick: 'GPad_GetStick(', GPad_GetButton: 'GPad_GetButton(', GPad_IsButtonPressed: 'GPad_IsButtonPressed(',
    Dvar_SetBoolFromSource: 'Dvar_SetBoolFromSource(' };
  for (const [k, p] of Object.entries(EXPORTS)) m.addFunctionExport(nameOf(byPrefix(p)), 'KB_Pad_' + k);
  // The runtime addresses engine data directly (kbpad-runtime.js KBPAD_*). Check each against the code that uses it, so
  // a different engine build fails here instead of writing to the wrong place.
  const addrs = fn => {
    const out = new Set();
    walk(b.getFunctionInfo(byPrefix(fn)).body, e => {
      const i = info(e);
      if (i.id === b.ConstId && typeof i.value === 'number') out.add(i.value);
      if (i.id === b.LoadId || i.id === b.StoreId) {
        out.add(i.offset);
        if (info(i.ptr).id === b.ConstId) out.add(info(i.ptr).value + i.offset);
      }
    });
    return out;
  };
  const CHECK = [['GPad_IsActive(', 147054240, 's_gamePads'], ['GPad_InitAll(', 147054168, 'gpad_debug'],
    ['GPad_InitAll(', 147054220, 'gpad_enabled'], ['GPad_InitAll(', 147054224, 'gpad_present'],
    ['CL_GamepadAxisValue(', 13382032, 'gaGlobs'], ['CL_GamepadAxisValue(', 63598185, 'devgui active'],
    ['Axis_Unbindall_f(', 13382056, 'gaGlobs.virtualAxes'], ['CL_GetLocalClientUIGlobals(', 13391952, 'clientUIActives'],
    ['Key_ClearStates(', 13382496, 'playerKeys.anyKeyDown'], ['Key_ClearStates(', 13429888, 'cls.uiStarted']];
  for (const [fn, a, what] of CHECK) if (!addrs(fn).has(a)) throw new Error(`gamepad: ${what} is not at ${a} (${fn})`);
  console.log('gamepad: BrowserPollInput -> kb_pad_frame, engine addresses checked');
}

// 4. KB_Cbuf(text): Cbuf_AddText(0, text)
const cbuf = nameOf(byPrefix('Cbuf_AddText('));
m.addFunction('KB_Cbuf', b.createType([i32]), none, [], m.call(cbuf, [m.i32.const(0), m.local.get(0, i32)], none));
m.addFunctionExport('KB_Cbuf', 'KB_Cbuf');

console.log(`hooked ${hooked} send sites; validating...`);
if (!m.validate()) throw new Error('validation failed');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
b.setDebugInfo(true);  // keep the name section (function names in stack traces)
const bin = m.emitBinary();
fs.writeFileSync(OUT, bin);
console.log(`wrote ${OUT} (${bin.length} bytes, source ${fs.statSync(SRC).size})`);
