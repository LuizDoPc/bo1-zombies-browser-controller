// kbpad: gamepad support. Injected into KisakBlack-web.mjs next to kbnet-runtime.js (mp/build.mjs), so it runs in every
// thread. The engine kept its gamepad consumers (CL_CreateCmd's CL_GamepadMove, CL_GamepadAxisValue, the GPad_* reads,
// the gpad_* dvars, bindaxis and the stick/button configs in the fastfiles); the Win32 feeder that filled them did not
// survive the port. Two halves:
//   page thread: polls the Gamepad API (it only exists there) every 8 ms and publishes the first pad as an
//                XInput state in a control block in the shared wasm memory
//   engine thread: kb_pad_frame(), called by BrowserPollInput (mp/patch-wasm.mjs) once per engine frame, is the PC
//                engine's IN_GamepadsMove (win32/win_input.cpp) with GPad_UpdateAll (win32/win_gamepad.cpp) and
//                CL_GamepadEvent/CL_GamepadButtonEvent (client/cl_gamepad.cpp), ported line by line from the
//                decompiled source and calling the engine's own functions (KB_Pad_* exports) wherever they survived.
// ctrl (i32 at KBPAD_CTRL): [0] magic [1] updates [2] connected [3] wButtons (XInput bits) [4] left trigger 0..255
//   [5] right trigger [6..9] sThumbLX, LY, RX, RY (-32768..32767, Y up) [10] keyboard/mouse presses (counter)
//   [11] flags (1 = log events) [12] engine: the last update it read (page presses are latched until then)
var KBPAD_CTRL = 896, KBPAD_MAGIC = 0x4B425044;
// Engine data (static addresses in this build; mp/patch-wasm.mjs checks each against the code that uses it).
var KBPAD_PAD = 147054240;          // s_gamePads[0], GamePad (win_gamepad.h, 0x7C bytes)
var KBPAD_DVAR = {                  // const dvar_t *gpad_* (GPad_InitAll); dvar->current is at +24
  debug: 147054168, lstickDeflect: 147054172, rstickDeflect: 147054176, buttonDeadzone: 147054180,
  stickDeadzoneMin: 147054184, stickDeadzoneMax: 147054188, stickPressed: 147054192, stickHysteresis: 147054196,
  scrollFirst: 147054204, scrollRest: 147054208, enabled: 147054220, present: 147054224 };
var KBPAD_GAGLOBS = 13382032;       // gaGlobs[0].axesValues[6] (virtualAxes[6] follow at +24)
var KBPAD_KEYS = 13382208;          // playerKeys[0]: anyKeyDown +288, keys[256] (KeyState: down, repeats, binding,
                                    // binding2) +292, locSelInputState +4388
var KBPAD_UI = 13391952;            // clientUIActives[0]: keyCatchers +4, connectionState +8, nextScrollTime +12
var KBPAD_UISTARTED = 13429888;     // cls.uiStarted
var KBPAD_DEVGUI = 63598185;        // DevGui_IsActive()
// win_input.cpp buttonList: GamePadButton -> engine key (K_BUTTON_A = 1, ... ui/keycodes.h)
var KBPAD_BUTTONS = [0x10004000, 3, 0x10001000, 1, 0x10002000, 2, 0x10008000, 4, 0x20000000, 18, 0x20000001, 19,
  0x10000100, 5, 0x10000200, 6, 0x10000010, 14, 0x10000020, 15, 0x10000040, 16, 0x10000080, 17,
  0x10000001, 20, 0x10000002, 21, 0x10000004, 22, 0x10000008, 23];
var KBPAD_MENU_SCROLL = [20, 21, 22, 23, 28, 29, 30, 31];  // menuScrollButtonList: dpad, apad
var kbpad = { kbm: 0, configs: false, log: false };

function kbpadDvar(name) { return HEAP32[KBPAD_DVAR[name] >> 2]; }
function kbpadFloat(name) { return HEAPF32[(kbpadDvar(name) + 24) >> 2]; }
function kbpadInt(name) { return HEAP32[(kbpadDvar(name) + 24) >> 2]; }
function kbpadBool(name) { var d = kbpadDvar(name); return d ? HEAPU8[d + 24] : 0; }
function kbpadCmd(text) {  // Cbuf_AddText(0, text); it copies the text
  var sp = stackSave();
  wasmExports.KB_Cbuf(stringToUTF8OnStack(text));
  stackRestore(sp);
}

