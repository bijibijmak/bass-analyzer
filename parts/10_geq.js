// ═══════════════════════════════════════════════════════════
// GRAPHIC EQ PREAMP — 11 band, after the MXR M108S
//
// The M108S is a TEN band: 31.25 · 62.5 · 125 · 250 · 500 · 1k · 2k · 4k ·
// 8k Hz peaking, plus a ±12 dB shelf on top, with Volume and Gain sliders
// alongside. Three deliberate departures: the top band sits at 10 kHz rather
// than 16 kHz so it stays inside the analyzer's range, it is peaking rather
// than shelving so its label means what it says at that frequency, and the
// eleventh band is ours -- a peaking filter whose centre you type in.
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

// Top band is 10 kHz, not the M108S's 16 kHz: the analyzer is capped at
// 10 kHz, and a band above the chart is a control you can hear but never
// see. Still a shelf, so it catches everything above it.
const GEQ_FIXED = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 10000];
const GEQ_N = GEQ_FIXED.length + 1;          // 11: ten fixed plus the user band
const GEQ_MAX_DB = 12;
const GEQ_Q = 1.4;                            // ~1 octave, matching octave spacing
const GEQ_KEY = 'b7k_geq';
const PREAMP_KEY = 'b7k_preamp';

const geq = {
  gains: new Array(GEQ_N).fill(0),            // dB, −12..+12
  qs: new Array(GEQ_N).fill(GEQ_Q),           // width, 0.5..18 — per band, so one
                                              // notch can bite while the rest stay broad
  userFreq: 700,                              // the 11th band's centre
  gain: 0,                                    // M108S "Gain", pre-EQ
  volume: 0                                   // M108S "Volume", post-EQ
};
let preampKind = 'b7k';                       // 'b7k' | 'geq'
let geqNodes = null, geqSpliced = false;

const GEQ_USER_MAX = 10000;   // = AX_FMAX, so every band is on the chart
const geqFreqAt = i => (i < GEQ_FIXED.length ? GEQ_FIXED[i]
                                             : Math.max(20, Math.min(GEQ_USER_MAX, num(geq.userFreq, 700))));
// Every band is peaking, including the top one. The M108S's top band is a
// shelf, but a shelf only reaches half its gain at the corner frequency —
// with the corner at the chart's own ceiling that is a fader marked +12 that
// delivers +6 at the highest frequency you can see. Measured before the
// change: 0 dB at 2k, 1.1 at 6k, 6.0 at 10k for a +12 setting.
const geqDbGain = db => Math.pow(10, num(db, 0) / 20);

// ── Graph ──────────────────────────────────────────────────
function geqBuild() {
  if (!audioCtx || geqNodes) return;
  const ac = audioCtx;
  const n = { in: ac.createGain(), out: ac.createGain(), bands: [] };
  let prev = n.in;
  for (let i = 0; i < GEQ_N; i++) {
    const b = ac.createBiquadFilter();
    b.type = 'peaking';
    b.frequency.value = geqFreqAt(i);
    b.Q.value = num(geq.qs[i], GEQ_Q);
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
    b.Q.setTargetAtTime(num(geq.qs[i], GEQ_Q), t, S);
    b.gain.setTargetAtTime(num(geq.gains[i], 0), t, S);
  }
  geqNodes.in.gain.setTargetAtTime(geqDbGain(geq.gain), t, S);
  geqNodes.out.gain.setTargetAtTime(geqDbGain(geq.volume), t, S);
}

// ── Preamp selection ───────────────────────────────────────
const PREAMP_KINDS = ['b7k', 'geq', 'curve'];
function setPreamp(kind) {
  preampKind = PREAMP_KINDS.indexOf(kind) >= 0 ? kind : 'b7k';
  try { localStorage.setItem(PREAMP_KEY, preampKind); } catch (e) {}
  [['preampB7k', 'b7k'], ['preampGeq', 'geq'], ['preampCurve', 'curve']].forEach(([id, k]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = preampKind === k ? '' : 'none';
  });
  document.querySelectorAll('[data-preamp]').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.preamp === preampKind));
  // The graphic and the parametric splice across the same edge, so exactly
  // one of them may be in the chain at a time. Unsplice first, always.
  if (audioRunning) {
    geqUnsplice(); curveUnsplice();
    if (preampKind === 'geq') geqSplice();
    else if (preampKind === 'curve') curveSplice();
  }
  geqSyncUI();
  if (typeof curveSyncUI === 'function') curveSyncUI();
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
      if (Array.isArray(o.qs))
        for (let i = 0; i < GEQ_N; i++)
          geq.qs[i] = Math.max(EQ_Q_MIN, Math.min(EQ_Q_MAX, num(parseFloat(o.qs[i]), GEQ_Q)));
      geq.userFreq = Math.max(20, Math.min(GEQ_USER_MAX, num(parseFloat(o.userFreq), 700)));
      geq.gain   = Math.max(-GEQ_MAX_DB, Math.min(GEQ_MAX_DB, num(parseFloat(o.gain), 0)));
      geq.volume = Math.max(-GEQ_MAX_DB, Math.min(GEQ_MAX_DB, num(parseFloat(o.volume), 0)));
    } catch (e) {}
  }
  let p = null;
  try { p = localStorage.getItem(PREAMP_KEY); } catch (e) {}
  preampKind = (p === 'geq' || p === 'curve') ? p : 'b7k';
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
function geqSetQ(i, q) {
  geq.qs[i] = Math.max(EQ_Q_MIN, Math.min(EQ_Q_MAX, num(q, GEQ_Q)));
  if (geqNodes && audioCtx)
    geqNodes.bands[i].Q.setTargetAtTime(geq.qs[i], audioCtx.currentTime, 0.02);
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
  geq.userFreq = Math.max(20, Math.min(GEQ_USER_MAX, num(parseFloat(hz), 700)));
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
