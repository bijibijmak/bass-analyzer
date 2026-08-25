#!/usr/bin/env python3
"""Wire the Morley Power Fuzz Wah tab in.

New part file plus five small hooks. Everything about the effect itself lives
in parts/09_wah.js; these edits only tell the app it exists.
"""
import sys, io, re
WAH_JS = r"""// ═══════════════════════════════════════════════════════════
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
  tiltHeel: 20, tiltToe: 70
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
function wahOnTilt(e) {
  if (e.beta == null) return;
  const lo = Math.min(wah.tiltHeel, wah.tiltToe), hi = Math.max(wah.tiltHeel, wah.tiltToe);
  if (hi - lo < 3) return;
  const inv = wah.tiltToe < wah.tiltHeel;
  let p = (e.beta - lo) / (hi - lo);
  wahLastBeta = e.beta;
  wahExpress(inv ? 1 - p : p, null);
}
let wahLastBeta = null;

async function wahTiltStart() {
  if (typeof DeviceOrientationEvent === 'undefined') { wahSay('This device reports no orientation sensor.'); return; }
  // iOS 13+ requires an explicit grant, and only from a user gesture.
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') { wahSay('Motion access denied — tilt unavailable.'); return; }
    } catch (err) { wahSay('Motion access needs a secure (https) page.'); return; }
  }
  window.addEventListener('deviceorientation', wahOnTilt);
  wahTiltOn = true; wahSyncUI();
  wahSay('Tilt live. Rock the phone like a treadle.');
}
function wahTiltStop() {
  if (!wahTiltOn) return;
  window.removeEventListener('deviceorientation', wahOnTilt);
  wahTiltOn = false; wahSyncUI();
}
function wahTiltToggle() { wahTiltOn ? wahTiltStop() : wahTiltStart(); }
function wahSetTilt(which) {
  if (wahLastBeta == null) { wahSay('No tilt reading yet — enable tilt first.'); return; }
  wah[which === 'heel' ? 'tiltHeel' : 'tiltToe'] = Math.round(wahLastBeta);
  wahSyncUI();
  wahSay((which === 'heel' ? 'Heel' : 'Toe') + ' set at ' + Math.round(wahLastBeta) + '°.');
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
"""
PANEL_HTML = r"""<section class="tab-panel" id="panel-wah" role="tabpanel" aria-labelledby="tab-wah">
  <div class="section-label">Wah — <span>Morley Power Fuzz Wah</span></div>

  <div class="fft-toggle-row">
    <button class="fft-btn" id="wahOnBtn"   onclick="wahToggleOn()">Wah: OFF</button>
    <button class="fft-btn" id="wahFuzzBtn" onclick="wahToggleFuzz()">Fuzz: OFF</button>
    <button class="fft-btn" id="wahXBtn"    onclick="wahToggleX()">X = fuzz: OFF</button>
    <span class="fft-info" id="wahReadout"><em>—</em></span>
  </div>

  <div class="wah-pad" id="wahPad">
    <div class="wah-axis wah-toe">Toe</div>
    <div class="wah-axis wah-heel">Heel</div>
    <div class="wah-axis wah-left">Clean</div>
    <div class="wah-axis wah-right">Fuzz</div>
    <div class="wah-dot" id="wahDot"></div>
    <div class="wah-hint">click to engage</div>
  </div>
  <p class="hint" id="wahMsg">
    Click the pad to engage, then move the cursor up and down — toe at the top,
    heel at the bottom. It holds wherever you leave it. On a phone, tilt does the same job.
  </p>

  <div class="section-label">Panel — <span>the pedal's own controls</span></div>
  <div class="noise-section">
    <div class="noise-tool">
      <div class="ctrl-label">Wah Level <span class="val" id="wahLevelVal">75%</span></div>
      <input type="range" data-wahbind="wahLevel" min="0" max="100" value="75" step="1">
    </div>
    <div class="noise-tool">
      <div class="ctrl-label">Fuzz Level <span class="val" id="wahFuzzLevelVal">60%</span></div>
      <input type="range" data-wahbind="fuzzLevel" min="0" max="100" value="60" step="1">
    </div>
    <div class="noise-tool">
      <div class="ctrl-label">Fuzz voicing</div>
      <div class="sw3">
        <button type="button" data-wahmode="vintage" onclick="wahSetMode('vintage')">Vintage</button>
        <button type="button" data-wahmode="modern"  onclick="wahSetMode('modern')">Modern</button>
      </div>
      <div class="noise-tool-desc">Vintage is the ripped-speaker voice; Modern is tighter, closer to a distortion.</div>
    </div>
  </div>

  <div class="section-label">Sweep — <span>not on the real pedal</span></div>
  <div class="noise-section">
    <div class="noise-tool">
      <div class="ctrl-label">Heel frequency <span class="val" id="wahLoVal">150 Hz</span></div>
      <input type="range" data-wahbind="sweepLo" min="60" max="600" value="150" step="5">
    </div>
    <div class="noise-tool">
      <div class="ctrl-label">Toe frequency <span class="val" id="wahHiVal">1800 Hz</span></div>
      <input type="range" data-wahbind="sweepHi" min="700" max="4000" value="1800" step="20">
    </div>
    <div class="noise-tool">
      <div class="ctrl-label">Resonance <span class="val" id="wahQVal">3.5</span></div>
      <input type="range" data-wahbind="q" min="0.5" max="9" value="3.5" step="0.1">
      <div class="noise-tool-desc">Morley publish no sweep figures, so these open lower than a guitar wah to suit a bass.</div>
    </div>
  </div>

  <div class="section-label">Tilt — <span>phone expression</span></div>
  <div class="noise-section">
    <div class="noise-tool">
      <div class="noise-tool-head">
        <button class="noise-btn" id="wahTiltBtn" onclick="wahTiltToggle()">Use phone tilt</button>
        <span class="fft-info">range <em id="wahTiltRange">20° → 70°</em></span>
      </div>
      <div class="noise-tool-desc">
        Rock the phone forward and back like a treadle. iOS asks for motion access
        the first time, and only grants it over https.
      </div>
      <div class="freq-btns">
        <button class="freq-btn" type="button" onclick="wahSetTilt('heel')">Set heel here</button>
        <button class="freq-btn" type="button" onclick="wahSetTilt('toe')">Set toe here</button>
      </div>
    </div>
  </div>
</section>

"""
PAD_CSS = r"""
/* ── Morley wah expression pad ───────────────────────────── */
/* touch-action flips to none only while engaged, so an idle pad still
   scrolls the page — engaging is a deliberate tap. */
.wah-pad {
  position: relative; width: 100%; height: 230px; margin-bottom: 8px;
  border: 1px solid var(--pedal-edge); border-radius: 8px;
  background: var(--panel-2); cursor: crosshair; overflow: hidden;
  touch-action: pan-y;
}
.wah-pad.engaged {
  border-color: var(--darkgas-teal);
  box-shadow: inset 0 0 0 1px var(--darkgas-teal), 0 0 18px var(--glow);
  touch-action: none;
}
.wah-dot {
  position: absolute; left: 0; top: 0; width: 18px; height: 18px; border-radius: 50%;
  background: var(--darkgas-teal); box-shadow: 0 0 14px var(--glow);
  pointer-events: none;
}
.wah-pad:not(.engaged) .wah-dot { opacity: 0.3; }
.wah-axis {
  position: absolute; font-size: 0.5rem; letter-spacing: 0.16em;
  text-transform: uppercase; color: var(--dim); pointer-events: none;
}
.wah-toe   { top: 7px;    left: 50%; transform: translateX(-50%); }
.wah-heel  { bottom: 7px; left: 50%; transform: translateX(-50%); }
.wah-left  { left: 8px;   top: 50%;  transform: translateY(-50%); }
.wah-right { right: 8px;  top: 50%;  transform: translateY(-50%); }
.wah-left, .wah-right { display: none; }
.wah-pad.xfuzz .wah-left, .wah-pad.xfuzz .wah-right { display: block; }
.wah-hint {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  font-size: 0.6rem; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--dim); pointer-events: none;
}
.wah-pad.engaged .wah-hint { display: none; }
"""