// ---- win_gamepad.cpp
function kbpadConvertStick(inX, inY) {  // GPad_ConvertStickToFloat
  var f = Math.fround, x = f(inX / 32767), y = f(inY / 32767), len = f(Math.sqrt(x * x + y * y));
  if (len) { x = f(x / len); y = f(y / len); }  // Vec2Normalize
  var min = kbpadFloat('stickDeadzoneMin'), max = kbpadFloat('stickDeadzoneMax');
  if (min <= len) len = len <= f(1 - max) ? f(f(len - min) / f(1 - f(min + max))) : 1;
  else len = 0;
  return [f(x * len), f(y * len)];
}
function kbpadUpdateSticks(x) {  // GPad_UpdateSticks + GPad_UpdateSticksDown
  var p = KBPAD_PAD, l = kbpadConvertStick(x.lx, x.ly), r = kbpadConvertStick(x.rx, x.ry), s = [l[0], l[1], r[0], r[1]];
  for (var i = 0; i < 4; i++) { HEAPF32[(p + 40 >> 2) + i] = HEAPF32[(p + 24 >> 2) + i]; HEAPF32[(p + 24 >> 2) + i] = s[i]; }
  var pressed = kbpadFloat('stickPressed'), hyst = kbpadFloat('stickHysteresis');
  for (var stick = 0; stick < 4; stick++) for (var dir = 0; dir < 2; dir++) {
    var o = stick * 2 + dir, last = HEAPU8[p + 64 + o] = HEAPU8[p + 56 + o];
    var t = Math.fround(last ? pressed - hyst : pressed + hyst), v = HEAPF32[(p + 24 >> 2) + stick];
    HEAPU8[p + 56 + o] = dir ? -t > v : v > t;
  }
}
function kbpadUpdateDigitals(x) {  // GPad_UpdateDigitals: a stick click doesn't count while that stick is deflected
  var p = KBPAD_PAD, d = x.buttons, s = p + 24 >> 2;
  HEAP16[p + 4 >> 1] = HEAP16[p + 2 >> 1];
  var r = kbpadFloat('rstickDeflect'), l = kbpadFloat('lstickDeflect');
  if (Math.abs(HEAPF32[s + 2]) > r || Math.abs(HEAPF32[s + 3]) > r) d &= ~0x80;
  if (Math.abs(HEAPF32[s]) > l || Math.abs(HEAPF32[s + 1]) > l) d &= ~0x40;
  HEAP16[p + 2 >> 1] = d;
}
function kbpadUpdateAnalogs(x) {  // GPad_UpdateAnalogs: trigger deadzone gpad_button_deadzone
  var p = KBPAD_PAD, dz = kbpadFloat('buttonDeadzone'), f = Math.fround;
  [x.lt, x.rt].forEach(function (t, i) {
    var v = f(f(f(t / 255) - dz) / f(1 - dz));
    HEAPF32[(p + 16 >> 2) + i] = HEAPF32[(p + 8 >> 2) + i];
    HEAPF32[(p + 8 >> 2) + i] = 0 - v < 0 ? v : 0;
  });
}
function kbpadButtonDown(b, last) {  // the state GPad_IsButtonReleased compares
  var p = KBPAD_PAD;
  if (b & 0x10000000) return (b & 0xEFFFFFFF & HEAP16[p + (last ? 4 : 2) >> 1]) !== 0;
  return HEAPF32[(p + (last ? 16 : 8) >> 2) + (b & 0xDFFFFFFF)] > 0;
}

