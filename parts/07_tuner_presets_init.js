// ═══════════════════════════════════════════════════════════
// CHROMATIC TUNER — McLeod Pitch Method (normalised square difference)
// Unchanged from v2. Robust against the octave / harmonic-locking errors
// plain autocorrelation suffers when a fundamental is weak and overtones
// dominate: it picks the FIRST strong NSDF peak, not the tallest.
// ═══════════════════════════════════════════════════════════
const TUNER_MIN_FREQ = 27.5;
const TUNER_MAX_FREQ = 2000;
const MPM_K = 0.9;
const MPM_CLARITY = 0.5;
let tunerLast = 0, tunerSmoothHz = 0, tunerMissCount = 0, tunerRaf = null;

function detectPitch(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.005) return -1;

  const maxTau = Math.min(Math.floor(sampleRate / TUNER_MIN_FREQ), Math.floor(SIZE / 2));
  const minTau = Math.floor(sampleRate / TUNER_MAX_FREQ);

  const nsdf = new Float32Array(maxTau + 1);
  for (let tau = 0; tau <= maxTau; tau++) {
    let r = 0, m = 0;
    for (let i = 0; i < SIZE - tau; i++) {
      r += buf[i] * buf[i + tau];
      m += buf[i] * buf[i] + buf[i + tau] * buf[i + tau];
    }
    nsdf[tau] = m > 0 ? 2 * r / m : 0;
  }

  const peaks = [];
  let pos = 1;
  while (pos < maxTau && nsdf[pos] > 0)  pos++;
  while (pos < maxTau && nsdf[pos] <= 0) pos++;
  let curMax = 0;
  while (pos < maxTau) {
    if (nsdf[pos] > nsdf[pos - 1] && nsdf[pos] >= nsdf[pos + 1]) {
      if (curMax === 0 || nsdf[pos] > nsdf[curMax]) curMax = pos;
    }
    pos++;
    if (pos < maxTau && nsdf[pos] < 0) {
      if (curMax > 0) { peaks.push(curMax); curMax = 0; }
      while (pos < maxTau && nsdf[pos] <= 0) pos++;
    }
  }
  if (curMax > 0) peaks.push(curMax);
  if (!peaks.length) return -1;

  let highest = 0;
  for (const p of peaks) if (nsdf[p] > highest) highest = nsdf[p];
  if (highest < MPM_CLARITY) return -1;

  const thr = MPM_K * highest;
  let chosen = -1;
  for (const p of peaks) { if (nsdf[p] >= thr && p >= minTau) { chosen = p; break; } }
  if (chosen < 0) for (const p of peaks) { if (nsdf[p] >= thr) { chosen = p; break; } }
  if (chosen <= 0) return -1;

  const x1 = nsdf[chosen - 1], x2 = nsdf[chosen], x3 = nsdf[chosen + 1];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  let tau = chosen;
  if (a) tau = chosen - b / (2 * a);
  return sampleRate / tau;
}

const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
const NOTE_NAMES_ASCII = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

function freqToNote(freq) {
  const midi = 12 * Math.log2(freq / 440) + 69;
  const rounded = Math.round(midi);
  return {
    name: NOTE_NAMES[((rounded % 12) + 12) % 12],
    octave: Math.floor(rounded / 12) - 1,
    cents: Math.round((midi - rounded) * 100),
    ascii: NOTE_NAMES_ASCII[((rounded % 12) + 12) % 12] + (Math.floor(rounded / 12) - 1)
  };
}

function toggleTuner() {
  if (!audioRunning || !tunerAnalyser) {
    document.getElementById('tunerStatus').textContent = 'Enable audio on the Preamp tab first';
    return;
  }
  tunerOn = !tunerOn;
  document.getElementById('tunerToggle').classList.toggle('active', tunerOn);
  document.getElementById('tunerDisplay').classList.toggle('on', tunerOn);
  if (tunerOn) {
    document.getElementById('tunerStatus').innerHTML = '<em>Listening…</em> play one note at a time';
    tunerSmoothHz = 0; tunerMissCount = 0;
    startTunerLoop();
  } else {
    stopTuner();
    document.getElementById('tunerStatus').textContent = 'Chromatic tuner — enable audio on the Preamp tab, then activate';
  }
}

function stopTuner() {
  tunerOn = false;
  if (tunerRaf) { cancelAnimationFrame(tunerRaf); tunerRaf = null; }
  const btn = document.getElementById('tunerToggle');
  if (btn) btn.classList.remove('active');
  const disp = document.getElementById('tunerDisplay');
  if (disp) disp.classList.remove('on');
}

