// ═══════════════════════════════════════════════════════════
// LOOPER — record a lick, loop it THROUGH the preamp
//
// The point is hands-free tuning, so the recording is taken DRY, off the
// input, ahead of everything. It is played back into preampIn, the same
// place the live instrument lands. Every pass is therefore re-processed by
// whatever the knobs are doing right now — which is the whole feature.
// Recording after the preamp would freeze the tone you were trying to change.
//
// LATENCY: nothing here is in series with what you monitor.
//   · The record tap is a BRANCH off inGainNode; a branch cannot delay the
//     path it hangs from.
//   · Playback is an AudioBufferSourceNode, which is sample-accurate.
//   · Export taps gateGainNode the same way, and encodes afterwards.
// So the looper adds exactly zero samples, on every path.
// ═══════════════════════════════════════════════════════════

// A minute was right for "record a lick", which is what this was built for.
// It is wrong for a song, and it stopped without ever saying why — the cap
// was invisible until you hit it.
//
// The ceiling is really a memory budget: audio is held uncompressed at four
// bytes a sample, so 48 kHz mono costs ~11 MB per minute. 20 minutes is
// ~220 MB, fine on a desktop and reckless on a phone, so a phone gets five.
const LOOP_MAX_PHONE_SEC = 5 * 60;
const LOOP_MAX_DESK_SEC  = 20 * 60;
const loopMaxSec = () => (typeof mqCoarse !== 'undefined' && mqCoarse && mqCoarse.matches)
  ? LOOP_MAX_PHONE_SEC : LOOP_MAX_DESK_SEC;
const LOOP_REC_WRAPPER = `
class LoopRec extends AudioWorkletProcessor {
  constructor(){ super(); this.on = false;
    this.port.onmessage = e => { this.on = !!e.data.on; }; }
  process(inputs){
    const i = inputs[0];
    if (this.on && i && i.length) this.port.postMessage(new Float32Array(i[0]));
    return true;
  }
}
registerProcessor('loop-rec', LoopRec);
`;
// Worklet modules cannot be fetched from file://; check the protocol, not
// isSecureContext, which is true there.
const LOOP_WORKLET_BLOCKED = (typeof location !== 'undefined' && location.protocol === 'file:');

const loop = { autoTrim: true, muteLive: true, level: 100 };
let loopBuf = null, loopSrc = null, loopGain = null, liveGain = null;
let loopRecNode = null, loopRecChunks = [], loopRecLen = 0, loopRecOn = false;
let loopModuleAdded = false, loopHost = '—', loopPlaying = false, loopHitCap = false;
let loopSink = null;
let loopBusy = false, loopProgress = '';

const loopSec = () => loopBuf ? loopBuf.duration : 0;

// A ScriptProcessor only runs if it reaches a destination. Its output buffer
// is never written, so it is already silent — but route it through a muted
// gain anyway rather than trusting that.
function loopMutedSink() {
  if (!loopSink) {
    loopSink = audioCtx.createGain();
    loopSink.gain.value = 0;
    loopSink.connect(audioCtx.destination);
  }
  return loopSink;
}

