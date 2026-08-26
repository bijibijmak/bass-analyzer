// ═══════════════════════════════════════════════════════════
// GRAPHIC EQ PREAMP — 11 band, after the MXR M108S
//
// The M108S is a TEN band: 31.25 · 62.5 · 125 · 250 · 500 · 1k · 2k · 4k ·
// 8k Hz peaking, plus a ±12 dB shelf at 16k, with Volume and Gain sliders
// alongside. The eleventh band here is ours: a peaking filter whose centre
// frequency you type in.
//
// It is a second PREAMP, not a second tab. The Preamp tab carries a selector
// and swaps this panel in for the B7K's knob panel; the drive section is
// literally the same controls, bound to the same `state` keys, so the knobs
// on one panel and the faders on the other are twins of each other and the
// preset schema does not change at all.
//
// PHONE GESTURE — the point Bijan spotted before it shipped. Eleven vertical
// faders is the worst case for the scroll bug this app hit three times, so
// the faders never take a vertical touch gesture. touch-action: pan-y hands
// vertical drags to the browser, and a fader is set by dragging SIDEWAYS.
// A mouse keeps direct vertical positioning, where there is no conflict.
// It is structurally impossible for this panel to block scrolling.
// ═══════════════════════════════════════════════════════════

const GEQ_FIXED = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const GEQ_N = GEQ_FIXED.length + 1;          // 11: ten fixed plus the user band
const GEQ_MAX_DB = 12;
const GEQ_Q = 1.4;                            // ~1 octave, matching octave spacing
const GEQ_KEY = 'b7k_geq';
const PREAMP_KEY = 'b7k_preamp';

const geq = {
  gains: new Array(GEQ_N).fill(0),            // dB, −12..+12
  userFreq: 700,                              // the 11th band's centre
  gain: 0,                                    // M108S "Gain", pre-EQ
  volume: 0                                   // M108S "Volume", post-EQ
};
let preampKind = 'b7k';                       // 'b7k' | 'geq'
let geqNodes = null, geqSpliced = false;

const geqFreqAt = i => (i < GEQ_FIXED.length ? GEQ_FIXED[i]
                                             : Math.max(20, Math.min(16000, num(geq.userFreq, 700))));
const geqIsShelf = i => i === GEQ_FIXED.length - 1;    // 16k is a shelf on the real pedal
const geqDbGain = db => Math.pow(10, num(db, 0) / 20);

// ── Response, computed from the same filter maths that runs the audio ──
// getFrequencyResponse on a throwaway OfflineAudioContext, so the drawn curve
// is the filters' real response rather than a second implementation that can
// drift from it. The context is never started; it exists only to own biquads.
let geqCalcCtx = null, geqCalcBq = null;
function geqCalcInit() {
  if (geqCalcBq) return true;
  try {
    const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OC) return false;
    geqCalcCtx = new OC(1, 1, 44100);
    geqCalcBq = [];
    for (let i = 0; i < GEQ_N; i++) geqCalcBq.push(geqCalcCtx.createBiquadFilter());
  } catch (e) { geqCalcBq = null; return false; }
  return true;
}

// Summed dB response across an array of frequencies.
function geqResponseDb(freqs) {
  const out = new Float32Array(freqs.length);
  if (!geqCalcInit()) return out;
  const f32 = freqs instanceof Float32Array ? freqs : Float32Array.from(freqs);
  const mag = new Float32Array(freqs.length), phase = new Float32Array(freqs.length);
  for (let i = 0; i < GEQ_N; i++) {
    const b = geqCalcBq[i];
    b.type = geqIsShelf(i) ? 'highshelf' : 'peaking';
    b.frequency.value = geqFreqAt(i);
    b.Q.value = GEQ_Q;
    b.gain.value = num(geq.gains[i], 0);
    b.getFrequencyResponse(f32, mag, phase);
    for (let k = 0; k < out.length; k++) out[k] += 20 * Math.log10(Math.max(mag[k], 1e-7));
  }
  const trim = num(geq.gain, 0) + num(geq.volume, 0);
  for (let k = 0; k < out.length; k++) out[k] += trim;
  return out;
}

