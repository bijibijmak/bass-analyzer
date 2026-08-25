// ═══════════════════════════════════════════════════════════
// MORLEY POWER FUZZ WAH — prototype
//
// Modelled on the Classic Power Fuzz Wah. Morley are explicit that the
// reissue keeps the original order: the FUZZ CIRCUIT COMES BEFORE THE WAH.
// Panel controls are Wah Level, Fuzz Level and a Modern / Vintage fuzz
// voicing switch, with an independent footswitch per effect.
//
// This tab is deliberately STANDALONE: on entry it takes the B7K drive and
// EQ out of the path entirely, so what you hear is the Morley alone.
//
// LATENCY — the whole point of this prototype:
//   · Every node here is sample-accurate. Biquads and waveshapers do not
//     buffer, so the chain adds exactly zero delay.
//   · The waveshaper is oversample:'none' on purpose. 2x/4x oversampling
//     is implemented with resampling filters that DO add delay, which is
//     the one thing we are trying to avoid. That trades some aliasing for
//     immediacy.
//   · Expression is written straight to AudioParams inside the pointer or
//     tilt event. Nothing is polled from a rAF loop, so the control path
//     adds no frame of lag either.
//   · The pad indicator moves by a direct style write in the same handler,
//     for the same reason.
// The ~100 ms you can still hear is input + output buffering, exactly as
// documented for the rest of the app. Nothing in JS moves that.
// ═══════════════════════════════════════════════════════════

// Sweep defaults are bass-oriented. A guitar wah runs roughly 400 Hz–2.2 kHz;
// that is too high to be useful on a low B, so this opens lower. Morley
// advertise "our widest frequency sweep" but publish no numbers, so these are
// a judgement call rather than a measurement (~40% confidence in the exact
// endpoints, high confidence that this range is the useful one for bass).
const WAH_DEFAULTS = {
  on: false, fuzzOn: false,
  wahLevel: 75,      // 0..100 → −24..+6 dB
  fuzzLevel: 60,     // 0..100 → −24..+6 dB
  fuzzMode: 'vintage',
  sweepLo: 150, sweepHi: 1800,
  q: 3.5,
  xFuzz: false,      // X axis drives fuzz amount
  pos: 0.35,         // heel..toe, 0..1
  fuzzAmt: 0.5,      // 0..1, only used when xFuzz is on
  tiltHeel: 25, tiltToe: 80
};
const wah = Object.assign({}, WAH_DEFAULTS);

// 8 ms: fast enough that a sweep feels attached to the cursor, slow enough
// that stepping the filter does not zipper.
const WAH_SMOOTH = 0.008;

let wahNodes = null;        // only exists while the tab is open
let wahSpliced = false;
let wahTiltOn = false;

// ── Curves ─────────────────────────────────────────────────
// Vintage: "that old-school ripped speaker sound" — hard, asymmetric,
// spitty. Modern: "tighter and more guitar distortion like" — smoother and
// more symmetric. Both ~35% confidence as emulations; the behaviour of the
// controls is what this prototype is actually for.
function wahFuzzCurve(mode, n) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    let y;
    if (mode === 'vintage') {
      y = x >= 0 ? Math.tanh(6.5 * x) : 0.80 * Math.tanh(4.2 * x);
      y = Math.max(-0.92, Math.min(0.98, y * 1.06));     // squares off the tops
    } else {
      y = Math.tanh(3.0 * x);
    }
    c[i] = y;
  }
  return c;
}

const wahDb = v => Math.pow(10, (-24 + (num(v, 0) / 100) * 30) / 20);   // 0..100 → −24..+6 dB
const wahFreqAt = p => wah.sweepLo * Math.pow(wah.sweepHi / wah.sweepLo,
                                              Math.max(0, Math.min(1, p)));
const wahFuzzGainAt = a => Math.pow(10, (Math.max(0, Math.min(1, a)) * 32) / 20);  // 0..+32 dB

