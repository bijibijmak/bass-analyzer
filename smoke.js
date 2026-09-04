// Headless DOM smoke test. jsdom has no canvas and no Web Audio, so both are
// stubbed. This will NOT tell us anything about sound — it catches init-time
// ReferenceErrors, missing elements, and broken tab/preset/control logic,
// which is exactly the class of bug a static grep misses.
//
// Usage: node smoke.js <path-to-html>
const fs = require('fs');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.error('smoke.js needs jsdom.  Run:  npm install  (in this folder)');
  process.exit(2);
}

const file = process.argv[2];
const html = fs.readFileSync(file, 'utf8');

let fails = 0;
const errors = [];
const ok  = s => console.log('  ok   ' + s);
const bad = s => { console.log('  FAIL ' + s); fails++; };

// ── Canvas 2D stub: every method a no-op, every property writable ──
function ctx2d() {
  const noop = () => {};
  const target = {
    canvas: null,
    createLinearGradient: () => ({ addColorStop: noop }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData:   (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    measureText: () => ({ width: 10 })
  };
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      return typeof k === 'string' ? noop : undefined;
    },
    set(t, k, v) { t[k] = v; return true; }
  });
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://localhost/index.html',
  beforeParse(window) {
    window.HTMLCanvasElement.prototype.getContext = function () { const c = ctx2d(); c.canvas = this; return c; };
    // jsdom leaves clientWidth at 0; give every element a plausible width so
    // the "hidden parent" guards don't mask real drawing bugs.
    Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get() { return 560; } });
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, top: 0, left: 0, right: 560, bottom: 320, width: 560, height: 320 };
    };
    window.navigator.mediaDevices = {
      enumerateDevices: () => Promise.resolve([]),
      getUserMedia: () => Promise.reject(new Error('no audio in jsdom'))
    };
    window.scrollTo = () => {};
    window.URL.createObjectURL = () => 'blob:stub';
    Object.defineProperty(window, 'isSecureContext', { get: () => true });
    // jsdom is a desktop: a fine pointer, not a coarse one. Answering every
    // query "false" made (pointer: fine) false too, which silently disabled
    // the EQ handles the tests below exist to exercise.
    window.matchMedia = q => ({ matches: /pointer:\s*fine/.test(q), media: q,
                                addEventListener() {}, removeEventListener() {} });
    window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 16);
    window.cancelAnimationFrame = id => clearTimeout(id);
    window.onerror = (msg, src, line, col, err) => { errors.push((err && err.stack) || msg); };
    window.addEventListener('error', e => errors.push(e.error ? e.error.stack : e.message));
  }
});

const w = dom.window, d = w.document;
// Top-level `const`/`let` in a classic script land in the global lexical
// environment, not on `window` — only function declarations become properties.
// `window.eval` runs in global scope, so it can see both.
const ev = expr => w.eval(expr);