// ── Graph ──────────────────────────────────────────────────
function geqBuild() {
  if (!audioCtx || geqNodes) return;
  const ac = audioCtx;
  const n = { in: ac.createGain(), out: ac.createGain(), bands: [] };
  let prev = n.in;
  for (let i = 0; i < GEQ_N; i++) {
    const b = ac.createBiquadFilter();
    b.type = geqIsShelf(i) ? 'highshelf' : 'peaking';
    b.frequency.value = geqFreqAt(i);
    b.Q.value = GEQ_Q;
    b.gain.value = num(geq.gains[i], 0);
    prev.connect(b); prev = b; n.bands.push(b);
  }
  prev.connect(n.out);
  geqNodes = n;
  geqApply(true);
}
function geqDestroy() {
  if (!geqNodes) return;
  try { geqNodes.in.disconnect(); } catch (e) {}
  geqNodes.bands.forEach(b => { try { b.disconnect(); } catch (e) {} });
  try { geqNodes.out.disconnect(); } catch (e) {}
  geqNodes = null;
}

// The B7K tone stack and this one are alternatives, so exactly one of them is
// wired between sumBus and the cleanup section at any time.
function geqSplice() {
  if (geqSpliced || !audioCtx || !audioRunning) return;
  geqBuild();
  if (!geqNodes) return;
  try {
    sumBus.disconnect(filterLow);
    filterTreble.disconnect(filterHiss);
    sumBus.connect(geqNodes.in);
    geqNodes.out.connect(filterHiss);
    geqSpliced = true;
  } catch (e) { console.warn('[GEQ] splice', e); }
}
function geqUnsplice() {
  if (!geqSpliced) return;
  try {
    sumBus.disconnect(geqNodes.in);
    geqNodes.out.disconnect(filterHiss);
    sumBus.connect(filterLow);
    filterTreble.connect(filterHiss);
  } catch (e) { console.warn('[GEQ] unsplice', e); }
  geqSpliced = false;
  geqDestroy();
}

function geqApply(immediate) {
  if (!geqNodes || !audioCtx) return;
  const t = audioCtx.currentTime, S = immediate ? 0.001 : 0.02;
  for (let i = 0; i < GEQ_N; i++) {
    const b = geqNodes.bands[i];
    b.frequency.setTargetAtTime(geqFreqAt(i), t, S);
    b.gain.setTargetAtTime(num(geq.gains[i], 0), t, S);
  }
  geqNodes.in.gain.setTargetAtTime(geqDbGain(geq.gain), t, S);
  geqNodes.out.gain.setTargetAtTime(geqDbGain(geq.volume), t, S);
}

// ── Preamp selection ───────────────────────────────────────
function setPreamp(kind) {
  preampKind = (kind === 'geq') ? 'geq' : 'b7k';
  try { localStorage.setItem(PREAMP_KEY, preampKind); } catch (e) {}
  const b7k = document.getElementById('preampB7k');
  const g = document.getElementById('preampGeq');
  if (b7k) b7k.style.display = preampKind === 'b7k' ? '' : 'none';
  if (g) g.style.display = preampKind === 'geq' ? '' : 'none';
  document.querySelectorAll('[data-preamp]').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.preamp === preampKind));
  if (audioRunning) { preampKind === 'geq' ? geqSplice() : geqUnsplice(); }
  geqSyncUI();
  redrawStatic();
}
// Called from startAudio, so the selection survives enabling audio later.
function geqOnAudioStart() { if (preampKind === 'geq') geqSplice(); }
function geqOnAudioStop() { geqSpliced = false; geqDestroy(); }

