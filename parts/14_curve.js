// ═══════════════════════════════════════════════════════════
// CURVE EQ — draw the response, the filters chase it
//
// Not bands. You click anywhere on the chart and get a point; you pull it;
// a smooth spline runs through every point you have made. There is no such
// thing as a band frequency here, so 100.5 Hz and 505 Hz are as ordinary as
// 1 kHz.
//
// HOW IT IS ACTUALLY FILTERED
// A drawn curve is an arbitrary magnitude response, and no small set of
// filters produces one directly. Behind the curve is a fixed bank of peaking
// filters at half-octave centres, two widths each, plus a shelf at either
// end. Their gains are solved by least squares to match whatever you drew.
// You never see them and never touch them.
//
// Measured against the VPF curve this was built for (+6 dB at 40 Hz, a
// -19 dB notch at 350 Hz, +12 dB up top): 0.32 dB RMS, 1.4 dB worst, and the
// worst is at the very bottom of the notch. Biquads add no delay, so the
// whole thing is free.
//
// The solve is cheap because the expensive half does not depend on what you
// drew. The normal matrix is built and Cholesky-factored once at startup;
// each edit only rebuilds the right-hand side and back-substitutes.
// ═══════════════════════════════════════════════════════════

const CURVE_KEY = 'b7k_curve';
const CURVE_FMIN = 20, CURVE_FMAX = 10000;    // = the chart
const CURVE_MAX_DB = 18;                      // points can go past ±12; the fit will not
const CURVE_RIDGE = 0.3;                      // keeps the solved gains sane
const CURVE_GRID = 220;                       // frequencies the fit is judged on
const CURVE_QS = [1, 3];                      // one broad, one narrow, at every centre
const CURVE_PER_OCT = 2;

// Points are always sorted by frequency. The two ends are anchors: they can
// be dragged up and down but never sideways and never removed, so the curve
// always has somewhere to start and finish.
const curveEq = { pts: [{ f: CURVE_FMIN, db: 0, anchor: true },
                        { f: CURVE_FMAX, db: 0, anchor: true }] };
let curveNodes = null, curveSpliced = false;
let curveBasis = null;    // { freqs, rows, chol, centres }
let curveGains = null;    // solved gain per filter

const curveClampDb = v => Math.max(-CURVE_MAX_DB, Math.min(CURVE_MAX_DB, num(parseFloat(v), 0)));
const curveClampF  = f => Math.max(CURVE_FMIN, Math.min(CURVE_FMAX, num(parseFloat(f), 1000)));

// ── The spline ─────────────────────────────────────────────
// Monotone cubic (Fritsch-Carlson) in log-frequency. Plain cubic splines
// overshoot between points, which on an EQ means a bump you did not draw and
// cannot see the cause of. This one cannot overshoot: between two points the
// curve stays between their values.
function curveAt(f) {
  const p = curveEq.pts;
  if (!p.length) return 0;
  const x = Math.log2(Math.max(CURVE_FMIN, Math.min(CURVE_FMAX, f)));
  if (p.length === 1 || x <= Math.log2(p[0].f)) return p[0].db;
  if (x >= Math.log2(p[p.length - 1].f)) return p[p.length - 1].db;

  const X = p.map(q => Math.log2(q.f)), Y = p.map(q => q.db), n = p.length;
  // secant slopes, then Fritsch-Carlson tangents
  const d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((Y[i + 1] - Y[i]) / (X[i + 1] - X[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] * d[i] <= 0) ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  let i = 0; while (i < n - 2 && x > X[i + 1]) i++;
  const h = X[i + 1] - X[i], t = (x - X[i]) / h, t2 = t * t, t3 = t2 * t;
  return (2*t3 - 3*t2 + 1) * Y[i] + (t3 - 2*t2 + t) * h * m[i]
       + (-2*t3 + 3*t2) * Y[i + 1] + (t3 - t2) * h * m[i + 1];
}

// ── The filter bank, and the fit ───────────────────────────
function curveBuildBasis() {
  if (curveBasis) return curveBasis;
  const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OC) return null;
  let calc;
  try { calc = new OC(1, 1, 44100); } catch (e) { return null; }

  const freqs = new Float32Array(CURVE_GRID);
  for (let i = 0; i < CURVE_GRID; i++)
    freqs[i] = CURVE_FMIN * Math.pow(CURVE_FMAX / CURVE_FMIN, i / (CURVE_GRID - 1));

  const centres = [], rows = [];
  const mag = new Float32Array(CURVE_GRID), ph = new Float32Array(CURVE_GRID);
  const addRow = (type, fc, q) => {
    const b = calc.createBiquadFilter();
    b.type = type; b.frequency.value = fc;
    if (type === 'peaking') b.Q.value = q;
    b.gain.value = 1;                                   // unit gain: the fit scales it
    b.getFrequencyResponse(freqs, mag, ph);
    const r = new Float64Array(CURVE_GRID);
    for (let k = 0; k < CURVE_GRID; k++) r[k] = 20 * Math.log10(Math.max(mag[k], 1e-9));
    rows.push(r); centres.push({ type, fc, q });
  };
  const step = Math.pow(2, 1 / CURVE_PER_OCT);
  for (let f = CURVE_FMIN; f <= CURVE_FMAX * 1.001; f *= step)
    for (const q of CURVE_QS) addRow('peaking', f, q);
  // Peaking filters cannot hold a level shelf at the ends of the range, and a
  // drawn curve very often does exactly that. Two of each, at different
  // corners: one shelf alone left the top octave 1.4 dB short of a drawing
  // that sat at +12 all the way to 10 kHz.
  addRow('lowshelf', 40, 0);
  addRow('lowshelf', 120, 0);
  addRow('highshelf', 2000, 0);
  addRow('highshelf', 6000, 0);

  // Normal equations, ridge, Cholesky — none of which depend on the drawing.
  const n = rows.length, N = [];
  for (let i = 0; i < n; i++) {
    N.push(new Float64Array(n));
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < CURVE_GRID; k++) s += rows[i][k] * rows[j][k];
      N[i][j] = s;
    }
    N[i][i] += CURVE_RIDGE;
  }
  const L = [];
  for (let i = 0; i < n; i++) {
    L.push(new Float64Array(n));
    for (let j = 0; j <= i; j++) {
      let s = N[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = (i === j) ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j];
    }
  }
  curveBasis = { freqs, rows, chol: L, centres, n };
  return curveBasis;
}

