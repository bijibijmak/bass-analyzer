// ═══════════════════════════════════════════════════════════
// CHORUS — classic analog, one voice
//
// The signal arrives here already shaped: preamp (B7K, graphic EQ or curve)
// → chorus → cleanup → out. That order is deliberate. A chorus is a pitch
// effect, and putting it after the EQ means it hears the tone you actually
// play, while the hiss filter and the notch downstream still get a chance at
// anything it adds.
//
// HOW IT WORKS, because this is the part people guess at:
//   out(t) = dry(t) + wet(t − D(t))
// One delayed copy, with the delay D slowly swept by a sine. A delay that is
// getting LONGER drags the copy flat; one that is shortening pulls it sharp.
// That moving detune beating against the untouched dry path is the whole
// effect. The instantaneous ratio is 1 − D′(t), so the pitch swing is set by
// how fast the delay moves — Depth AND Rate together, not Depth alone. The
// panel prints the resulting cents for exactly that reason.
//
// It is asymmetric: at a given sweep speed the flat side is slightly wider
// than the sharp side, because log2(1 − d) is larger in magnitude than
// log2(1 + d). The readout quotes the flat side, the bigger of the two.
//
// NO feedback path. Feeding the delay back into itself is a flanger, not a
// chorus — comb notches that whoosh, rather than a thickened unison.
//
// LATENCY: the dry leg is a plain gain node, so it adds zero samples. Only
// the wet voice is delayed, by 3.5–10.5 ms, which IS the effect. Nothing
// here moves the app's end-to-end figure.
// ═══════════════════════════════════════════════════════════

const CHORUS_KEY      = 'b7k_chorus_v1';
const CHORUS_BASE_MS  = 7;      // centre delay — classic BBD territory
const CHORUS_SWEEP_MS = 3.5;    // peak deviation at Depth 100
const CHORUS_SMOOTH   = 0.02;   // param ramp, slow enough not to zipper

// Base must exceed the sweep or the delay would go negative at the bottom of
// the sine. 7 ± 3.5 ms bottoms out at 3.5 ms, which is still a chorus and
// not a flanger.
const CHORUS_DEFAULTS = {
  on: false,
  rate: 0.8,     // Hz, 0.05 … 8
  depth: 45,     // 0..100 → 0 … 3.5 ms of sweep
  mix: 50,       // 0..100, equal-power against the dry path
  lows: 120      // Hz: wet leg is high-passed here so the fundamental stays dry
};
const chorus = Object.assign({}, CHORUS_DEFAULTS);

let chsNodes = null;
let chsSpliced = false;

const chorusSweepMs = () =>
  CHORUS_SWEEP_MS * Math.max(0, Math.min(100, num(chorus.depth, 0))) / 100;

// Peak pitch deviation, flat side, in cents. d = max |D'(t)| for a sine.
function chorusCents() {
  const A = chorusSweepMs() / 1000;
  const d = Math.min(0.95, A * 2 * Math.PI * Math.max(0, num(chorus.rate, 0)));
  return -1200 * Math.log2(1 - d);
}
const chorusMinMs = () => CHORUS_BASE_MS - chorusSweepMs();
const chorusMaxMs = () => CHORUS_BASE_MS + chorusSweepMs();

// ── Graph ──────────────────────────────────────────────────
function chorusBuild() {
  if (!audioCtx || chsNodes) return;
  const ac = audioCtx;
  const n = {
    in:      ac.createGain(),
    dry:     ac.createGain(),
    hp:      ac.createBiquadFilter(),
    delay:   ac.createDelay(0.05),
    lfo:     ac.createOscillator(),
    lfoGain: ac.createGain(),
    wet:     ac.createGain(),
    out:     ac.createGain()
  };
  n.hp.type = 'highpass';
  n.hp.Q.value = 0.707;
  // A sine, not a triangle. A triangle sweep reverses direction instantly,
  // which steps the detune — you hear it as a tick at the top and bottom of
  // every cycle. A sine has no such corner.
  n.lfo.type = 'sine';

  n.in.connect(n.dry); n.dry.connect(n.out);
  n.in.connect(n.hp); n.hp.connect(n.delay); n.delay.connect(n.wet); n.wet.connect(n.out);
  // The LFO drives the delay time as an AudioParam, so modulation happens in
  // the audio thread at audio rate. Nothing is polled from a frame loop.
  n.lfo.connect(n.lfoGain); n.lfoGain.connect(n.delay.delayTime);
  try { n.lfo.start(); } catch (e) {}

  chsNodes = n;
  chorusApply(true);
}

