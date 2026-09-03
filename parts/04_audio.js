// ═══════════════════════════════════════════════════════════
// WEB AUDIO ENGINE
//
// Signal chain (B7K v2 topology, from the Darkgas manual):
//
//   in ─┬───────────────── dry, unity gain ─────────────────┐
//       └─ Grunt(LF) → Attack(HF) → Drive → clipper → Level ┤
//                                                            ▼ sum
//                                   → Low → LoMid → HiMid → Treble → out
//
//   · Level scales the WET path only. It is not a master volume.
//   · Grunt and Attack are pre-clipper and never touch the dry path.
//   · EQ is post-blend, on the summed signal.
// ═══════════════════════════════════════════════════════════

let audioCtx = null;
let micStream = null;
let sourceNode = null;
let inGainNode = null;
let outGainNode = null;

// Drive section
let dryGainNode = null;      // equal-power dry leg (cos)
let wetBlendNode = null;     // equal-power wet leg (sin)
let levelGainNode = null;    // wet-only Level
let driveGainNode = null;    // pre-clipper gain
let gruntFilter = null;      // lowshelf, pre-clipper
let attackFilter = null;     // highshelf, pre-clipper
let clipperNode = null;      // asymmetric soft clip
let sumBus = null;           // dry + wet

// Preamp bus. Everything that can feed the preamp lands on preampIn, and the
// two optional blocks each own their own edge downstream of it, so one
// splicing can never disturb the other:
//
//   inGain ─→ liveGain ─┐
//                       ├→ preampIn ─[detune]→ dtOut ─[comp]→ compOut ─→ dry/wet
//   loopGain ───────────┘
//
// Gain nodes are pure multiplies, so the two spare hops cost zero samples.
let preampIn = null;         // live + loop mix point
let dtOut = null;            // detune splices between preampIn and here

// EQ + cleanup
let filterLow = null, filterLoMid = null, filterHiMid = null, filterTreble = null;
let filterHiss = null, filterNotch = null, gateGainNode = null;

// Analysis
let inAnalyser = null, outAnalyser = null, inBuf = null, outBuf = null;
let fftAnalyser = null, fftBuf = null, fftByteBuf = null;
let tunerAnalyser = null, tunerBuf = null;

let audioRunning = false;
let bypassed = false;
let fftEnabled = false;

// Peak hold
let peakHoldBuf = null, peakHoldAge = null, peakHoldFrozen = false;
let showInstruments = true;
let showPeakHoldLine = true;
const PEAK_HOLD_FRAMES = 90;
const PEAK_DECAY_RATE = 0.4;

// Noise tools
let hissOn = false, notchOn = false, gateOn = false, gateOpen = true;
const noiseState = { hissFreq: 4000, notchFreq: 3000, notchQ: 8, gateThresh: -50 };

// Tuner
let tunerOn = false;

const num = (v, d) => Number.isFinite(v) ? v : d;

// ── Asymmetric soft clipper ────────────────────────────────
// Different curve above and below zero, which is what produces even
// harmonics. Confidence in this specific shape is low (~40%) — the real
// pedal's curve is not published. Behaviour is right; tone is not a match.
function makeClipCurve(n) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    c[i] = x >= 0 ? Math.tanh(1.7 * x) : 0.78 * Math.tanh(2.6 * x);
  }
  return c;
}

// ── Latency readout ────────────────────────────────────────
// baseLatency and outputLatency are specified in SECONDS. A four-digit
// millisecond result therefore means a browser is reporting something
// else -- most likely already-milliseconds. Rather than guess the unit,
// show the raw values untouched and clamp + flag the derived figure.
const LAT_MAX_MS = 500;
function latencyLine() {
  if (!audioCtx) return '';
  const bl = audioCtx.baseLatency;
  const ol = audioCtx.outputLatency;
  const sr = audioCtx.sampleRate;
  if (!Number.isFinite(bl) && !Number.isFinite(ol)) return '';
  const ms = ((Number.isFinite(bl) ? bl : 0) + (Number.isFinite(ol) ? ol : 0)) * 1000;
  const over = ms > LAT_MAX_MS;
  const shown = over ? LAT_MAX_MS : Math.round(ms);
  const fmt = v => Number.isFinite(v) ? String(Number(v.toPrecision(4))) : 'n/a';
  const diag = `base ${fmt(bl)} · out ${fmt(ol)} · sr ${sr}`;
  return ` · Latency: ${over ? '&gt;' : '~'}${shown} ms`
       + `<small class="lat-raw">${diag}</small>`;
}