// ── Recording the dry input ────────────────────────────────
async function loopBuildRec() {
  if (loopRecNode || !audioCtx || !inGainNode) return;
  if (!LOOP_WORKLET_BLOCKED && audioCtx.audioWorklet) {
    try {
      if (!loopModuleAdded) {
        const url = URL.createObjectURL(new Blob([LOOP_REC_WRAPPER], { type: 'application/javascript' }));
        await audioCtx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        loopModuleAdded = true;
      }
      loopRecNode = new AudioWorkletNode(audioCtx, 'loop-rec');
      loopRecNode.port.onmessage = e => loopPush(e.data);
      loopHost = 'AudioWorklet';
    } catch (e) { console.warn('[Loop] worklet unavailable:', e.message); }
  }
  if (!loopRecNode) {
    // A ScriptProcessor here is harmless: it is a branch, so its block size
    // delays nothing you are listening to.
    loopRecNode = audioCtx.createScriptProcessor(2048, 1, 1);
    loopRecNode.onaudioprocess = e => {
      if (loopRecOn) loopPush(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    loopRecNode.connect(loopMutedSink());
    loopHost = 'ScriptProcessor';
  }
  inGainNode.connect(loopRecNode);
}

function loopPush(chunk) {
  if (!loopRecOn) return;
  if (loopRecLen + chunk.length > loopMaxSec() * audioCtx.sampleRate) {
    loopHitCap = true; loopStopRec(); return;
  }
  loopRecChunks.push(chunk); loopRecLen += chunk.length;
  loopSyncUI();
}

async function loopStartRec() {
  if (!audioRunning || !audioCtx) { loopSay('Enable audio first.'); return; }
  loopStopPlay();
  await loopBuildRec();
  loopRecChunks = []; loopRecLen = 0; loopRecOn = true;
  if (loopRecNode && loopRecNode.port) loopRecNode.port.postMessage({ on: true });
  loopSay('Recording — play your lick, then press Stop.');
  loopSyncUI();
}

function loopStopRec() {
  if (!loopRecOn) return;
  loopRecOn = false;
  if (loopRecNode && loopRecNode.port) loopRecNode.port.postMessage({ on: false });
  if (!loopRecLen) { loopSay('Nothing recorded.'); loopSyncUI(); return; }

  // Assemble straight into the AudioBuffer. The old path built a full-length
  // scratch array first and copied that in, so peak memory was three copies
  // of the take. At twenty minutes that is the difference between a file and
  // a dead tab.
  const [s, e] = loop.autoTrim ? loopTrimChunks(loopRecChunks, loopRecLen) : [0, loopRecLen];
  const n = Math.max(1, e - s);
  loopBuf = audioCtx.createBuffer(1, n, audioCtx.sampleRate);
  loopCopyRange(loopRecChunks, s, e, loopBuf.getChannelData(0));
  loopRecChunks = []; loopRecLen = 0;
  loopFadeEdges(loopBuf.getChannelData(0));
  loopDrawWave();
  loopSay(loopHitCap
    ? 'Stopped at the ' + Math.round(loopMaxSec() / 60) + '-minute limit — kept '
      + loopFmtSec(loopSec()) + '. Press Loop to hear it.'
    : 'Recorded ' + loopFmtSec(loopSec()) + '. Press Loop to play it through the preamp.');
  loopHitCap = false;
  loopSyncUI();
}

// Trim leading and trailing silence so the loop turns over cleanly. Walks the
// chunk list rather than a concatenated copy of it, so trimming a 20-minute
// take costs no extra memory at all.
function loopTrimChunks(chunks, total) {
  let peak = 0;
  for (const c of chunks) for (let i = 0; i < c.length; i++) { const v = c[i] < 0 ? -c[i] : c[i]; if (v > peak) peak = v; }
  const th = Math.max(peak * 0.02, 1e-4);
  let s = -1, e = total, at = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) if ((c[i] < 0 ? -c[i] : c[i]) >= th) { s = at + i; break; }
    if (s >= 0) break;
    at += c.length;
  }
  if (s < 0) return [0, total];            // nothing above the floor
  at = total;
  for (let k = chunks.length - 1; k >= 0; k--) {
    const c = chunks[k]; at -= c.length; let hit = -1;
    for (let i = c.length - 1; i >= 0; i--) if ((c[i] < 0 ? -c[i] : c[i]) >= th) { hit = i; break; }
    if (hit >= 0) { e = at + hit + 1; break; }
  }
  const pad = Math.round(audioCtx.sampleRate * 0.01);
  return [Math.max(0, s - pad), Math.min(total, e + pad)];
}

// Copy samples [s, e) out of the chunk list into dest, chunk by chunk.
function loopCopyRange(chunks, s, e, dest) {
  let at = 0, w = 0;
  for (const c of chunks) {
    const cs = at, ce = at + c.length;
    if (ce > s && cs < e) {
      const from = Math.max(0, s - cs), to = Math.min(c.length, e - cs);
      dest.set(c.subarray(from, to), w);
      w += to - from;
    }
    at = ce;
    if (at >= e) break;
  }
}