// Solve for the gains that best match the drawn curve.
function curveSolve() {
  const B = curveBuildBasis();
  if (!B) { curveGains = null; return null; }
  const t = new Float64Array(CURVE_GRID);
  for (let k = 0; k < CURVE_GRID; k++) t[k] = curveAt(B.freqs[k]);
  const n = B.n, rhs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < CURVE_GRID; k++) s += B.rows[i][k] * t[k];
    rhs[i] = s;
  }
  const L = B.chol, y = new Float64Array(n), g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = rhs[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * g[k];
    g[i] = s / L[i][i];
  }
  curveGains = g;
  return g;
}

// What the filters actually do, as opposed to what you drew.
function curveAchievedDb(freqs) {
  const B = curveBuildBasis();
  const out = new Float64Array(freqs.length);
  if (!B || !curveGains) return out;
  const mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
  const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  let calc;
  try { calc = new OC(1, 1, 44100); } catch (e) { return out; }
  const f32 = freqs instanceof Float32Array ? freqs : Float32Array.from(freqs);
  for (let i = 0; i < B.n; i++) {
    if (Math.abs(curveGains[i]) < 0.005) continue;
    const c = B.centres[i], b = calc.createBiquadFilter();
    b.type = c.type; b.frequency.value = c.fc;
    if (c.type === 'peaking') b.Q.value = c.q;
    b.gain.value = curveGains[i];
    b.getFrequencyResponse(f32, mag, ph);
    for (let k = 0; k < out.length; k++) out[k] += 20 * Math.log10(Math.max(mag[k], 1e-9));
  }
  return out;
}

