// ═══════════════════════════════════════════════════════════
// BASS ANALYZER v3
// Single-file PWA. Four tabs over one shared state object.
// ═══════════════════════════════════════════════════════════

// ─────────────────────────────────────────────
// CONFIG GATES
// Heavy features are behind LITE so the Pi Zero 2W build is a
// flag flip, not a fork. Set LITE_DEFAULT = true, or load with ?lite=1
// ─────────────────────────────────────────────
const LITE_DEFAULT = false;
const LITE = LITE_DEFAULT ||
  new URLSearchParams(location.search).get('lite') === '1';

const CFG = {
  fftSize:        LITE ? 4096 : 16384,  // main analyser resolution
  scopeFftSize:   LITE ? 1024 : 2048,
  tunerFftSize:   8192,                 // never reduced — pitch accuracy at 31 Hz
  sgColumns:      LITE ? 3 : 2,         // px advanced per spectrogram frame
  sgSmoothing:    LITE ? 0.3 : 0.5,
  glow:           !LITE,                // canvas shadowBlur (expensive on Pi)
  spectrumFilters: true                 // the 14-biquad overtone chain
};

// ─────────────────────────────────────────────
// STATE — one object, shared by every tab.
// A control on one tab moves its twin on another because both
// carry the same data-bind key and syncUI() writes to all of them.
// ─────────────────────────────────────────────
const state = {
  low: 0, loMid: 0, loMidFreq: 1000,
  hiMid: 0, hiMidFreq: 3000, treble: 0,
  blend: 0,    // 0..100  clean → distorted (equal-power)
  level: 100,  // 0..100  wet path volume, 100 = unity
  drive: 0,    // 0..100  pre-clipper gain, 0..+32 dB
  grunt: 1,    // 0 Thin · 1 Raw · 2 Fat
  attack: 1    // 0 Cut · 1 Flat · 2 Boost
};

const GRUNT_DB  = [0, 4.5, 9];    // lowshelf @ 120 Hz, pre-clipper
const ATTACK_DB = [-6, 0, 6];     // highshelf @ 3 kHz, pre-clipper
const GRUNT_NAME  = ['Thin', 'Raw', 'Fat'];
const ATTACK_NAME = ['Cut', 'Flat', 'Boost'];

// Level: linear in dB across the slider, −40 dB … 0 dB, hard zero at the bottom.
function levelGain(l) { return l <= 0 ? 0 : Math.pow(10, ((l - 100) * 0.4) / 20); }
function levelDb(l)   { return (l - 100) * 0.4; }
// Drive: 0 … +32 dB into the clipper.
function driveGainOf(d) { return Math.pow(10, (d / 100 * 32) / 20); }
// Equal-power crossfade: dry = cos, wet = sin.
function blendGains(b) {
  const th = (b / 100) * (Math.PI / 2);
  return { dry: Math.cos(th), wet: Math.sin(th) };
}

// ─────────────────────────────────────────────
// THEME (canvas colours — CSS handles the DOM)
// ─────────────────────────────────────────────
const THEMES = {
  dark: {
    chartBg:'#141418', gridLine:'#1c1c26', axisLabel:'#44445a', axisTitle:'#33334a',
    refLine:'rgba(255,255,255,0.10)', refText:'rgba(255,255,255,0.20)',
    unityLine:'rgba(255,255,255,0.08)', unityText:'rgba(255,255,255,0.18)',
    bandMarker:'rgba(0,229,255,0.18)',
    scopeBg:'#0a0a0e', scopeGrid:'#1a1a26', scopeZero:'#252535', scopeText:'#333348',
    bass:'#00e5ff', bassGhost:'rgba(0,229,255,0.28)',
    guitar:'#ff4d4d', kick:'#ffaa00', snare:'#c084fc', hh:'#86efac',
    fftFill0:'rgba(0,229,255,0.28)', fftFill1:'rgba(0,200,180,0.10)', fftLine:'rgba(0,229,255,0.85)',
    fftGlow:'#00e5ff', crosshair:'rgba(0,200,180,0.45)'
  },
  light: {
    chartBg:'#f7f8fb', gridLine:'#dde0ea', axisLabel:'#9498ad', axisTitle:'#aab0c2',
    refLine:'rgba(20,24,40,0.14)', refText:'rgba(20,24,40,0.40)',
    unityLine:'rgba(20,24,40,0.10)', unityText:'rgba(20,24,40,0.32)',
    bandMarker:'rgba(0,140,160,0.30)',
    scopeBg:'#eef0f6', scopeGrid:'#dde0ea', scopeZero:'#c2c6d4', scopeText:'#9498ad',
    bass:'#0096c8', bassGhost:'rgba(0,120,170,0.35)',
    guitar:'#d62b2b', kick:'#c97a00', snare:'#8a3fce', hh:'#2f9e57',
    fftFill0:'rgba(0,150,200,0.26)', fftFill1:'rgba(0,154,138,0.10)', fftLine:'rgba(0,120,170,0.85)',
    fftGlow:'#0096c8', crosshair:'rgba(0,154,138,0.55)'
  }
};
let TH = THEMES.dark;
const THEME_KEY = 'b7k_theme';
let bootDone = false;

