// ═══════════════════════════════════════════════════════════
// PARAMETRIC EQ — the curve is the instrument
//
// The graphic EQ is a fixed octave grid you sweep with faders. This is the
// other half of the job: nothing is fixed, every band goes wherever the
// problem is. 100.5 Hz, 505 Hz, anywhere between 20 and 10 k.
//
// There are no faders here on purpose. A fader implies a fixed frequency,
// and the whole point of this preamp is that nothing is fixed. What it has
// instead is the curve — grab it and drag — and a row of typed numbers per
// band, because dragging is desktop-only and a preamp you cannot touch on a
// phone is half a preamp.
//
// Bands may cross each other freely. There is no strip whose left-to-right
// order they could scramble, so stacking three of them inside one octave to
// build a shape is a feature, not a mistake.
// ═══════════════════════════════════════════════════════════

const PARA_N = 6;
const PARA_KEY = 'b7k_para';
const PARA_FMIN = 20, PARA_FMAX = 10000;      // = the chart, so nothing hides off-screen

// Spread across the range a bass actually occupies, all flat, all an octave
// wide. A starting position, not a preset: everything moves.
const PARA_DEFAULTS = [60, 150, 400, 1000, 2500, 6000];

const para = { bands: PARA_DEFAULTS.map(f => ({ f, db: 0, q: 1.4 })) };
let paraNodes = null, paraSpliced = false;

const paraClampF  = f => Math.max(PARA_FMIN, Math.min(PARA_FMAX, num(parseFloat(f), 1000)));
const paraClampDb = v => Math.max(-12, Math.min(12, num(parseFloat(v), 0)));
const paraClampQ  = v => Math.max(EQ_Q_MIN, Math.min(EQ_Q_MAX, num(parseFloat(v), 1.4)));

// ── Graph ──────────────────────────────────────────────────
function paraBuild() {
  if (!audioCtx || paraNodes) return;
  const ac = audioCtx;
  const n = { in: ac.createGain(), out: ac.createGain(), bands: [] };
  let prev = n.in;
  for (let i = 0; i < PARA_N; i++) {
    const b = ac.createBiquadFilter();
    b.type = 'peaking';
    b.frequency.value = paraClampF(para.bands[i].f);
    b.Q.value = paraClampQ(para.bands[i].q);
    b.gain.value = paraClampDb(para.bands[i].db);
    prev.connect(b); prev = b; n.bands.push(b);
  }
  prev.connect(n.out);
  paraNodes = n;
}
function paraDestroy() {
  if (!paraNodes) return;
  try {
    paraNodes.in.disconnect(); paraNodes.out.disconnect();
    paraNodes.bands.forEach(b => b.disconnect());
  } catch (e) {}
  paraNodes = null;
}

// Splices across the same edge the graphic EQ uses, so the two can never be
// in the chain at once.
function paraSplice() {
  if (paraSpliced || !audioCtx || !audioRunning) return;
  paraBuild();
  if (!paraNodes) return;
  try {
    sumBus.disconnect(filterLow);
    filterTreble.disconnect(filterHiss);
    sumBus.connect(paraNodes.in);
    paraNodes.out.connect(filterHiss);
    paraSpliced = true;
  } catch (e) { console.warn('[Para] splice', e); }
}
function paraUnsplice() {
  if (!paraSpliced) return;
  try {
    sumBus.disconnect(paraNodes.in);
    paraNodes.out.disconnect(filterHiss);
    sumBus.connect(filterLow);
    filterTreble.connect(filterHiss);
  } catch (e) { console.warn('[Para] unsplice', e); }
  paraSpliced = false;
  paraDestroy();
}

function paraApply(immediate) {
  if (!paraNodes || !audioCtx) return;
  const t = audioCtx.currentTime, S = immediate ? 0.001 : 0.02;
  for (let i = 0; i < PARA_N; i++) {
    const n = paraNodes.bands[i], b = para.bands[i];
    n.frequency.setTargetAtTime(paraClampF(b.f), t, S);
    n.Q.setTargetAtTime(paraClampQ(b.q), t, S);
    n.gain.setTargetAtTime(paraClampDb(b.db), t, S);
  }
}

