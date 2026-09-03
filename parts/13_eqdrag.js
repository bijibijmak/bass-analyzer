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
const EQ_HANDLE_R = 3;    // drawn radius — a marker, not a target: you can
                          // grab the curve anywhere, so the dot only has to
                          // say where a band is centred
const EQ_GRAB_R  = 12;    // still used to show the "grab" cursor over a dot
const EQ_Q_MIN = 0.5;     // very broad
const EQ_Q_MAX = 18;      // a surgical notch, ~1/20th of an octave
const EQ_DRAG_SLOP = 3;   // px before a click counts as a drag
const EQ_MIN_AUTHORITY = 0.5;  // below this a band cannot honestly chase the cursor

const mqFine = (typeof window !== 'undefined' && window.matchMedia)
  ? window.matchMedia('(pointer: fine)') : { matches: true };
const eqDragAvailable = () => !!mqFine.matches;

// ── One band model for both preamps ────────────────────────
// The drawing, the hit-testing and the drag maths are written once against
// this shape. `steps` is a switch — the B7K's mid frequencies are two-position
// on the real pedal, so a sideways drag flips rather than sweeps. `range` is a
// continuous sweep, which only the graphic EQ's user band has.
function eqBands() {
  if (typeof preampKind !== 'undefined' && preampKind === 'para') {
    return para.bands.map((b, i) => ({
      id: 'para' + i, label: 'Band ' + (i + 1),
      freq: b.f, db: b.db, q: b.q, type: 'peaking', step: 0.5,
      free: true,                                   // its centre moves with the drag
      setDb: v => paraSet(i, 'db', v),
      setQ:  v => paraSet(i, 'q', v),
      sweep: { range: [PARA_FMIN, PARA_FMAX], set: hz => paraSet(i, 'f', hz) }
    }));
  }
  if (typeof preampKind !== 'undefined' && preampKind === 'geq') {
    const out = [];
    for (let i = 0; i < GEQ_N; i++) {
      out.push({
        id: 'geq' + i,
        label: geqLabel(geqFreqAt(i)) + (geqFreqAt(i) >= 1000 ? 'Hz' : ' Hz'),
        freq: geqFreqAt(i), db: num(geq.gains[i], 0),
        type: 'peaking', q: num(geq.qs[i], GEQ_Q), step: 0.5,
        setDb: v => geqSetBand(i, v),
        setQ: v => geqSetQ(i, v),
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
      type: 'peaking', q: num(state.loMidQ, 2.2), step: 0.5,
      sweep: { steps: [500, 1000], set: hz => setParam('loMidFreq', hz) },
      setDb: v => setParam('loMid', v),
      setQ: v => setParam('loMidQ', eqClampQ(v)) },
    { id: 'hiMid', label: 'Hi Mid', freq: num(state.hiMidFreq, 3000), db: num(state.hiMid, 0),
      type: 'peaking', q: num(state.hiMidQ, 2.2), step: 0.5,
      sweep: { steps: [1500, 3000], set: hz => setParam('hiMidFreq', hz) },
      setDb: v => setParam('hiMid', v),
      setQ: v => setParam('hiMidQ', eqClampQ(v)) },
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
// The drag clamps before it calls setQ, but a preset or a direct call would
// not — and setParam writes state[key] with no validation at all. Clamp at
// the setter so nothing can put a filter somewhere Web Audio will not go.
const eqClampQ = v => Math.max(EQ_Q_MIN, Math.min(EQ_Q_MAX, num(v, 1.4)));

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
let eqGeo = null;      // { ch, cw } from the last paint

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
  if (interactive) eqGeo = { ch, cw };

  ctx.fillStyle = TH.axisLabel; ctx.font = '8px Share Tech Mono,monospace'; ctx.textAlign = 'left';
  ctx.fillText('+12', PAD.l + 3, g.yOf(EQ_MAX_DB) + 8);
  ctx.fillText('−12', PAD.l + 3, g.yOf(-EQ_MAX_DB) - 2);
  ctx.fillText(interactive && eqDragAvailable() ? 'EQ curve · drag it · alt = width' : 'EQ curve',
               PAD.l + 3, PAD.t + 9);
  ctx.restore();
}

// ── Which band owns this point, and by how much ────────────
// Response of ONE band at one frequency, for a hypothetical gain.
function eqBandAt(band, db, f) {
  return eqResponseDb([Object.assign({}, band, { db })], [f])[0];
}

// dB the curve moves at f per dB of this band's own gain. Zero means this
// band has no say here; 1 means it owns the point outright.
function eqSensitivity(band, f) {
  return eqBandAt(band, num(band.db, 0) + 1, f) - eqBandAt(band, num(band.db, 0), f);
}

// The band that actually controls the curve at f — not the nearest one, the
// most influential one. For a shelf that is everything past its corner; for a
// narrow notch it is a sliver. This is what makes "grab it anywhere" feel
// right: you get the band you were reaching for.
function eqBandAtFreq(f) {
  const bands = eqBands();
  // Freely-tunable bands: nearest centre wins. Influence would be perverse
  // here — set Q to 18 and the band 5 Hz from your cursor has almost none,
  // so you would be handed a different band than the one you are pointing at.
  if (bands.length && bands[0].free) {
    let near = null, nd = Infinity;
    for (const b of bands) {
      const d = Math.abs(Math.log2(f / b.freq));
      if (d < nd) { nd = d; near = b; }
    }
    return near;
  }
  let best = null, bestS = 0.02;
  for (const b of bands) {
    const sv = Math.abs(eqSensitivity(b, f));
    if (sv > bestS) { bestS = sv; best = b; }
  }
  if (best) return best;
  // Nothing has real influence here (every band flat and far away) — fall
  // back to the nearest centre so a grab still does something sensible.
  let near = null, nd = Infinity;
  for (const b of bands) {
    const d = Math.abs(Math.log2(f / (b.hx || b.freq)));
    if (d < nd) { nd = d; near = b; }
  }
  return near;
}

// Solve for the gain that puts the SUMMED curve through targetDb at f.
// Newton, because response-at-f is not linear in the gain parameter once you
// are off the band's centre. Three or four steps land inside a hundredth of
// a dB, and the derivative is recomputed each step.
function eqSolveGain(band, f, targetDb) {
  const others = eqBands().filter(b => b.id !== band.id);
  const sumOthers = others.length ? eqResponseDb(others, [f])[0] : 0;
  const trimOnly = eqResponseDb([], [f])[0];      // the geq's in/out trim, if any
  let g = num(band.db, 0);
  for (let k = 0; k < 5; k++) {
    const cur = sumOthers + eqBandAt(band, g, f) - (others.length ? trimOnly : 0);
    const err = targetDb - cur;
    if (Math.abs(err) < 0.01) break;
    const sv = eqBandAt(band, g + 1, f) - eqBandAt(band, g, f);
    if (Math.abs(sv) < 1e-3) break;               // cannot move the curve here
    g = eqClampDb(g + err / sv);
  }
  return g;
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
  if (!eqGeo) return false;
  const rect = el.getBoundingClientRect();
  const px = e.clientX - rect.left;
  if (px < PAD.l || px > PAD.l + eqGeo.cw) return false;   // outside the plot
  const f = chartXtoFreq(el, e.clientX);
  if (!f) return false;
  const b = eqBandAtFreq(f);
  if (!b) return false;
  // Grab the CURVE, not the dot: remember where the curve sits at the exact
  // frequency under the cursor, and drag from there.
  eqDrag = { id: b.id, x0: e.clientX, y0: e.clientY, f,
             base: eqResponseDb(eqBands(), [f])[0], db0: num(b.db, 0), q0: num(b.q, 1.4),
             f0: num(b.freq, f),
             ch: eqGeo.ch, moved: false };
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
  const dy = e.clientY - eqDrag.y0;
  const dx = e.clientX - eqDrag.x0;
  // Both axes. This used to measure dy alone, which meant a purely sideways
  // drag never cleared the threshold — and sideways is precisely the gesture
  // that moves a band's frequency, so it did nothing at all.
  if (!eqDrag.moved && Math.hypot(dx, dy) < EQ_DRAG_SLOP && !e.altKey) { e.preventDefault(); return true; }
  eqDrag.moved = true;

  if (e.altKey) {
    // Width. Logarithmic, because Q is: 0.5 to 18 should feel like even
    // travel, not like nothing then everything.
    if (b.setQ) {
      const q = eqDrag.q0 * Math.pow(2, -dy / 70);
      b.setQ(Math.max(EQ_Q_MIN, Math.min(EQ_Q_MAX, q)));
    } else {
      loopNoop();   // shelves have no width; Web Audio ignores Q on them
    }
    eqTip(eqBandById(eqDrag.id) || b, e.clientX, e.clientY, true);
    e.preventDefault();
    return true;
  }

  // Gain. Two regimes, and which one you get depends on whether the band you
  // grabbed can actually do what you are asking at this frequency.
  //
  // Authority is how many dB the curve moves here per dB of the band's gain:
  // 1.0 dead on its centre, a few hundredths far out on its skirt.
  //
  //   · Enough authority — solve, so the curve passes exactly through the
  //     cursor. This is the case you are in whenever you grab near a band.
  //   · Not enough — no gain within ±12 can put the curve under your hand, so
  //     chasing it just pins the band at its rail while the curve sits dead.
  //     Move the band 1:1 with your hand instead: less magical, but it does
  //     something, and it does the same thing every time.
  //
  // The B7K has this weak spot around 200-400 Hz because it only has four
  // bands. The graphic EQ's eleven cover the range with no gaps.
  const target = eqDrag.base - dy / g.perDb;
  const authority = Math.abs(eqSensitivity(b, eqDrag.f));
  const next = authority >= EQ_MIN_AUTHORITY
    ? eqSolveGain(b, eqDrag.f, target)
    : eqDrag.db0 - dy / g.perDb;        // weak spot: the band itself follows
  b.setDb(eqClampDb(eqQuant(next, b.step)));

  if (b.sweep) {
    const f = chartXtoFreq(el, e.clientX);
    if (f) {
      if (b.sweep.steps) {
        const snapped = eqNearestStep(f, b.sweep.steps);
        if (snapped !== b.freq) b.sweep.set(snapped);
      } else {
        // Relative, in log space. Setting the band to the cursor's absolute
        // frequency would teleport it the instant you pressed the mouse
        // down; multiplying its own frequency by how far the cursor has
        // travelled means nothing moves until you move.
        const moved = eqDrag.f0 * (f / eqDrag.f);
        b.sweep.set(Math.max(b.sweep.range[0], Math.min(b.sweep.range[1], moved)));
      }
    }
  }
  eqTip(eqBandById(eqDrag.id) || b, e.clientX, e.clientY);
  e.preventDefault();
  return true;
}

// Shelves have no width to set; Web Audio ignores Q on lowshelf/highshelf.
function loopNoop() {}

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
  const px = e.clientX - rect.left;
  const inPlot = eqGeo && px >= PAD.l && px <= PAD.l + eqGeo.cw;
  el.style.cursor = eqHitBand(px, e.clientY - rect.top) ? 'grab' : (inPlot ? 'ns-resize' : '');
}

function eqTip(b, cx, cy, widthMode) {
  const tip = document.getElementById('freqTooltip');
  if (!tip || !b) return;
  const sign = b.db > 0 ? '+' : '';
  let s = b.label + '  ·  ' + sign + num(b.db, 0).toFixed(1) + ' dB';
  if (b.setQ) s += '  ·  Q ' + num(b.q, 1.4).toFixed(1) + (widthMode ? ' ←' : '');
  else if (widthMode) s += '  ·  a shelf has no width';
  if (b.sweep) s += '  ·  ' + (b.free ? (b.freq >= 1000 ? (b.freq / 1000).toFixed(2) + ' kHz'
                                                       : b.freq.toFixed(1) + ' Hz')
                                     : freqDisplay(b.freq));
  tip.textContent = s;
  tip.style.display = 'block';
  tip.style.left = Math.max(6, Math.min(cx + 14, window.innerWidth - tip.offsetWidth - 16)) + 'px';
  tip.style.top = Math.max(6, cy - 30) + 'px';
}
