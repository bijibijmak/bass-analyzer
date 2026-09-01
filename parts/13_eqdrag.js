// ═══════════════════════════════════════════════════════════
// THE EQ, ON THE CHART
//
// Both preamps get their response curve drawn over the analyzer, and on a
// mouse you can grab a band off the curve and drag it.
//
// Why mouse only: an up-and-down drag on the analyzer is the page-scroll
// gesture on a touch screen, and the analyzer is sticky — it sits under your
// thumb for most of a portrait screen. Claiming that gesture is the exact bug
// we chased four times. Phones keep the sliders and the knobs, which is where
// a thumb is accurate anyway.
// ═══════════════════════════════════════════════════════════

const EQ_MAX_DB  = 12;    // both preamps run ±12
const EQ_HANDLE_R = 5.5;  // drawn radius
const EQ_GRAB_R  = 15;    // hit radius — generous, the curve moves under you

const mqFine = (typeof window !== 'undefined' && window.matchMedia)
  ? window.matchMedia('(pointer: fine)') : { matches: true };
const eqDragAvailable = () => !!mqFine.matches;

// ── One band model for both preamps ────────────────────────
// The drawing, the hit-testing and the drag maths are written once against
// this shape. `steps` is a switch — the B7K's mid frequencies are two-position
// on the real pedal, so a sideways drag flips rather than sweeps. `range` is a
// continuous sweep, which only the graphic EQ's user band has.
function eqBands() {
  if (typeof preampKind !== 'undefined' && preampKind === 'geq') {
    const out = [];
    for (let i = 0; i < GEQ_N; i++) {
      out.push({
        id: 'geq' + i,
        label: geqLabel(geqFreqAt(i)) + (geqFreqAt(i) >= 1000 ? 'Hz' : ' Hz'),
        freq: geqFreqAt(i), db: num(geq.gains[i], 0),
        type: 'peaking', q: GEQ_Q, step: 0.5,
        setDb: v => geqSetBand(i, v),
        sweep: i === GEQ_N - 1
          ? { range: [20, GEQ_USER_MAX], set: hz => geqSetUserFreq(Math.round(hz)) }
          : null
      });
    }
    return out;
  }
  // B7K: the four post-blend bands only. Grunt and Attack are wet-path,
  // pre-clipper, and a distortion stage has no honest linear response curve.
  return [
    // hx is where the HANDLE sits, which is not always the corner frequency.
    // A shelf delivers exactly half its gain at its own corner, so a handle
    // there would rise at half the speed of the cursor dragging it. Measured
    // for a +12 setting: Low gives 6.00 dB at 100 Hz but 11.61 at 40 Hz (97%),
    // and Treble gives 6.00 at 5 kHz but 11.11 at 9 kHz (93%). Put the grips
    // there, where the band's effect actually lives and the dot keeps up.
    { id: 'low', label: 'Low', freq: 100, hx: 40, db: num(state.low, 0),
      type: 'lowshelf', q: null, step: 0.5, sweep: null,
      setDb: v => setParam('low', v) },
    { id: 'loMid', label: 'Lo Mid', freq: num(state.loMidFreq, 1000), db: num(state.loMid, 0),
      type: 'peaking', q: 2.2, step: 0.5,
      sweep: { steps: [500, 1000], set: hz => setParam('loMidFreq', hz) },
      setDb: v => setParam('loMid', v) },
    { id: 'hiMid', label: 'Hi Mid', freq: num(state.hiMidFreq, 3000), db: num(state.hiMid, 0),
      type: 'peaking', q: 2.2, step: 0.5,
      sweep: { steps: [1500, 3000], set: hz => setParam('hiMidFreq', hz) },
      setDb: v => setParam('hiMid', v) },
    { id: 'treble', label: 'Treble', freq: 5000, hx: 9000, db: num(state.treble, 0),
      type: 'highshelf', q: null, step: 0.5, sweep: null,
      setDb: v => setParam('treble', v) }
  ];
}

// ── Response, from the same filter maths that runs the audio ───
// getFrequencyResponse on a throwaway OfflineAudioContext, so the drawn curve
// is the filters' real response and not a second implementation that can drift
// from it. The context is never started; it exists only to own biquads.
let eqCalcCtx = null, eqCalcPool = [];
function eqCalcBq(n) {
  try {
    if (!eqCalcCtx) {
      const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!OC) return null;
      eqCalcCtx = new OC(1, 1, 44100);
    }
    while (eqCalcPool.length < n) eqCalcPool.push(eqCalcCtx.createBiquadFilter());
  } catch (e) { return null; }
  return eqCalcPool;
}