function paraOnAudioStart() { if (preampKind === 'para') paraSplice(); }
function paraOnAudioStop() { paraSpliced = false; paraDestroy(); }

// ── Setters ────────────────────────────────────────────────
function paraSet(i, key, v) {
  const b = para.bands[i];
  if (!b) return;
  b[key] = key === 'f' ? paraClampF(v) : key === 'db' ? paraClampDb(v) : paraClampQ(v);
  if (paraNodes && audioCtx) {
    const n = paraNodes.bands[i], t = audioCtx.currentTime;
    const p = key === 'f' ? n.frequency : key === 'db' ? n.gain : n.Q;
    p.setTargetAtTime(key === 'f' ? b.f : key === 'db' ? b.db : b.q, t, 0.02);
  }
  paraSave();
  paraSyncUI();
  if (activeTab === 'preamp') redrawStatic();
}
function paraReset() {
  para.bands = PARA_DEFAULTS.map(f => ({ f, db: 0, q: 1.4 }));
  if (paraNodes) paraApply(false);
  paraSave(); paraSyncUI();
  if (activeTab === 'preamp') redrawStatic();
}

// ── Persistence ────────────────────────────────────────────
function paraSave() {
  try { localStorage.setItem(PARA_KEY, JSON.stringify(para)); } catch (e) {}
}
function paraLoad() {
  let raw = null;
  try { raw = localStorage.getItem(PARA_KEY); } catch (e) {}
  if (!raw) return;
  try {
    const o = JSON.parse(raw) || {};
    if (Array.isArray(o.bands))
      for (let i = 0; i < PARA_N; i++) {
        const s = o.bands[i] || {};
        para.bands[i] = { f: paraClampF(s.f), db: paraClampDb(s.db), q: paraClampQ(s.q) };
      }
  } catch (e) {}
}

// ── UI: numbers, not faders ────────────────────────────────
function paraBuildStrip() {
  const host = document.getElementById('paraRows');
  if (!host || host.childElementCount) return;
  let html = '';
  for (let i = 0; i < PARA_N; i++) {
    html +=
      '<div class="para-row">' +
        '<span class="para-n">' + (i + 1) + '</span>' +
        '<label class="para-f"><input type="number" id="paraF' + i + '" data-para="' + i + '" data-k="f" ' +
          'min="' + PARA_FMIN + '" max="' + PARA_FMAX + '" step="0.5" inputmode="decimal"><em>Hz</em></label>' +
        '<label class="para-g"><input type="number" id="paraG' + i + '" data-para="' + i + '" data-k="db" ' +
          'min="-12" max="12" step="0.5" inputmode="decimal"><em>dB</em></label>' +
        '<label class="para-q"><input type="number" id="paraQ' + i + '" data-para="' + i + '" data-k="q" ' +
          'min="' + EQ_Q_MIN + '" max="' + EQ_Q_MAX + '" step="0.1" inputmode="decimal"><em>Q</em></label>' +
      '</div>';
  }
  host.innerHTML = html;
}

function paraSyncUI() {
  for (let i = 0; i < PARA_N; i++) {
    const b = para.bands[i];
    if (!b) continue;
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el && document.activeElement !== el && parseFloat(el.value) !== v) el.value = v;
    };
    set('paraF' + i, Math.round(b.f * 10) / 10);
    set('paraG' + i, Math.round(b.db * 10) / 10);
    set('paraQ' + i, Math.round(b.q * 10) / 10);
  }
}

function wirePara() {
  const host = document.getElementById('paraRows');
  if (!host) return;
  host.addEventListener('input', e => {
    const el = e.target;
    if (!el.dataset || el.dataset.para === undefined) return;
    paraSet(parseInt(el.dataset.para, 10), el.dataset.k, el.value);
  });
}

function initPara() { paraLoad(); paraBuildStrip(); wirePara(); paraSyncUI(); }