// ---- cl_gamepad.cpp
function kbpadAxisEvent(axis, value) {  // CL_GamepadEvent
  // (CL_GamepadGenerateAPad has no effect in this engine; the debug chords on keyMask, toggling cg_wadefps and network
  // logging, and CL_ResetLastGamePadEventTime, whose idle timer is gone, are left out)
  HEAP32[(KBPAD_GAGLOBS >> 2) + axis] = value;
}
function kbpadIgnoreRepeat(key, repeats, time) {  // CL_CheckForIgnoreDueToRepeat (emblem editor delays left out)
  var ui = KBPAD_UI >> 2;
  if (HEAP32[ui + 1] & 0x10 && KBPAD_MENU_SCROLL.indexOf(key) >= 0) {
    if (repeats === 1) { HEAP32[ui + 3] = kbpadInt('scrollFirst') + time; return false; }
    if (time >>> 0 > HEAP32[ui + 3] >>> 0) { HEAP32[ui + 3] = kbpadInt('scrollRest') + time; return false; }
  }
  return repeats > 1;
}
function kbpadButtonEvent(key, ev, time, gpb) {  // CL_GamepadButtonEventForPort(0, ...) + CL_GamepadButtonEvent
  var X = wasmExports, ui = KBPAD_UI >> 2, kc = HEAP32[ui + 1];
  if (kc & 0x10 && ev === 1 && KBPAD_MENU_SCROLL.indexOf(key) >= 0)  // CL_GamepadResetMenuScrollTime
    HEAP32[ui + 3] = kbpadInt('scrollFirst') + time;
  var pressed = ev === 1, down = ev === 1 || ev === 2;
  if (kc & 0x100) return;
  var ks = KBPAD_KEYS + 292 + key * 16, any = KBPAD_KEYS + 288 >> 2;  // (every key in buttonList is a gamepad key)
  HEAP32[ks >> 2] = down;
  var clc = HEAP32[ui + 2];
  if (ev === 1) { if (++HEAP32[(ks >> 2) + 1] === 1) ++HEAP32[any]; }
  else { HEAP32[(ks >> 2) + 1] = 0; if (--HEAP32[any] < 0) HEAP32[any] = 0; }
  var kbPtr = HEAP32[(ks >> 2) + 2], kb = kbPtr ? UTF8ToString(kbPtr) : null;
  if (kbpad.log) console.log('KBPAD button key=' + key + ' event=' + ev + ' binding=' + kb + ' catchers=' + kc + ' state=' + clc);
  // Left out: the devgui chord (Back+Start, and a "devgui" binding), the Xbox Live unlockables reset, and the
  // LSTICK+dpad screenshot/noclip/notarget developer chords.
  if (HEAPU8[KBPAD_DEVGUI]) return;
  var bind = function (k) { var b = HEAP32[(KBPAD_KEYS + 300 + key * 16 >> 2) + k]; return b ? UTF8ToString(b) : null; };
  var locSel = KBPAD_KEYS + 4388 >> 2;
  if (kc & 8 && down) {  // location selection (airstrikes and the like)
    if (key === 2 || bind(0) === '+actionslot 4') HEAP32[locSel] = 1;  // LOC_SEL_INPUT_CANCEL
    else if (key === 1 || bind(0) === '+attack') HEAP32[locSel] = 2;  // CONFIRM
    else if (bind(0) === 'weapnext') HEAP32[locSel] = 4;  // REGROUP
    else if (bind(0) === '+usereload') HEAP32[locSel] = 5;  // DEFEND
    else if (bind(0) === 'togglescores') HEAP32[locSel] = 6;  // SQUAD_CANCEL
    return;
  }
  HEAP32[locSel] = 0;
  var menu = kc & 0x10 ? X.KB_Pad_UI_GetActiveMenu(0) : 0;
  if (clc === 1 || clc === 3) {  // CA_CINEMATIC, CA_LOGO: A or Start skips
    // (CL_StopLogoOrCinematic was inlined away; Escape through CL_KeyEvent reaches it in these states)
    if (ev === 1 && (key === 1 || key === 14) && (!(kc & 0x10) || !menu)) { X.KB_Pad_CL_KeyEvent(0, 27, 1, time); X.KB_Pad_CL_KeyEvent(0, 27, 0, time); }
    return;
  }
  if (down && kbpadIgnoreRepeat(key, HEAP32[(ks >> 2) + 1], time) && ev !== 2) return;
  if (kb && kb.toLowerCase() === 'mainmenu' && ev === 1) {
    if (kc & 0x10 || clc !== 10) X.KB_Pad_UI_KeyEvent(0, 15, pressed);
    return;
  }
  X.KB_Pad_Demo_HandleInput(0, 0, key, pressed);
  // (the scoreboard menu, gamercard and mute-error handlers are MP menus whose input functions are gone)
  var value = gpb ? X.KB_Pad_GPad_GetButton(0, gpb) : 0;
  for (var i = 0; i < 2; i++) {
    var kba = bind(i);
    if (down) {
      if (!(kc & 0x50) || menu === 7) {
        // (CG_TranslateGamepadButton only acts in MP kill cams and spectating, gone with them)
        if (clc && clc !== 2 && kba) kbpadCmd(kba[0] === '+' ? kba + ' ' + key + ' ' + (time >>> 0) + ' ' + value.toFixed(3) + '\n' : kba + '\n');
      } else if (HEAP32[KBPAD_UISTARTED >> 2] && !i) X.KB_Pad_UI_KeyEvent(0, kbpadMenuKey(key), down);
    } else {
      if (kba && kba[0] === '+') kbpadCmd('-' + kba.slice(1) + ' ' + key + ' ' + (time >>> 0) + ' ' + value.toFixed(3) + '\n');
      if (kc & 0x10 && HEAP32[KBPAD_UISTARTED >> 2] && !i) X.KB_Pad_UI_KeyEvent(0, kbpadMenuKey(key), 0);
    }
  }
}