// 45.20 s below a minute, 3:07 above it.
// Branch on the value we would actually PRINT, not the raw one: 59.999 is
// under a minute but rounds to "60.00 s", which reads as a minute displayed
// in seconds. Deciding after rounding sends it to 1:00 instead.
function loopFmtSec(s) {
  const shown = Math.round(s * 100) / 100;
  if (shown < 60) return shown.toFixed(2) + ' s';
  const whole = Math.round(s);
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
}
// 5 ms in and out, so the seam does not click on every pass.
function loopFadeEdges(d) {
  const n = Math.min(Math.round(audioCtx.sampleRate * 0.005), d.length >> 1);
  for (let i = 0; i < n; i++) { const g = i / n; d[i] *= g; d[d.length - 1 - i] *= g; }
}

// ── Playback ───────────────────────────────────────────────
function loopPlay() {
  if (!loopBuf || !audioCtx || !loopGain) { loopSay('Record something first.'); return; }
  loopStopPlay();
  loopSrc = audioCtx.createBufferSource();
  loopSrc.buffer = loopBuf;
  loopSrc.loop = true;
  loopSrc.connect(loopGain);
  loopSrc.start();
  loopPlaying = true;
  loopApplyGains();
  loopSay('Looping — adjust the preamp and listen. Every pass is re-processed.');
  loopSyncUI();
}
function loopStopPlay() {
  if (loopSrc) { try { loopSrc.stop(); } catch (e) {} try { loopSrc.disconnect(); } catch (e) {} loopSrc = null; }
  loopPlaying = false;
  loopApplyGains();
  loopSyncUI();
}
function loopToggle() { loopPlaying ? loopStopPlay() : loopPlay(); }
function loopRecToggle() { loopRecOn ? loopStopRec() : loopStartRec(); }

function loopApplyGains() {
  if (!audioCtx || !loopGain || !liveGain) return;
  const t = audioCtx.currentTime;
  loopGain.gain.setTargetAtTime(loopPlaying ? num(loop.level, 100) / 100 : 0, t, 0.02);
  liveGain.gain.setTargetAtTime((loopPlaying && loop.muteLive) ? 0 : 1, t, 0.02);
}