setTimeout(() => {
  console.log('[1] load');
  if (errors.length) bad('console errors on load:\n      ' + errors.join('\n      '));
  else ok('no errors during init');

  console.log('\n[2] tab switching');
  const panels = ['preamp', 'tuner', 'spectrum', 'detune', 'mix'];
  let tabOk = true;
  for (const t of panels) {
    try { ev('setTab')(t); } catch (e) { bad(`setTab('${t}') threw: ${e.message}`); tabOk = false; continue; }
    const active = panels.filter(p => d.getElementById('panel-' + p).classList.contains('active'));
    if (active.length !== 1 || active[0] !== t) { bad(`after setTab('${t}') active panels = ${active}`); tabOk = false; }
    if (d.getElementById('tab-' + t).getAttribute('aria-selected') !== 'true') { bad(`tab-${t} not aria-selected`); tabOk = false; }
  }
  if (tabOk) ok(`all ${panels.length} tabs switch, exactly one panel active each time`);
  ev('setTab')('preamp');

  console.log('\n[3] island does not overlap content');
  const padBottom = d.body.style.paddingBottom;
  if (/^\d+px$/.test(padBottom) && parseInt(padBottom) >= 320) ok('body padding-bottom set from measured island height (' + padBottom + ')');
  else bad('body padding-bottom is "' + padBottom + '" — island would overlap');

  console.log('\n[4] twin controls stay in sync');
  // Preamp is a knob now; the Mix compact strip keeps its slider. Both are
  // views onto the same `state`, which is why the knob could be swapped in
  // without touching the preset schema or the DSP.
  const lowKnob = d.querySelector('[data-knob="low"]');
  const mixLow  = d.querySelector('input[data-bind="low"]');
  if (!lowKnob || !mixLow) bad('expected a Preamp low knob and a Mix low slider');
  else {
    ev('setParam')('low', 6);
    const labels = [...d.querySelectorAll('[data-val="low"]')].map(e => e.textContent);
    const step = lowKnob.getAttribute('aria-valuenow');
    const clock = d.querySelector('[data-clock="low"]').textContent;
    if (parseFloat(mixLow.value) !== 6) bad('Mix twin did not follow (got ' + mixLow.value + ')');
    else if (!labels.every(t => t === '+6.0 dB')) bad('labels out of sync: ' + JSON.stringify(labels));
    else if (step !== '15') bad('+6 dB should be detent 15, knob says ' + step);
    else if (clock !== '2:30') bad('detent 15 should read 2:30, knob says ' + clock);
    else ok(`knob + Mix twin + ${labels.length} labels synced (+6 dB = detent 15, ${clock})`);

    // 0 dB must land exactly on the centre detent, or the EQ knobs will not
    // return to flat by eye.
    ev('setParam')('low', 0);
    if (lowKnob.getAttribute('aria-valuenow') === '10' &&
        d.querySelector('[data-clock="low"]').textContent === '12:00')
      ok('0 dB is dead centre (detent 10, 12:00)');
    else bad('0 dB is not centred: detent ' + lowKnob.getAttribute('aria-valuenow'));

    // and the knob writes back to state
    lowKnob.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    if (Math.abs(ev('state.low') - 12) < 1e-9) ok('knob End drives state to +12 dB');
    else bad('knob keyboard did not set state: ' + ev('state.low'));
    ev('setParam')('low', 0);
  }

  console.log('\n[5] Level dims when Blend = 0');
  ev('setParam')('blend', 0);
  const card = d.getElementById('cardLevel');
  const lvlKnob = d.querySelector('[data-knob="level"]');
  const lvlOff = () => lvlKnob.getAttribute('aria-disabled') === 'true';
  if (card.classList.contains('dimmed') && lvlOff()) ok('Level dimmed and disabled at blend 0');
  else bad(`blend 0 → dimmed=${card.classList.contains('dimmed')} disabled=${lvlOff()}`);
  ev('setParam')('blend', 50);
  if (!card.classList.contains('dimmed') && !lvlOff()) ok('Level re-enabled once Blend > 0');
  else bad('Level still dimmed at blend 50');
  ev('setParam')('blend', 0);

  console.log('\n[6] 3-position switches');
  const gruntPill = d.querySelector('[data-sw="grunt"]');
  // Grunt and Attack now appear on both preamp panels, so a bare
  // querySelectorAll returns every instance concatenated. Scope to the first.
  const swSpans = id => [...d.querySelector(`[data-swlabels="${id}"]`).querySelectorAll('span')];
  const gruntSpans = swSpans('grunt');
  // Listed top to bottom on screen. Reading the values out of the markup is
  // the point: the physical order and the state value cannot drift in code.
  const order = gruntSpans.map(sp => sp.textContent);
  // Order comes from the real pedal's labelling, via Bijan's printed sheet.
  // It is deliberately not sorted by dB, so it has to be pinned here.
  if (order.join('/') === 'Fat/Thin/Raw') ok('grunt switch reads Fat/Thin/Raw top to bottom');
  else bad('grunt switch order is ' + order.join('/'));
  const aOrder = swSpans('attack').map(sp => sp.textContent);
  if (aOrder.join('/') === 'Flat/Boost/Cut') ok('attack switch reads Flat/Boost/Cut top to bottom');
  else bad('attack switch order is ' + aOrder.join('/'));

  ev('setParam')('grunt', 1);
  gruntPill.dispatchEvent(new w.Event('click', { bubbles: true }));   // Raw (bottom) → Fat (top)
  const onSpan = gruntSpans.find(sp => sp.classList.contains('on'));
  if (ev('state.grunt') === 2 && onSpan && onSpan.textContent === 'Fat' &&
      d.querySelector('[data-val="grunt"]').textContent === 'Fat')
    ok('clicking the pill cycles to Fat and moves state, dot and label together');
  else bad(`grunt=${ev('state.grunt')} on=${onSpan && onSpan.textContent}`);

  const dots = [...d.querySelectorAll('[data-sw="grunt"] .sw-dot')];
  if (dots.length >= 2 && dots.every(x => x.style.top === '15%'))
    ok(`all ${dots.length} Grunt switches sit at the top position for Fat — the panels are twins`);
  else bad('dots at ' + dots.map(x => x.style.top).join(',') + ' for Fat');

  // The 2-position frequency switch shares the same code path.
  ev('setParam')('loMidFreq', 1000);
  const fPill = d.querySelector('[data-sw="loMidFreq"]');
  fPill.dispatchEvent(new w.Event('click', { bubbles: true }));
  if (ev('state.loMidFreq') === 500) ok('2-position frequency switch toggles 1 kHz → 500 Hz');
  else bad('loMidFreq=' + ev('state.loMidFreq'));
  ev('setParam')('loMidFreq', 1000);
  ev('setParam')('grunt', 1);

  console.log('\n[7] preset round-trip + v1 migration (the NaN trap)');
  try {
    w.localStorage.clear();
    // A genuine v1-schema preset: has tone/pickup, no drive section at all.
    w.localStorage.setItem('b7k_presets_v1', JSON.stringify([{
      name: 'Old v1', low: 3, loMid: -2, loMidFreq: 500, hiMid: 4,
      hiMidFreq: 1500, treble: 1.5, tone: 80, pickup: 30
    }]));
    const loaded = ev('loadPresetsFromStorage')();
    if (loaded.length !== 1) throw new Error('migration produced ' + loaded.length + ' presets');
    const p = loaded[0];
    // v3 adds a string (preamp) and an array (geqGains); everything else must
    // still be a finite number.
    // paraBands is an array of objects; its contents are checked below rather
    // than by the flat finite sweep.
    const SKIP = new Set(['name', 'preamp', 'geqGains', 'geqQs', 'curvePts', 'compOn']);
    const badBand = (arr) => !Array.isArray(arr) || arr.length < 2 || arr.some(b =>
      !b || !Number.isFinite(b.f) || !Number.isFinite(b.db) ||
      b.f < 20 || b.f > 10000 || Math.abs(b.db) > 18);
    const bad0 = Object.entries(p).filter(([k, v]) => !SKIP.has(k) && !Number.isFinite(v));
    if (bad0.length) bad('migrated preset has non-finite fields: ' + JSON.stringify(bad0));
    else ok('v1 → v3 migration produced only finite numbers');
    if (badBand(p.curvePts)) bad('migrated preset has bad curve points');
    else ok('curve points survive migration, anchors intact');
    if (Array.isArray(p.geqGains) && p.geqGains.length === 11 && p.geqGains.every(Number.isFinite))
      ok('migrated preset carries 11 finite EQ band gains');
    else bad('geqGains is ' + JSON.stringify(p.geqGains));
    if (p.preamp === 'b7k') ok('migrated preset defaults to the B7K preamp');
    else bad('preamp defaulted to ' + p.preamp);
    if ('tone' in p || 'pickup' in p) bad('tone/pickup survived migration');
    else ok('tone and pickup dropped');
    if (p.blend === 0 && p.level === 100 && p.drive === 0 && p.grunt === 1 && p.attack === 1)
      ok('drive section defaulted neutral (blend 0, level unity, drive min, Raw, Flat)');
    else bad('drive defaults wrong: ' + JSON.stringify(p));
    if (!w.localStorage.getItem('b7k_presets_v3')) bad('v3 store not written on migrate');
    else ok('v3 store written');

    // v2 is the store most users are actually on, so migrate that too.
    w.localStorage.clear();
    w.localStorage.setItem('b7k_presets_v2', JSON.stringify([{
      name: 'Old v2', low: 2, blend: 40, level: 90, drive: 30, grunt: 2, attack: 0
    }]));
    const v2p = ev('loadPresetsFromStorage')()[0];
    if (v2p && v2p.blend === 40 && v2p.grunt === 2 && v2p.geqGains.every(g => g === 0))
      ok('v2 → v3 keeps the drive section and adds a flat EQ');
    else bad('v2 migration gave ' + JSON.stringify(v2p));

    // Deliberately hostile: hand-edited garbage must not reach a gain node.
    // Written to the CURRENT store, or the migration above would shadow it.
    w.localStorage.clear();
    w.localStorage.setItem('b7k_presets_v3', JSON.stringify([
      { name: 'Junk', low: 'x', loMid: null, treble: undefined, blend: NaN,
        level: 'unity', drive: {}, grunt: 9, attack: -3, loMidFreq: 777, hiMidFreq: 'abc',
        geqGains: ['x', null, undefined, NaN, 99, -99, {}, [], 'y', 3, 'z'],
        geqUserFreq: 'nope', geqGain: {}, geqVolume: NaN, preamp: 'nonsense' }
    ]));
    const j = ev('loadPresetsFromStorage')()[0];
    const junkBad = Object.entries(j).filter(([k, v]) => !SKIP.has(k) && !Number.isFinite(v));
    if (junkBad.length) bad('garbage preset yielded non-finite: ' + JSON.stringify(junkBad));
    else ok('garbage preset fully coerced to finite defaults');
    if (badBand(j.curvePts)) bad('garbage preset produced bad curve points');
    else ok('garbage cannot produce an out-of-range curve point');
    if (j.geqGains.every(Number.isFinite) && j.geqGains[4] === 12 && j.geqGains[5] === -12 &&
        j.geqGains[9] === 3 && j.preamp === 'b7k' && Number.isFinite(j.geqUserFreq))
      ok('garbage EQ bands coerced and clamped to ±12, preamp falls back to b7k');
    else bad('geq garbage gave ' + JSON.stringify({g: j.geqGains, p: j.preamp, f: j.geqUserFreq}));
    if (j.loMidFreq === 1000 && j.hiMidFreq === 3000) ok('out-of-set band frequencies fall back to defaults');
    else bad(`band freqs = ${j.loMidFreq}/${j.hiMidFreq}`);
    if (j.grunt === 1 && j.attack === 1) ok('out-of-range switch positions fall back to centre');
    else bad(`grunt=${j.grunt} attack=${j.attack}`);

    ev('applyPreset')(0);
    const nonFinite = Object.entries(ev('state')).filter(([, v]) => !Number.isFinite(v));
    if (nonFinite.length) bad('state polluted after applyPreset: ' + JSON.stringify(nonFinite));
    else ok('applyPreset left every state field finite');

    // Save / list / delete
    w.localStorage.clear();
    d.getElementById('presetName').value = 'Round trip';
    ev('savePreset')();
    if (ev('loadPresetsFromStorage')().length === 1 &&
        d.getElementById('presetList').innerHTML.includes('Round trip')) ok('save + render round-trips');
    else bad('save did not round-trip');
    ev('deletePreset')(0);
    if (ev('loadPresetsFromStorage')().length === 0) ok('delete works');
    else bad('delete failed');

    // geqGains round-trip — the failure that cost an evening: a curve dialled
    // in, saved, flattened, then recalled must come back.
    w.localStorage.clear();
    ev('setPreamp')('geq');
    const g = ev('geq');
    g.gains[0] = 7.5; g.gains[5] = -9; g.gains[10] = 4;
    g.userFreq = 820; g.gain = 2.5; g.volume = -3;
    d.getElementById('presetName').value = 'Curve';
    ev('savePreset')();
    ev('geqReset')(); g.userFreq = 700; g.gain = 0; g.volume = 0;
    ev('applyPreset')(0);
    const back = ev('geq');
    if (back.gains[0] === 7.5 && back.gains[5] === -9 && back.gains[10] === 4 &&
        back.userFreq === 820 && back.gain === 2.5 && back.volume === -3 &&
        ev('preampKind') === 'geq')
      ok('EQ curve survives save → flat → recall, and the preamp comes back with it');
    else bad('EQ did not round-trip: ' + JSON.stringify({
      g: back.gains, f: back.userFreq, gain: back.gain, vol: back.volume, p: ev('preampKind') }));
    // and the compressor rides along with it
    w.localStorage.clear();
    const cp = ev('comp');
    cp.on = true; cp.threshold = -33; cp.ratio = 7.5; cp.attack = 12; cp.release = 250;
    cp.makeup = 4.5; cp.knee = 9;
    d.getElementById('presetName').value = 'Squashed';
    ev('savePreset')();
    cp.on = false; cp.threshold = -24; cp.ratio = 4; cp.attack = 5;
    cp.release = 120; cp.makeup = 0; cp.knee = 6;
    ev('applyPreset')(0);
    const cb = ev('comp');
    if (cb.on && cb.threshold === -33 && cb.ratio === 7.5 && cb.attack === 12 &&
        cb.release === 250 && cb.makeup === 4.5 && cb.knee === 9)
      ok('compressor survives save → reset → recall');
    else bad('compressor did not round-trip: ' + JSON.stringify(cb));
    cp.on = false;

    ev('setPreamp')('b7k'); w.localStorage.clear();
  } catch (e) { bad('preset test threw: ' + e.stack); }

  console.log('\n[8] analyzer mode swap');
  try {
    ev('setAnalyzerMode')('sg');
    const sgOn = d.getElementById('layerSg').classList.contains('active');
    const fftOff = !d.getElementById('layerFft').classList.contains('active');
    ev('setAnalyzerMode')('fft');
    const back = d.getElementById('layerFft').classList.contains('active') &&
                 !d.getElementById('layerSg').classList.contains('active');
    if (sgOn && fftOff && back) ok('exactly one analyzer layer active in each mode');
    else bad(`sg=${sgOn} fftOff=${fftOff} back=${back}`);
  } catch (e) { bad('setAnalyzerMode threw: ' + e.stack); }

  console.log('\n[9] spectrum enter/exit with no audio must not throw');
  try {
    for (let i = 0; i < 10; i++) { ev('setTab')('spectrum'); ev('setTab')('preamp'); }
    ok('10× spectrum enter/exit cycles clean');
    ev('setTab')('spectrum');
    if (d.getElementById('sxLadder').children.length === 12) ok('12 harmonic chips built');
    else bad('ladder has ' + d.getElementById('sxLadder').children.length + ' chips');
    if (d.getElementById('sxKeys').children.length === 12) ok('12 harmonic key buttons built');
    else bad('keys has ' + d.getElementById('sxKeys').children.length);
    ev("sxMode = 'mute'");
    ev('sxOnChip')({ currentTarget: { dataset: { n: '3' } } });
    if (ev('sxMuted')[3]) ok('H3 mute recorded in JS state');
    else bad('H3 mute not recorded');
    ev('setTab')('preamp'); ev('setTab')('spectrum');
    if (ev('sxMuted')[3]) ok('mute state survives tab exit + re-entry');
    else bad('mute state lost across tab switch');
    ev('sxResetHarmonics')();
    if (Object.keys(ev('sxMuted')).length === 0) ok('reset clears mutes');
    else bad('reset did not clear mutes');
    ev('setTab')('preamp');
  } catch (e) { bad('spectrum test threw: ' + e.stack); }

  console.log('\n[10] toggles that must not throw without audio');
  ['toggleFFT','togglePeakLine','toggleScopePanel','toggleHiss','toggleGate','toggleNotch',
   'toggleInstruments','toggleTheme','toggleTuner','openRef','closeRef','resetPeakHold',
   'togglePeakHold','toggleBypass'].forEach(fn => {
    try { ev(fn)(); } catch (e) { bad(`${fn}() threw: ${e.message}`); }
  });
  ok('14 UI toggles survive being called with no AudioContext');

  console.log('\n[11] clipper curve is asymmetric and bounded');
  try {
    const c = ev('makeClipCurve')(4096);
    const mid = c[2047], midNext = c[2048];
    const pos = c[4095], neg = c[0];
    let mono = true;
    for (let i = 1; i < c.length; i++) if (c[i] < c[i - 1]) { mono = false; break; }
    let finite = c.every(Number.isFinite);
    if (!finite) bad('clip curve has non-finite entries');
    else if (!mono) bad('clip curve is not monotonic — would fold, not clip');
    else if (Math.abs(Math.abs(pos) - Math.abs(neg)) < 0.05) bad(`curve is symmetric (${pos.toFixed(3)} / ${neg.toFixed(3)}) — no even harmonics`);
    else if (Math.abs(pos) > 1 || Math.abs(neg) > 1) bad('curve exceeds ±1');
    else if (Math.abs(mid) > 0.01 || Math.abs(midNext) > 0.01) bad('curve is not near zero at zero input');
    else ok(`monotonic, bounded, asymmetric (+${pos.toFixed(3)} / ${neg.toFixed(3)})`);
  } catch (e) { bad('clipper test threw: ' + e.stack); }

  console.log('\n[12] gain-computing helpers never emit NaN');
  try {
    const probes = [-1, 0, 0.5, 50, 100, 101, NaN, undefined, null, 'x'];
    const badVals = [];
    probes.forEach(v => {
      [['levelGain', ev('levelGain')(v)], ['driveGainOf', ev('driveGainOf')(v)]].forEach(([n, r]) => {
        if (!Number.isFinite(r) && Number.isFinite(parseFloat(v))) badVals.push(`${n}(${v})=${r}`);
      });
      const b = ev('blendGains')(v);
      if (Number.isFinite(parseFloat(v)) && (!Number.isFinite(b.dry) || !Number.isFinite(b.wet)))
        badVals.push(`blendGains(${v})`);
    });
    if (badVals.length) bad('non-finite for valid input: ' + badVals.join(', '));
    else ok('levelGain / driveGainOf / blendGains finite for all numeric input');
    const b0 = ev('blendGains')(0), b100 = ev('blendGains')(100);
    if (Math.abs(b0.dry - 1) < 1e-9 && Math.abs(b0.wet) < 1e-9 &&
        Math.abs(b100.dry) < 1e-9 && Math.abs(b100.wet - 1) < 1e-9) ok('blend endpoints are pure dry / pure wet');
    else bad(`blend endpoints wrong: ${JSON.stringify(b0)} ${JSON.stringify(b100)}`);
    if (Math.abs(ev('levelGain')(100) - 1) < 1e-9) ok('Level at max is unity gain');
    else bad('Level at max is ' + ev('levelGain')(100));
    if (Math.abs(ev('driveGainOf')(0) - 1) < 1e-9) ok('Drive at min is unity gain');
    else bad('Drive at min is ' + ev('driveGainOf')(0));
  } catch (e) { bad('gain helper test threw: ' + e.stack); }


  console.log('\n[14] spectrogram scroll speed');
  try {
    ev('setAnalyzerMode')('sg');
    const btns = [...d.querySelectorAll('#speedSel button')];
    if (btns.length !== 5) bad('expected 5 speed buttons, found ' + btns.length);
    else ok('5 speed buttons present');
    if (d.getElementById('speedRow').style.display !== 'none') ok('speed row shown in spectrogram mode');
    else bad('speed row hidden in spectrogram mode');
    ev('setAnalyzerMode')('fft');
    if (d.getElementById('speedRow').style.display === 'none') ok('speed row hidden in FFT mode');
    else bad('speed row still visible in FFT mode');
    ev('setAnalyzerMode')('sg');

    // Each setting must change the pixel rate monotonically.
    const rates = [];
    for (let i = 0; i < 5; i++) {
      ev('setSgSpeed')(i);
      rates.push(ev('sgPx')() / ev('sgSkip')());
      const active = btns.filter(b => b.classList.contains('active'));
      if (active.length !== 1 || parseInt(active[0].dataset.speed, 10) !== i) bad(`speed ${i}: ${active.length} buttons active`);
    }
    const monotonic = rates.every((r, i) => i === 0 || r > rates[i - 1]);
    if (monotonic) ok('px/frame strictly increases across settings: ' + rates.join(', '));
    else bad('speed settings are not monotonic: ' + rates.join(', '));
    if (rates[2] === 1) ok('default (1x) is one pixel per frame');
    else bad('1x is ' + rates[2] + ' px/frame');

    ev('setSgSpeed')(0);
    if (ev('sgSkip')() === 4 && ev('sgPx')() === 1) ok('slowest setting holds frames rather than shrinking columns');
    else bad('slowest setting is skip=' + ev('sgSkip')() + ' px=' + ev('sgPx')());

    // Persistence
    ev('setSgSpeed')(4);
    if (w.localStorage.getItem('b7k_sg_speed') === '4') ok('speed persisted to localStorage');
    else bad('speed not persisted');
    ev('setSgSpeed')(2);
    ev('setAnalyzerMode')('fft');
  } catch (e) { bad('speed control threw: ' + e.stack); }

  console.log('\n[15] frequency probe');
  try {
    const tip = d.getElementById('freqTooltip');
    // Canvas spans x=0..560; PAD.l=38, PAD.r=18 → plot is 38..542.
    // Midpoint of the log axis: ~632 Hz over 20 Hz–20 kHz, ~447 Hz over
    // 20 Hz–10 kHz. The assertion below only requires that some frequency
    // is reported, so it holds either way.
    ev('setAnalyzerMode')('fft');
    ev('showProbe')(38 + (542 - 38) / 2, 100);
    if (tip.style.display === 'block' && /Hz|kHz/.test(tip.textContent)) ok('FFT probe shows a frequency: "' + tip.textContent + '"');
    else bad('FFT probe produced "' + tip.textContent + '" display=' + tip.style.display);
    const mid = tip.textContent;

    ev('hideProbe')();
    if (tip.style.display === 'none') ok('probe hides');
    else bad('probe did not hide');

    ev('setAnalyzerMode')('sg');
    ev('showProbe')(38 + (542 - 38) / 2, 100);
    if (tip.style.display === 'block' && tip.textContent === mid) ok('spectrogram probe reports the same frequency at the same x — axes agree');
    else bad(`spectrogram probe "${tip.textContent}" != FFT probe "${mid}"`);

    // Out-of-plot x must not report anything
    ev('hideProbe')();
    ev('showProbe')(5, 100);
    if (tip.style.display === 'none') ok('probe ignores x outside the plot area');
    else bad('probe reported "' + tip.textContent + '" outside the plot');

    // Note naming at a known frequency. The x is derived from the page's own
    // axis constants rather than a duplicated span, so this cannot go stale
    // when the range changes -- it asserts that 110 Hz lands on A2, whatever
    // the ceiling is. (It used to divide by a literal 3: three decades above
    // 20 Hz, i.e. a hardcoded 20 kHz.)
    ev('hideProbe')();
    const xFor = f => 38 + Math.log10(f / ev('AX_FMIN')) / ev('AX_DECADES') * (542 - 38);
    ev('showProbe')(xFor(110), 100);
    if (/A2/.test(tip.textContent)) ok('110 Hz probes as A2: "' + tip.textContent + '"');
    else bad('110 Hz probed as "' + tip.textContent + '"');
    ev('hideProbe')();
    ev('setAnalyzerMode')('fft');
  } catch (e) { bad('probe threw: ' + e.stack); }

  console.log('\n[16] detune tab');
  try {
    ev('setTab')('detune');
    const dt = ev('detune');
    if (dt && dt.engaged === false) ok('starts disengaged');
    else bad('detune.engaged = ' + (dt && dt.engaged));

    // Ratio maths
    const cases = [[0, 0, 1], [-12, 0, 0.5], [12, 0, 2], [7, 0, 1.4983], [0, 50, 1.0293]];
    let ratioOk = true;
    cases.forEach(([semis, cents, want]) => {
      dt.semis = semis; dt.cents = cents;
      const r = ev('detuneRatio')();
      if (Math.abs(r - want) > 0.001) { bad(`ratio(${semis}st ${cents}c) = ${r.toFixed(4)}, want ${want}`); ratioOk = false; }
    });
    if (ratioOk) ok('ratio maths correct across 5 cases including cents');
    dt.semis = 0; dt.cents = 0;

    // Presets
    ev('setDetunePreset')(-2);
    if (ev('detune').semis === -2 && ev('detune').cents === 0) ok('preset sets semitones and clears cents');
    else bad('preset gave ' + JSON.stringify(ev('detune')));
    const active = [...d.querySelectorAll('#dtPresets button')].filter(b => b.classList.contains('active'));
    if (active.length === 1 && active[0].dataset.dt === '-2') ok('matching preset button highlighted');
    else bad(active.length + ' preset buttons active');

    // Resulting string pitches: E1 down 2 semitones is D1 (36.71 Hz)
    const strings = [...d.querySelectorAll('#dtStrings .dt-string')];
    if (strings.length === 4) ok('4 open strings shown');
    else bad(strings.length + ' strings shown');
    const first = strings[0].textContent;
    if (/D1/.test(first) && /36\.7/.test(first)) ok('E1 −2 st reads as D1 36.7 Hz');
    else bad('E1 −2 st reads "' + first.replace(/\s+/g, ' ').trim() + '"');

    ev('setDetunePreset')(-12);
    if (/E0/.test(strings[0].textContent) || /E0/.test(d.getElementById('dtStrings').textContent)) ok('octave down reads as E0');
    else bad('octave down gave "' + d.getElementById('dtStrings').textContent.replace(/\s+/g, ' ').trim().slice(0, 60) + '"');

    // Clamping
    ev('setDetunePreset')(99);
    if (ev('detune').semis === 12) ok('out-of-range preset clamps to +12');
    else bad('99 clamped to ' + ev('detune').semis);
    ev('setDetunePreset')(0);

    // Badge only appears when engaged AND away from unity
    const badge = d.getElementById('detuneBadge');
    if (badge.style.display === 'none') ok('no badge while disengaged');
    else bad('badge showing while disengaged');

    // Persistence
    ev('setDetunePreset')(-5);
    const saved = JSON.parse(w.localStorage.getItem('b7k_detune') || '{}');
    if (saved.semis === -5) ok('detune settings persisted');
    else bad('detune not persisted: ' + JSON.stringify(saved));
    ev('setDetunePreset')(0);

    // Engage without audio must fail gracefully, not throw
    ev('toggleDetune')();
    ok('engage without audio handled without throwing');

    // Momentary
    const mom = d.getElementById('dtMom');
    mom.dispatchEvent(new w.Event('pointerdown'));
    const held = mom.classList.contains('held');
    mom.dispatchEvent(new w.Event('pointerup'));
    if (held && !mom.classList.contains('held')) ok('momentary press/release toggles the held state');
    else bad(`momentary held=${held} afterRelease=${mom.classList.contains('held')}`);

    // Response profiles
    const profBtns = [...d.querySelectorAll('#dtProfiles button')];
    if (profBtns.length === 3) ok('3 response profiles offered');
    else bad(profBtns.length + ' profile buttons');
    ev('setDetuneProfile')('tight');
    if (ev('detune').profile === 'tight') ok('profile switch updates state');
    else bad('profile is ' + ev('detune').profile);
    const activeProf = profBtns.filter(b => b.classList.contains('active'));
    if (activeProf.length === 1 && activeProf[0].dataset.prof === 'tight') ok('active profile button highlighted');
    else bad(activeProf.length + ' profile buttons active');
    const sub = d.getElementById('dtProfileSub').textContent;
    if (/55 Hz/.test(sub) && /ms/.test(sub)) ok('profile sub-label states floor and latency: "' + sub + '"');
    else bad('profile sub-label reads "' + sub + '"');
    const savedProf = JSON.parse(w.localStorage.getItem('b7k_detune') || '{}');
    if (savedProf.profile === 'tight') ok('profile persisted');
    else bad('profile not persisted');
    ev('setDetuneProfile')('balanced');

    ev('setTab')('preamp');
  } catch (e) { bad('detune test threw: ' + e.stack); }

  console.log('\n[17] detune reset on audio stop');
  try {
    ev('detune').engaged = true;
    ev('detuneReset')();
    if (ev('detune').engaged === false) ok('detuneReset clears engaged flag');
    else bad('still engaged after reset');
    if (d.getElementById('detuneBadge').style.display === 'none') ok('badge cleared');
    else bad('badge left showing');
  } catch (e) { bad('detuneReset threw: ' + e.stack); }

  console.log('\n[18] skins');
  try {
    const order = ev('SKIN_ORDER');
    const seen = new Map();
    let skinFails = 0;
    order.forEach(skin => ['dark', 'light'].forEach(mode => {
      ev('applyLook')(skin, mode, false);
      const th = ev('TH');
      const keys = Object.keys(th);
      // Drawing code reads TH.* blind, so a missing key paints with whatever
      // was last set on the context rather than throwing.
      if (keys.length !== 24 || keys.some(k => !th[k])) {
        bad(`${skin}/${mode}: ${keys.length} colours, empty: ${keys.filter(k => !th[k])}`); skinFails++;
      } else if (d.documentElement.getAttribute('data-skin') !== skin ||
                 d.documentElement.getAttribute('data-theme') !== mode) {
        bad(`${skin}/${mode}: root attributes not set`); skinFails++;
      } else {
        const sig = JSON.stringify(th);
        if (seen.has(sig)) { bad(`${skin}/${mode} is a copy of ${seen.get(sig)}`); skinFails++; }
        else seen.set(sig, skin + '/' + mode);
      }
    }));
    if (!skinFails) ok(`${order.length} skins x 2 modes = ${seen.size} distinct 24-colour palettes`);

    ev('applyLook')('classic', 'dark', false);
    const labels = [];
    for (let i = 0; i < 5; i++) { labels.push(d.getElementById('skinToggle').textContent); ev('cycleSkin')(); }
    if (labels.join('>') === 'Classic>Aria>Minimal>Lab>Classic') ok('cycleSkin wraps: ' + labels.join(' > '));
    else bad('cycle order is ' + labels.join(' > '));

    ev('setSkin')('lab');
    ev('applyLook')('lab', 'light', true);
    if (w.localStorage.getItem('b7k_skin') === 'lab' && w.localStorage.getItem('b7k_theme') === 'light')
      ok('skin and mode persist under b7k_skin / b7k_theme');
    else bad('persistence wrong');

    // The rest of the app still calls these by their old names.
    const api = ['applyTheme', 'toggleTheme', 'initTheme', 'applyLook', 'setSkin', 'cycleSkin'];
    const missing = api.filter(n => ev('typeof ' + n) !== 'function');
    if (!missing.length) ok('API intact: ' + api.join(', '));
    else bad('missing: ' + missing.join(', '));

    // The band markers must follow the skin, or they vanish on light skins.
    if (/ctx\.strokeStyle = TH\.bandMarker/.test(ev('drawSgOverlay').toString()))
      ok('spectrogram band markers are themed, not hardcoded white');
    else bad('spectrogram band markers are hardcoded — invisible on light skins');

    ev('applyLook')('classic', 'dark', true);
  } catch (e) { bad('skins threw: ' + e.stack); }

  console.log('\n[19] looper');
  try {
    const ids = ['loopBar', 'loopRecBtn', 'loopPlayBtn', 'loopTime', 'loopRecBtn2',
                 'loopPlayBtn2', 'loopTime2', 'loopWave', 'loopMsg', 'loopHost',
                 'loopExportBtn', 'loopWavBtn', 'loopM4aBtn', 'loopLevelVal'];
    const gone = ids.filter(i => !d.getElementById(i));
    if (!gone.length) ok(`${ids.length} looper elements present`);
    else bad('missing: ' + gone.join(', '));

    // Nothing may throw before audio exists — these are the first buttons a
    // curious user presses, and they press them before Enable Audio.
    ev('loopRecToggle')();
    ev('loopToggle')();
    ev('loopExportToggle')();
    ok('transport handled without audio, without throwing');
    if (/Enable audio first/.test(d.getElementById('loopMsg').textContent))
      ok('and says so');
    else bad('no "enable audio" message');

    if (d.getElementById('loopPlayBtn').disabled && d.getElementById('loopPlayBtn2').disabled)
      ok('Loop is disabled until something is recorded');
    else bad('Loop offered with an empty buffer');
    if (d.getElementById('loopWavBtn').disabled && d.getElementById('loopM4aBtn').disabled)
      ok('downloads disabled until something is captured');
    else bad('download offered with no capture');

    ev('loopSetSwitch')('muteLive');
    if (ev('loop').muteLive === false &&
        !d.querySelector('[data-loopsw="muteLive"]').classList.contains('active'))
      ok('switches toggle and repaint');
    else bad('switch did not toggle');
    ev('loopSetSwitch')('muteLive');

    ev('loopSetLevel')(60);
    if (ev('loop').level === 60 && d.getElementById('loopLevelVal').textContent === '60%')
      ok('loop level reads back');
    else bad('level readout wrong: ' + d.getElementById('loopLevelVal').textContent);
    ev('loopSetLevel')(100);

    // The WAV encoder is pure arithmetic, so jsdom can check it properly.
    const wav = ev('loopWav')(new w.Float32Array([0, 1, -1, 0.5]), 48000);
    const dv = new DataView(wav);
    const tag = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (tag === 'RIFF' && dv.byteLength === 44 + 8 && dv.getUint32(24, true) === 48000)
      ok('WAV: RIFF header, 44-byte prologue, rate carried through');
    else bad(`WAV header wrong: ${tag} len ${dv.byteLength} rate ${dv.getUint32(24, true)}`);
    if (dv.getInt16(44 + 2, true) === 32767 && dv.getInt16(44 + 4, true) === -32768)
      ok('WAV: full scale maps to +32767 / -32768 without wrapping');
    else bad(`WAV clipping wrong: ${dv.getInt16(46, true)} / ${dv.getInt16(48, true)}`);

    // The new chunk walkers replace a concatenate-then-slice path. They are
    // pure arithmetic over the chunk list, so jsdom can check the edges
    // properly — off-by-one here would silently clip the start of every take.
    ev('audioCtx = { sampleRate: 48000 }');
    const F = n => w.eval('Float32Array');
    const mk = a => { const f = new (F())(a.length); f.set(a); return f; };

    const chunks = [mk([0,1,2,3,4]), mk([5,6,7,8,9]), mk([10,11,12,13,14])];
    const dest = new (F())(6);
    ev('loopCopyRange')(chunks, 4, 10, dest);
    if ([...dest].join(',') === '4,5,6,7,8,9') ok('loopCopyRange spans chunk boundaries exactly');
    else bad('loopCopyRange gave ' + [...dest].join(','));

    const d2 = new (F())(3);
    ev('loopCopyRange')(chunks, 0, 3, d2);
    if ([...d2].join(',') === '0,1,2') ok('loopCopyRange handles a range inside one chunk');
    else bad('loopCopyRange gave ' + [...d2].join(','));

    // 1000 silent, 1000 loud, 1000 silent — in 3 chunks. Pad is 10 ms = 480.
    const sil = () => mk(new Array(1000).fill(0));
    const loud = () => mk(new Array(1000).fill(0.5));
    const b = ev('loopTrimChunks')([sil(), loud(), sil()], 3000);
    if (b[0] === 1000 - 480 && b[1] === 2000 + 480)
      ok(`loopTrimChunks found the signal at ${b[0]}..${b[1]} (1000..2000 plus 10 ms padding)`);
    else bad('loopTrimChunks gave ' + b.join('..') + ', expected 520..2480');

    const allSil = ev('loopTrimChunks')([sil(), sil()], 2000);
    if (allSil[0] === 0 && allSil[1] === 2000) ok('a silent take is not trimmed to nothing');
    else bad('silent take trimmed to ' + allSil.join('..'));

    const fmt = ev('loopFmtSec');
    const times = [[45.2,'45.20 s'],[59.999,'1:00'],[187,'3:07'],[300,'5:00'],[1200,'20:00']];
    const wrongT = times.filter(([v,e]) => fmt(v) !== e);
    if (!wrongT.length) ok('times read 45.20 s, 3:07, 5:00, 20:00');
    else bad('bad formatting: ' + JSON.stringify(wrongT.map(([v]) => [v, fmt(v)])));

    // jsdom answers (pointer: coarse) false, so it is the desktop ceiling.
    if (ev('loopMaxSec')() === 1200) ok('desktop gets the 20-minute ceiling');
    else bad('loopMaxSec is ' + ev('loopMaxSec')());
    if (ev('LOOP_MAX_PHONE_SEC') === 300) ok('phones get 5 minutes (~55 MB of audio)');
    else bad('phone cap is ' + ev('LOOP_MAX_PHONE_SEC'));
    ev('audioCtx = null');

    ev('loopReset')();
    ok('loopReset survives a context that never existed');
  } catch (e) { bad('looper threw: ' + e.stack); }

  console.log('\n[20] EQ on the chart');
  try {
    ev('setPreamp')('b7k');
    ['low','loMid','hiMid','treble'].forEach(k => ev('setParam')(k, 0));
    ev('setParam')('loMidFreq', 1000); ev('setParam')('hiMidFreq', 3000);

    const b = ev('eqBands')();
    if (b.length === 4 && b.map(x => x.id).join(',') === 'low,loMid,hiMid,treble')
      ok('B7K offers its four post-blend bands');
    else bad('B7K bands are ' + b.map(x => x.id).join(','));
    if (!b.some(x => /grunt|attack/i.test(x.id)))
      ok('Grunt and Attack stay off the curve — wet-path only, and ahead of a clipper');
    else bad('a pre-clipper band leaked onto the curve');

    // THE drift guard. The curve claims to be what the audio does; prove it
    // by reading the frequencies and types straight out of applyAudioParams.
    const src = ev('applyAudioParams').toString();
    const grab = node => {
      const t = new RegExp(node + "\\.type = '([a-z]+)'").exec(src);
      const f = new RegExp(node + "\\.frequency\\.value = ([^;]+);").exec(src);
      const q = new RegExp(node + "\\.Q\\.value = ([^;]+);").exec(src);
      return { type: t && t[1], freq: f && ev(f[1].trim()), q: q ? ev(q[1].trim()) : null };
    };
    const pairs = [['low','filterLow'],['loMid','filterLoMid'],['hiMid','filterHiMid'],['treble','filterTreble']];
    let drift = 0;
    pairs.forEach(([id, node]) => {
      const want = grab(node), got = b.find(x => x.id === id);
      if (want.type === got.type && want.freq === got.freq && (want.q || null) === (got.q || null)) return;
      bad(`${id}: curve draws ${got.type} ${got.freq}Hz Q${got.q}, audio runs ${want.type} ${want.freq}Hz Q${want.q}`);
      drift++;
    });
    if (!drift) ok('all four bands draw the same filter the audio actually runs');

    // A shelf gives half its gain at its own corner, so the grip is moved to
    // where the band actually acts — measured in Chromium at +12: Low 11.61 dB
    // at 40 Hz (97% of 12), Treble 11.11 at 9 kHz (93%). At the corners both
    // read 6.00, and the dot would crawl at half the cursor's speed.
    const lowB = b.find(x => x.id === 'low'), trebB = b.find(x => x.id === 'treble');
    if (lowB.hx === 40 && lowB.freq === 100 && trebB.hx === 9000 && trebB.freq === 5000)
      ok('shelf grips sit where the shelf is developed, not on the corner');
    else bad(`shelf grips at low ${lowB.hx}, treble ${trebB.hx}`);
    if (b.filter(x => x.type === 'peaking').every(x => !x.hx))
      ok('peaking bands keep their grip on the centre frequency');
    else bad('a peaking band moved its grip off centre');

    ev('setPreamp')('geq');
    const g = ev('eqBands')();
    if (g.length === ev('GEQ_N')) ok(`graphic EQ offers all ${g.length} bands`);
    else bad(`graphic EQ gave ${g.length} bands, expected ${ev('GEQ_N')}`);
    if (!g[0].sweep && g[g.length-1].sweep && g[g.length-1].sweep.range)
      ok('only the 11th band sweeps; the fixed ten do not');
    else bad('sweepable bands are wrong');
    ev('setPreamp')('b7k');
    if (ev('eqBands')()[1].sweep.steps.join('/') === '500/1000')
      ok('B7K Lo-Mid is a two-position switch, as on the pedal — a drag flips it');
    else bad('B7K Lo-Mid sweep is not the 500/1k switch');

    // snapping, on the log axis
    const near = ev('eqNearestStep');
    const snaps = [[520,500],[690,500],[730,1000],[1400,1000]];
    const wrong = snaps.filter(([hz, want]) => near(hz, [500,1000]) !== want);
    if (!wrong.length) ok('520→500, 690→500, 730→1k, 1400→1k — the midpoint sits at 707 Hz');
    else bad('snapped wrong: ' + JSON.stringify(wrong.map(x => [x[0], near(x[0],[500,1000])])));

    // geometry round trip
    const geo = ev('eqGeom')(200);
    const rt = [-12,-3,0,4.5,12].filter(d => Math.abs(geo.dbOf(geo.yOf(d)) - d) > 1e-9);
    if (!rt.length) ok('dB→y→dB is exact across the range');
    else bad('geometry does not round-trip at ' + rt.join(', '));

    // hit-testing
    const hs = [{id:'low',x:100,y:100,ch:200},{id:'treble',x:400,y:100,ch:200}];
    const hit = ev('eqHitBand');
    if (hit(103,104,hs) && hit(103,104,hs).id === 'low') ok('a click near a dot grabs that band');
    else bad('near miss did not hit');
    if (hit(250,100,hs) === null) ok('a click on empty chart grabs nothing — the probe still gets it');
    else bad('empty space grabbed a band');

    // NOTE: the gain solver calls getFrequencyResponse, which jsdom does not
    // implement — every response reads 0, so no gain can be solved for here.
    // The value assertions live in the Chromium run instead; what is checked
    // below is the plumbing that does not need filter maths.
    ev('setParam')('low', 0);
    const cv = d.getElementById('fftCanvas');
    const mk = (type, x, y) => { const e = new w.Event(type, {bubbles:true});
      e.pointerType='mouse'; e.pointerId=1; e.clientX=x; e.clientY=y;
      e.preventDefault=()=>{}; return e; };
    // A grab anywhere in the plot must start a drag — no dot required.
    w.eval('eqGeo = { ch: 300, cw: 480 }');
    const started = ev('eqDragStart')(cv, mk('pointerdown', 260, 150));
    if (started && ev('eqDrag') && ev('eqDrag').f > 0)
      ok(`a grab on empty curve at ${Math.round(ev('eqDrag').f)} Hz starts a drag — no dot needed`);
    else bad('grabbing the curve away from a dot did not start a drag');
    if (ev('eqDrag') && typeof ev('eqDrag').base === 'number' && ev('eqDrag').moved === false)
      ok('the grab records where the curve was, and waits for real movement');
    else bad('drag state is missing base/moved');
    ev('eqDragEnd')(cv, mk('pointerup', 260, 150));
    if (ev('eqDrag') === null) ok('mouseup releases it');
    else bad('drag never ended');

    // A click that never moves must not nudge the EQ.
    ev('setParam')('low', 0);
    ev('eqDragStart')(cv, mk('pointerdown', 200, 150));
    ev('eqDragMove')(cv, mk('pointermove', 200, 151));      // 1 px, under the slop
    ev('eqDragEnd')(cv, mk('pointerup', 200, 151));
    if (ev('state').low === 0) ok('a 1 px twitch is a click, not an edit');
    else bad('a stray click moved Low to ' + ev('state').low);

    // Width: Alt+drag is plumbed straight through to setQ.
    const bands = ev('eqBands')();
    const mid = bands.find(x => x.id === 'loMid');
    if (mid.setQ) {
      mid.setQ(9);
      if (Math.abs(ev('state').loMidQ - 9) < 1e-9) ok('Alt-drag target: loMid Q set to 9');
      else bad('loMidQ is ' + ev('state').loMidQ);
      mid.setQ(999);
      if (ev('state').loMidQ === 18) ok('Q clamps at 18 — a notch, not a dirac');
      else bad('Q clamp gave ' + ev('state').loMidQ);
      mid.setQ(0.01);
      if (ev('state').loMidQ === 0.5) ok('and at 0.5 going the other way');
      else bad('Q floor gave ' + ev('state').loMidQ);
      ev('setParam')('loMidQ', 2.2);
    } else bad('loMid has no setQ');

    // Shelves genuinely cannot be narrowed: Web Audio ignores Q on them.
    if (!bands.find(x => x.id === 'low').setQ && !bands.find(x => x.id === 'treble').setQ)
      ok('the two shelves offer no width, because a shelf has none');
    else bad('a shelf claims to have a width');

    ev('setPreamp')('geq');
    const gb = ev('eqBands')();
    if (gb.every(x => x.setQ)) ok('all eleven graphic EQ bands have their own width');
    else bad('a graphic EQ band is missing setQ');
    ev('geqSetQ')(3, 12);
    if (Math.abs(ev('geq').qs[3] - 12) < 1e-9) ok('geqSetQ writes the band it was given');
    else bad('geq.qs[3] is ' + ev('geq').qs[3]);
    ev('geqSetQ')(3, ev('GEQ_Q'));
    ev('setPreamp')('b7k');

    // Everything above called the drag functions directly. Dispatch a real
    // event sequence instead, so the wiring inside wireProbe is what is being
    // tested — a bad patch there would pass every check above.
    w.eval('eqGeo = { ch: 300, cw: 480 }');
    cv.dispatchEvent(mk('pointerdown', 240, 150));
    const live = ev('eqDrag');
    cv.dispatchEvent(mk('pointerup', 240, 150));
    if (live && ev('eqDrag') === null)
      ok('a real pointerdown/up on the canvas drives the drag through the real listeners');
    else bad('the event path did not reach eqDragStart');

    // and it cannot start from a finger
    ev('eqHandles').push({ id:'low', x:100, y:150, ch:300, sweep:false });
    const touch = mk('pointerdown',100,150); touch.pointerType = 'touch';
    if (ev('eqDragStart')(cv, touch) === false)
      ok('a finger on the same spot does not grab — it scrolls the page');
    else bad('touch started a drag');

    // eqClampDb is what stops a drag running off the top; check it directly,
    // since the drag that calls it needs filter maths jsdom does not have.
    const cl = ev('eqClampDb');
    if (cl(99) === 12 && cl(-99) === -12 && cl(3.5) === 3.5)
      ok('gains clamp to ±12 dB');
    else bad('clamp gave ' + [cl(99), cl(-99), cl(3.5)].join(', '));
    ev('setParam')('low', 0);
  } catch (e) { bad('EQ drag threw: ' + e.stack); }

  console.log('\n[21] curve EQ');
  try {
    ev('setPreamp')('curve');
    if (ev('preampKind') === 'curve') ok('the third preamp selects');
    else bad('preampKind is ' + ev('preampKind'));
    const shown = id => d.getElementById(id) && d.getElementById(id).style.display !== 'none';
    if (shown('preampCurve') && !shown('preampGeq') && !shown('preampB7k'))
      ok('its panel shows and the other two hide');
    else bad('panel visibility wrong');

    ev('curveClear')();
    const pts = () => ev('curveEq').pts;
    if (pts().length === 2 && pts().every(p => p.anchor)) ok('starts as two end anchors, nothing else');
    else bad('starts with ' + JSON.stringify(pts()));
    const at = ev('curveAt');
    if ([20, 100, 1000, 10000].every(f => Math.abs(at(f)) < 1e-9)) ok('and draws a flat line');
    else bad('flat is not flat');

    // no bands at all — the band machinery must not apply here
    if (ev('eqBands')().length === 0) ok('there are no bands in curve mode');
    else bad('eqBands returned ' + ev('eqBands')().length);

    // a point is exactly where you put it
    ev('curveAddPoint')(505, -9);
    if (Math.abs(at(505) - (-9)) < 1e-6) ok('a point at 505 Hz reads -9.0 dB there — the exact frequency, not a grid slot');
    else bad('curve at 505 is ' + at(505));
    if (Math.abs(at(100.5) - at(100.5)) < 1e-9 && Number.isFinite(at(100.5))) ok('and 100.5 Hz is an ordinary frequency');

    // THE property that makes a drawn curve trustworthy: between two points
    // the line stays between their values. A plain cubic spline overshoots,
    // which would put a bump in the response that you did not draw.
    ev('curveClear')();
    ev('curveAddPoint')(100, 0);
    ev('curveAddPoint')(200, -12);
    ev('curveAddPoint')(400, 0);
    let lo = 99, hi = -99;
    for (let f = 100; f <= 400; f *= 1.005) { const v = at(f); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (lo >= -12.001 && hi <= 0.001)
      ok(`between the points the curve stays within [${lo.toFixed(2)}, ${hi.toFixed(2)}] — it cannot overshoot`);
    else bad(`overshoot: [${lo.toFixed(2)}, ${hi.toFixed(2)}] outside [-12, 0]`);

    // monotone segments stay monotone
    ev('curveClear')();
    ev('curveAddPoint')(100, 0); ev('curveAddPoint')(1000, 10);
    let mono = true, prev = -99;
    for (let f = 100; f <= 1000; f *= 1.01) { const v = at(f); if (v < prev - 1e-9) mono = false; prev = v; }
    if (mono) ok('a rising segment rises the whole way — no dips on the way up');
    else bad('a monotone segment was not monotone');

    // anchors are structural
    ev('curveClear')();
    const anch = pts()[0];
    if (ev('curveRemovePoint')(anch) === false && pts().length === 2) ok('an end anchor cannot be removed');
    else bad('an anchor was removed');
    ev('curveMovePoint')(anch, 5000, 6);
    if (anch.f === 20 && Math.abs(anch.db - 6) < 1e-9) ok('an anchor moves in dB but not in frequency');
    else bad(`anchor went to ${anch.f} Hz / ${anch.db} dB`);

    const p2 = ev('curveAddPoint')(700, 3);
    if (ev('curveRemovePoint')(p2) && pts().length === 2) ok('an added point can be removed');
    else bad('point removal failed');

    // clamps and repair
    ev('curveClear')();
    const cp = ev('curveAddPoint')(99999, 999);
    if (cp.f === 10000 && cp.db === 18) ok('points clamp to the chart and to ±18 dB');
    else bad('clamps gave ' + JSON.stringify(cp));
    const rebuilt = ev('curveNormalise')([{ f: 500, db: 3 }]);
    if (rebuilt.length === 3 && rebuilt[0].anchor && rebuilt[2].anchor)
      ok('a stored drawing missing its anchors gets them back');
    else bad('normalise gave ' + JSON.stringify(rebuilt));

    // The drive stage now appears on all three preamps. One state, three
    // sets of controls — a copy that does not follow the others is worse
    // than no copy at all.
    // The B7K drives Blend from a knob, the other two from faders, so the
    // count is two faders plus one knob — not three of either.
    const nBlend = d.querySelectorAll('input[data-bind="blend"]').length;
    const nKnob  = d.querySelectorAll('[data-knob="blend"]').length;
    const nGrunt = d.querySelectorAll('[data-sw="grunt"]').length;
    if (nBlend === 2 && nKnob === 1) ok('Blend appears three times: two faders and the B7K knob');
    else bad(`${nBlend} faders + ${nKnob} knobs — the curve is missing its drive section`);
    if (nGrunt >= 3) ok(`${nGrunt} Grunt switches`);
    else bad('only ' + nGrunt + ' Grunt switches');

    ev('setParam')('blend', 42);
    const vals = [...d.querySelectorAll('input[data-bind="blend"]')].map(e => parseFloat(e.value));
    if (vals.every(v => v === 42)) ok('setting Blend moves every copy — three faces of one state');
    else bad('copies disagree: ' + vals.join(', '));
    const labels = [...d.querySelectorAll('[data-val="blend"]')].map(e => e.textContent);
    if (labels.every(t => t === labels[0])) ok('and every readout agrees: ' + labels[0]);
    else bad('readouts disagree: ' + labels.join(' / '));

    // Level does nothing at Blend 0; every card should say so, not just one.
    ev('setParam')('blend', 0);
    const cards = [...d.querySelectorAll('#cardLevel, .card-level')];
    if (cards.length >= 3 && cards.every(c => c.classList.contains('dimmed')))
      ok(`all ${cards.length} Level cards dim when Blend is fully clean`);
    else bad(`${cards.filter(c=>c.classList.contains('dimmed')).length} of ${cards.length} dimmed`);
    ev('setParam')('blend', 50);
    if (cards.every(c => !c.classList.contains('dimmed'))) ok('and undim together');
    else bad('a card stayed dimmed');
    ev('setParam')('blend', 0);

    ev('curveClear')();
    ev('setPreamp')('b7k');
  } catch (e) { bad('curve EQ threw: ' + e.stack); }

  console.log('\n[13] no late errors');
  if (errors.length) bad('errors accumulated:\n      ' + errors.join('\n      '));
  else ok('clean throughout');

  console.log('\n' + (fails ? `${fails} FAILURE(S)` : 'ALL SMOKE CHECKS PASSED'));
  process.exit(fails ? 1 : 0);
}, 700);