// ── Parameter setter. Never touches connections; the graph is wired
//    once in startAudio() and stays wired. ──────────────────
function applyAudioParams() {
  if (!audioCtx || !sourceNode) return;
  const t = audioCtx.currentTime;
  const S = 0.02;
  const byp = bypassed;

  const inTrim = num(parseFloat(document.getElementById('inTrimKnob').value), 0);
  inGainNode.gain.setTargetAtTime(Math.pow(10, inTrim / 20), t, 0.01);

  // ── Drive section ──
  const blend = byp ? 0 : num(state.blend, 0);
  const bg = blendGains(blend);
  dryGainNode.gain.setTargetAtTime(num(bg.dry, 1), t, S);
  wetBlendNode.gain.setTargetAtTime(num(bg.wet, 0), t, S);
  levelGainNode.gain.setTargetAtTime(byp ? 1 : num(levelGain(num(state.level, 100)), 1), t, S);
  driveGainNode.gain.setTargetAtTime(byp ? 1 : num(driveGainOf(num(state.drive, 0)), 1), t, S);

  gruntFilter.type = 'lowshelf';
  gruntFilter.frequency.value = 120;
  gruntFilter.gain.setTargetAtTime(byp ? 0 : num(GRUNT_DB[state.grunt], 0), t, S);

  attackFilter.type = 'highshelf';
  attackFilter.frequency.value = 3000;
  attackFilter.gain.setTargetAtTime(byp ? 0 : num(ATTACK_DB[state.attack], 0), t, S);

  // ── EQ, post-blend ──
  filterLow.type = 'lowshelf';
  filterLow.frequency.value = 100;
  filterLow.gain.setTargetAtTime(byp ? 0 : num(state.low, 0), t, S);

  filterLoMid.type = 'peaking';
  filterLoMid.frequency.value = num(state.loMidFreq, 1000);
  filterLoMid.Q.value = num(state.loMidQ, 2.2);
  filterLoMid.gain.setTargetAtTime(byp ? 0 : num(state.loMid, 0), t, S);

  filterHiMid.type = 'peaking';
  filterHiMid.frequency.value = num(state.hiMidFreq, 3000);
  filterHiMid.Q.value = num(state.hiMidQ, 2.2);
  filterHiMid.gain.setTargetAtTime(byp ? 0 : num(state.hiMid, 0), t, S);

  filterTreble.type = 'highshelf';
  filterTreble.frequency.value = 5000;
  filterTreble.gain.setTargetAtTime(byp ? 0 : num(state.treble, 0), t, S);

  // ── Cleanup ──
  filterHiss.type = 'lowpass';
  filterHiss.frequency.setTargetAtTime((hissOn && !byp) ? num(noiseState.hissFreq, 20000) : 20000, t, S);
  filterHiss.Q.value = 0.707;

  filterNotch.type = 'peaking';
  filterNotch.frequency.setTargetAtTime(num(noiseState.notchFreq, 3000), t, S);
  filterNotch.Q.value = num(noiseState.notchQ, 8);
  filterNotch.gain.setTargetAtTime((notchOn && !byp) ? -30 : 0, t, S);

  const outTrim = num(parseFloat(document.getElementById('outTrimKnob').value), 0);
  outGainNode.gain.setTargetAtTime(Math.pow(10, outTrim / 20), t, 0.01);
}