// Summed dB response of `bands` across `freqs`.
function eqResponseDb(bands, freqs) {
  const out = new Float32Array(freqs.length);
  const pool = eqCalcBq(bands.length);
  if (!pool) return out;
  const f32 = freqs instanceof Float32Array ? freqs : Float32Array.from(freqs);
  const mag = new Float32Array(freqs.length), phase = new Float32Array(freqs.length);
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i], bq = pool[i];
    bq.type = b.type;
    bq.frequency.value = b.freq;
    if (b.q) bq.Q.value = b.q;
    bq.gain.value = num(b.db, 0);
    bq.getFrequencyResponse(f32, mag, phase);
    for (let k = 0; k < out.length; k++) out[k] += 20 * Math.log10(Math.max(mag[k], 1e-7));
  }
  // The graphic EQ's own input gain and output volume shift the whole curve.
  if (typeof preampKind !== 'undefined' && preampKind === 'geq') {
    const trim = num(geq.gain, 0) + num(geq.volume, 0);
    for (let k = 0; k < out.length; k++) out[k] += trim;
  }
  return out;
}

// ── Geometry ───────────────────────────────────────────────
// The curve gets its own ±12 dB scale centred at mid-height. Plotted against
// the analyser's ~90 dB span a 12 dB boost would be a barely visible wobble.
function eqGeom(ch) {
  const mid = PAD.t + ch / 2;
  const perDb = (ch * 0.34) / EQ_MAX_DB;
  const lim = EQ_MAX_DB * 1.6;
  return {
    mid, perDb,
    yOf: d => mid - Math.max(-lim, Math.min(lim, d)) * perDb,
    dbOf: y => (mid - y) / perDb
  };
}

const eqQuant = (v, step) => (step ? Math.round(v / step) * step : v);
const eqClampDb = v => Math.max(-EQ_MAX_DB, Math.min(EQ_MAX_DB, v));