// ── Persistence ────────────────────────────────────────────
function geqSave() {
  try { localStorage.setItem(GEQ_KEY, JSON.stringify(geq)); } catch (e) {}
}
function geqLoad() {
  let raw = null;
  try { raw = localStorage.getItem(GEQ_KEY); } catch (e) {}
  if (raw) {
    try {
      const o = JSON.parse(raw) || {};
      if (Array.isArray(o.gains))
        for (let i = 0; i < GEQ_N; i++)
          geq.gains[i] = Math.max(-GEQ_MAX_DB, Math.min(GEQ_MAX_DB, num(parseFloat(o.gains[i]), 0)));
      geq.userFreq = Math.max(20, Math.min(16000, num(parseFloat(o.userFreq), 700)));
      geq.gain   = Math.max(-GEQ_MAX_DB, Math.min(GEQ_MAX_DB, num(parseFloat(o.gain), 0)));
      geq.volume = Math.max(-GEQ_MAX_DB, Math.min(GEQ_MAX_DB, num(parseFloat(o.volume), 0)));
    } catch (e) {}
  }
  let p = null;
  try { p = localStorage.getItem(PREAMP_KEY); } catch (e) {}
  preampKind = p === 'geq' ? 'geq' : 'b7k';
}

// ── Faders ─────────────────────────────────────────────────
function geqSetBand(i, db) {
  geq.gains[i] = Math.max(-GEQ_MAX_DB, Math.min(GEQ_MAX_DB, db));
  if (geqNodes && audioCtx)
    geqNodes.bands[i].gain.setTargetAtTime(geq.gains[i], audioCtx.currentTime, 0.02);
  geqPaintBand(i);
  geqSave();
  if (activeTab === 'preamp') redrawStatic();
}
function geqSetTrim(which, db) {
  geq[which] = Math.max(-GEQ_MAX_DB, Math.min(GEQ_MAX_DB, db));
  if (geqNodes && audioCtx) {
    const t = audioCtx.currentTime;
    geqNodes[which === 'gain' ? 'in' : 'out'].gain.setTargetAtTime(geqDbGain(geq[which]), t, 0.02);
  }
  geqSyncUI(); geqSave();
  if (activeTab === 'preamp') redrawStatic();
}
function geqSetUserFreq(hz) {
  geq.userFreq = Math.max(20, Math.min(16000, num(parseFloat(hz), 700)));
  if (geqNodes && audioCtx)
    geqNodes.bands[GEQ_N - 1].frequency.setTargetAtTime(geqFreqAt(GEQ_N - 1), audioCtx.currentTime, 0.02);
  geqSyncUI(); geqSave();
  if (activeTab === 'preamp') redrawStatic();
}
function geqReset() {
  geq.gains.fill(0);
  if (geqNodes && audioCtx) geqApply(false);
  geqSyncUI(); geqSave();
  if (activeTab === 'preamp') redrawStatic();
}

// String(+n.toFixed(2)) rather than toFixed alone, so 62.5 reads "62.5"
// and not "62.50" while 31.25 keeps both decimals.
const geqLabel = hz => hz >= 1000 ? (hz % 1000 === 0 ? (hz / 1000) + 'k' : String(+(hz / 1000).toFixed(2)) + 'k')
                                  : String(+hz.toFixed(2));

function geqPaintBand(i) {
  const fill = document.getElementById('geqFill' + i);
  const knob = document.getElementById('geqKnob' + i);
  const val  = document.getElementById('geqVal' + i);
  const db = num(geq.gains[i], 0);
  const frac = (db + GEQ_MAX_DB) / (2 * GEQ_MAX_DB);      // 0 bottom, 1 top
  if (knob) knob.style.bottom = 'calc(' + (frac * 100) + '% - 5px)';
  if (fill) {
    const mid = 50, pos = frac * 100;
    fill.style.bottom = Math.min(mid, pos) + '%';
    fill.style.height = Math.abs(pos - mid) + '%';
  }
  if (val) val.textContent = (db > 0 ? '+' : '') + db.toFixed(1);
}