// Menus. The PC UI (Menu_HandleKey) moves between menu items only with the arrow keys and the mouse wheel; the D-pad
// keys only scroll list boxes, and the console builds' left-stick menu keys (CL_GamepadGenerateAPad) are an empty
// stub on PC. So a controller could open the pause menu and press its first item, nothing else. In menus the D-pad
// sends the arrow keys instead (list boxes take those too), and so does the left stick, pressed and released through
// the engine's own stick state (stickDown: gpad_stick_pressed with gpad_stick_pressed_hysteresis). In play nothing
// changes: the D-pad keys run their bindings.
function kbpadMenuKey(key) { return key >= 20 && key <= 23 ? 154 + key - 20 : key; }  // DPAD_UP.. -> K_UPARROW..
function kbpadMenuStick() {
  var p = KBPAD_PAD, ui = KBPAD_UI >> 2;
  if (!(HEAP32[ui + 1] & 0x10) || HEAP32[ui + 1] & 0x100 || !HEAP32[KBPAD_UISTARTED >> 2]) return;
  [[1, 0, 154], [1, 1, 155], [0, 1, 156], [0, 0, 157]].forEach(function (s) {  // LY+ up, LY- down, LX- left, LX+ right
    var o = s[0] * 2 + s[1], d = HEAPU8[p + 56 + o];
    if (d !== HEAPU8[p + 64 + o]) wasmExports.KB_Pad_UI_KeyEvent(0, s[2], d);
  });
}