// ── Remembered input device ────────────────────────────────
const INPUT_KEY = 'b7k_input_device';
function saveInputChoice(deviceId, label) {
  try { localStorage.setItem(INPUT_KEY, JSON.stringify({ deviceId, label })); } catch (e) {}
}
function loadInputChoice() {
  try { return JSON.parse(localStorage.getItem(INPUT_KEY) || 'null'); } catch (e) { return null; }
}
function preferSavedDevice(inputs, sel) {
  const saved = loadInputChoice();
  if (!saved) return;
  let match = inputs.find(d => d.deviceId === saved.deviceId);
  if (!match && saved.label) match = inputs.find(d => d.label && d.label === saved.label);
  if (match) sel.value = match.deviceId;
}
function fillDeviceOptions(inputs, sel) {
  sel.innerHTML = '<option value="">Default input</option>';
  inputs.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || 'Microphone ' + (i + 1);
    sel.appendChild(opt);
  });
}
async function populateDevices() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach(t => t.stop());
  } catch (e) {}
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(d => d.kind === 'audioinput');
  const sel = document.getElementById('deviceSelect');
  fillDeviceOptions(inputs, sel);
  preferSavedDevice(inputs, sel);
  document.getElementById('deviceRow').style.display = '';
}

// ── Start ──────────────────────────────────────────────────
async function startAudio() {
  try {
    document.getElementById('audioStatus').textContent = 'Requesting mic access...';
    await populateDevices();
    const deviceId = document.getElementById('deviceSelect').value;

    const audioConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1
    };
    if (deviceId) audioConstraints.deviceId = { exact: deviceId };

    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch (e) {
      if ((e.name === 'OverconstrainedError' || e.name === 'NotFoundError') && audioConstraints.deviceId) {
        delete audioConstraints.deviceId;
        micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      } else { throw e; }
    }

    const track = micStream.getAudioTracks()[0];
    saveInputChoice(track.getSettings().deviceId || deviceId, track.label);

    // Do NOT force sampleRate — forcing 48000 against a 44100 stream silently
    // breaks MediaStreamSource on Chrome/Mac (connects but passes no audio).
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    sourceNode    = audioCtx.createMediaStreamSource(micStream);
    inGainNode    = audioCtx.createGain();
    outGainNode   = audioCtx.createGain();

    // Drive section
    dryGainNode   = audioCtx.createGain();
    wetBlendNode  = audioCtx.createGain();
    levelGainNode = audioCtx.createGain();
    driveGainNode = audioCtx.createGain();
    gruntFilter   = audioCtx.createBiquadFilter();
    attackFilter  = audioCtx.createBiquadFilter();
    clipperNode   = audioCtx.createWaveShaper();
    clipperNode.curve = makeClipCurve(4096);
    clipperNode.oversample = LITE ? 'none' : '4x';
    sumBus        = audioCtx.createGain();
    sumBus.gain.value = 1;

    // EQ + cleanup
    filterLow    = audioCtx.createBiquadFilter();
    filterLoMid  = audioCtx.createBiquadFilter();
    filterHiMid  = audioCtx.createBiquadFilter();
    filterTreble = audioCtx.createBiquadFilter();
    filterHiss   = audioCtx.createBiquadFilter();
    filterNotch  = audioCtx.createBiquadFilter();
    gateGainNode = audioCtx.createGain();
    gateGainNode.gain.value = 1;

    // Tuner analyser — pre-EQ so nothing downstream can skew pitch.
    // 8192 samples (~170 ms @48k) ≈ 5 periods of low B (31 Hz).
    tunerAnalyser = audioCtx.createAnalyser();
    tunerAnalyser.fftSize = CFG.tunerFftSize;
    tunerAnalyser.smoothingTimeConstant = 0;
    tunerBuf = new Float32Array(tunerAnalyser.fftSize);

    // Main FFT analyser — post everything. Shared by FFT mode,
    // spectrogram mode and the Mix overlay. Zero extra nodes.
    fftAnalyser = audioCtx.createAnalyser();
    fftAnalyser.fftSize = CFG.fftSize;
    fftAnalyser.smoothingTimeConstant = 0.80;
    applyFftRange();     // window comes from the saved display range, not a literal
    fftBuf      = new Float32Array(fftAnalyser.frequencyBinCount);
    fftByteBuf  = new Uint8Array(fftAnalyser.frequencyBinCount);
    peakHoldBuf = new Float32Array(fftAnalyser.frequencyBinCount).fill(-Infinity);
    peakHoldAge = new Uint16Array(fftAnalyser.frequencyBinCount);

    inAnalyser  = audioCtx.createAnalyser();
    outAnalyser = audioCtx.createAnalyser();
    inAnalyser.fftSize = 256; outAnalyser.fftSize = 256;
    inAnalyser.smoothingTimeConstant  = 0.7;
    outAnalyser.smoothingTimeConstant = 0.7;
    inBuf  = new Float32Array(inAnalyser.fftSize);
    outBuf = new Float32Array(outAnalyser.fftSize);

    // ── Wiring ──
    sourceNode.connect(inGainNode);
    inGainNode.connect(inAnalyser);
    inGainNode.connect(tunerAnalyser);          // pre-EQ tap

    // The preamp bus. The tuner and the input meter stay upstream on
    // inGainNode, so they keep seeing the raw instrument whatever the
    // looper, the detune or the compressor are doing.
    liveGain = audioCtx.createGain();
    loopGain = audioCtx.createGain();
    loopGain.gain.value = 0;          // silent until the looper plays
    preampIn = audioCtx.createGain();
    dtOut    = audioCtx.createGain();
    compOut  = audioCtx.createGain();

    inGainNode.connect(liveGain);
    liveGain.connect(preampIn);
    loopGain.connect(preampIn);
    preampIn.connect(dtOut);          // detune splices across this edge
    dtOut.connect(compOut);           // the compressor splices across this one

    compOut.connect(dryGainNode);
    dryGainNode.connect(sumBus);

    // wet leg
    compOut.connect(gruntFilter);
    gruntFilter.connect(attackFilter);
    attackFilter.connect(driveGainNode);
    driveGainNode.connect(clipperNode);
    clipperNode.connect(levelGainNode);
    levelGainNode.connect(wetBlendNode);
    wetBlendNode.connect(sumBus);

    // EQ, post-blend
    sumBus.connect(filterLow);
    filterLow.connect(filterLoMid);
    filterLoMid.connect(filterHiMid);
    filterHiMid.connect(filterTreble);
    filterTreble.connect(filterHiss);
    filterHiss.connect(filterNotch);
    filterNotch.connect(gateGainNode);
    gateGainNode.connect(outAnalyser);
    gateGainNode.connect(outGainNode);          // ← Spectrum tab splices in here
    outGainNode.connect(audioCtx.destination);
    outGainNode.connect(fftAnalyser);

    applyAudioParams();
    buildScopeNodes();

    audioRunning = true;
    startUiLoop();
    geqOnAudioStart();   // the selected preamp may not be the B7K
    compApply();         // and the compressor may be on

    document.getElementById('audioToggle').textContent = '⏹ Disable Audio';
    document.getElementById('audioToggle').classList.add('active');
    document.getElementById('bypassBtn').style.display = '';

    const lat = latencyLine();
    const trackLabel = track.label ? ` · ${track.label}` : '';
    const statusEl = document.getElementById('audioStatus');
    statusEl.innerHTML = `<em>Live · ctx:${audioCtx.state}</em>${trackLabel}${lat}`;
    statusEl.classList.remove('err');
    document.getElementById('metersRow').style.display = '';
    document.getElementById('loopBar').style.display = '';
    document.getElementById('trimRow').style.display = '';

    // If the user was already sitting on the Spectrum tab, wire it up now.
    if (activeTab === 'spectrum') spectrumEnter();

  } catch (err) {
    let msg = 'Mic access denied or unavailable.';
    if (err.name === 'NotAllowedError') msg = 'Permission denied — reset mic permission for this page, then refresh.';
    if (err.name === 'NotFoundError')   msg = 'No audio input found — check the interface connection.';
    if (err.name === 'OverconstrainedError') msg = 'Selected device unavailable — try "Default input".';
    console.error('[Audio] Error:', err.name, err.message);
    const statusEl = document.getElementById('audioStatus');
    statusEl.textContent = msg;
    statusEl.classList.add('err');
  }
}