// Nearest switch position, judged in log-frequency — which is how the chart
// is spaced and how the ear hears it. Linear distance would put the midpoint
// between 500 and 1000 at 750 Hz instead of 707.
function eqNearestStep(hz, steps) {
  let best = steps[0], bestD = Infinity;
  for (const s of steps) {
    const d = Math.abs(Math.log2(hz / s));
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

// Handle positions from the last paint, in CSS pixels on the canvas.
let eqHandles = [];

function eqHitBand(px, py, handles) {
  let best = null, bestD = EQ_GRAB_R;
  for (const h of (handles || eqHandles)) {
    const d = Math.hypot(px - h.x, py - h.y);
    if (d <= bestD) { bestD = d; best = h; }
  }
  return best;
}

// ── Drawing ────────────────────────────────────────────────
function drawEqCurve(ctx, xp, cw, ch, interactive) {
  const bands = eqBands();
  const N = 220;
  const fs = new Float32Array(N);
  for (let i = 0; i < N; i++) fs[i] = AX_FMIN * Math.pow(AX_FMAX / AX_FMIN, i / (N - 1));
  const db = eqResponseDb(bands, fs);
  const g = eqGeom(ch);

  ctx.save();
  // unity reference and the ±12 dB rails
  ctx.strokeStyle = TH.unityLine; ctx.lineWidth = 1; ctx.setLineDash([2, 6]);
  [-EQ_MAX_DB, 0, EQ_MAX_DB].forEach(d => {
    ctx.beginPath(); ctx.moveTo(PAD.l, g.yOf(d)); ctx.lineTo(PAD.l + cw, g.yOf(d)); ctx.stroke();
  });
  ctx.setLineDash([]);

  ctx.beginPath();
  for (let i = 0; i < N; i++) {
    const x = xp(fs[i]);
    if (x < PAD.l - 1 || x > PAD.l + cw + 1) continue;
    const y = g.yOf(db[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  if (CFG.glow) { ctx.shadowColor = TH.bass; ctx.shadowBlur = 6; }
  ctx.strokeStyle = TH.bass; ctx.lineWidth = 1.8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Handles sit ON the curve, at the summed response — not at the band's own
  // gain, which neighbouring bands have already moved.
  const handles = [];
  if (interactive && eqDragAvailable()) {
    const bf = Float32Array.from(bands.map(b => Math.min(AX_FMAX, Math.max(AX_FMIN, b.hx || b.freq))));
    const bdb = eqResponseDb(bands, bf);
    bands.forEach((b, i) => {
      const x = xp(bf[i]), y = g.yOf(bdb[i]);
      if (x < PAD.l - 2 || x > PAD.l + cw + 2) return;
      handles.push({ id: b.id, x, y, ch, sweep: !!b.sweep });
      const held = eqDrag && eqDrag.id === b.id;
      ctx.beginPath();
      ctx.arc(x, y, EQ_HANDLE_R + (held ? 2 : 0), 0, Math.PI * 2);
      ctx.fillStyle = held ? TH.bass : TH.chartBg;
      ctx.fill();
      ctx.strokeStyle = TH.bass; ctx.lineWidth = held ? 2 : 1.5;
      ctx.stroke();
      // a tick under a band whose frequency moves, so it reads as draggable sideways
      if (b.sweep) {
        ctx.beginPath();
        ctx.moveTo(x - 3, y + EQ_HANDLE_R + 4); ctx.lineTo(x + 3, y + EQ_HANDLE_R + 4);
        ctx.stroke();
      }
    });
  }
  eqHandles = handles;

  ctx.fillStyle = TH.axisLabel; ctx.font = '8px Share Tech Mono,monospace'; ctx.textAlign = 'left';
  ctx.fillText('+12', PAD.l + 3, g.yOf(EQ_MAX_DB) + 8);
  ctx.fillText('−12', PAD.l + 3, g.yOf(-EQ_MAX_DB) - 2);
  ctx.fillText(interactive && eqDragAvailable() ? 'EQ curve · drag a dot' : 'EQ curve',
               PAD.l + 3, g.yOf(0) - 4);
  ctx.restore();
}

// ── Dragging ───────────────────────────────────────────────
let eqDrag = null;

function eqBandById(id) {
  const bs = eqBands();
  for (const b of bs) if (b.id === id) return b;
  return null;
}

function eqDragStart(el, e) {
  if (!eqDragAvailable() || e.pointerType !== 'mouse') return false;
  if (typeof analyzerMode !== 'undefined' && analyzerMode !== 'fft') return false;
  const rect = el.getBoundingClientRect();
  const hit = eqHitBand(e.clientX - rect.left, e.clientY - rect.top);
  if (!hit) return false;
  const b = eqBandById(hit.id);
  if (!b) return false;
  eqDrag = { id: b.id, x0: e.clientX, y0: e.clientY, db0: b.db, ch: hit.ch };
  try { el.setPointerCapture(e.pointerId); } catch (err) {}
  el.style.cursor = 'grabbing';
  hideProbe();
  eqTip(b, e.clientX, e.clientY);
  e.preventDefault();
  return true;
}

function eqDragMove(el, e) {
  if (!eqDrag) return false;
  const b = eqBandById(eqDrag.id);
  if (!b) { eqDragEnd(el, e); return true; }
  const g = eqGeom(eqDrag.ch);

  // Relative, not absolute: the handle keeps the offset you grabbed it at,
  // so nothing jumps under the cursor on the first pixel of movement.
  b.setDb(eqClampDb(eqQuant(eqDrag.db0 - (e.clientY - eqDrag.y0) / g.perDb, b.step)));

  if (b.sweep) {
    const f = chartXtoFreq(el, e.clientX);
    if (f) {
      if (b.sweep.steps) {
        const snapped = eqNearestStep(f, b.sweep.steps);
        if (snapped !== b.freq) b.sweep.set(snapped);
      } else {
        b.sweep.set(Math.max(b.sweep.range[0], Math.min(b.sweep.range[1], f)));
      }
    }
  }
  eqTip(eqBandById(eqDrag.id) || b, e.clientX, e.clientY);
  e.preventDefault();
  return true;
}

function eqDragEnd(el, e) {
  if (!eqDrag) return false;
  eqDrag = null;
  if (el) {
    el.style.cursor = '';
    if (e && el.releasePointerCapture) { try { el.releasePointerCapture(e.pointerId); } catch (err) {} }
  }
  hideProbe();
  if (typeof redrawStatic === 'function') redrawStatic();
  return true;
}

// Hover feedback, so the dots read as grabbable before you try.
function eqHoverCursor(el, e) {
  if (!eqDragAvailable() || e.pointerType !== 'mouse' || eqDrag) return;
  const rect = el.getBoundingClientRect();
  el.style.cursor = eqHitBand(e.clientX - rect.left, e.clientY - rect.top) ? 'grab' : '';
}

function eqTip(b, cx, cy) {
  const tip = document.getElementById('freqTooltip');
  if (!tip || !b) return;
  const sign = b.db > 0 ? '+' : '';
  let s = b.label + '  ·  ' + sign + num(b.db, 0).toFixed(1) + ' dB';
  if (b.sweep) s += '  ·  ' + freqDisplay(b.freq);
  tip.textContent = s;
  tip.style.display = 'block';
  tip.style.left = Math.max(6, Math.min(cx + 14, window.innerWidth - tip.offsetWidth - 16)) + 'px';
  tip.style.top = Math.max(6, cy - 30) + 'px';
}