// ── Graph ──────────────────────────────────────────────────
function wahBuild() {
  if (!audioCtx || wahNodes) return;
  const ac = audioCtx;
  const n = {
    in:        ac.createGain(),
    fuzzDry:   ac.createGain(),
    fuzzPre:   ac.createGain(),
    shaper:    ac.createWaveShaper(),
    fuzzTone:  ac.createBiquadFilter(),
    fuzzWet:   ac.createGain(),
    fuzzSum:   ac.createGain(),
    fuzzLevel: ac.createGain(),
    wahDry:    ac.createGain(),
    filter:    ac.createBiquadFilter(),
    wahWet:    ac.createGain(),
    wahSum:    ac.createGain(),
    wahLevel:  ac.createGain(),
    out:       ac.createGain()
  };

  n.shaper.oversample = 'none';                 // see the latency note above
  n.fuzzTone.type = 'lowpass';
  n.filter.type = 'bandpass';                   // an inductor wah IS a bandpass

  // fuzz, then wah — the pedal's own order
  n.in.connect(n.fuzzDry);   n.fuzzDry.connect(n.fuzzSum);
  n.in.connect(n.fuzzPre);   n.fuzzPre.connect(n.shaper);
  n.shaper.connect(n.fuzzTone); n.fuzzTone.connect(n.fuzzWet); n.fuzzWet.connect(n.fuzzSum);
  n.fuzzSum.connect(n.fuzzLevel);

  n.fuzzLevel.connect(n.wahDry); n.wahDry.connect(n.wahSum);
  n.fuzzLevel.connect(n.filter); n.filter.connect(n.wahWet); n.wahWet.connect(n.wahSum);
  n.wahSum.connect(n.wahLevel); n.wahLevel.connect(n.out);

  wahNodes = n;
  wahApplyAll(true);
}

function wahDestroy() {
  if (!wahNodes) return;
  Object.keys(wahNodes).forEach(k => { try { wahNodes[k].disconnect(); } catch (e) {} });
  wahNodes = null;
}

// Splice ahead of the output and mute the B7K path, mirroring how the
// Spectrum tab splices its filter bank in.
function wahEnter() {
  wahSyncUI();
  if (!audioRunning || !audioCtx) return;
  wahBuild();
  if (wahSpliced || !wahNodes) return;
  try {
    gateGainNode.disconnect(outGainNode);       // B7K path stops reaching the output
    inGainNode.connect(wahNodes.in);            // straight off the input instead
    wahNodes.out.connect(outGainNode);
    wahSpliced = true;
  } catch (e) { console.warn('[Wah] splice', e); }
}

function wahExit(force) {
  wahTiltStop();
  if (!wahSpliced) { wahDestroy(); return; }
  const unsplice = () => {
    try {
      inGainNode.disconnect(wahNodes.in);
      wahNodes.out.disconnect(outGainNode);
      gateGainNode.connect(outGainNode);
    } catch (e) { console.warn('[Wah] unsplice', e); }
    wahSpliced = false;
    wahDestroy();
  };
  if (force || !audioCtx) { unsplice(); return; }
  // ramp the tab's output down first so the switch does not click
  try { wahNodes.out.gain.setTargetAtTime(0, audioCtx.currentTime, 0.012); } catch (e) {}
  setTimeout(unsplice, 60);
}

// ── Parameters ─────────────────────────────────────────────
function wahApplyAll(immediate) {
  if (!wahNodes || !audioCtx) return;
  const t = audioCtx.currentTime;
  const S = immediate ? 0.001 : WAH_SMOOTH;
  const n = wahNodes;

  n.shaper.curve = wahFuzzCurve(wah.fuzzMode, 1024);
  n.fuzzTone.frequency.value = wah.fuzzMode === 'vintage' ? 2600 : 4200;
  n.fuzzTone.Q.value = 0.707;

  const fz = wah.fuzzOn ? 1 : 0;
  n.fuzzWet.gain.setTargetAtTime(fz, t, S);
  n.fuzzDry.gain.setTargetAtTime(1 - fz, t, S);
  n.fuzzPre.gain.setTargetAtTime(
    wahFuzzGainAt(wah.xFuzz ? wah.fuzzAmt : 0.55), t, S);
  n.fuzzLevel.gain.setTargetAtTime(wah.fuzzOn ? wahDb(wah.fuzzLevel) : 1, t, S);

  const wo = wah.on ? 1 : 0;
  n.wahWet.gain.setTargetAtTime(wo, t, S);
  n.wahDry.gain.setTargetAtTime(1 - wo, t, S);
  n.filter.Q.setTargetAtTime(num(wah.q, 3.5), t, S);
  n.filter.frequency.setTargetAtTime(wahFreqAt(wah.pos), t, S);
  n.wahLevel.gain.setTargetAtTime(wah.on ? wahDb(wah.wahLevel) : 1, t, S);
  n.out.gain.setTargetAtTime(1, t, S);
}