// ── Stop ───────────────────────────────────────────────────
function stopAudio() {
  spectrumExit(true);
  detuneReset();          // the worklet dies with the context
  loopReset();            // its nodes died with the context too
  compReset();            // ditto, and compBuild() short-circuits on a stale node
  stopUiLoop();
  stopScope();
  stopTuner();
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  if (audioCtx) { try { audioCtx.close(); } catch (e) {} }

  audioCtx = micStream = sourceNode = null;
  inGainNode = outGainNode = null;
  preampIn = dtOut = compOut = null;
  dryGainNode = wetBlendNode = levelGainNode = driveGainNode = null;
  gruntFilter = attackFilter = clipperNode = sumBus = null;
  filterLow = filterLoMid = filterHiMid = filterTreble = null;
  filterHiss = filterNotch = gateGainNode = null;
  tunerAnalyser = null; tunerBuf = null;
  inAnalyser = outAnalyser = inBuf = outBuf = null;
  fftAnalyser = null; fftBuf = null; fftByteBuf = null;
  peakHoldBuf = null; peakHoldAge = null; peakHoldFrozen = false;
  scopeInAna = scopeOutAna = null;
  fftEnabled = false;
  audioRunning = false; bypassed = false;

  const fftBtn = document.getElementById('fftBtn');
  fftBtn.textContent = 'Run: OFF'; fftBtn.classList.remove('active');
  document.getElementById('holdBtn').style.display = 'none';
  document.getElementById('resetBtn').style.display = 'none';
  document.getElementById('fftInfo').textContent = '';
  document.getElementById('frameInfo').innerHTML = 'frame <em>—</em>';

  document.getElementById('audioToggle').textContent = '⏵ Enable Audio';
  document.getElementById('audioToggle').classList.remove('active');
  const byp = document.getElementById('bypassBtn');
  byp.style.display = 'none';
  byp.classList.remove('bypass-on');
  byp.textContent = 'Bypass: OFF';
  document.getElementById('metersRow').style.display = 'none';
  document.getElementById('loopBar').style.display = 'none';
  document.getElementById('trimRow').style.display = 'none';
  document.getElementById('inMeter').style.width = '0%';
  document.getElementById('outMeter').style.width = '0%';
  const statusEl = document.getElementById('audioStatus');
  statusEl.textContent = 'Click "Enable Audio" — allow mic access when prompted';
  statusEl.classList.remove('err');
  render();
}