function applyTheme(mode, persist) {
  TH = THEMES[mode] || THEMES.dark;
  document.documentElement.setAttribute('data-theme', mode);
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = mode === 'light' ? '☀️' : '🌙';
  if (persist) { try { localStorage.setItem(THEME_KEY, mode); } catch (e) {} }
  if (bootDone) {
    redrawStatic();
    if (document.getElementById('refModal').classList.contains('open')) drawRefChart();
    if (!audioRunning) stopScope();
  }
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(cur === 'light' ? 'dark' : 'light', true);
}
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
  if (saved === 'light' || saved === 'dark') { applyTheme(saved, false); return; }
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(prefersLight ? 'light' : 'dark', false);
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', e => {
      let override = null;
      try { override = localStorage.getItem(THEME_KEY); } catch (err) {}
      if (!override) applyTheme(e.matches ? 'light' : 'dark', false);
    });
  }
}

// ═══════════════════════════════════════════════════════════
// TABS
// Only one panel's DOM is displayed at a time. Entering or leaving
// the Spectrum tab connects / disconnects its filter chain.
// ═══════════════════════════════════════════════════════════
const TABS = ['preamp', 'tuner', 'spectrum', 'detune', 'mix'];
let activeTab = 'preamp';

function setTab(name) {
  if (!TABS.includes(name) || name === activeTab) return;
  const prev = activeTab;
  activeTab = name;

  TABS.forEach(t => {
    document.getElementById('panel-' + t).classList.toggle('active', t === name);
    document.getElementById('tab-' + t).setAttribute('aria-selected', String(t === name));
  });

  if (prev === 'spectrum') spectrumExit();
  if (name === 'spectrum') spectrumEnter();

  window.scrollTo(0, 0);
  requestAnimationFrame(() => { sizeIsland(); redrawStatic(); });
}

// ── Sticky analyzer ────────────────────────────────────────
// Full height in flow, shrunk when pinned: enough to read spectrum shape
// with a thumb on a knob, without eating a portrait viewport that is
// already giving space to the island.
//
// Height is a function, not a constant, because the canvases are sized in
// device pixels from JS -- a CSS-only shrink would just crop them.
const ANALYZER_H_FULL  = 220;
const ANALYZER_H_STUCK = 120;
let analyzerStuck = false;
function analyzerH() { return analyzerStuck ? ANALYZER_H_STUCK : ANALYZER_H_FULL; }

function resizeAnalyzer() {
  const slot = document.getElementById('analyzerSlot');
  if (slot) slot.style.height = analyzerH() + 'px';
  if (analyzerMode === 'sg') sizeSpectrogram();
  redrawStatic();
}

// A zero-height sentinel just above the sticky wrapper: when it scrolls out
// of view the wrapper is pinned. There is no CSS :stuck selector.
function initStickyAnalyzer() {
  const sentinel = document.getElementById('analyzerSentinel');
  const wrap = document.getElementById('analyzerSticky');
  if (!sentinel || !wrap) return;
  if (!('IntersectionObserver' in window)) return;   // stays 220 px, still usable
  new IntersectionObserver(entries => {
    const stuck = !entries[0].isIntersecting;
    if (stuck === analyzerStuck) return;
    analyzerStuck = stuck;
    wrap.classList.toggle('stuck', stuck);
    resizeAnalyzer();
  }, { threshold: 0 }).observe(sentinel);
}

// Island must never overlap content: measure it and pad the body to match.
function sizeIsland() {
  const island = document.getElementById('tabIsland');
  if (!island) return;
  const h = island.getBoundingClientRect().height;
  document.body.style.paddingBottom = (h + 26) + 'px';
}

