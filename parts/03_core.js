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
function drawPedal() {
  const svg = document.getElementById('pedalSvg');
  if (!svg) return;
  const rad = d => d * Math.PI / 180;
  const knobAngle = (v, mn, mx) => -135 + ((v - mn) / (mx - mn)) * 270;

  function knobSVG(cx, cy, r, adeg, label, color) {
    const a = rad(adeg - 90);
    const ix = cx + r * 0.60 * Math.cos(a), iy = cy + r * 0.60 * Math.sin(a);
    const ox = cx + r * 0.92 * Math.cos(a), oy = cy + r * 0.92 * Math.sin(a);
    return `
      <circle cx="${cx}" cy="${cy}" r="${r * 1.22}" fill="none" stroke="#1e1e2c" stroke-width="2.5"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="#1a1a22" stroke="#3a3a4e" stroke-width="1.5"/>
      <circle cx="${cx}" cy="${cy}" r="${r * 0.58}" fill="#0f0f14"/>
      <line x1="${ix}" y1="${iy}" x2="${ox}" y2="${oy}" stroke="${color}" stroke-width="2.2" stroke-linecap="round"/>
      <text x="${cx}" y="${cy + r + 16}" text-anchor="middle" fill="#555570" font-family="Share Tech Mono" font-size="8.5" letter-spacing="0.8">${label}</text>`;
  }

  function toggleBtn(x, y, w, h, label, active) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2.5" fill="${active ? '#00c8b4' : '#1e1e2c'}" stroke="${active ? '#00c8b4' : '#2e2e3e'}" stroke-width="1"/>
    <text x="${x + w / 2}" y="${y + h / 2 + 3.5}" text-anchor="middle" fill="${active ? '#000' : '#555570'}" font-family="Share Tech Mono" font-size="8" letter-spacing="0.3">${label}</text>`;
  }

  // 3-position slide switch: pos 0 left, 1 centre, 2 right
  function slideSwitch(x, y, label, pos) {
    const cx = x + 4.5 + pos * 8.5;
    return `<rect x="${x}" y="${y}" width="26" height="9" rx="4" fill="#111118" stroke="#252535" stroke-width="1"/>
    <circle cx="${cx + 4}" cy="${y + 4.5}" r="4.5" fill="#00c8b4"/>
    <text x="${x + 13}" y="${y + 20}" text-anchor="middle" fill="#555570" font-family="Share Tech Mono" font-size="6.5" letter-spacing="1">${label}</text>`;
  }

  const W = 540, H = 300;
  const levelDim = state.blend <= 0;   // Level does nothing with no wet path

  svg.innerHTML = `
  <defs>
    <filter id="glow2"><feGaussianBlur stdDeviation="2.5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="bg2" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#20202e"/><stop offset="100%" stop-color="#13131a"/>
    </linearGradient>
  </defs>

  <rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="10" fill="#2a2a3a"/>
  <rect x="12" y="12" width="${W - 24}" height="${H - 24}" rx="8" fill="url(#bg2)"/>

  <rect x="12" y="12" width="${W - 24}" height="28" rx="8" fill="#0e0e16"/>
  <rect x="12" y="32" width="${W - 24}" height="8" fill="#0e0e16"/>
  <text x="${W / 2}" y="30" text-anchor="middle" fill="#00c8b4" font-family="Bebas Neue,sans-serif" font-size="15" letter-spacing="6">DARKGAS ELECTRONICS</text>
  <text x="${W / 2}" y="56" text-anchor="middle" fill="#8888aa" font-family="Share Tech Mono" font-size="9" letter-spacing="2.5">MICROTUBES B7K v2</text>

  <circle cx="36" cy="56" r="4.5" fill="#00c8b4" filter="url(#glow2)"/>
  <text x="36" y="69" text-anchor="middle" fill="#333348" font-family="Share Tech Mono" font-size="6.5">ON</text>

  <!-- Drive section: live -->
  <g opacity="1">${knobSVG(150, 110, 20, knobAngle(state.blend, 0, 100), 'BLEND', '#00c8b4')}</g>
  <g opacity="${levelDim ? 0.32 : 1}">${knobSVG(270, 110, 20, knobAngle(state.level, 0, 100), 'LEVEL', '#00c8b4')}</g>
  <g opacity="1">${knobSVG(390, 110, 20, knobAngle(state.drive, 0, 100), 'DRIVE', '#00c8b4')}</g>
  ${slideSwitch(70, 95, 'GRUNT', state.grunt)}
  ${slideSwitch(444, 95, 'ATTACK', state.attack)}

  <!-- 4 EQ knobs -->
  ${knobSVG(95,  185, 26, knobAngle(state.low,    -12, 12), 'LOW',    '#00c8b4')}
  ${knobSVG(210, 185, 26, knobAngle(state.loMid,  -12, 12), 'LO MID', '#00c8b4')}
  ${knobSVG(330, 185, 26, knobAngle(state.hiMid,  -12, 12), 'HI MID', '#00c8b4')}
  ${knobSVG(445, 185, 26, knobAngle(state.treble, -12, 12), 'TREBLE', '#00c8b4')}

  ${toggleBtn(174, 207, 36, 14, '500Hz', state.loMidFreq === 500)}
  ${toggleBtn(212, 207, 36, 14, '1kHz',  state.loMidFreq === 1000)}
  ${toggleBtn(294, 207, 36, 14, '1.5k',  state.hiMidFreq === 1500)}
  ${toggleBtn(332, 207, 36, 14, '3kHz',  state.hiMidFreq === 3000)}

  <circle cx="${W / 2}" cy="258" r="24" fill="#0e0e16" stroke="${bypassed ? '#ff4d4d' : '#252535'}" stroke-width="3"/>
  <circle cx="${W / 2}" cy="258" r="16" fill="#0a0a12" stroke="#1c1c2a" stroke-width="1"/>
  <text x="${W / 2}" y="290" text-anchor="middle" fill="${bypassed ? '#ff4d4d' : '#2a2a38'}" font-family="Share Tech Mono" font-size="7" letter-spacing="2">BYPASS</text>

  <text x="28" y="${H - 8}" fill="#2a2a38" font-family="Share Tech Mono" font-size="7" letter-spacing="1.5">IN</text>
  <text x="${W - 44}" y="${H - 8}" fill="#2a2a38" font-family="Share Tech Mono" font-size="7" letter-spacing="1.5">OUT</text>
  <text x="${W - 60}" y="${H - 8}" fill="#2a2a38" font-family="Share Tech Mono" font-size="7" letter-spacing="1">XLR</text>
  `;
}

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
  const dim = state.blend <= 0;
  const card = document.getElementById('cardLevel');
  if (card) card.classList.toggle('dimmed', dim);
  document.querySelectorAll('input[data-bind="level"]').forEach(el => { el.disabled = dim; });
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
  drawPedal();
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