function toggleAudio() { audioRunning ? stopAudio() : startAudio(); }

async function switchDevice() {
  if (!audioRunning) return;
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  const deviceId = document.getElementById('deviceSelect').value;
  const audioConstraints = {
    echoCancellation: false, noiseSuppression: false,
    autoGainControl: false, channelCount: 1
  };
  if (deviceId) audioConstraints.deviceId = { exact: deviceId };
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    const track = micStream.getAudioTracks()[0];
    saveInputChoice(track.getSettings().deviceId || deviceId, track.label);
    sourceNode.disconnect();
    sourceNode = audioCtx.createMediaStreamSource(micStream);
    sourceNode.connect(inGainNode);
    document.getElementById('audioStatus').innerHTML = `<em>Live · ctx:${audioCtx.state}</em> · ${track.label}` + latencyLine();
  } catch (e) {
    document.getElementById('audioStatus').textContent = 'Device switch failed: ' + e.message;
  }
}

function toggleBypass() {
  bypassed = !bypassed;
  const btn = document.getElementById('bypassBtn');
  btn.textContent = bypassed ? 'Bypass: ON' : 'Bypass: OFF';
  btn.classList.toggle('bypass-on', bypassed);
  if (audioCtx) applyAudioParams();
  compApply();  // bypass takes the compressor with it
}

// ── Level meters + noise gate (driven from the shared UI loop) ──
function getRMS(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}
function rmsToPercent(rms) {
  if (rms < 0.0001) return 0;
  const dB = 20 * Math.log10(rms);
  return Math.max(0, Math.min(100, (dB + 60) / 60 * 100));
}
function rmsToDbStr(rms) {
  if (rms < 0.0001) return '-inf';
  return (20 * Math.log10(rms)).toFixed(1) + ' dB';
}