// ═══════════════════════════════════════════════════════════
// FREQUENCY AXIS + SCHEMATIC CURVES  (Mix tab only)
// ═══════════════════════════════════════════════════════════
// ── Axis range ─────────────────────────────────────────────
// Ceiling is 10 kHz, not 20 kHz. On a log axis 10 kHz buys ~11% more
// pixels per decade; what it costs is the 10-20 kHz band, which carries
// nothing a bass player works against. Hiss lives 5-15 kHz and stays
// visible, and there is a full octave above the 5 kHz treble shelf to
// see its upper skirt.
//
// EVERY frequency display derives from these three. Do not reintroduce a
// bare 20000 or a bare Math.log10(1000): the span used to be written as
// "three decades from 20 Hz" with no ceiling literal in the mapping at
// all, so a literal-only edit passed review while the axis stayed wrong.
// verify.js now fails the build on both patterns.
const AX_FMIN = 20;
const AX_FMAX = 10000;
const AX_DECADES = Math.log10(AX_FMAX / AX_FMIN);

const STEPS = 500;
const freqs = Array.from({ length: STEPS + 1 },
  (_, i) => AX_FMIN * Math.pow(AX_FMAX / AX_FMIN, i / STEPS));
const LABEL_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
function fLabel(f) { return f >= 1000 ? f / 1000 + 'k' : '' + f; }

function gauss(f, fc, bw, a) { return a * Math.exp(-Math.pow(Math.log(f / fc) / bw, 2)); }

// The curve is normalised so its peak sits at DISPLAY_FLAT (0.50): all knobs
// at zero draws at exactly half chart height, equal room to boost or cut.
const DISPLAY_FLAT = 0.50;

// Pickup character is fixed at the old 0.5 midpoint — the Pickup control is gone.
const PICKUP_FIXED = 0.5;

function buildBassCurve() {
  const p = PICKUP_FIXED;
  const raw = freqs.map(f => {
    const sub   = gauss(f,   70, 0.55, 0.55 - 0.10 * p);
    const body  = gauss(f,  180, 0.55, 0.52 - 0.07 * p);
    const umid  = gauss(f,  450, 0.50, 0.38 - 0.04 * p);
    const click = gauss(f,  950, 0.42, 0.18 + 0.18 * p);
    const growl = gauss(f, 2800, 0.48, 0.08 + 0.18 * p);
    const air   = gauss(f, 6000, 0.40, 0.03 + 0.05 * p);
    let v = sub + body + umid + click + growl + air;
    if (f > 3000) v *= Math.pow(3000 / f, 0.60);   // pickup inductance rolloff
    return Math.max(0, v);
  });
  const peak = Math.max.apply(null, raw);
  return raw.map(v => (v / peak) * DISPLAY_FLAT);
}

const guitarCurve = freqs.map(f => Math.min(
  gauss(f,100,0.45,0.28) + gauss(f,300,0.70,0.82) + gauss(f,750,0.65,0.96) +
  gauss(f,1900,0.65,0.88) + gauss(f,4500,0.60,0.68) + gauss(f,9000,0.65,0.30), 1));

const kickCurve = freqs.map(f => Math.min(
  gauss(f,60,0.42,0.96) + gauss(f,105,0.38,0.62) +
  gauss(f,3500,0.65,0.52) + gauss(f,7000,0.55,0.20), 1));

const snareCurve = freqs.map(f => Math.min(
  gauss(f,185,0.48,0.70) + gauss(f,950,0.55,0.52) +
  gauss(f,6000,0.70,0.80) + gauss(f,11000,0.55,0.42), 1));

const hhCurve = freqs.map(f => Math.min(
  gauss(f,8000,0.55,0.70) + gauss(f,12000,0.52,0.85) + gauss(f,16000,0.55,0.55), 1));

const refBassCurve = freqs.map(f => {
  let v = gauss(f,70,0.80,0.85) + gauss(f,200,0.85,0.88) + gauss(f,350,0.55,0.18) +
          gauss(f,950,0.60,0.65) + gauss(f,2800,0.70,0.42);
  if (f > 3000) v *= Math.pow(3000 / f, 0.5);
  return Math.max(0, Math.min(v, 1));
});

const flatBassCurve = buildBassCurve();   // pickup fixed, so compute once