// ---- win_input.cpp
function kb_pad_frame() {
  var c = KBPAD_CTRL >> 2, X = wasmExports;
  if (Atomics.load(HEAP32, c) !== KBPAD_MAGIC || !kbpadDvar('enabled')) return;
  if (kbpadInt('debug') < 0) return;  // (gpad_debug < 0 delays input by that many frames, a test mode; not ported)
  kbpad.log = !!(HEAP32[c + 11] & 1);
  var seq = Atomics.load(HEAP32, c + 1);
  var p = KBPAD_PAD, was = HEAPU8[p], now = HEAP32[c + 2] ? 1 : 0;
  var x = { buttons: HEAP32[c + 3], lt: HEAP32[c + 4], rt: HEAP32[c + 5], lx: HEAP32[c + 6], ly: HEAP32[c + 7], rx: HEAP32[c + 8], ry: HEAP32[c + 9] };
  Atomics.store(HEAP32, c + 12, seq);
  // GPad_Check: XInputGetCapabilities -> the page saw a pad
  HEAPU8[p] = now; HEAPU8[p + 1] = 0;
  if (was && !now) {
    // GPad_ResetState. The PC engine only resets through its removed callback and doesn't release buttons held when
    // the pad goes away; release them (and center the axes) so nothing stays held.
    var zero = { buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 };
    kbpadUpdateSticks(zero); kbpadUpdateDigitals(zero); kbpadUpdateAnalogs(zero);
    for (var a = 0; a < 6; a++) kbpadAxisEvent(a, 0);
    for (var k = 0; k < 16; k++) if (kbpadButtonDown(KBPAD_BUTTONS[2 * k], true)) kbpadButtonEvent(KBPAD_BUTTONS[2 * k + 1], 0, X.KB_Pad_Sys_Milliseconds(), KBPAD_BUTTONS[2 * k]);
    console.log('KBPAD gamepad disconnected');
  }
  if (now) {
    if (!was) console.log('KBPAD gamepad connected');
    kbpadUpdateSticks(x); kbpadUpdateDigitals(x); kbpadUpdateAnalogs(x);  // GPad_UpdateAll
  }
  var present = 0, time = X.KB_Pad_Sys_Milliseconds();
  if (X.KB_Pad_GPad_IsActive(0)) {
    present = 1;
    kbpadEnable(c);
    var v = function (stick) { return Math.trunc(X.KB_Pad_GPad_GetStick(0, stick) * 65535); };
    var lx = v(0x40000000), ly = v(0x40000001), rx = v(0x40000002), ry = v(0x40000003);
    var lt = Math.trunc(X.KB_Pad_GPad_GetButton(0, 0x20000000) * 65535), rt = Math.trunc(X.KB_Pad_GPad_GetButton(0, 0x20000001) * 65535);
    kbpadAxisEvent(0, rx); kbpadAxisEvent(1, ry); kbpadAxisEvent(2, lx); kbpadAxisEvent(3, ly);
    kbpadAxisEvent(5, lt); kbpadAxisEvent(4, rt);
    for (var i = 0; i < 16; i++) {
      var b = KBPAD_BUTTONS[2 * i], key = KBPAD_BUTTONS[2 * i + 1];
      if (X.KB_Pad_GPad_IsButtonPressed(0, b)) kbpadButtonEvent(key, 1, time, b);
      else if (b & 0x20000000 && X.KB_Pad_GPad_GetButton(0, b) > 0) kbpadButtonEvent(key, 2, time, b);  // GPad_ButtonRequiresUpdates
      else if (!kbpadButtonDown(b, false) && kbpadButtonDown(b, true)) kbpadButtonEvent(key, 0, time, b);  // GPad_IsButtonReleased
    }
    kbpadMenuStick();
  } else kbpadEnable(c);
  var pd = kbpadDvar('present');
  if (pd && HEAPU8[pd + 24] !== present) X.KB_Pad_Dvar_SetBoolFromSource(pd, present, 0);
}
// gpad_enabled is the PC game's "Enable gamepad" option: CL_CreateCmd ignores the sticks without it, and it switches
// the on-screen hints ("Press X to ...") to controller buttons. Here it follows the input device in use: on with the
// pad's buttons or sticks, off again with a key or mouse press, and off without a pad. The first time a pad shows up
// it runs what GamerProfile_ExecControllerBindings does for a profile with the gamepad on: exec the stick and button
// configs named by gpad_sticksConfig/gpad_buttonsConfig (thumbstick_default/buttons_default, in the fastfiles).
function kbpadEnable(c) {
  var p = KBPAD_PAD, want = kbpadBool('enabled'), active = HEAPU8[p], kbm = HEAP32[c + 10];
  if (active && !kbpad.configs) { kbpad.configs = true; kbpadCmd('bindgpsticksconfigs\nbindgpbuttonsconfigs\nupdatevehiclebindings\n'); }
  if (!active) want = 0;
  else if (kbm !== kbpad.kbm) want = 0;
  else {
    var s = p + 24 >> 2;
    if (HEAP16[p + 2 >> 1] || HEAPF32[(p + 8 >> 2)] > 0 || HEAPF32[(p + 8 >> 2) + 1] > 0 ||
        HEAPF32[s] || HEAPF32[s + 1] || HEAPF32[s + 2] || HEAPF32[s + 3]) want = 1;
  }
  kbpad.kbm = kbm;
  if (want !== kbpadBool('enabled')) {
    wasmExports.KB_Pad_Dvar_SetBoolFromSource(kbpadDvar('enabled'), want, 0);
    if (kbpad.log) console.log('KBPAD gpad_enabled ' + want);
  }
}

