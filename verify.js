// Static verification for bass_mix_interactive.html — spec §"Static"
// Usage: node verify.js <path-to-html>
const fs = require('fs');
const file = process.argv[2];
const html = fs.readFileSync(file, 'utf8');

const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.error('FAIL: no <script> block found'); process.exit(1); }
const js = m[1];
const wsola = (html.match(/<script id="wsolaSrc"[^>]*>([\s\S]*?)<\/script>/) || [])[1] || '';
// Strip the inert worklet block before scanning markup, or its source shows up
// as if it were page content.
const markupRaw = html.slice(0, html.indexOf('<script>'));
const markup = markupRaw.replace(/<script id="wsolaSrc"[\s\S]*?<\/script>/, '');

let fails = 0;
const ok  = s => console.log('  ok   ' + s);
const bad = s => { console.log('  FAIL ' + s); fails++; };

// ── 1. syntax (node --check is run separately, but re-assert parseability) ──
try { new (require('vm').Script)(js); ok('main script parses'); }
catch (e) { bad('main script parse error: ' + e.message); }
if (!wsola) bad('worklet source block missing');
else {
  try { new (require('vm').Script)(wsola); ok('worklet source parses (it is inert text, so nothing else checks it)'); }
  catch (e) { bad('worklet parse error: ' + e.message); }
}

// ── 2. every getElementById target exists in the markup ──
console.log('\n[2] getElementById targets');
const ids = new Set();
for (const mm of markupRaw.matchAll(/\bid\s*=\s*"([^"]+)"/g)) ids.add(mm[1]);
const wanted = new Set();
for (const mm of js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) wanted.add(mm[1]);
for (const mm of js.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) wanted.add(mm[1]);
// dynamic id built by concatenation — check the expansions explicitly
const TAB_NAMES = ['preamp','tuner','spectrum','detune','mix'];
const dynamic = [
  ...TAB_NAMES.map(t => 'panel-' + t),
  ...TAB_NAMES.map(t => 'tab-' + t),
  ...['In','Out','Both'].map(s => 'scopeBtn' + s)
];
dynamic.forEach(d => wanted.add(d));
// remove the concatenation stubs themselves
['panel-','tab-','scopeBtn'].forEach(s => wanted.delete(s));
let missing = [...wanted].filter(id => !ids.has(id));
if (missing.length) bad('missing ids: ' + missing.join(', '));
else ok(`${wanted.size} referenced ids all present`);