// ── Export: re-render the take through the preamp ──────────
//
// The old design taped the live output while you played, so exporting was a
// performance: press record, play the thing again, press stop. Rendering
// offline instead means the take you already have is pushed through the
// current settings faster than realtime. Change a knob, export again, and
// you get the same performance with the new tone.
//
// This graph must stay the one startAudio() wires. Same nodes, same order,
// same parameters — and smoke.js reads applyAudioParams and asserts every
// parameter it touches is named in here too, so a new knob cannot quietly go
// missing from exports.
//
// Two things are deliberately absent, and the panel says so:
//   · the detune, a live pitch-shift worklet and not part of the preamp
//   · the noise gate, whose gain is driven frame by frame by the live meter
async function loopRenderOffline() {
  if (!loopBuf) return null;
  const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OC) throw new Error('This browser cannot render offline.');
  const sr = loopBuf.sampleRate;
  const off = new OC(1, loopBuf.length, sr);
  const byp = bypassed;

  const src = off.createBufferSource();
  src.buffer = loopBuf;
  let head = src;

  // ── compressor: the same worklet core the live path runs ──
  if (comp.on && !byp) {
    try {
      const code = makeCompCore.toString() + '\n' + COMP_WRAPPER;
      const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      await off.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const c = new AudioWorkletNode(off, 'bass-comp', { processorOptions: compParams() });
      head.connect(c); head = c;
    } catch (e) { console.warn('[Loop] offline compressor unavailable:', e.message); }
  }

  // ── drive section ──
  const bg = blendGains(byp ? 0 : num(state.blend, 0));
  const dry   = off.createGain(); dry.gain.value   = num(bg.dry, 1);
  const wet   = off.createGain(); wet.gain.value   = num(bg.wet, 0);
  const level = off.createGain(); level.gain.value = byp ? 1 : num(levelGain(num(state.level, 100)), 1);
  const drive = off.createGain(); drive.gain.value = byp ? 1 : num(driveGainOf(num(state.drive, 0)), 1);

  const grunt = off.createBiquadFilter();
  grunt.type = 'lowshelf'; grunt.frequency.value = 120;
  grunt.gain.value = byp ? 0 : num(GRUNT_DB[state.grunt], 0);

  const attack = off.createBiquadFilter();
  attack.type = 'highshelf'; attack.frequency.value = 3000;
  attack.gain.value = byp ? 0 : num(ATTACK_DB[state.attack], 0);

  const clip = off.createWaveShaper();
  clip.curve = makeClipCurve(4096);
  clip.oversample = LITE ? 'none' : '4x';

  const sum = off.createGain(); sum.gain.value = 1;
  head.connect(dry); dry.connect(sum);
  head.connect(grunt); grunt.connect(attack); attack.connect(drive);
  drive.connect(clip); clip.connect(level); level.connect(wet); wet.connect(sum);

  // ── whichever preamp is selected ──
  let tail = sum;
  const kind = (typeof preampKind !== 'undefined') ? preampKind : 'b7k';
  if (kind === 'geq') {
    const gin = off.createGain(); gin.gain.value = byp ? 1 : geqDbGain(num(geq.gain, 0));
    sum.connect(gin);
    let prev = gin;
    for (let i = 0; i < GEQ_N; i++) {
      const b = off.createBiquadFilter();
      b.type = 'peaking';
      b.frequency.value = geqFreqAt(i);
      b.Q.value = num(geq.qs[i], GEQ_Q);
      b.gain.value = byp ? 0 : num(geq.gains[i], 0);
      prev.connect(b); prev = b;
    }
    const gout = off.createGain(); gout.gain.value = byp ? 1 : geqDbGain(num(geq.volume, 0));
    prev.connect(gout); tail = gout;
  } else if (kind === 'curve') {
    // The solved bank, not the drawing. Whatever the filters are actually
    // doing to what you hear is what lands in the file.
    const B = curveBuildBasis();
    if (B && curveGains) {
      let prev = sum;
      for (let i = 0; i < B.n; i++) {
        const c = B.centres[i], b = off.createBiquadFilter();
        b.type = c.type; b.frequency.value = c.fc;
        if (c.type === 'peaking') b.Q.value = c.q;
        b.gain.value = byp ? 0 : curveGains[i];
        prev.connect(b); prev = b;
      }
      tail = prev;
    }
  } else {
    const low = off.createBiquadFilter();
    low.type = 'lowshelf'; low.frequency.value = 100;
    low.gain.value = byp ? 0 : num(state.low, 0);
    const loMid = off.createBiquadFilter();
    loMid.type = 'peaking'; loMid.frequency.value = num(state.loMidFreq, 1000);
    loMid.Q.value = num(state.loMidQ, 2.2); loMid.gain.value = byp ? 0 : num(state.loMid, 0);
    const hiMid = off.createBiquadFilter();
    hiMid.type = 'peaking'; hiMid.frequency.value = num(state.hiMidFreq, 3000);
    hiMid.Q.value = num(state.hiMidQ, 2.2); hiMid.gain.value = byp ? 0 : num(state.hiMid, 0);
    const treble = off.createBiquadFilter();
    treble.type = 'highshelf'; treble.frequency.value = 5000;
    treble.gain.value = byp ? 0 : num(state.treble, 0);
    sum.connect(low); low.connect(loMid); loMid.connect(hiMid); hiMid.connect(treble);
    tail = treble;
  }

  // ── cleanup, minus the gate ──
  const hiss = off.createBiquadFilter();
  hiss.type = 'lowpass';
  hiss.frequency.value = (hissOn && !byp) ? num(noiseState.hissFreq, 20000) : 20000;
  hiss.Q.value = 0.707;
  const notch = off.createBiquadFilter();
  notch.type = 'peaking';
  notch.frequency.value = num(noiseState.notchFreq, 3000);
  notch.Q.value = num(noiseState.notchQ, 8);
  notch.gain.value = (notchOn && !byp) ? -30 : 0;

  const trimEl = document.getElementById('outTrimKnob');
  const outTrim = off.createGain();
  outTrim.gain.value = Math.pow(10, num(trimEl ? parseFloat(trimEl.value) : 0, 0) / 20);

  tail.connect(hiss); hiss.connect(notch); notch.connect(outTrim);
  outTrim.connect(off.destination);
  src.start();
  return await off.startRendering();
}