// Spliced across ONE edge, eqOut → filterHiss, which exists whichever preamp
// is selected: the graphic EQ and the curve both land on eqOut too. Before
// eqOut existed they returned straight to filterHiss, and anything spliced
// there would have been dropped the moment you switched preamp.
function chorusSplice() {
  if (!audioRunning || !audioCtx || chsSpliced) return;
  chorusBuild();
  if (!chsNodes || !eqOut || !filterHiss) return;
  try {
    eqOut.disconnect(filterHiss);
    eqOut.connect(chsNodes.in);
    chsNodes.out.connect(filterHiss);
    chsSpliced = true;
  } catch (e) { console.warn('[Chorus] splice', e); }
}

function chorusUnsplice() {
  if (!chsSpliced || !chsNodes) return;
  try {
    eqOut.disconnect(chsNodes.in);
    chsNodes.out.disconnect(filterHiss);
    eqOut.connect(filterHiss);
  } catch (e) { console.warn('[Chorus] unsplice', e); }
  chsSpliced = false;
}

function chorusOnAudioStart() { chorusSplice(); chorusSyncUI(); }

// The nodes died with the context. Holding the old ones would splice a
// corpse into the next graph — the exact failure the compressor had.
function chorusReset() { chsNodes = null; chsSpliced = false; }

// ── Parameters ─────────────────────────────────────────────
function chorusApply(immediate) {
  if (!chsNodes || !audioCtx) return;
  const t = audioCtx.currentTime;
  const S = immediate ? 0.001 : CHORUS_SMOOTH;
  const n = chsNodes;
  const on = !!chorus.on && !bypassed;

  // Equal-power against the dry path, the same crossfade the drive section
  // uses. Chorus is two decorrelated copies of the same note, so summing
  // them linearly at 50/50 would be quieter than either alone.
  const g = blendGains(on ? Math.max(0, Math.min(100, num(chorus.mix, 50))) : 0);
  n.dry.gain.setTargetAtTime(num(g.dry, 1), t, S);
  n.wet.gain.setTargetAtTime(num(g.wet, 0), t, S);

  n.delay.delayTime.setTargetAtTime(CHORUS_BASE_MS / 1000, t, S);
  n.lfoGain.gain.setTargetAtTime(on ? chorusSweepMs() / 1000 : 0, t, S);
  n.lfo.frequency.setTargetAtTime(Math.max(0.05, num(chorus.rate, 0.8)), t, S);

  // Keep lows dry: the wet voice is high-passed, so the fundamental of a low
  // note never gets detuned. Chorus on the bottom octave is what makes a
  // bass sound seasick and ill-defined; above the shelf it just thickens.
  const lo = num(chorus.lows, 0);
  n.hp.frequency.setTargetAtTime(lo > 20 ? lo : 10, t, S);
}

// ── Persistence ────────────────────────────────────────────
function chorusSave() {
  try { localStorage.setItem(CHORUS_KEY, JSON.stringify(chorus)); } catch (e) {}
}
function chorusLoad() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem(CHORUS_KEY)); } catch (e) {}
  chorusAdopt(o);
}
// One clamp used by storage AND by presets, so a hand-edited file cannot put
// a rate of 9000 into an oscillator.
function chorusAdopt(o) {
  if (!o || typeof o !== 'object') return;
  const cl = (v, d, lo, hi) => {
    const x = parseFloat(v);
    return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d;
  };
  chorus.on    = !!o.on;
  chorus.rate  = cl(o.rate,  CHORUS_DEFAULTS.rate,  0.05, 8);
  chorus.depth = cl(o.depth, CHORUS_DEFAULTS.depth, 0, 100);
  chorus.mix   = cl(o.mix,   CHORUS_DEFAULTS.mix,   0, 100);
  chorus.lows  = cl(o.lows,  CHORUS_DEFAULTS.lows,  0, 300);
}

// ── UI ─────────────────────────────────────────────────────
function chorusToggle() {
  chorus.on = !chorus.on;
  chorusSave(); chorusApply(false); chorusSyncUI();
}