D = sys.argv[1] if len(sys.argv) > 1 else '.'
SRC = sys.argv[2] if len(sys.argv) > 2 else '/root/wah'
def rd(p): return io.open(p, encoding='utf-8').read()
_INLINE = {'09_wah.js': WAH_JS, 'panel.html': PANEL_HTML, 'pad.css': PAD_CSS}
def src(name): return _INLINE[name]
def wr(p, s): io.open(p, 'w', encoding='utf-8').write(s)

# 1 ── the part file itself
wr(D + '/parts/09_wah.js', src('09_wah.js'))
print('1. parts/09_wah.js written')

# 2 ── build.sh must concatenate it (before 07, which carries the boot sequence)
b = rd(D + '/build.sh')
if '09_wah.js' in b:
    print('2. build.sh already lists it')
else:
    OLD = '"$P/wsola_core.js" "$P/08_detune.js" "$P/07_tuner_presets_init.js" > /tmp/app.js'
    NEW = '"$P/wsola_core.js" "$P/08_detune.js" "$P/09_wah.js" "$P/07_tuner_presets_init.js" > /tmp/app.js'
    if OLD not in b: raise SystemExit('build.sh concat line not found')
    wr(D + '/build.sh', b.replace(OLD, NEW, 1))
    print('2. build.sh now concatenates 09_wah.js')