// The hot path: called on every pointer move and every tilt event. Touches
// only the two params that expression drives, and writes them directly.
function wahExpress(pos, amt) {
  if (pos != null) wah.pos = Math.max(0, Math.min(1, pos));
  if (amt != null) wah.fuzzAmt = Math.max(0, Math.min(1, amt));
  if (wahNodes && audioCtx) {
    const t = audioCtx.currentTime;
    wahNodes.filter.frequency.setTargetAtTime(wahFreqAt(wah.pos), t, WAH_SMOOTH);
    if (wah.xFuzz) wahNodes.fuzzPre.gain.setTargetAtTime(wahFuzzGainAt(wah.fuzzAmt), t, WAH_SMOOTH);
  }
  wahPaintDot();
}

function wahSetParam(key, value) {
  wah[key] = value;
  wahApplyAll(false);
  wahSyncUI();
}

// ── Pad ────────────────────────────────────────────────────
function wahPaintDot() {
  const dot = document.getElementById('wahDot');
  const pad = document.getElementById('wahPad');
  if (!dot || !pad) return;
  const r = pad.getBoundingClientRect();
  if (r.width < 2) return;
  const x = wah.xFuzz ? wah.fuzzAmt * r.width : r.width / 2;
  const y = (1 - wah.pos) * r.height;            // toe at the top
  dot.style.transform = 'translate(' + (x - 9) + 'px,' + (y - 9) + 'px)';
  const rd = document.getElementById('wahReadout');
  if (rd) {
    rd.innerHTML = '<em>' + Math.round(wahFreqAt(wah.pos)) + ' Hz</em>' +
      (wah.xFuzz ? ' · fuzz <em>' + Math.round(wah.fuzzAmt * 100) + '%</em>' : '');
  }
}

function wahFromEvent(e) {
  const pad = document.getElementById('wahPad');
  const r = pad.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;
  wahExpress(1 - (e.clientY - r.top) / r.height,
             wah.xFuzz ? (e.clientX - r.left) / r.width : null);
}

function wahTogglePad() {
  wah.on = !wah.on;
  wahApplyAll(false);
  wahSyncUI();
}

function wireWahPad() {
  const pad = document.getElementById('wahPad');
  if (!pad) return;

  // A click engages; after that the cursor drives the sweep with no button
  // held. Leaving the pad holds the last position rather than resetting.
  pad.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse') return;        // touch handled below
    wahTogglePad();
    if (wah.on) wahFromEvent(e);
    e.preventDefault();
  });
  pad.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    if (wah.on) wahFromEvent(e);
  });

  // Touch: the pad only claims gestures once engaged, so an unengaged pad
  // still scrolls the page. Engaging is a deliberate tap.
  let tapX = 0, tapY = 0, moved = false;
  pad.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    tapX = e.clientX; tapY = e.clientY; moved = false;
    if (wah.on) { wahFromEvent(e); e.preventDefault(); }
  });
  pad.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse') return;
    if (Math.abs(e.clientX - tapX) > 8 || Math.abs(e.clientY - tapY) > 8) moved = true;
    if (wah.on) { wahFromEvent(e); e.preventDefault(); }
  });
  pad.addEventListener('pointerup', e => {
    if (e.pointerType === 'mouse') return;
    if (!moved) { wahTogglePad(); if (wah.on) wahFromEvent(e); }
  });
}

// ── Tilt (phone) ───────────────────────────────────────────
// Failure here has to be loud. deviceorientation needs a SECURE CONTEXT:
// over plain http (which `npm run serve` gives you on the LAN) the event
// never fires, and on Android there is no permission prompt to fail — so
// it is entirely possible to attach a listener, report success and receive
// nothing. Every branch below says what actually happened, and a watchdog
// catches the silent case.
// isSecureContext is TRUE on file:// in Chrome, so it cannot classify this
// on its own — the protocol has to be checked first. Same lesson the detune
// worklet guard learned, and verify.js [13] enforces it.
function wahContext() {
  if (typeof location === 'undefined') return 'unknown';
  if (location.protocol === 'file:') return 'file';
  return window.isSecureContext ? 'secure' : 'insecure';
}
const WAH_CTX_NOTE = {
  file:     'opened as a local file — browsers do not report motion from file://',
  insecure: 'not a secure context — browsers only report motion over https or from localhost',
  secure:   'secure',
  unknown:  'unknown'
};