function chorusSet(k, v) {
  chorus[k] = v;
  chorusAdopt(Object.assign({}, chorus));     // same clamps as storage
  chorusSave(); chorusApply(false); chorusSyncUI();
}

function chorusSyncUI() {
  const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
  set('chorusBtn', el => {
    el.textContent = chorus.on ? 'Chorus: ON' : 'Chorus: OFF';
    el.classList.toggle('active', chorus.on);
  });
  set('chorusRateVal',  el => el.textContent = num(chorus.rate, 0.8).toFixed(2) + ' Hz');
  set('chorusDepthVal', el => el.textContent = Math.round(num(chorus.depth, 0)) + '%');
  set('chorusMixVal',   el => el.textContent = Math.round(num(chorus.mix, 50)) + '%');
  set('chorusLowsVal',  el => el.textContent =
    num(chorus.lows, 0) > 20 ? Math.round(chorus.lows) + ' Hz' : 'off — all of it');
  set('chorusInfo', el => el.innerHTML =
    'sweep <em>' + chorusMinMs().toFixed(2) + ' – ' + chorusMaxMs().toFixed(2) +
    ' ms</em> · detune <em>±' + chorusCents().toFixed(0) + ' cents</em>');
  document.querySelectorAll('input[data-chs]').forEach(el => {
    const k = el.dataset.chs;
    if (parseFloat(el.value) !== chorus[k]) el.value = chorus[k];
  });
  drawChorusChart();
}

// ── The sweep, drawn ───────────────────────────────────────
// Two seconds of delay time. The point of the picture is that Rate and Depth
// together decide the slope, and the slope is the pitch swing — a steep line
// is a wide detune however shallow the sweep looks.
function drawChorusChart() {
  const cv = document.getElementById('chorusChart');
  if (!cv || !cv.parentElement) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = cv.parentElement.clientWidth, H = 96;
  if (W < 2) return;
  cv.width = W * dpr; cv.height = H * dpr;
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = TH.chartBg; ctx.fillRect(0, 0, W, H);

  const SECS = 2, MS_MAX = CHORUS_BASE_MS + CHORUS_SWEEP_MS + 1;
  const y = ms => H - 6 - (ms / MS_MAX) * (H - 16);

  ctx.strokeStyle = TH.gridLine; ctx.lineWidth = 1;
  [0, 5, 10].forEach(ms => {
    ctx.beginPath(); ctx.moveTo(0, y(ms)); ctx.lineTo(W, y(ms)); ctx.stroke();
  });
  ctx.fillStyle = TH.axisLabel;
  ctx.font = '9px ui-monospace, monospace';
  ctx.fillText('10 ms', 4, y(10) - 3);
  ctx.fillText('0', 4, y(0) - 3);

  // The centre delay, which is where it sits with the effect off.
  ctx.strokeStyle = TH.bassGhost; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(0, y(CHORUS_BASE_MS)); ctx.lineTo(W, y(CHORUS_BASE_MS)); ctx.stroke();
  ctx.setLineDash([]);

  const A = chorus.on ? chorusSweepMs() : 0;
  const f = Math.max(0.05, num(chorus.rate, 0.8));
  ctx.strokeStyle = TH.bass; ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let x = 0; x <= W; x++) {
    const t = (x / W) * SECS;
    const ms = CHORUS_BASE_MS + A * Math.sin(2 * Math.PI * f * t);
    if (x === 0) ctx.moveTo(x, y(ms)); else ctx.lineTo(x, y(ms));
  }
  ctx.stroke();

  ctx.fillStyle = TH.axisTitle;
  ctx.fillText('2 s', W - 20, H - 4);
}

function wireChorus() {
  document.querySelectorAll('input[data-chs]').forEach(el => {
    const k = el.dataset.chs;
    el.addEventListener('input', () => chorusSet(k, parseFloat(el.value)));
    el.addEventListener('wheel', e => {
      if (document.activeElement !== el) return;   // the wheel belongs to the page
      e.preventDefault();
      const step = parseFloat(el.step) || 1, dir = e.deltaY < 0 ? 1 : -1;
      const v = Math.min(parseFloat(el.max),
                Math.max(parseFloat(el.min), parseFloat(el.value) + dir * step));
      el.value = v; chorusSet(k, v);
    }, { passive: false });
  });
}

function initChorus() { chorusLoad(); wireChorus(); chorusSyncUI(); }