// ── EQ, in the dB domain relative to DISPLAY_FLAT ──
function shelfdB(f, gain, fc, isLow) {
  const t = Math.log10(isLow ? fc / f : f / fc);
  return gain * (0.5 * (1 + Math.tanh(3.5 * t)));
}
function peakdB(f, gain, fc, Q) {
  const bw = 1 / Q;
  return gain * Math.exp(-Math.pow(Math.log(f / fc) / bw, 2));
}
const EQ_DISPLAY_PEAK = DISPLAY_FLAT;

function applyEQ(baseCurve) {
  return baseCurve.map((v, i) => {
    const f = freqs[i];
    let dB = 20 * Math.log10(Math.max(v / EQ_DISPLAY_PEAK, 0.0001));
    dB += shelfdB(f, state.low,    100,  true);
    dB += shelfdB(f, state.treble, 5000, false);
    dB += peakdB(f, state.loMid, state.loMidFreq, 2.2);
    dB += peakdB(f, state.hiMid, state.hiMidFreq, 2.2);
    return Math.max(0, Math.min(EQ_DISPLAY_PEAK * Math.pow(10, dB / 20), 1.0));
  });
}

// ═══════════════════════════════════════════════════════════
// CHART DRAWING UTILITIES
// ═══════════════════════════════════════════════════════════
// Returns null when the canvas' parent is hidden (width 0). Every caller
// bails on null — drawing into a 0-width canvas leaves it stuck at 0 until
// something else forces a resize, which is how "blank chart after tab
// switch" bugs happen.
function setupCanvas(id, h) {
  const canvas = document.getElementById(id);
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.parentElement.clientWidth;
  if (W < 2) return null;
  canvas.width = W * dpr; canvas.height = h * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W, H: h };
}

const PAD = { t: 14, r: 18, b: 33, l: 38 };

function drawAxes(ctx, W, H) {
  const cw = W - PAD.l - PAD.r, ch = H - PAD.t - PAD.b;
  const xp = f => PAD.l + Math.log10(f / AX_FMIN) / AX_DECADES * cw;

  ctx.fillStyle = TH.chartBg; ctx.fillRect(0, 0, W, H);

  LABEL_FREQS.forEach(f => {
    const x = xp(f);
    ctx.strokeStyle = TH.gridLine; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + ch); ctx.stroke();
    ctx.fillStyle = TH.axisLabel; ctx.font = '10px Share Tech Mono,monospace'; ctx.textAlign = 'center';
    ctx.fillText(fLabel(f), x, PAD.t + ch + 18);
  });

  [0.25, 0.5, 0.75, 1].forEach(fr => {
    const y = PAD.t + ch - fr * ch;
    ctx.strokeStyle = TH.gridLine; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + cw, y); ctx.stroke();
  });

  ctx.fillStyle = TH.axisTitle; ctx.font = '9px Share Tech Mono,monospace'; ctx.textAlign = 'center';
  ctx.fillText('FREQUENCY (Hz)', PAD.l + cw / 2, H - 3);
  ctx.save(); ctx.translate(11, PAD.t + ch / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText('LEVEL', 0, 0); ctx.restore();

  return { cw, ch, xp, yp: v => PAD.t + ch - Math.min(v, 1) * ch };
}

function drawCurve(ctx, data, xp, yp, color, lw, glow, dash) {
  if (glow && CFG.glow) { ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 10; }
  ctx.strokeStyle = color; ctx.lineWidth = lw;
  ctx.setLineDash(dash || []);
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = xp(freqs[i]), y = yp(v);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke(); ctx.setLineDash([]);
  if (glow && CFG.glow) ctx.restore();
}

function zoneRect(ctx, x1, x2, yTop, height, color) {
  const g = ctx.createLinearGradient(x1, 0, x2, 0);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.2, color); g.addColorStop(0.8, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(x1, yTop, x2 - x1, height);
}

function drawBandMarkers(ctx, ch, xp) {
  [100, state.loMidFreq, state.hiMidFreq, 5000].forEach(f => {
    ctx.strokeStyle = TH.bandMarker; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
    ctx.beginPath(); ctx.moveTo(xp(f), PAD.t); ctx.lineTo(xp(f), PAD.t + ch); ctx.stroke();
    ctx.setLineDash([]);
  });
}