let wahLastBeta = null, wahTiltSeen = 0, wahTiltWatch = null, wahCal = null;

function wahTiltDiag() {
  const el = document.getElementById('wahTiltDiag');
  if (!el) return;
  const has = typeof DeviceOrientationEvent !== 'undefined';
  el.innerHTML =
    'context <em>' + wahContext() + '</em>' +
    ' · sensor <em>' + (has ? 'yes' : 'no') + '</em>' +
    ' · grant <em>' + (has && typeof DeviceOrientationEvent.requestPermission === 'function'
                        ? 'required' : 'not needed') + '</em>' +
    ' · events <em>' + wahTiltSeen + '</em>' +
    (wahLastBeta == null ? '' : ' · beta <em>' + wahLastBeta.toFixed(1) + '°</em>');
}

function wahOnTilt(e) {
  if (e.beta == null) return;
  wahTiltSeen++;
  wahLastBeta = e.beta;                      // recorded before any early exit,
  if (wahCal) {                              // so calibration always has a value
    wahCal.lo = Math.min(wahCal.lo, e.beta);
    wahCal.hi = Math.max(wahCal.hi, e.beta);
  }
  wahTiltDiag();
  const lo = Math.min(wah.tiltHeel, wah.tiltToe), hi = Math.max(wah.tiltHeel, wah.tiltToe);
  if (hi - lo < 3) return;
  const inv = wah.tiltToe < wah.tiltHeel;
  const p = (e.beta - lo) / (hi - lo);
  wahExpress(inv ? 1 - p : p, null);
}

async function wahTiltStart() {
  if (typeof DeviceOrientationEvent === 'undefined') {
    wahSay('This browser exposes no orientation sensor — desktop browsers generally do not.');
    wahTiltDiag(); return;
  }
  const ctx = wahContext();
  if (ctx !== 'secure') {
    // Warn, then try anyway: if it somehow works the watchdog will say so.
    wahSay('Heads up — this page is ' + WAH_CTX_NOTE[ctx] + '. Trying anyway…');
  }
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') { wahSay('Motion access denied. Reload and allow it to use tilt.'); wahTiltDiag(); return; }
    } catch (err) {
      wahSay('Motion access could not be requested: ' + err.message +
             '. On iOS this needs an https page.');
      wahTiltDiag(); return;
    }
  }

  window.addEventListener('deviceorientation', wahOnTilt);
  wahTiltOn = true;
  wah.on = true;                 // tilt against a bypassed wah is silent
  wahApplyAll(false);
  wahSyncUI(); wahTiltDiag();

  const before = wahTiltSeen;
  clearTimeout(wahTiltWatch);
  wahTiltWatch = setTimeout(() => {
    if (wahTiltSeen === before) {
      const c = wahContext();
      wahSay(c === 'secure'
        ? 'Listener attached but the device is sending no orientation events. ' +
          'Either there is no sensor, or the browser is withholding it.'
        : 'No orientation events — this page is ' + WAH_CTX_NOTE[c] +
          '. Serve it over https, or from localhost, and tilt will work.');
    } else {
      wahSay('Tilt live — rock the phone like a treadle. Wah engaged automatically.');
    }
    wahTiltDiag();
  }, 1500);
}

function wahTiltStop() {
  if (!wahTiltOn) return;
  clearTimeout(wahTiltWatch);
  window.removeEventListener('deviceorientation', wahOnTilt);
  wahTiltOn = false; wahSyncUI(); wahTiltDiag();
}
function wahTiltToggle() { wahTiltOn ? wahTiltStop() : wahTiltStart(); }

function wahSetTilt(which) {
  if (wahLastBeta == null) { wahSay('No tilt reading yet — enable tilt first.'); return; }
  wah[which === 'heel' ? 'tiltHeel' : 'tiltToe'] = Math.round(wahLastBeta);
  wahSyncUI();
  wahSay((which === 'heel' ? 'Heel' : 'Toe') + ' set at ' + Math.round(wahLastBeta) + '°.');
}