function tickMeters() {
  if (!inAnalyser || !outAnalyser) return;
  inAnalyser.getFloatTimeDomainData(inBuf);
  outAnalyser.getFloatTimeDomainData(outBuf);
  const inRms = getRMS(inBuf), outRms = getRMS(outBuf);

  if (gateGainNode && audioCtx) {
    if (gateOn && !bypassed) {
      const inDbVal = inRms > 0.00001 ? 20 * Math.log10(inRms) : -120;
      const openThresh = noiseState.gateThresh;
      const closeThresh = noiseState.gateThresh - 4;   // hysteresis
      if (gateOpen) { if (inDbVal < closeThresh) gateOpen = false; }
      else          { if (inDbVal > openThresh)  gateOpen = true;  }
      gateGainNode.gain.setTargetAtTime(gateOpen ? 1 : 0, audioCtx.currentTime, gateOpen ? 0.005 : 0.06);
    } else {
      gateGainNode.gain.setTargetAtTime(1, audioCtx.currentTime, 0.01);
    }
  }

  document.getElementById('inMeter').style.width  = rmsToPercent(inRms) + '%';
  document.getElementById('outMeter').style.width = rmsToPercent(outRms) + '%';
  document.getElementById('inDb').textContent  = rmsToDbStr(inRms);
  document.getElementById('outDb').textContent = rmsToDbStr(outRms);
}

// Watch AudioContext state — it can suspend on tab/app switch.
setInterval(() => {
  if (!audioRunning || !audioCtx) return;
  const statusEl = document.getElementById('audioStatus');
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  statusEl.innerHTML = statusEl.innerHTML.replace(/ctx:[a-z]+/, 'ctx:' + audioCtx.state);
}, 1000);

// ── Trim sliders ───────────────────────────────────────────
function wireTrim(id, labelId) {
  const el = document.getElementById(id);
  function update() {
    const v = num(parseFloat(el.value), 0);
    document.getElementById(labelId).textContent = (v >= 0 ? '+' : '') + v + ' dB';
    if (audioRunning && audioCtx) applyAudioParams();
  }
  el.addEventListener('input', update);
  el.addEventListener('wheel', e => {
    e.preventDefault();
    const next = Math.min(20, Math.max(-20, num(parseFloat(el.value), 0) + (e.deltaY < 0 ? 1 : -1)));
    el.value = next; update();
  }, { passive: false });
}

// ── Noise / hiss tools ─────────────────────────────────────
function refreshNoise() { if (audioRunning && audioCtx) applyAudioParams(); }

function toggleHiss() {
  hissOn = !hissOn;
  const btn = document.getElementById('hissBtn');
  btn.textContent = 'High-cut: ' + (hissOn ? 'ON' : 'OFF');
  btn.classList.toggle('active', hissOn);
  document.getElementById('hissParam').classList.toggle('on', hissOn);
  refreshNoise();
}
function toggleNotch() {
  notchOn = !notchOn;
  const btn = document.getElementById('notchBtn');
  btn.textContent = 'Notch: ' + (notchOn ? 'ON' : 'OFF');
  btn.classList.toggle('active', notchOn);
  document.getElementById('notchParam').classList.toggle('on', notchOn);
  refreshNoise();
}
function toggleGate() {
  gateOn = !gateOn;
  gateOpen = true;
  const btn = document.getElementById('gateBtn');
  btn.textContent = 'Gate: ' + (gateOn ? 'ON' : 'OFF');
  btn.classList.toggle('active', gateOn);
  document.getElementById('gateParam').classList.toggle('on', gateOn);
  refreshNoise();
}
function wireNoiseParam(id, key, labelId, fmtFn) {
  const el = document.getElementById(id);
  function update() {
    noiseState[key] = num(parseFloat(el.value), noiseState[key]);
    document.getElementById(labelId).textContent = fmtFn(noiseState[key]);
    refreshNoise();
  }
  el.addEventListener('input', update);
  el.addEventListener('wheel', e => {
    e.preventDefault();
    const step = parseFloat(el.step) || 1;
    const next = Math.min(parseFloat(el.max), Math.max(parseFloat(el.min),
      num(parseFloat(el.value), 0) + (e.deltaY < 0 ? step : -step)));
    el.value = next; update();
  }, { passive: false });
}
const kHz = v => v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' kHz' : v.toFixed(0) + ' Hz';