// ── Reference chart (modal) ──
function drawRefChart() {
  const s = setupCanvas('refChart', 200);
  if (!s) return;
  const { ctx, W, H } = s;
  const { cw, ch, xp, yp } = drawAxes(ctx, W, H);

  zoneRect(ctx, xp(40),  xp(80),   PAD.t, ch, 'rgba(255,170,0,0.10)');
  zoneRect(ctx, xp(200), xp(500),  PAD.t, ch, 'rgba(255,120,40,0.11)');
  zoneRect(ctx, xp(700), xp(1200), PAD.t, ch, 'rgba(0,229,255,0.08)');

  ctx.font = '8px Share Tech Mono,monospace'; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,170,0,0.7)';  ctx.fillText('SUB CLASH', (xp(40) + xp(80)) / 2, PAD.t + 10);
  ctx.fillStyle = 'rgba(255,120,40,0.7)'; ctx.fillText('MUD ZONE', (xp(200) + xp(500)) / 2, PAD.t + 10);
  ctx.fillStyle = 'rgba(0,229,255,0.6)';  ctx.fillText('CLICK', (xp(700) + xp(1200)) / 2, PAD.t + 10);

  drawCurve(ctx, flatBassCurve, xp, yp, TH.bassGhost, 1.5, false, [4, 4]);
  drawCurve(ctx, hhCurve,     xp, yp, TH.hh,     1.3, false);
  drawCurve(ctx, snareCurve,  xp, yp, TH.snare,  1.3, false);
  drawCurve(ctx, kickCurve,   xp, yp, TH.kick,   1.8, false);
  drawCurve(ctx, guitarCurve, xp, yp, TH.guitar, 2.0, true);
  drawCurve(ctx, refBassCurve,xp, yp, TH.bass,   2.8, true);
}

// ═══════════════════════════════════════════════════════════
// PEDAL SVG
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// CONTROL BINDING — generic, so twins on other tabs stay in sync
// ═══════════════════════════════════════════════════════════
function dbFmt(v) { return (v >= 0 ? '+' : '') + parseFloat(v).toFixed(1) + ' dB'; }

const VAL_FMT = {
  low: dbFmt, loMid: dbFmt, hiMid: dbFmt, treble: dbFmt,
  blend:  v => Math.round(v) + '%',
  level:  v => v <= 0 ? '−∞ dB' : (levelDb(v) >= 0 ? '' : '') + levelDb(v).toFixed(1) + ' dB',
  drive:  v => Math.round(v) + '%',
  grunt:  v => GRUNT_NAME[v] || 'Raw',
  attack: v => ATTACK_NAME[v] || 'Flat'
};

// ═══════════════════════════════════════════════════════════
// PEDAL PANEL — knobs and switches
//
// 21 detents from 7 to 5 o'clock, the positions printed on the real pedal,
// so a setting here can be copied straight onto it. The detent is a UI
// affordance ONLY: state stays in real units (dB and %), which is why the
// Mix tab twins, the preset schema and the DSP all needed no changes.
// ═══════════════════════════════════════════════════════════
const KNOB_STEPS = 20;    // 21 positions, 0..20
const KNOB_SWEEP = 300;   // degrees swept, 7 o'clock → 5 o'clock
const KNOB_RANGE = {
  blend: [0, 100], level: [0, 100], drive: [0, 100],
  low: [-12, 12], loMid: [-12, 12], hiMid: [-12, 12], treble: [-12, 12]
};

function knobToValue(key, step) {
  const r = KNOB_RANGE[key]; if (!r) return 0;
  return r[0] + (step / KNOB_STEPS) * (r[1] - r[0]);
}
function knobToStep(key, v) {
  const r = KNOB_RANGE[key]; if (!r) return 0;
  const val = Number.isFinite(v) ? v : r[0];
  const t = (val - r[0]) / (r[1] - r[0]);
  return Math.max(0, Math.min(KNOB_STEPS, Math.round(t * KNOB_STEPS)));
}
function knobDeg(step) { return -KNOB_SWEEP / 2 + (step / KNOB_STEPS) * KNOB_SWEEP; }
function knobClock(step) {
  const total = 420 + step * 30;              // minutes from midnight, 7:00 base
  const h = Math.floor(total / 60) % 12 || 12;
  return h + ':' + (total % 60 ? '30' : '00');
}