// ── Graph ──────────────────────────────────────────────────
function curveBuild() {
  if (!audioCtx || curveNodes) return;
  const B = curveBuildBasis();
  if (!B) return;
  const n = { in: audioCtx.createGain(), out: audioCtx.createGain(), bands: [] };
  let prev = n.in;
  for (let i = 0; i < B.n; i++) {
    const c = B.centres[i], b = audioCtx.createBiquadFilter();
    b.type = c.type; b.frequency.value = c.fc;
    if (c.type === 'peaking') b.Q.value = c.q;
    b.gain.value = 0;
    prev.connect(b); prev = b; n.bands.push(b);
  }
  prev.connect(n.out);
  curveNodes = n;
  curveApply(true);
}
function curveDestroy() {
  if (!curveNodes) return;
  try {
    curveNodes.in.disconnect(); curveNodes.out.disconnect();
    curveNodes.bands.forEach(b => b.disconnect());
  } catch (e) {}
  curveNodes = null;
}
function curveSplice() {
  if (curveSpliced || !audioCtx || !audioRunning) return;
  curveBuild();
  if (!curveNodes) return;
  try {
    sumBus.disconnect(filterLow);
    filterTreble.disconnect(filterHiss);
    sumBus.connect(curveNodes.in);
    curveNodes.out.connect(filterHiss);
    curveSpliced = true;
  } catch (e) { console.warn('[Curve] splice', e); }
}
function curveUnsplice() {
  if (!curveSpliced) return;
  try {
    sumBus.disconnect(curveNodes.in);
    curveNodes.out.disconnect(filterHiss);
    sumBus.connect(filterLow);
    filterTreble.connect(filterHiss);
  } catch (e) { console.warn('[Curve] unsplice', e); }
  curveSpliced = false;
  curveDestroy();
}
function curveApply(immediate) {
  curveSolve();
  if (!curveNodes || !audioCtx || !curveGains) return;
  const t = audioCtx.currentTime, S = immediate ? 0.001 : 0.02;
  for (let i = 0; i < curveNodes.bands.length; i++)
    curveNodes.bands[i].gain.setTargetAtTime(curveGains[i], t, S);
}
function curveOnAudioStart() { if (preampKind === 'curve') curveSplice(); }
function curveOnAudioStop() { curveSpliced = false; curveDestroy(); }

// ── Editing ────────────────────────────────────────────────
function curveSort() { curveEq.pts.sort((a, b) => a.f - b.f); }

function curveAddPoint(f, db) {
  const p = { f: curveClampF(f), db: curveClampDb(db), anchor: false };
  curveEq.pts.push(p);
  curveSort();
  curveChanged();
  return p;
}
function curveMovePoint(p, f, db) {
  if (!p) return;
  if (!p.anchor) p.f = curveClampF(f);     // anchors move vertically only
  p.db = curveClampDb(db);
  curveSort();
  curveChanged();
}
function curveRemovePoint(p) {
  if (!p || p.anchor) return false;
  const i = curveEq.pts.indexOf(p);
  if (i < 0) return false;
  curveEq.pts.splice(i, 1);
  curveChanged();
  return true;
}
function curveClear() {
  curveEq.pts = curveEq.pts.filter(p => p.anchor);
  curveEq.pts.forEach(p => { p.db = 0; });
  curveChanged();
}
function curveChanged() {
  curveApply(false);
  curveSave();
  curveSyncUI();
  if (activeTab === 'preamp') redrawStatic();
}

// ── Persistence ────────────────────────────────────────────
function curveSave() {
  try { localStorage.setItem(CURVE_KEY, JSON.stringify(curveEq)); } catch (e) {}
}
function curveNormalise(pts) {
  const out = [];
  if (Array.isArray(pts)) for (const s of pts) {
    const f = curveClampF(s && s.f), db = curveClampDb(s && s.db);
    if (Number.isFinite(f) && Number.isFinite(db)) out.push({ f, db, anchor: !!(s && s.anchor) });
  }
  // The two anchors are structural: rebuild them if a stored file lost them.
  if (!out.some(p => p.anchor && p.f <= CURVE_FMIN)) out.push({ f: CURVE_FMIN, db: 0, anchor: true });
  if (!out.some(p => p.anchor && p.f >= CURVE_FMAX)) out.push({ f: CURVE_FMAX, db: 0, anchor: true });
  out.sort((a, b) => a.f - b.f);
  return out;
}
function curveLoad() {
  let raw = null;
  try { raw = localStorage.getItem(CURVE_KEY); } catch (e) {}
  if (!raw) return;
  try { curveEq.pts = curveNormalise((JSON.parse(raw) || {}).pts); } catch (e) {}
}

// ── UI ─────────────────────────────────────────────────────
function curveSyncUI() {
  const n = curveEq.pts.filter(p => !p.anchor).length;
  const el = document.getElementById('curveCount');
  if (el) el.textContent = n === 0 ? 'no points yet — click the curve to add one'
                                   : n + (n === 1 ? ' point' : ' points');
  const fit = document.getElementById('curveFit');
  if (fit) {
    const B = curveBuildBasis();
    if (B && curveGains) {
      const got = curveAchievedDb(B.freqs);
      let worst = 0;
      for (let k = 0; k < B.freqs.length; k++)
        worst = Math.max(worst, Math.abs(got[k] - curveAt(B.freqs[k])));
      fit.textContent = 'filters within ' + worst.toFixed(2) + ' dB of the drawing';
    } else fit.textContent = '';
  }
}
function initCurve() { curveLoad(); curveSolve(); curveSyncUI(); }
