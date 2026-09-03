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
let loopExportRec = null, loopExportChunks = [], loopExportTap = null;
let loopExportRaw = [], loopExportLen = 0, loopExportOn = false;
let loopWavBlob = null, loopM4aBlob = null, loopExportMime = '';

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

// ── Export: capture the CONDITIONED output ─────────────────
async function loopExportStart() {
  if (!audioRunning || !audioCtx || !gateGainNode) { loopSay('Enable audio first.'); return; }
  loopWavBlob = loopM4aBlob = null;
  loopExportRaw = []; loopExportLen = 0; loopExportOn = true;

  // Raw tap for a lossless WAV.
  if (!loopExportTap) {
    if (!LOOP_WORKLET_BLOCKED && audioCtx.audioWorklet && loopModuleAdded) {
      loopExportTap = new AudioWorkletNode(audioCtx, 'loop-rec');
      loopExportTap.port.onmessage = e => {
        if (!loopExportOn) return;
        loopExportRaw.push(e.data); loopExportLen += e.data.length; loopSyncUI();
      };
    } else {
      loopExportTap = audioCtx.createScriptProcessor(2048, 1, 1);
      loopExportTap.onaudioprocess = e => {
        if (!loopExportOn) return;
        const c = new Float32Array(e.inputBuffer.getChannelData(0));
        loopExportRaw.push(c); loopExportLen += c.length; loopSyncUI();
      };
      loopExportTap.connect(loopMutedSink());
    }
    gateGainNode.connect(loopExportTap);
  }
  if (loopExportTap.port) loopExportTap.port.postMessage({ on: true });

  // And a MediaRecorder for the compressed file, straight from the browser.
  // MP3 is not an option: no shipping browser exposes an MP3 encoder to
  // MediaRecorder. M4A (AAC) is the closest thing everything can open.
  try {
    const dest = audioCtx.createMediaStreamDestination();
    gateGainNode.connect(dest);
    loopExportMime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
      .find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
    if (loopExportMime) {
      loopExportChunks = [];
      loopExportRec = new MediaRecorder(dest.stream, { mimeType: loopExportMime });
      loopExportRec.ondataavailable = e => { if (e.data.size) loopExportChunks.push(e.data); };
      loopExportRec.onstop = () => {
        loopM4aBlob = new Blob(loopExportChunks, { type: loopExportMime });
        loopSyncUI();
      };
      loopExportRec.start();
    }
  } catch (e) { console.warn('[Loop] MediaRecorder unavailable:', e.message); }

  loopSay('Capturing the processed output…');
  loopSyncUI();
}

function loopExportStop() {
  if (!loopExportOn) return;
  loopExportOn = false;
  if (loopExportTap && loopExportTap.port) loopExportTap.port.postMessage({ on: false });
  if (loopExportRec && loopExportRec.state !== 'inactive') loopExportRec.stop();

  if (loopExportLen) {
    const all = new Float32Array(loopExportLen);
    let at = 0;
    for (const c of loopExportRaw) { all.set(c, at); at += c.length; }
    loopWavBlob = new Blob([loopWav(all, audioCtx.sampleRate)], { type: 'audio/wav' });
  }
  const secs = loopExportLen / (audioCtx ? audioCtx.sampleRate : 48000);
  loopExportRaw = [];
  loopSay('Captured ' + secs.toFixed(1) + ' s — download it below.');
  loopSyncUI();
}
function loopExportToggle() { loopExportOn ? loopExportStop() : loopExportStart(); }

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

function loopDownload(which) {
  const blob = which === 'wav' ? loopWavBlob : loopM4aBlob;
  if (!blob) { loopSay('Nothing captured yet.'); return; }
  const ext = which === 'wav' ? 'wav' : (loopExportMime.indexOf('mp4') >= 0 ? 'm4a' : 'webm');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'bass-analyzer-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.' + ext;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
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
  set('loopExportBtn', el => {
    el.textContent = loopExportOn ? '■ Stop capture' : '● Capture output';
    el.classList.toggle('active', loopExportOn);
  });
  set('loopWavBtn', el => el.disabled = !loopWavBlob);
  set('loopM4aBtn', el => {
    el.disabled = !loopM4aBlob;
    // Only rename it once a capture has told us what the browser chose.
    if (loopExportMime)
      el.textContent = 'Download ' + (loopExportMime.indexOf('mp4') >= 0 ? 'M4A' : 'WebM');
  });
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
  loopExportTap = null; loopExportRec = null; loopExportRaw = [];
  loopExportLen = 0; loopExportOn = false;
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