// Switch positions live in the markup, listed top to bottom, so the physical
// order on screen and the state value can never drift apart in code.
function swSpec(id) {
  const wrap = document.querySelector('[data-swlabels="' + id + '"]');
  if (!wrap) return null;
  const spans = Array.from(wrap.querySelectorAll('span'));
  return { spans, values: spans.map(sp => parseFloat(sp.dataset.v)) };
}
function syncSwitch(id) {
  const sp = swSpec(id); if (!sp) return;
  const n = sp.values.length;
  let i = sp.values.indexOf(state[id]);
  if (i < 0) i = n >> 1;
  const dot = document.querySelector('[data-sw="' + id + '"] .sw-dot');
  if (dot) dot.style.top = (n === 3 ? [15, 50, 85][i] : [25, 75][i]) + '%';
  sp.spans.forEach((el, k) => el.classList.toggle('on', k === i));
}
function advanceSwitch(id) {
  const sp = swSpec(id); if (!sp) return;
  const i = sp.values.indexOf(state[id]);
  setParam(id, sp.values[i < 0 ? 0 : (i + 1) % sp.values.length]);
}

function syncPedalPanel() {
  document.querySelectorAll('[data-knob]').forEach(k => {
    const key = k.dataset.knob;
    const step = knobToStep(key, state[key]);
    k.style.setProperty('--deg', knobDeg(step) + 'deg');
    k.setAttribute('aria-valuenow', String(step));
    const f = VAL_FMT[key];
    k.setAttribute('aria-valuetext', (f ? f(state[key]) : String(state[key])) +
                   ', ' + knobClock(step) + " o'clock");
    const c = document.querySelector('[data-clock="' + key + '"]');
    if (c) c.textContent = knobClock(step);
  });
  ['grunt', 'attack', 'loMidFreq', 'hiMidFreq'].forEach(syncSwitch);
}

function wirePedalPanel() {
  document.querySelectorAll('[data-knob]').forEach(k => {
    const key = k.dataset.knob;
    const off = () => k.getAttribute('aria-disabled') === 'true';
    const setStep = st => setParam(key, knobToValue(key, Math.max(0, Math.min(KNOB_STEPS, st))));
    let dragging = false;

    // Angle from the knob centre; straight up is 0, clockwise positive.
    const fromPointer = e => {
      const r = k.getBoundingClientRect();
      const deg = Math.atan2(e.clientX - (r.left + r.width / 2),
                             -(e.clientY - (r.top + r.height / 2))) * 180 / Math.PI;
      const cl = Math.max(-KNOB_SWEEP / 2, Math.min(KNOB_SWEEP / 2, deg));
      setStep(Math.round(((cl + KNOB_SWEEP / 2) / KNOB_SWEEP) * KNOB_STEPS));
    };

    // Touch must never steal a vertical scroll. The panel sits mid-page and a
    // thumb crossing a knob would otherwise freeze the page — the same bug the
    // probe canvases had. touch-action: pan-y in the CSS hands vertical
    // gestures to the browser; we claim only clearly horizontal ones, and then
    // track RELATIVE movement so the value does not jump to the finger.
    const TOUCH_SLOP = 8;         // px before deciding scroll vs turn
    const TOUCH_PX_PER_STEP = 5;  // ~100 px of drag covers the full sweep
    let tPid = null, tX = 0, tY = 0, tStep = 0, tClaimed = false;
    const dropTouch = () => { tPid = null; tClaimed = false; };

    k.addEventListener('pointerdown', e => {
      if (off()) return;
      if (e.pointerType === 'mouse') {
        dragging = true;
        try { k.setPointerCapture(e.pointerId); } catch (err) {}
        fromPointer(e); e.preventDefault();
        return;
      }
      tPid = e.pointerId; tX = e.clientX; tY = e.clientY;
      tStep = knobToStep(key, state[key]); tClaimed = false;
    });

    k.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse') { if (dragging) fromPointer(e); return; }
      if (e.pointerId !== tPid || off()) return;
      if (!tClaimed) {
        const dx = Math.abs(e.clientX - tX), dy = Math.abs(e.clientY - tY);
        if (dx < TOUCH_SLOP && dy < TOUCH_SLOP) return;
        if (dy >= dx) { dropTouch(); return; }     // vertical: let the page scroll
        tClaimed = true;
        try { k.setPointerCapture(e.pointerId); } catch (err) {}
      }
      setStep(tStep + Math.round((e.clientX - tX) / TOUCH_PX_PER_STEP));
      e.preventDefault();
    });

    k.addEventListener('pointerup', e => {
      dragging = false; dropTouch();
      try { k.releasePointerCapture(e.pointerId); } catch (err) {}
    });
    k.addEventListener('pointercancel', () => { dragging = false; dropTouch(); });
    k.addEventListener('wheel', e => {
      if (off()) return;
      e.preventDefault();
      setStep(knobToStep(key, state[key]) + (e.deltaY < 0 ? 1 : -1));
    }, { passive: false });
    k.addEventListener('keydown', e => {
      if (off()) return;
      const cur = knobToStep(key, state[key]);
      let d = 0;
      switch (e.key) {
        case 'ArrowUp': case 'ArrowRight': d = 1; break;
        case 'ArrowDown': case 'ArrowLeft': d = -1; break;
        case 'PageUp': d = 2; break;
        case 'PageDown': d = -2; break;
        case 'Home': setStep(0); e.preventDefault(); return;
        case 'End': setStep(KNOB_STEPS); e.preventDefault(); return;
        default: return;
      }
      setStep(cur + d); e.preventDefault();
    });
  });

  document.querySelectorAll('[data-sw]').forEach(p => {
    const id = p.dataset.sw;
    p.addEventListener('click', () => advanceSwitch(id));
    p.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { advanceSwitch(id); e.preventDefault(); }
    });
  });
}