function geqSyncUI() {
  for (let i = 0; i < GEQ_N; i++) {
    geqPaintBand(i);
    const lab = document.getElementById('geqFreq' + i);
    if (lab) lab.textContent = geqLabel(geqFreqAt(i));
  }
  const uf = document.getElementById('geqUserFreq');
  if (uf && document.activeElement !== uf) uf.value = Math.round(geq.userFreq);
  ['gain', 'volume'].forEach(k => {
    const el = document.getElementById('geq' + k[0].toUpperCase() + k.slice(1) + 'Val');
    if (el) el.textContent = (geq[k] > 0 ? '+' : '') + num(geq[k], 0).toFixed(1) + ' dB';
    const inp = document.querySelector('input[data-geqtrim="' + k + '"]');
    if (inp && parseFloat(inp.value) !== geq[k]) inp.value = geq[k];
  });
}

// Mouse gets direct vertical positioning; touch only ever takes a horizontal
// drag, so a vertical swipe on the panel always belongs to the page.
function wireGeq() {
  for (let i = 0; i < GEQ_N; i++) {
    const track = document.getElementById('geqTrack' + i);
    if (!track) continue;
    let dragging = false, tPid = null, tX = 0, tY = 0, tDb = 0, tClaimed = false;
    const SLOP = 8, PX_PER_DB = 6;

    const fromY = e => {
      const r = track.getBoundingClientRect();
      const frac = 1 - (e.clientY - r.top) / r.height;
      geqSetBand(i, Math.round((frac * 2 * GEQ_MAX_DB - GEQ_MAX_DB) * 2) / 2);
    };

    track.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse') {
        dragging = true;
        try { track.setPointerCapture(e.pointerId); } catch (err) {}
        fromY(e); e.preventDefault();
        return;
      }
      tPid = e.pointerId; tX = e.clientX; tY = e.clientY;
      tDb = num(geq.gains[i], 0); tClaimed = false;
    });
    track.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse') { if (dragging) fromY(e); return; }
      if (e.pointerId !== tPid) return;
      if (!tClaimed) {
        const dx = Math.abs(e.clientX - tX), dy = Math.abs(e.clientY - tY);
        if (dx < SLOP && dy < SLOP) return;
        if (dy >= dx) { tPid = null; return; }      // vertical: the page scrolls
        tClaimed = true;
        try { track.setPointerCapture(e.pointerId); } catch (err) {}
      }
      geqSetBand(i, tDb + (e.clientX - tX) / PX_PER_DB);
      e.preventDefault();
    });
    const end = e => {
      dragging = false; tPid = null; tClaimed = false;
      try { track.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    track.addEventListener('dblclick', () => geqSetBand(i, 0));
    track.addEventListener('keydown', e => {
      const d = e.key === 'ArrowUp' ? 0.5 : e.key === 'ArrowDown' ? -0.5 : 0;
      if (!d) { if (e.key === 'Home') { geqSetBand(i, 0); e.preventDefault(); } return; }
      geqSetBand(i, num(geq.gains[i], 0) + d); e.preventDefault();
    });
    track.addEventListener('wheel', e => {
      if (document.activeElement !== track) return;   // the wheel belongs to the page
      e.preventDefault();
      geqSetBand(i, num(geq.gains[i], 0) + (e.deltaY < 0 ? 0.5 : -0.5));
    }, { passive: false });
  }

  const uf = document.getElementById('geqUserFreq');
  if (uf) {
    uf.addEventListener('change', () => geqSetUserFreq(uf.value));
    uf.addEventListener('keydown', e => { if (e.key === 'Enter') { uf.blur(); geqSetUserFreq(uf.value); } });
  }
  document.querySelectorAll('input[data-geqtrim]').forEach(el => {
    el.addEventListener('input', () => geqSetTrim(el.dataset.geqtrim, parseFloat(el.value)));
    el.addEventListener('wheel', e => {
      if (document.activeElement !== el) return;
      e.preventDefault();
      const v = Math.min(12, Math.max(-12, parseFloat(el.value) + (e.deltaY < 0 ? 0.5 : -0.5)));
      el.value = v; geqSetTrim(el.dataset.geqtrim, v);
    }, { passive: false });
  });
}

