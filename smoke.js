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
  url: 'https://localhost/bass_mix_interactive.html',
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
    window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
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
  // Two `low` sliders exist: Preamp full grid and Mix compact strip.
  const lows = [...d.querySelectorAll('input[data-bind="low"]')];
  if (lows.length < 2) bad(`expected ≥2 twinned "low" sliders, found ${lows.length}`);
  else {
    lows[0].value = '6';
    lows[0].dispatchEvent(new w.Event('input', { bubbles: true }));
    if (ev('state.low') !== 6) bad('state.low did not follow the Preamp slider');
    else if (parseFloat(lows[1].value) !== 6) bad('Mix twin did not follow (got ' + lows[1].value + ')');
    else {
      const labels = [...d.querySelectorAll('[data-val="low"]')].map(e => e.textContent);
      if (labels.every(t => t === '+6.0 dB')) ok(`twin sliders + ${labels.length} labels all synced`);
      else bad('value labels out of sync: ' + JSON.stringify(labels));
    }
    lows[0].value = '0'; lows[0].dispatchEvent(new w.Event('input', { bubbles: true }));
  }

  console.log('\n[5] Level dims when Blend = 0');
  ev('setParam')('blend', 0);
  const card = d.getElementById('cardLevel');
  const lvl = d.querySelector('input[data-bind="level"]');
  if (card.classList.contains('dimmed') && lvl.disabled) ok('Level dimmed and disabled at blend 0');
  else bad(`blend 0 → dimmed=${card.classList.contains('dimmed')} disabled=${lvl.disabled}`);
  ev('setParam')('blend', 50);
  if (!card.classList.contains('dimmed') && !lvl.disabled) ok('Level re-enabled once Blend > 0');
  else bad('Level still dimmed at blend 50');
  ev('setParam')('blend', 0);

  console.log('\n[6] 3-position switches');
  const fatBtn = d.querySelector('button[data-set="grunt"][data-v="2"]');
  fatBtn.dispatchEvent(new w.Event('click', { bubbles: true }));
  // onclick attribute handlers need an explicit call in jsdom event flow
  ev('setSwitch')(fatBtn);
  if (ev('state.grunt') === 2 && fatBtn.classList.contains('active') &&
      d.querySelector('[data-val="grunt"]').textContent === 'Fat') ok('Grunt → Fat sets state, button and label');
  else bad(`grunt=${ev('state.grunt')} label=${d.querySelector('[data-val="grunt"]').textContent}`);
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
    const bad0 = Object.entries(p).filter(([k, v]) => k !== 'name' && !Number.isFinite(v));
    if (bad0.length) bad('migrated preset has non-finite fields: ' + JSON.stringify(bad0));
    else ok('v1 → v2 migration produced only finite numbers');
    if ('tone' in p || 'pickup' in p) bad('tone/pickup survived migration');
    else ok('tone and pickup dropped');
    if (p.blend === 0 && p.level === 100 && p.drive === 0 && p.grunt === 1 && p.attack === 1)
      ok('drive section defaulted neutral (blend 0, level unity, drive min, Raw, Flat)');
    else bad('drive defaults wrong: ' + JSON.stringify(p));
    if (!w.localStorage.getItem('b7k_presets_v2')) bad('v2 store not written on migrate');
    else ok('v2 store written');

    // Deliberately hostile: hand-edited garbage must not reach a gain node.
    w.localStorage.setItem('b7k_presets_v2', JSON.stringify([
      { name: 'Junk', low: 'x', loMid: null, treble: undefined, blend: NaN,
        level: 'unity', drive: {}, grunt: 9, attack: -3, loMidFreq: 777, hiMidFreq: 'abc' }
    ]));
    const j = ev('loadPresetsFromStorage')()[0];
    const junkBad = Object.entries(j).filter(([k, v]) => k !== 'name' && !Number.isFinite(v));
    if (junkBad.length) bad('garbage preset yielded non-finite: ' + JSON.stringify(junkBad));
    else ok('garbage preset fully coerced to finite defaults');
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

  console.log('\n[13] no late errors');
  if (errors.length) bad('errors accumulated:\n      ' + errors.join('\n      '));
  else ok('clean throughout');

  console.log('\n' + (fails ? `${fails} FAILURE(S)` : 'ALL SMOKE CHECKS PASSED'));
  process.exit(fails ? 1 : 0);
}, 700);