// Writes state → every bound input, every value label, every switch button.
function syncUI() {
  document.querySelectorAll('input[data-bind]').forEach(el => {
    const k = el.dataset.bind;
    if (parseFloat(el.value) !== state[k]) el.value = state[k];
  });
  document.querySelectorAll('[data-val]').forEach(el => {
    const k = el.dataset.val;
    const f = VAL_FMT[k];
    if (f) el.textContent = f(state[k]);
  });
  document.querySelectorAll('button[data-set]').forEach(btn => {
    const k = btn.dataset.set;
    const on = String(state[k]) === btn.dataset.v;
    btn.classList.toggle('active', on);
  });
  // Level does nothing when Blend is fully clean — say so in the UI.
  syncPedalPanel();
  const dim = state.blend <= 0;
  const card = document.getElementById('cardLevel');
  if (card) card.classList.toggle('dimmed', dim);
  document.querySelectorAll('input[data-bind="level"]').forEach(el => { el.disabled = dim; });
  const lvlKnob = document.querySelector('[data-knob="level"]');
  if (lvlKnob) {
    lvlKnob.setAttribute('aria-disabled', String(dim));
    lvlKnob.tabIndex = dim ? -1 : 0;
  }
}

function setParam(key, value) {
  state[key] = value;
  syncUI();
  render();
}

// Called from onclick on freq buttons and 3-position switches
function setSwitch(btn) {
  setParam(btn.dataset.set, parseFloat(btn.dataset.v));
}

function wireControls() {
  document.querySelectorAll('input[data-bind]').forEach(el => {
    const key = el.dataset.bind;
    el.addEventListener('input', () => setParam(key, parseFloat(el.value)));
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const step = parseFloat(el.step) || 1;
      const dir = e.deltaY < 0 ? 1 : -1;
      const next = Math.min(parseFloat(el.max),
                   Math.max(parseFloat(el.min), parseFloat(el.value) + dir * step));
      el.value = next; setParam(key, next);
    }, { passive: false });
  });
}

// Tooltips: hover on pointer devices (CSS), tap-to-toggle on touch (this).
function toggleTip(ev, btn) {
  ev.preventDefault(); ev.stopPropagation();
  const wasOpen = btn.classList.contains('open');
  document.querySelectorAll('.tip-btn.open').forEach(b => b.classList.remove('open'));
  if (!wasOpen) btn.classList.add('open');
}
document.addEventListener('click', () => {
  document.querySelectorAll('.tip-btn.open').forEach(b => b.classList.remove('open'));
});

// ═══════════════════════════════════════════════════════════
// RENDER — push state to the pedal graphic, the charts and the audio graph
// ═══════════════════════════════════════════════════════════
function render() {
  redrawStatic();
  if (audioRunning && audioCtx) applyAudioParams();
}

// Redraw whatever the visible tab shows when nothing is animating.
function redrawStatic() {
  if (activeTab === 'preamp') {
    if (analyzerMode === 'fft') drawFftChart();
    else { sizeSpectrogram(); drawSgOverlay(); }
    if (!audioRunning) stopScope();
  } else if (activeTab === 'mix') {
    drawMixChart();
  } else if (activeTab === 'spectrum') {
    sxLayout();
  } else if (activeTab === 'detune') {
    renderDetune();
  }
}