// Records the range you actually use, which beats guessing at how someone
// holds their phone.
function wahAutoCalibrate() {
  if (!wahTiltOn) { wahSay('Enable tilt first, then calibrate.'); return; }
  wahCal = { lo: 1e9, hi: -1e9 };
  wahSay('Rock the phone heel to toe for three seconds…');
  setTimeout(() => {
    const c = wahCal; wahCal = null;
    if (!c || c.hi - c.lo < 8) { wahSay('Not enough movement — try again, rocking further.'); return; }
    wah.tiltHeel = Math.round(c.lo); wah.tiltToe = Math.round(c.hi);
    wahSyncUI();
    wahSay('Calibrated: heel ' + Math.round(c.lo) + '° → toe ' + Math.round(c.hi) + '°.');
  }, 3000);
}

function wahSay(msg) { const el = document.getElementById('wahMsg'); if (el) el.textContent = msg; }

// ── UI ─────────────────────────────────────────────────────
function wahSyncUI() {
  const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
  set('wahOnBtn', el => { el.textContent = 'Wah: ' + (wah.on ? 'ON' : 'OFF'); el.classList.toggle('active', wah.on); });
  set('wahFuzzBtn', el => { el.textContent = 'Fuzz: ' + (wah.fuzzOn ? 'ON' : 'OFF'); el.classList.toggle('active', wah.fuzzOn); });
  set('wahXBtn', el => { el.textContent = 'X = fuzz: ' + (wah.xFuzz ? 'ON' : 'OFF'); el.classList.toggle('active', wah.xFuzz); });
  set('wahTiltBtn', el => { el.textContent = wahTiltOn ? 'Tilt: ON' : 'Use phone tilt'; el.classList.toggle('active', wahTiltOn); });
  set('wahPad', el => { el.classList.toggle('engaged', wah.on);
                        el.classList.toggle('xfuzz', wah.xFuzz); });
  set('wahLevelVal', el => el.textContent = Math.round(wah.wahLevel) + '%');
  set('wahFuzzLevelVal', el => el.textContent = Math.round(wah.fuzzLevel) + '%');
  set('wahQVal', el => el.textContent = num(wah.q, 3.5).toFixed(1));
  set('wahLoVal', el => el.textContent = Math.round(wah.sweepLo) + ' Hz');
  set('wahHiVal', el => el.textContent = Math.round(wah.sweepHi) + ' Hz');
  wahTiltDiag();
  set('wahTiltRange', el => el.textContent = Math.round(wah.tiltHeel) + '° → ' + Math.round(wah.tiltToe) + '°');
  document.querySelectorAll('[data-wahmode]').forEach(b =>
    b.classList.toggle('active', b.dataset.wahmode === wah.fuzzMode));
  document.querySelectorAll('input[data-wahbind]').forEach(el => {
    const k = el.dataset.wahbind;
    if (parseFloat(el.value) !== wah[k]) el.value = wah[k];
  });
  wahPaintDot();
}

function wireWah() {
  wireWahPad();
  document.querySelectorAll('input[data-wahbind]').forEach(el => {
    const k = el.dataset.wahbind;
    el.addEventListener('input', () => wahSetParam(k, parseFloat(el.value)));
    el.addEventListener('wheel', e => {
      if (document.activeElement !== el) return;   // the wheel belongs to the page
      e.preventDefault();
      const step = parseFloat(el.step) || 1, dir = e.deltaY < 0 ? 1 : -1;
      const v = Math.min(parseFloat(el.max), Math.max(parseFloat(el.min), parseFloat(el.value) + dir * step));
      el.value = v; wahSetParam(k, v);
    }, { passive: false });
  });
}

function wahToggleOn()   { wahTogglePad(); }
function wahToggleFuzz() { wah.fuzzOn = !wah.fuzzOn; wahApplyAll(false); wahSyncUI(); }
function wahToggleX()    { wah.xFuzz = !wah.xFuzz; wahApplyAll(false); wahSyncUI(); }
function wahSetMode(m)   { wah.fuzzMode = m; wahApplyAll(false); wahSyncUI(); }