// ── Downloads ──────────────────────────────────────────────
async function loopDownloadWav() {
  if (!loopBuf) { loopSay('Record something first.'); return; }
  if (loopBusy) return;
  loopBusy = true; loopProgress = 'Rendering…'; loopSyncUI();
  try {
    const r = await loopRenderOffline();
    loopSave(new Blob([loopWav(r.getChannelData(0), r.sampleRate)], { type: 'audio/wav' }), 'wav');
    loopSay('Exported ' + loopFmtSec(r.duration) + ' as WAV.');
  } catch (e) { loopSay('Export failed: ' + e.message); }
  finally { loopBusy = false; loopProgress = ''; loopSyncUI(); }
}

// M4A cannot come from an offline render: MediaRecorder is the only encoder a
// browser exposes and it runs in realtime. So render first, then play the
// result into a stream destination at 1x and record that. A five-minute take
// takes five minutes, which is why the button says so before you press it.
async function loopDownloadM4a() {
  if (!loopBuf) { loopSay('Record something first.'); return; }
  if (loopBusy) return;
  const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
    .find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
  if (!mime) { loopSay('This browser has no compressed audio encoder.'); return; }
  if (!audioRunning || !audioCtx) { loopSay('Enable audio first — encoding runs through a live context.'); return; }

  loopBusy = true; loopProgress = 'Rendering…'; loopSyncUI();
  let r;
  try { r = await loopRenderOffline(); }
  catch (e) { loopBusy = false; loopProgress = ''; loopSay('Export failed: ' + e.message); loopSyncUI(); return; }

  const total = r.duration;
  const dest = audioCtx.createMediaStreamDestination();
  const src = audioCtx.createBufferSource();
  src.buffer = r;
  src.connect(dest);                     // to the encoder only, never the speakers
  const rec = new MediaRecorder(dest.stream, { mimeType: mime });
  const parts = [];
  rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
  const t0 = audioCtx.currentTime;
  const tick = setInterval(() => {
    const done = Math.min(1, (audioCtx.currentTime - t0) / total);
    loopProgress = 'Encoding ' + Math.round(done * 100) + '% · ' + loopFmtSec(total * (1 - done)) + ' left';
    loopSyncUI();
  }, 400);
  rec.onstop = () => {
    clearInterval(tick);
    const ext = mime.indexOf('mp4') >= 0 ? 'm4a' : 'webm';
    loopSave(new Blob(parts, { type: mime }), ext);
    loopBusy = false; loopProgress = '';
    loopSay('Exported ' + loopFmtSec(total) + ' as ' + ext.toUpperCase() + '.');
    loopSyncUI();
  };
  // A short grace period before stopping: MediaRecorder can drop its last
  // chunk if it is stopped the same instant playback ends.
  src.onended = () => setTimeout(() => {
    try { rec.stop(); } catch (e) {}
    try { src.disconnect(); dest.disconnect(); } catch (e) {}
  }, 250);
  rec.start();
  src.start();
  loopSyncUI();
}

function loopSave(blob, ext) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'bass-analyzer-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.' + ext;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// 16-bit PCM WAV. Twenty lines, no library, and lossless.
function loopWav(samples, rate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

// ── Waveform ───────────────────────────────────────────────
function loopDrawWave() {
  const cv = document.getElementById('loopWave');
  if (!cv || !cv.parentElement) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.parentElement.clientWidth, H = 56;
  if (W < 2) return;
  cv.width = W * dpr; cv.height = H * dpr;
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = TH.chartBg; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = TH.gridLine; ctx.beginPath();
  ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
  if (!loopBuf) return;
  const d = loopBuf.getChannelData(0), step = Math.max(1, Math.floor(d.length / W));
  ctx.strokeStyle = TH.bass; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < W; x++) {
    let lo = 1, hi = -1;
    for (let i = x * step; i < (x + 1) * step && i < d.length; i++) {
      if (d[i] < lo) lo = d[i]; if (d[i] > hi) hi = d[i];
    }
    ctx.moveTo(x + 0.5, H / 2 - hi * H / 2 * 0.92);
    ctx.lineTo(x + 0.5, H / 2 - lo * H / 2 * 0.92);
  }
  ctx.stroke();
}