// ── The curve, drawn over the live FFT ─────────────────────
// The theoretical response of the eleven filters, on its own ±12 dB scale
// centred at mid-height. Plotting it against the analyser's ~90 dB span
// would reduce a 12 dB boost to a barely visible wobble.
function drawGeqCurve(ctx, xp, cw, ch) {
  if (preampKind !== 'geq') return;
  const N = 200;
  const fs = new Float32Array(N);
  for (let i = 0; i < N; i++) fs[i] = AX_FMIN * Math.pow(AX_FMAX / AX_FMIN, i / (N - 1));
  const db = geqResponseDb(fs);
  const mid = PAD.t + ch / 2;
  const perDb = (ch * 0.34) / GEQ_MAX_DB;
  const yOf = d => mid - Math.max(-GEQ_MAX_DB * 1.6, Math.min(GEQ_MAX_DB * 1.6, d)) * perDb;

  ctx.save();
  // unity reference and the ±12 dB rails
  ctx.strokeStyle = TH.unityLine; ctx.lineWidth = 1; ctx.setLineDash([2, 6]);
  [-GEQ_MAX_DB, 0, GEQ_MAX_DB].forEach(d => {
    ctx.beginPath(); ctx.moveTo(PAD.l, yOf(d)); ctx.lineTo(PAD.l + cw, yOf(d)); ctx.stroke();
  });
  ctx.setLineDash([]);

  ctx.beginPath();
  for (let i = 0; i < N; i++) {
    const x = xp(fs[i]);
    if (x < PAD.l - 1 || x > PAD.l + cw + 1) continue;
    const y = yOf(db[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  if (CFG.glow) { ctx.shadowColor = TH.bass; ctx.shadowBlur = 6; }
  ctx.strokeStyle = TH.bass; ctx.lineWidth = 1.8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.fillStyle = TH.axisLabel; ctx.font = '8px Share Tech Mono,monospace'; ctx.textAlign = 'left';
  ctx.fillText('+12', PAD.l + 3, yOf(GEQ_MAX_DB) + 8);
  ctx.fillText('−12', PAD.l + 3, yOf(-GEQ_MAX_DB) - 2);
  ctx.fillText('EQ curve', PAD.l + 3, yOf(0) - 4);
  ctx.restore();
}

// The strip is built from GEQ_FIXED rather than written out by hand, so the
// band list and the DOM cannot drift apart.
function geqBuildStrip() {
  const strip = document.getElementById('geqStrip');
  if (!strip || strip.childElementCount) return;
  let html = '';
  for (let i = 0; i < GEQ_N; i++) {
    const isUser = i === GEQ_N - 1;
    html +=
      '<div class="geq-band' + (isUser ? ' geq-user' : '') + '">' +
        '<div class="geq-val" id="geqVal' + i + '">0.0</div>' +
        '<div class="geq-track" id="geqTrack' + i + '" tabindex="0" role="slider" ' +
             'aria-valuemin="-12" aria-valuemax="12" aria-label="' + geqLabel(geqFreqAt(i)) + ' Hz band">' +
          '<div class="geq-mid"></div>' +
          '<div class="geq-fill" id="geqFill' + i + '"></div>' +
          '<div class="geq-knob" id="geqKnob' + i + '"></div>' +
        '</div>' +
        '<div class="geq-freq" id="geqFreq' + i + '">' + geqLabel(geqFreqAt(i)) + '</div>' +
      '</div>';
  }
  strip.innerHTML = html;
}

function initGeq() {
  geqLoad();
  geqBuildStrip();
  wireGeq();
  setPreamp(preampKind);
}