// ---- page thread: Gamepad API -> ctrl. W3C "standard" mapping: buttons 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT,
// 8 Back, 9 Start, 10 LS, 11 RS, 12-15 dpad up/down/left/right; axes 0-3 LX, LY, RX, RY (Y down).
function kbpadPage() {
  var BITS = [0x1000, 0x2000, 0x4000, 0x8000, 0x100, 0x200, 0, 0, 0x20, 0x10, 0x40, 0x80, 0x1, 0x2, 0x4, 0x8];
  var kbm = 0, id = null, hidden = false, log = /[?&]padlog=1/.test(location.search), latch = 0, lt = 0, rt = 0, latchSeq = 0;
  ['keydown', 'mousedown', 'wheel'].forEach(function (t) { addEventListener(t, function () { kbm++; }, { capture: true, passive: true }); });
  document.addEventListener('visibilitychange', function () { hidden = document.hidden; publish(); });
  var thumb = function (v) { return Math.max(-32768, Math.min(32767, Math.round((v || 0) * 32767))); };
  function publish() {
    if (typeof HEAP32 === 'undefined' || !HEAP32) return;  // before the engine's memory exists
    var c = KBPAD_CTRL >> 2, pads = [], g = null;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) {}
    for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected && pads[i].mapping === 'standard') { g = pads[i]; break; }
    if (!g) for (var j = 0; j < pads.length; j++) if (pads[j] && pads[j].connected) { g = pads[j]; break; }
    if ((g && g.id) !== id) {
      id = g ? g.id : null;
      console.log(g ? 'KBPAD page: using gamepad "' + g.id + '" (mapping "' + g.mapping + '")' +
        (g.mapping === 'standard' ? '' : '; not the standard layout, buttons may be mixed up') : 'KBPAD page: no gamepad');
    }
    HEAP32[c + 10] = kbm; HEAP32[c + 11] = log ? 1 : 0;
    var on = !!g && g.buttons.length >= 4 && g.axes.length >= 2, use = on && !hidden, btn = 0;
    var val = function (k) { var b = g.buttons[k]; return b ? b.value || (b.pressed ? 1 : 0) : 0; };
    if (use) for (var k = 0; k < 16; k++) if (BITS[k] && g.buttons[k] && g.buttons[k].pressed) btn |= BITS[k];
    // The engine samples once per engine frame, which can be slower than this loop: a press that ends before the
    // engine's next frame is kept (and a trigger pull at its deepest) until the engine has read an update with it.
    var seq = HEAP32[c + 1] + 1, l = use ? Math.round(val(6) * 255) : 0, r = use ? Math.round(val(7) * 255) : 0;
    if (Atomics.load(HEAP32, c + 12) >= latchSeq) { latch = 0; lt = 0; rt = 0; }
    if (btn & ~latch || l > lt || r > rt) latchSeq = seq;
    latch |= btn; lt = Math.max(lt, l); rt = Math.max(rt, r);
    HEAP32[c + 2] = on ? 1 : 0;
    HEAP32[c + 3] = btn | latch;
    HEAP32[c + 4] = Math.max(l, lt);
    HEAP32[c + 5] = Math.max(r, rt);
    var ax = use ? g.axes : [];
    HEAP32[c + 6] = thumb(ax[0]); HEAP32[c + 7] = thumb(-(ax[1] || 0)); HEAP32[c + 8] = thumb(ax[2]); HEAP32[c + 9] = thumb(-(ax[3] || 0));
    Atomics.store(HEAP32, c + 1, seq);
    Atomics.store(HEAP32, c, KBPAD_MAGIC);
  }
  // Polled on a short timer rather than only per animation frame: rAF can run far below 60 Hz while the page thread is
  // busy with the engine's proxied calls, and a quick tap would fall between two polls. And per animation frame too:
  // Safari on iPad throttles the timer on a page without recent touches (the pad "stopped" until the screen was
  // tapped), while a visible page drawing the game keeps getting frames.
  setInterval(publish, 8);
  (function frame() { publish(); requestAnimationFrame(frame); })();
  globalThis.__kbpad = { publish: publish, ctrl: function () { return Array.from(HEAP32.subarray(KBPAD_CTRL >> 2, (KBPAD_CTRL >> 2) + 13)); },
    pad: function () { var p = KBPAD_PAD; return { enabled: HEAPU8[p], digitals: HEAP16[p + 2 >> 1], analogs: Array.from(HEAPF32.subarray(p + 8 >> 2, (p + 8 >> 2) + 2)),
      sticks: Array.from(HEAPF32.subarray(p + 24 >> 2, (p + 24 >> 2) + 4)), axes: Array.from(HEAP32.subarray(KBPAD_GAGLOBS >> 2, (KBPAD_GAGLOBS >> 2) + 18)),
      gpad_enabled: kbpadBool('enabled'), gpad_present: kbpadBool('present') }; } };
}
if (typeof window === 'object' && typeof ENVIRONMENT_IS_PTHREAD !== 'undefined' && !ENVIRONMENT_IS_PTHREAD &&
    typeof navigator === 'object' && navigator.getGamepads) kbpadPage();