function startTunerLoop() {
  if (tunerRaf) cancelAnimationFrame(tunerRaf);
  function loop(ts) {
    if (!tunerOn || !tunerAnalyser) return;
    tunerRaf = requestAnimationFrame(loop);
    if (ts - tunerLast < 60) return;       // throttle to ~16 fps
    tunerLast = ts;
    tunerAnalyser.getFloatTimeDomainData(tunerBuf);
    updateTunerDisplay(detectPitch(tunerBuf, audioCtx.sampleRate));
  }
  tunerRaf = requestAnimationFrame(loop);
}

function updateTunerDisplay(hz) {
  const noteEl  = document.getElementById('tunerNote');
  const centsEl = document.getElementById('tunerCents');
  const arrowEl = document.getElementById('tunerArrow');
  const needle  = document.getElementById('tunerNeedle');
  const hzEl    = document.getElementById('tunerHz');

  if (hz < 0 || !isFinite(hz) || hz < TUNER_MIN_FREQ || hz > TUNER_MAX_FREQ) {
    if (++tunerMissCount > 8) {
      noteEl.innerHTML = '–'; noteEl.className = 'tuner-note';
      centsEl.textContent = '—'; arrowEl.textContent = '';
      hzEl.textContent = '—';
      needle.style.left = '50%'; needle.classList.remove('in-tune');
      document.querySelectorAll('.string-chip').forEach(c => c.classList.remove('hit'));
    }
    return;
  }
  tunerMissCount = 0;
  tunerSmoothHz = tunerSmoothHz ? tunerSmoothHz * 0.6 + hz * 0.4 : hz;

  const { name, octave, cents, ascii } = freqToNote(tunerSmoothHz);
  const absC = Math.abs(cents);
  noteEl.innerHTML = name + '<span class="tuner-octave">' + octave + '</span>';
  noteEl.className = 'tuner-note ' + (absC <= 5 ? 'in-tune' : (cents < 0 ? 'flat-of' : 'sharp-of'));
  centsEl.textContent = (cents > 0 ? '+' : '') + cents + '¢';
  arrowEl.textContent = absC <= 5 ? '✓ in tune' : (cents < 0 ? '♭ flat' : '♯ sharp');
  needle.style.left = Math.max(0, Math.min(100, 50 + cents)) + '%';
  needle.classList.toggle('in-tune', absC <= 5);
  hzEl.textContent = tunerSmoothHz.toFixed(1) + ' Hz';

  document.querySelectorAll('.string-chip').forEach(c => {
    c.classList.toggle('hit', c.dataset.string === ascii);
  });
}

// ═══════════════════════════════════════════════════════════
// PRESETS — v2 schema
//   { name, low, loMid, loMidFreq, hiMid, hiMidFreq, treble,
//     blend, level, drive, grunt, attack }
//
// v1 dropped `tone` and `pickup` and had no drive section. v1 presets
// migrate with the drive section neutral — which is the tone they were
// captured at anyway.
//
// Undefined fields written into gain nodes produce NaN and silently kill
// audio, so EVERY field is guarded and clamped on read, not just on migrate.
// ═══════════════════════════════════════════════════════════
const PRESET_KEY    = 'b7k_presets_v2';
const PRESET_KEY_V1 = 'b7k_presets_v1';
const LOMID_FREQS = [500, 1000];
const HIMID_FREQS = [1500, 3000];

function pnum(v, dflt, min, max) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
function ppick(v, dflt, allowed) {
  const n = parseInt(v, 10);
  return allowed.indexOf(n) >= 0 ? n : dflt;
}

function normalizePreset(p) {
  const o = (p && typeof p === 'object') ? p : {};
  return {
    name:      (typeof o.name === 'string' && o.name.trim()) ? o.name.trim().slice(0, 24) : 'Preset',
    low:       pnum(o.low,    0, -12, 12),
    loMid:     pnum(o.loMid,  0, -12, 12),
    hiMid:     pnum(o.hiMid,  0, -12, 12),
    treble:    pnum(o.treble, 0, -12, 12),
    loMidFreq: ppick(o.loMidFreq, 1000, LOMID_FREQS),
    hiMidFreq: ppick(o.hiMidFreq, 3000, HIMID_FREQS),
    blend:     pnum(o.blend,   0, 0, 100),
    level:     pnum(o.level, 100, 0, 100),
    drive:     pnum(o.drive,   0, 0, 100),
    grunt:     ppick(o.grunt,  1, [0, 1, 2]),
    attack:    ppick(o.attack, 1, [0, 1, 2])
  };
}