# 3 ── core: tab list, enter/exit hooks, redraw branch
c = rd(D + '/parts/03_core.js')
if "'wah'" in c:
    print('3. core already wired')
else:
    OLD = "const TABS = ['preamp', 'tuner', 'spectrum', 'detune', 'mix'];"
    NEW = "const TABS = ['preamp', 'tuner', 'spectrum', 'detune', 'wah', 'mix'];"
    if OLD not in c: raise SystemExit('TABS not found')
    c = c.replace(OLD, NEW, 1)

    OLD = ("  if (prev === 'spectrum') spectrumExit();\n"
           "  if (name === 'spectrum') spectrumEnter();")
    NEW = ("  if (prev === 'spectrum') spectrumExit();\n"
           "  if (prev === 'wah') wahExit(false);\n"
           "  if (name === 'spectrum') spectrumEnter();\n"
           "  if (name === 'wah') wahEnter();")
    if OLD not in c: raise SystemExit('setTab hooks not found')
    c = c.replace(OLD, NEW, 1)

    OLD = ("  } else if (activeTab === 'detune') {\n"
           "    renderDetune();\n"
           "  }")
    NEW = ("  } else if (activeTab === 'detune') {\n"
           "    renderDetune();\n"
           "  } else if (activeTab === 'wah') {\n"
           "    wahSyncUI();\n"
           "  }")
    if OLD not in c: raise SystemExit('redrawStatic branch not found')
    c = c.replace(OLD, NEW, 1)
    wr(D + '/parts/03_core.js', c)
    print('3. core: TABS, setTab hooks and redrawStatic branch')

# 4 ── markup: panel before the Mix panel, button before the Mix button
m = rd(D + '/parts/02_body.html')
if 'panel-wah' in m:
    print('4. markup already wired')
else:
    panel = src('panel.html')
    A = '<section class="tab-panel" id="panel-mix"'
    if A not in m: raise SystemExit('mix panel not found')
    m = m.replace(A, panel + A, 1)
    B = '  <button class="tab-btn" id="tab-mix"'
    if B not in m: raise SystemExit('mix tab button not found')
    btn = ('  <button class="tab-btn" id="tab-wah"      role="tab" aria-selected="false" '
           'aria-controls="panel-wah"      onclick="setTab(\'wah\')">'
           '<span class="tab-ico">\U0001F39B</span>Wah</button>\n')
    m = m.replace(B, btn + B, 1)
    wr(D + '/parts/02_body.html', m)
    print('4. markup: panel + island button')

# 5 ── css, ahead of the skins block so a skin can still override it
h = rd(D + '/parts/01_head.html')
if '.wah-pad' in h:
    print('5. css already present')
else:
    css = src('pad.css')
    A = '/* ═══════════════════════════════════════════════════════════\n   SKINS'
    if A in h: h = h.replace(A, css + '\n' + A, 1)
    else:      h = h.replace('</style>', css + '\n</style>', 1)
    wr(D + '/parts/01_head.html', h)
    print('5. css inserted ahead of the skins block')

# 6 ── boot
i = rd(D + '/parts/07_tuner_presets_init.js')
if 'wireWah()' in i:
    print('6. already wired at boot')
else:
    A = 'wirePedalPanel();'
    if A not in i: raise SystemExit('boot anchor not found')
    wr(D + '/parts/07_tuner_presets_init.js', i.replace(A, A + '\nwireWah();', 1))
    print('6. wireWah() wired at boot')