function loopSay(m) { const el = document.getElementById('loopMsg'); if (el) el.textContent = m; }

function loopSyncUI() {
  const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
  const secs = audioCtx ? (loopRecOn ? loopRecLen / audioCtx.sampleRate : loopSec()) : loopSec();
  ['loopRecBtn', 'loopRecBtn2'].forEach(id => set(id, el => {
    el.textContent = loopRecOn ? '■ Stop rec' : '● Record';
    el.classList.toggle('active', loopRecOn);
  }));
  ['loopPlayBtn', 'loopPlayBtn2'].forEach(id => set(id, el => {
    el.textContent = loopPlaying ? '■ Stop' : '▶ Loop';
    el.classList.toggle('active', loopPlaying);
    el.disabled = !loopBuf;
  }));
  ['loopTime', 'loopTime2'].forEach(id => set(id, el => {
    el.innerHTML = (loopBuf || loopRecOn)
      ? '<em>' + loopFmtSec(secs) + (loopRecOn ? ' / ' + loopFmtSec(loopMaxSec()) : '') + '</em>'
      : '<em>—</em>';
  }));
  set('loopLimit', el => el.textContent = 'up to ' + Math.round(loopMaxSec() / 60) + ' min on this device');
  set('loopHost', el => el.innerHTML = 'capture <em>' + loopHost + '</em>');
  ['loopWavBtn', 'loopM4aBtn'].forEach(id => set(id, el => { el.disabled = !loopBuf || loopBusy; }));
  set('loopProgress', el => { el.textContent = loopProgress; });
  set('loopLevelVal', el => el.textContent = Math.round(num(loop.level, 100)) + '%');
  document.querySelectorAll('[data-loopsw]').forEach(b =>
    b.classList.toggle('active', !!loop[b.dataset.loopsw]));
  const inp = document.querySelector('input[data-loop="level"]');
  if (inp && parseFloat(inp.value) !== loop.level) inp.value = loop.level;
}

function loopSetSwitch(k) { loop[k] = !loop[k]; loopApplyGains(); loopSyncUI(); }
function loopSetLevel(v) { loop.level = v; loopApplyGains(); loopSyncUI(); }

// Called from stopAudio(): every node belonged to the context that just
// closed. The recorded buffer survives — it is only samples, and a
// BufferSource resamples it if the new context runs at another rate.
function loopReset() {
  if (loopSrc) { try { loopSrc.stop(); } catch (e) {} }
  loopSrc = null; loopGain = null; liveGain = null; loopSink = null;
  loopRecNode = null; loopRecChunks = []; loopRecLen = 0; loopRecOn = false;
  loopModuleAdded = false; loopPlaying = false; loopHost = '—'; loopHitCap = false;
  loopBusy = false; loopProgress = '';
  loopSyncUI();
}

function wireLoop() {
  document.querySelectorAll('input[data-loop]').forEach(el => {
    el.addEventListener('input', () => loopSetLevel(parseFloat(el.value)));
    el.addEventListener('wheel', e => {
      if (document.activeElement !== el) return;   // the wheel belongs to the page
      e.preventDefault();
      const v = Math.min(200, Math.max(0, parseFloat(el.value) + (e.deltaY < 0 ? 5 : -5)));
      el.value = v; loopSetLevel(v);
    }, { passive: false });
  });
  window.addEventListener('resize', () => { if (loopBuf) loopDrawWave(); });
}
function initLoop() { wireLoop(); loopDrawWave(); loopSyncUI(); }