// ── 3. every inline onclick / onchange / onmouse* handler is defined ──
console.log('\n[3] inline handlers');
const handlers = new Set();
for (const mm of markup.matchAll(/\bon(?:click|change|mousemove|mouseleave|input)\s*=\s*"([a-zA-Z_$][\w$]*)\s*\(/g)) {
  handlers.add(mm[1]);
}
const undef = [...handlers].filter(fn =>
  !new RegExp(`\\bfunction\\s+${fn}\\s*\\(`).test(js) &&
  !new RegExp(`\\b(?:const|let|var)\\s+${fn}\\s*=`).test(js));
if (undef.length) bad('handlers not defined: ' + undef.join(', '));
else ok(`${handlers.size} inline handlers all defined: ${[...handlers].sort().join(', ')}`);

// ── 4. bracket balance (string/comment aware) ──
console.log('\n[4] bracket balance');
(function () {
  let par = 0, brace = 0, brack = 0;
  let i = 0, inS = null, inTmpl = 0, inLine = false, inBlock = false, inRe = false;
  let prevSig = '';
  while (i < js.length) {
    const c = js[i], n = js[i + 1];
    if (inLine) { if (c === '\n') inLine = false; i++; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } i++; continue; }
    if (inS) {
      if (c === '\\') { i += 2; continue; }
      if (c === inS) inS = null;
      i++; continue;
    }
    if (inTmpl > 0) {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { inTmpl--; i++; continue; }
      if (c === '$' && n === '{') { brace++; i += 2; continue; }
      if (c === '}' && brace > 0) { brace--; i++; continue; }
      i++; continue;
    }
    if (c === '/' && n === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
    if (c === '"' || c === "'") { inS = c; i++; continue; }
    if (c === '`') { inTmpl++; i++; continue; }
    if (c === '/' && /[=(,:[!&|?{};+\-*%~^]/.test(prevSig)) {   // regex literal
      i++;
      while (i < js.length) {
        if (js[i] === '\\') { i += 2; continue; }
        if (js[i] === '[') { while (i < js.length && js[i] !== ']') { if (js[i] === '\\') i++; i++; } }
        if (js[i] === '/') { i++; break; }
        if (js[i] === '\n') break;
        i++;
      }
      while (i < js.length && /[gimsuy]/.test(js[i])) i++;
      continue;
    }
    if (c === '(') par++; else if (c === ')') par--;
    else if (c === '{') brace++; else if (c === '}') brace--;
    else if (c === '[') brack++; else if (c === ']') brack--;
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  if (par === 0 && brace === 0 && brack === 0) ok('() {} [] all balanced');
  else bad(`unbalanced — parens ${par}, braces ${brace}, brackets ${brack}`);
})();

// ── 5. removed identifiers must be gone everywhere ──
console.log('\n[5] removed identifiers');
const forbidden = ['toneKnob', 'pickupKnob', 'filterTone', 'state.tone', 'state.pickup',
                   'updateTone', 'updatePickup', 'toneRolloffdB', 'toneVal', 'pickupVal',
                   'mainChart', 'setLoMidFreq', 'setHiMidFreq'];
forbidden.forEach(t => {
  const re = new RegExp(t.replace('.', '\\.'), 'g');
  const hits = (html.match(re) || []).length;
  if (hits) bad(`"${t}" still referenced ${hits}×`);
});
if (!forbidden.some(t => new RegExp(t.replace('.', '\\.')).test(html))) ok('no stale references');

// ── 6. state keys referenced in HTML data-bind/data-val/data-set exist ──
console.log('\n[6] data-bind / data-val / data-set keys');
const stateMatch = js.match(/const state = \{([\s\S]*?)\n\};/);
const stateKeys = new Set();
if (stateMatch) for (const mm of stateMatch[1].matchAll(/([a-zA-Z]\w*)\s*:/g)) stateKeys.add(mm[1]);
const boundKeys = new Set();
for (const mm of markup.matchAll(/data-(?:bind|val|set)\s*=\s*"([^"]+)"/g)) boundKeys.add(mm[1]);
const strayKeys = [...boundKeys].filter(k => !stateKeys.has(k));
if (strayKeys.length) bad('bound to non-existent state keys: ' + strayKeys.join(', '));
else ok(`${boundKeys.size} bound keys all in state: ${[...boundKeys].sort().join(', ')}`);

// ── 7. every data-bind key has a VAL_FMT formatter ──
console.log('\n[7] value formatters');
const fmtBlock = js.match(/const VAL_FMT = \{([\s\S]*?)\n\};/);
const fmtKeys = new Set();
if (fmtBlock) for (const mm of fmtBlock[1].matchAll(/(?:^|[\s,{])([a-zA-Z]\w*)\s*:/g)) fmtKeys.add(mm[1]);
const valKeys = new Set();
for (const mm of markup.matchAll(/data-val\s*=\s*"([^"]+)"/g)) valKeys.add(mm[1]);
const noFmt = [...valKeys].filter(k => !fmtKeys.has(k));
if (noFmt.length) bad('data-val with no formatter: ' + noFmt.join(', '));
else ok(`${valKeys.size} data-val keys all have formatters`);

// ── 8. drive-section wiring sanity ──
console.log('\n[8] drive topology');
const wiringChecks = [
  ['dry leg from input',        /inGainNode\.connect\(dryGainNode\)/],
  ['dry leg into sum',          /dryGainNode\.connect\(sumBus\)/],
  ['wet: grunt first',          /inGainNode\.connect\(gruntFilter\)/],
  ['wet: grunt → attack',       /gruntFilter\.connect\(attackFilter\)/],
  ['wet: attack → drive',       /attackFilter\.connect\(driveGainNode\)/],
  ['wet: drive → clipper',      /driveGainNode\.connect\(clipperNode\)/],
  ['wet: clipper → level',      /clipperNode\.connect\(levelGainNode\)/],
  ['wet: level → blend → sum',  /levelGainNode\.connect\(wetBlendNode\)[\s\S]{0,60}wetBlendNode\.connect\(sumBus\)/],
  ['EQ is post-blend',          /sumBus\.connect\(filterLow\)/],
  ['spectrum splice point',     /gateGainNode\.connect\(outGainNode\)/],
];
wiringChecks.forEach(([label, re]) => re.test(js) ? ok(label) : bad(label));

// ── 9. preset schema ──
console.log('\n[9] presets');
if (/b7k_presets_v2/.test(js)) ok('v2 key present'); else bad('v2 key missing');
if (/b7k_presets_v1/.test(js)) ok('v1 key referenced for migration'); else bad('no v1 migration path');
['blend','level','drive','grunt','attack'].forEach(k => {
  new RegExp(`${k}:\\s*p(?:num|pick)\\(`).test(js) ? ok(`${k} guarded in normalizePreset`) : bad(`${k} not guarded`);
});

// ── 10. five tabs are wired end to end ──
console.log('\n[10] tabs');
const tabsDecl = (js.match(/const TABS = \[([^\]]*)\]/) || [])[1] || '';
const declared = tabsDecl.split(',').map(s2 => s2.trim().replace(/['"]/g, '')).filter(Boolean);
if (declared.join(',') === TAB_NAMES.join(',')) ok('TABS matches the five panels: ' + declared.join(', '));
else bad(`TABS is [${declared}], markup has [${TAB_NAMES}]`);
TAB_NAMES.forEach(t => {
  if (!new RegExp(`setTab\\('${t}'\\)`).test(markup)) bad(`no island button calls setTab('${t}')`);
});
if (TAB_NAMES.every(t => new RegExp(`setTab\\('${t}'\\)`).test(markup))) ok('every tab has an island button');
if (/repeat\(5, 1fr\)/.test(html)) ok('island grid is five columns');
else bad('island grid is not five columns — buttons would wrap');

// ── 11. worklet contract matches the app ──
console.log('\n[11] worklet contract');
const regName = (wsola.match(/registerProcessor\(\s*'([^']+)'/) || [])[1];
const nodeName = (js.match(/new AudioWorkletNode\([^,]+,\s*'([^']+)'/) || [])[1];
if (regName && regName === nodeName) ok(`processor name agrees on both sides ("${regName}")`);
else bad(`registerProcessor('${regName}') vs AudioWorkletNode('${nodeName}')`);
['ratio', 'mix'].forEach(p2 => {
  const declared2 = new RegExp(`name:\\s*'${p2}'`).test(wsola);
  const used = new RegExp(`parameters\\.get\\('${p2}'\\)`).test(js);
  if (declared2 && used) ok(`AudioParam "${p2}" declared and used`);
  else bad(`AudioParam "${p2}": declared=${declared2} used=${used}`);
});
if (/URL\.createObjectURL\(new Blob/.test(js)) ok('worklet loaded from a Blob — single-file constraint holds');
else bad('worklet is not loaded from a Blob');
if (/type="text\/x-worklet"/.test(html)) ok('worklet block is inert to the HTML parser');
else bad('worklet block would be parsed as page script');

// The search span must cover a full period of the lowest note, or shifts get
// quantised away. This is the bug the DSP test caught; pin it down.
// Each profile's search span must cover a period of its own stated floor.
const profBlock = (wsola.match(/var WSOLA_PROFILES = \{([\s\S]*?)\n\};/) || [])[1] || '';
const profs = [...profBlock.matchAll(/(\w+):\s*\{[^}]*seekMs:\s*([\d.]+)[^}]*floorHz:\s*(\d+)/g)];
if (!profs.length) bad('no response profiles found');
profs.forEach(([, name, seek, floor]) => {
  const span = parseFloat(seek) * 2, needed = 1000 / parseInt(floor, 10);
  if (span >= needed - 0.5) ok(`${name}: ±${seek} ms span covers its ${floor} Hz floor (needs ${needed.toFixed(1)} ms)`);
  else bad(`${name}: ±${seek} ms span cannot cover ${floor} Hz (needs ${needed.toFixed(1)} ms) — shifts will quantise away`);
});
if (/BUF = 512/.test(js)) ok('ScriptProcessor buffer is 512 (10.7 ms), not 4096');
else bad('ScriptProcessor buffer is not 512 — block latency will dominate');
if (/dtLoadedVia === 'ScriptProcessor'/.test(js) && /Math\.max\(ms, DRAW_MS_SCRIPTPROC\)/.test(js))
  ok('analyzer throttled while the ScriptProcessor host is live, and it wins over the mobile cap');
else bad('no analyzer throttle — the small buffer will crackle');
// The mobile cap is a separate concern with a separate failure mode: without
// it a phone redraws 8192 bins every frame.
if (/DRAW_MS_MOBILE = 1000 \/ 30/.test(js) && /pointer: coarse/.test(js))
  ok('analyzer capped at 30 fps on touch devices');
else bad('no mobile draw cap — a phone will redraw every frame over 8192 bins');
// The readout has to measure draws, not rAF callbacks, or it reports 60 fps
// while drawing at 30 and is useless for sizing the Pi build.
if (/if \(minMs && frameLastT && t0 - frameLastT < minMs\) return;/.test(js) &&
    js.indexOf('frameDeltaMs = frameDeltaMs') > js.indexOf('if (minMs && frameLastT'))
  ok('frame readout measures draw-to-draw, not rAF-to-rAF');
else bad('frame readout still measures the rAF rate — it will not show the throttle');
if (/scan\(-SEEK, SEEK, 4\)/.test(wsola)) ok('search range is symmetric');
else bad('search range is not symmetric — offsets cannot wrap and will lock at a boundary');

// ── 12. spectrogram speed + probe ──
console.log('\n[12] spectrogram controls');
const speedBtns = (markup.match(/data-speed="\d+"/g) || []).length;
const speedDefs = (js.match(/const SG_SPEEDS = \[([\s\S]*?)\];/) || [])[1] || '';
const speedCount = (speedDefs.match(/label:/g) || []).length;
if (speedBtns && speedBtns === speedCount) ok(`${speedBtns} speed buttons match ${speedCount} speed definitions`);
else bad(`${speedBtns} speed buttons vs ${speedCount} definitions`);
if (/function sgSkip/.test(js) && /sgSkipCount < sgSkip\(\)/.test(js)) ok('sub-1x speeds hold frames rather than dropping data');
else bad('frame-skip path missing');
if (/id="sgCrosshair"/.test(markup)) ok('spectrogram has its own probe canvas');
else bad('no sgCrosshair canvas');
['fftCanvas', 'sgCrosshair'].forEach(id => {
  if (new RegExp(`'${id}'`).test(js)) ok(`${id} wired into the probe`);
  else bad(`${id} not wired into the probe`);
});
if (/pointerdown/.test(js) && /pointerup/.test(js)) ok('probe uses pointer events (mouse, pen and touch)');
else bad('probe is mouse-only');

// ── 13. worklet delivery: sibling file, blob fallback, SW cache ──
console.log('\n[13] worklet delivery');
const path = require('path');
const dir = path.dirname(file);
const siblingPath = path.join(dir, 'wsola-worklet.js');
if (!fs.existsSync(siblingPath)) {
  bad('wsola-worklet.js is missing — the primary load path will always fall back to the blob');
} else {
  ok('wsola-worklet.js present');
  const sibling = fs.readFileSync(siblingPath, 'utf8');
  // Split on the explicit header marker. A "strip leading comments" regex
  // also eats the worklet's own banner comment and reports false drift.
  const MARK = '//@@GENERATED-HEADER-END\n';
  const body = sibling.includes(MARK) ? sibling.slice(sibling.indexOf(MARK) + MARK.length) : sibling;
  if (body.trim() === wsola.trim()) ok('sibling file and inline block are identical — no drift');
  else bad(`sibling file has drifted from the inline block (${body.trim().length} vs ${wsola.trim().length} bytes)`);
  try { new (require('vm').Script)(sibling); ok('sibling file parses'); }
  catch (e) { bad('sibling file parse error: ' + e.message); }

  // The core exists in three places. All three must be the same text, or the
  // two hosts quietly diverge and only one of them is the tested algorithm.
  const grabCore = t => {
    const i = t.indexOf('function createWsolaCore');
    if (i < 0) return null;
    const j = t.indexOf('// @@WSOLA-CORE-END', i);
    return j < 0 ? null : t.slice(i, j).trim();
  };
  const cPage = grabCore(js), cInline = grabCore(wsola), cFile = grabCore(sibling);
  if (cPage && cInline && cFile && cPage === cInline && cPage === cFile)
    ok('WSOLA core identical in page script, inline block and sibling file');
  else bad(`core copies differ — page ${cPage && cPage.length}, inline ${cInline && cInline.length}, file ${cFile && cFile.length}`);
}
if (/addModule\('wsola-worklet\.js'\)/.test(js)) ok('sibling file tried first');
else bad('app does not try the sibling file');
if (/addModule\(dtModuleUrl\)/.test(js)) ok('blob kept as fallback');
else bad('no blob fallback');
// isSecureContext is TRUE on file:// in Chrome, so it cannot be the guard.
if (/location\.protocol === 'file:'/.test(js)) ok('file:// detected by protocol, not by isSecureContext');
else bad('file:// detection missing or relying on isSecureContext (which is true on file://)');
if (!/!window\.isSecureContext/.test(js)) ok('isSecureContext not used as a worklet guard');
else bad('isSecureContext used as a guard — it is true on file:// and will mislead');

// ── standalone operation: there must be a host that needs no server ──
console.log('\n[14] runs without a server');
if (/createScriptProcessor\(/.test(js)) ok('ScriptProcessor fallback host present');
else bad('no fallback host — the app cannot work from file://');
if (/createWsolaCore\(audioCtx\.sampleRate,\s*WSOLA_PROFILES/.test(js)) ok('fallback runs the same WSOLA core with the selected profile');
else bad('fallback does not reuse createWsolaCore');
if (/function createWsolaCore/.test(js)) ok('core is compiled into the page script');
else bad('core missing from the page script — fallback would throw');
const coreInPage = (js.match(/function createWsolaCore/g) || []).length;
if (coreInPage === 1) ok('exactly one copy of the core in the page script');
else bad(coreInPage + ' copies of createWsolaCore in the page script');
if (/kind: 'AudioWorklet'/.test(js) && /kind: 'ScriptProcessor'/.test(js)) ok('active host is named for the UI');
else bad('host kind not reported');
// The cushion is what makes the large-block fallback accurate; pin it.
if (/n \* ratio > OUT/.test(js)) ok('jitter cushion sized from the block length');
else bad('no jitter cushion — large-block hosts will zero-fill and detune inaccurately');

const swPath = path.join(dir, 'sw.js');
if (fs.existsSync(swPath)) {
  const sw = fs.readFileSync(swPath, 'utf8');
  if (/wsola-worklet\.js/.test(sw)) ok('service worker caches the worklet');
  else bad('service worker does not cache wsola-worklet.js — offline detune would fail');
  if (/req\.mode === 'navigate'/.test(sw)) ok('SW app-shell fallback restricted to navigations');
  else bad("SW returns the HTML shell for ANY failed request — a missing .js then fails as 'unable to load module'");
}

// ── 15. frequency axis is defined once, in named constants ──
// The span used to be encoded as Math.log10(1000) ("three decades above
// 20 Hz") with no ceiling literal anywhere in the mapping, so changing the
// 20000 literals alone clipped the data while leaving the axis 20 kHz wide.
// Both patterns are now build failures. Comments are stripped first so the
// commentary explaining this does not trip it.
console.log('\n[15] frequency axis');
(() => {
  const code = js
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"\\])\/\/.*$/gm, '$1');

  const fmax = (code.match(/const AX_FMAX\s*=\s*(\d+)/) || [])[1];
  const fmin = (code.match(/const AX_FMIN\s*=\s*(\d+)/) || [])[1];
  if (!fmin || !fmax) return bad('AX_FMIN / AX_FMAX not defined — axis range is not centralised');
  ok(`axis constants defined: ${fmin} Hz – ${fmax} Hz`);
  if (fmax !== '10000') bad(`AX_FMAX is ${fmax}, expected 10000 (handoff §5)`);
  if (!/const AX_DECADES\s*=\s*Math\.log10\(AX_FMAX \/ AX_FMIN\)/.test(code))
    bad('AX_DECADES not derived from AX_FMIN/AX_FMAX');

  const hardSpan = (code.match(/Math\.log10\(1000\)/g) || []).length;
  if (hardSpan) bad(`${hardSpan}× bare Math.log10(1000) — that is a hardcoded 20 kHz span`);
  else ok('no hardcoded decade span');

  // Every surviving 20000 must be the filterHiss cutoff, which is a filter
  // parameter and not axis code.
  const stray = code.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /\b20000\b/.test(l) && !/filterHiss/.test(l));
  if (stray.length) bad('20000 outside the hiss filter at line(s) ' + stray.map(x => x[0]).join(', '));
  else ok('the only 20000 literals are the hiss filter cutoff');

  const mapped = (code.match(/Math\.log10\(f \/ AX_FMIN\) \/ AX_DECADES/g) || []).length;
  if (mapped === 2) ok('both x-axis mappings derive from the constants');
  else bad(`${mapped} axis mappings use AX_DECADES, expected 2 (drawAxes + spectrogram overlay)`);

  if (/AX_FMIN \* Math\.pow\(AX_FMAX \/ AX_FMIN, t\)/.test(code)) ok('crosshair inverse matches the forward map');
  else bad('chartXtoFreq does not invert the AX_ mapping — probe will report the wrong frequency');

  const labels = (code.match(/const LABEL_FREQS = \[([^\]]+)\]/) || [])[1];
  if (labels) {
    const top = Math.max(...labels.split(',').map(n => parseInt(n, 10)));
    if (String(top) === fmax) ok(`highest axis label (${top}) matches the ceiling`);
    else bad(`highest axis label is ${top} but the ceiling is ${fmax}`);
  } else bad('LABEL_FREQS not found');
})();

// ── 16. the sticky analyzer must not eat vertical scroll ──
// The probe canvases were touch-action: none, which is fine while the chart
// scrolls away and fatal once it is pinned under the thumb: Chromium delivers
// touchmove with cancelable=false and the page simply will not scroll.
console.log('\n[16] probe does not block scrolling');
(() => {
  const css = markupRaw.match(/<style>([\s\S]*?)<\/style>/g) || [];
  const all = css.join('\n');
  const bad = /#(fftCanvas|sgCrosshair)[^}]*touch-action:\s*none/.test(all);
  if (bad) bad('probe canvas is touch-action: none — a swipe starting on the analyzer will not scroll');
  else ok('probe canvases allow vertical panning');
  if (/#fftCanvas[^}]*touch-action:\s*pan-y/.test(all)) ok('fftCanvas is pan-y');
  else bad('fftCanvas has no pan-y rule');
  // Seven 52px knobs mid-page: touch-action: none on them freezes the
  // whole page whenever a thumb crosses one while scrolling.
  if (/\.knob \{[^}]*touch-action:\s*none/.test(all))
    bad('knobs are touch-action: none — a thumb crossing one blocks scrolling');
  else if (/\.knob \{[^}]*touch-action:\s*pan-y/.test(all)) ok('knobs allow vertical panning');
  else bad('knobs have no touch-action rule');
  if (/TOUCH_PX_PER_STEP/.test(js) && /if \(dy >= dx\) \{ dropTouch\(\); return; \}/.test(js))
    ok('knob touch yields to a vertical gesture');
  else bad('knob claims every touch gesture — vertical drags will be swallowed');
  if (/PROBE_SLOP/.test(js) && /if \(dy >= dx\) \{ release\(\); return; \}/.test(js))
    ok('touch probe yields to a vertical gesture');
  else bad('probe claims every touch gesture — vertical drags will be swallowed');
})();

console.log('\n' + (fails ? `${fails} FAILURE(S)` : 'ALL STATIC CHECKS PASSED'));
process.exit(fails ? 1 : 0);