function savePresetsToStorage(presets) {
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); } catch (e) {}
}

function loadPresetsFromStorage() {
  let raw = null;
  try { raw = localStorage.getItem(PRESET_KEY); } catch (e) {}

  if (raw === null || raw === undefined) {
    // No v2 store yet — migrate v1 if there is one. v1 is left in place.
    let v1 = null;
    try { v1 = JSON.parse(localStorage.getItem(PRESET_KEY_V1) || 'null'); } catch (e) {}
    if (Array.isArray(v1) && v1.length) {
      const migrated = v1.map(normalizePreset);
      savePresetsToStorage(migrated);
      console.log('[Presets] migrated', migrated.length, 'preset(s) from v1 → v2');
      return migrated;
    }
    return [];
  }

  let arr = [];
  try { arr = JSON.parse(raw || '[]'); } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  return arr.map(normalizePreset);   // guard on every read, not just on migrate
}

function savePreset() {
  const nameEl = document.getElementById('presetName');
  const presets = loadPresetsFromStorage();
  const name = nameEl.value.trim() || 'Preset ' + (presets.length + 1);
  presets.push(normalizePreset({
    name,
    low: state.low, loMid: state.loMid, loMidFreq: state.loMidFreq,
    hiMid: state.hiMid, hiMidFreq: state.hiMidFreq, treble: state.treble,
    blend: state.blend, level: state.level, drive: state.drive,
    grunt: state.grunt, attack: state.attack
  }));
  savePresetsToStorage(presets);
  nameEl.value = '';
  renderPresetList();
}

function applyPreset(idx) {
  const p = loadPresetsFromStorage()[idx];
  if (!p) return;
  ['low','loMid','loMidFreq','hiMid','hiMidFreq','treble',
   'blend','level','drive','grunt','attack'].forEach(k => { state[k] = p[k]; });
  syncUI();
  render();
}

function deletePreset(idx) {
  const presets = loadPresetsFromStorage();
  presets.splice(idx, 1);
  savePresetsToStorage(presets);
  renderPresetList();
}

function renderPresetList() {
  const list = document.getElementById('presetList');
  const presets = loadPresetsFromStorage();
  if (!presets.length) {
    list.innerHTML = '<span class="preset-empty">No presets yet — dial in a sound and save it.</span>';
    return;
  }
  list.innerHTML = presets.map((p, i) => `
    <div class="preset-chip">
      <button class="preset-load" onclick="applyPreset(${i})">${escapeHtml(p.name)}</button>
      <button class="preset-del"  onclick="deletePreset(${i})" title="Delete">✕</button>
    </div>`).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ═══════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}

initTheme();
wireControls();
wirePedalPanel();
wireWah();
wireTrim('inTrimKnob',  'inTrimVal');
wireTrim('outTrimKnob', 'outTrimVal');
wireNoiseParam('hissFreqKnob',   'hissFreq',   'hissFreqVal',   v => (v / 1000).toFixed(1) + ' kHz');
wireNoiseParam('gateThreshKnob', 'gateThresh', 'gateThreshVal', v => v + ' dB');
wireNoiseParam('notchFreqKnob',  'notchFreq',  'notchFreqVal',  kHz);
wireNoiseParam('notchQKnob',     'notchQ',     'notchQVal',     v => v.toFixed(1));

document.getElementById('presetName').addEventListener('keydown', e => {
  if (e.key === 'Enter') savePreset();
});

initSgSpeed();
wireProbe();
loadDetune();
wireDetune();
renderDetune();

syncUI();
render();
stopScope();
renderPresetList();
sizeIsland();
initStickyAnalyzer();
bootDone = true;

let resizeTimer = null;
window.addEventListener('resize', () => {
  sizeIsland();
  reserveAnalyzerHeight();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    redrawStatic();
    if (scopeOpen && !audioRunning) stopScope();
    if (document.getElementById('refModal').classList.contains('open')) drawRefChart();
  }, 120);
});

// Pre-populate the device list without holding the mic open. Labels stay
// hidden until the first permission grant, which is fine.
navigator.mediaDevices.enumerateDevices().then(devices => {
  const inputs = devices.filter(d => d.kind === 'audioinput');
  const sel = document.getElementById('deviceSelect');
  fillDeviceOptions(inputs, sel);
  preferSavedDevice(inputs, sel);
  if (inputs.length) document.getElementById('deviceRow').style.display = '';
}).catch(() => {});

console.log('[Bass Analyzer] v3 ready' + (LITE ? ' · LITE mode' : ''));
