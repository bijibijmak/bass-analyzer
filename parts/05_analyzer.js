// ═══════════════════════════════════════════════════════════
// ANALYZER
//
// Two SEPARATE canvases swapped into one fixed-height slot — not one
// canvas with a mode flag. A polyline renderer and a pixel-column blit
// share no drawing code, and the crosshair's axis mapping differs.
//
// The column generator IS shared between the Preamp spectrogram
// (frequency on X, time scrolling down) and the Spectrum tab
// (frequency on Y, time scrolling left). Only the blit direction differs.
// ═══════════════════════════════════════════════════════════

let analyzerMode = 'fft';    // 'fft' | 'sg'

// ── Spectrogram scroll speed ───────────────────────────────
// Two mechanisms, because one alone doesn't cover the useful range:
// below 1× we hold each column for several frames (skip), above 1× we
// widen the column (px). Time resolution is unchanged either way — the
// analyser still integrates the same window; only the pixel rate changes.
const SG_SPEEDS = [
  { label: '¼×', skip: 4, px: 1 },
  { label: '½×', skip: 2, px: 1 },
  { label: '1×', skip: 1, px: 1 },
  { label: '2×', skip: 1, px: 2 },
  { label: '4×', skip: 1, px: 4 }
];
const SG_SPEED_KEY = 'b7k_sg_speed';
let sgSpeedIdx = 2;
let sgSkipCount = 0;

function sgPx()   { return SG_SPEEDS[sgSpeedIdx].px; }
function sgSkip() { return SG_SPEEDS[sgSpeedIdx].skip; }

function setSgSpeed(idx, persist) {
  if (!SG_SPEEDS[idx]) return;
  sgSpeedIdx = idx;
  sgSkipCount = 0;
  if (persist !== false) { try { localStorage.setItem(SG_SPEED_KEY, String(idx)); } catch (e) {} }
  document.querySelectorAll('#speedSel button').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.speed, 10) === idx);
  });
  sgAllocStrip();          // resize the column buffer without wiping history
  updateSpeedInfo();
}

function updateSpeedInfo() {
  const el = document.getElementById('speedInfo');
  if (!el) return;
  const pxPerSec = (sgPx() / sgSkip()) * 60;                 // assumes ~60 fps
  const secs = sgPlotW > 0 ? (sgPlotW / pxPerSec) : 0;
  el.innerHTML = `<em>~${pxPerSec.toFixed(0)} px/s</em> · ${secs > 0 ? '~' + secs.toFixed(1) + ' s across' : ''}`;
}

function initSgSpeed() {
  let saved = null;
  try { saved = localStorage.getItem(SG_SPEED_KEY); } catch (e) {}
  const idx = saved === null ? 2 : parseInt(saved, 10);
  setSgSpeed(SG_SPEEDS[idx] ? idx : 2, false);
}

// ── Shared colour ramp (quiet → loud) ──────────────────────
const RAMP_STOPS = [[0,0,5,18],[0.16,11,30,107],[0.34,11,127,212],[0.52,34,193,168],
                    [0.68,200,227,74],[0.84,245,166,35],[1,255,45,45]];
const RAMP_LUT = new Uint8Array(256 * 3);
(function buildLut() {
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = RAMP_STOPS[0], b = RAMP_STOPS[RAMP_STOPS.length - 1];
    for (let s = 0; s < RAMP_STOPS.length - 1; s++) {
      if (t >= RAMP_STOPS[s][0] && t <= RAMP_STOPS[s + 1][0]) { a = RAMP_STOPS[s]; b = RAMP_STOPS[s + 1]; break; }
    }
    const k = (t - a[0]) / ((b[0] - a[0]) || 1);
    RAMP_LUT[i * 3]     = a[1] + (b[1] - a[1]) * k;
    RAMP_LUT[i * 3 + 1] = a[2] + (b[2] - a[2]) * k;
    RAMP_LUT[i * 3 + 2] = a[3] + (b[3] - a[3]) * k;
  }
})();

// Maps pixel index → fractional FFT bin, log-spaced.
// reverse=true puts the lowest frequency at the HIGHEST index (screen bottom).
function buildLogMap(n, binCount, sampleRate, fMin, fMax, reverse) {
  const map = new Float32Array(n);
  const nyq = sampleRate / 2;
  const lmin = Math.log(fMin), lspan = Math.log(fMax) - Math.log(fMin);
  for (let i = 0; i < n; i++) {
    const t = reverse ? (1 - i / (n - 1)) : (i / n);
    const f = Math.exp(lmin + lspan * t);
    map[i] = Math.min(binCount - 1, f / nyq * binCount);
  }
  return map;
}

// Writes one time-slice into an ImageData.
//   vertical=true  → img is (thickness × n), index runs down the rows
//   vertical=false → img is (n × thickness), index runs across the columns
function renderColumn(img, bytes, map, n, thickness, vertical) {
  const px = img.data;
  for (let i = 0; i < n; i++) {
    const b = map[i];
    const lo = b | 0;
    const hi = Math.min(lo + 1, bytes.length - 1);
    const fr = b - lo;
    const v = (bytes[lo] * (1 - fr) + bytes[hi] * fr) | 0;
    const r = RAMP_LUT[v * 3], g = RAMP_LUT[v * 3 + 1], bl = RAMP_LUT[v * 3 + 2];
    for (let k = 0; k < thickness; k++) {
      const o = (vertical ? (i * thickness + k) : (k * n + i)) * 4;
      px[o] = r; px[o + 1] = g; px[o + 2] = bl; px[o + 3] = 255;
    }
  }
}

// ═══════════════════════════════════════════════════════════
// FFT MODE — line renderer. No schematic curve here; that lives on Mix.
// ═══════════════════════════════════════════════════════════
function drawFftChart() {
  const s = setupCanvas('fftCanvas', analyzerH());
  if (!s) return;
  const { ctx, W, H } = s;
  const { cw, ch, xp } = drawAxes(ctx, W, H);

  const unityY = PAD.t + ch - DISPLAY_FLAT * ch;
  ctx.strokeStyle = TH.unityLine; ctx.lineWidth = 1; ctx.setLineDash([6, 6]);
  ctx.beginPath(); ctx.moveTo(PAD.l, unityY); ctx.lineTo(PAD.l + cw, unityY); ctx.stroke();
  ctx.setLineDash([]);

  drawBandMarkers(ctx, ch, xp);
  drawFftOverlay(ctx, cw, ch, xp, true);

  if (!fftEnabled) {
    ctx.fillStyle = TH.axisLabel; ctx.font = '11px Share Tech Mono,monospace'; ctx.textAlign = 'center';
    ctx.fillText(audioRunning ? 'Press Run to start the analyzer'
                              : 'Enable audio, then press Run', PAD.l + cw / 2, PAD.t + ch / 2);
  }
}

// Live FFT + peak hold. Shared by the FFT chart and the Mix overlay.
function drawFftOverlay(ctx, cw, ch, xp, withDbScale) {
  if (!(fftEnabled && fftAnalyser && fftBuf)) return;
  fftAnalyser.getFloatFrequencyData(fftBuf);

  const nyquist = audioCtx.sampleRate / 2;
  const binCount = fftBuf.length;
  const minDb = fftAnalyser.minDecibels;
  const maxDb = fftAnalyser.maxDecibels;
  const dbRange = maxDb - minDb;

  if (peakHoldBuf && peakHoldAge) {
    for (let i = 0; i < binCount; i++) {
      const db = fftBuf[i];
      if (db > peakHoldBuf[i]) { peakHoldBuf[i] = db; peakHoldAge[i] = 0; }
      else if (!peakHoldFrozen) {
        peakHoldAge[i]++;
        if (peakHoldAge[i] > PEAK_HOLD_FRAMES) peakHoldBuf[i] = Math.max(peakHoldBuf[i] - PEAK_DECAY_RATE, db);
      }
    }
  }

  ctx.save();
  ctx.beginPath();
  let started = false, lastX = PAD.l + cw;
  for (let i = 1; i < binCount; i++) {
    const freq = (i / binCount) * nyquist;
    if (freq < AX_FMIN || freq > AX_FMAX) continue;
    const x = xp(freq);
    if (x < PAD.l || x > PAD.l + cw) continue;
    const norm = Math.max(0, Math.min(1, (fftBuf[i] - minDb) / dbRange));
    const y = PAD.t + ch - norm * ch;
    if (!started) { ctx.moveTo(x, PAD.t + ch); ctx.lineTo(x, y); started = true; }
    else ctx.lineTo(x, y);
    lastX = x;
  }
  ctx.lineTo(lastX, PAD.t + ch);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, PAD.t, 0, PAD.t + ch);
  grad.addColorStop(0, TH.fftFill0);
  grad.addColorStop(0.5, TH.fftFill1);
  grad.addColorStop(1, 'rgba(0,229,255,0.01)');
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath(); started = false;
  for (let i = 1; i < binCount; i++) {
    const freq = (i / binCount) * nyquist;
    if (freq < AX_FMIN || freq > AX_FMAX) continue;
    const x = xp(freq);
    if (x < PAD.l || x > PAD.l + cw) continue;
    const norm = Math.max(0, Math.min(1, (fftBuf[i] - minDb) / dbRange));
    const y = PAD.t + ch - norm * ch;
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  if (CFG.glow) { ctx.shadowColor = TH.fftGlow; ctx.shadowBlur = 5; }
  ctx.strokeStyle = TH.fftLine; ctx.lineWidth = 1.4;
  ctx.stroke();

  if (peakHoldBuf && showPeakHoldLine) {
    ctx.beginPath(); started = false;
    for (let i = 1; i < binCount; i++) {
      const freq = (i / binCount) * nyquist;
      if (freq < AX_FMIN || freq > AX_FMAX) continue;
      const x = xp(freq);
      if (x < PAD.l || x > PAD.l + cw) continue;
      const pkDb = peakHoldBuf[i];
      if (pkDb <= minDb + 1) continue;
      const norm = Math.max(0, Math.min(1, (pkDb - minDb) / dbRange));
      const y = PAD.t + ch - norm * ch;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    if (CFG.glow) { ctx.shadowColor = peakHoldFrozen ? '#ffffff' : '#ffbe3c'; ctx.shadowBlur = 4; }
    ctx.strokeStyle = peakHoldFrozen ? 'rgba(255,255,255,0.90)' : 'rgba(255,190,60,0.85)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
  ctx.restore();

  if (withDbScale) {
    ctx.fillStyle = TH.fftLine; ctx.font = '8px Share Tech Mono,monospace'; ctx.textAlign = 'right';
    [0, 0.25, 0.5, 0.75, 1].forEach(frac => {
      ctx.fillText((maxDb - frac * dbRange).toFixed(0) + 'dB', PAD.l + cw - 2, PAD.t + frac * ch + 9);
    });
  }
}

// ═══════════════════════════════════════════════════════════
// SPECTROGRAM MODE — frequency on X, time scrolling DOWN.
// The frequency axis is deliberately identical to FFT mode so the EQ
// band markers stay meaningful as vertical lines across both.
// ═══════════════════════════════════════════════════════════
let sgMap = null, sgImg = null, sgW = 0, sgPlotW = 0, sgPlotH = 0;

function sizeSpectrogram() {
  const cv = document.getElementById('sgCanvas');
  const W = cv.parentElement.clientWidth;
  if (W < 2) return;
  // Deliberately 1:1 device pixels — this is a blit, not vector art, and
  // dpr-scaling it triples the per-frame cost for no readable detail.
  cv.width = W; cv.height = analyzerH();
  cv.style.width = W + 'px'; cv.style.height = analyzerH() + 'px';
  sgW = W;
  sgPlotW = Math.max(1, Math.round(W - PAD.l - PAD.r));
  sgPlotH = Math.max(1, Math.round(analyzerH() - PAD.t - PAD.b));

  const ctx = cv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = TH.chartBg; ctx.fillRect(0, 0, W, analyzerH());
  ctx.fillStyle = '#000';     ctx.fillRect(PAD.l, PAD.t, sgPlotW, sgPlotH);

  sgAllocStrip();
  sgMap = (fftAnalyser && audioCtx)
    ? buildLogMap(sgPlotW, fftAnalyser.frequencyBinCount, audioCtx.sampleRate, AX_FMIN, AX_FMAX, false)
    : null;
  updateSpeedInfo();
}

// Column buffer only — deliberately does NOT clear the canvas, so changing
// scroll speed keeps the history already on screen.
function sgAllocStrip() {
  if (sgPlotW < 1) return;
  const cv = document.getElementById('sgCanvas');
  const ctx = cv.getContext('2d');
  sgImg = ctx.createImageData(sgPlotW, sgPx());
}

function drawSgOverlay() {
  const cv = document.getElementById('sgOverlay');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.parentElement.clientWidth;
  if (W < 2) return;
  cv.width = W * dpr; cv.height = analyzerH() * dpr;
  cv.style.width = W + 'px'; cv.style.height = analyzerH() + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, analyzerH());

  const cw = W - PAD.l - PAD.r, ch = analyzerH() - PAD.t - PAD.b;
  const xp = f => PAD.l + Math.log10(f / AX_FMIN) / AX_DECADES * cw;

  LABEL_FREQS.forEach(f => {
    ctx.fillStyle = TH.axisLabel; ctx.font = '10px Share Tech Mono,monospace'; ctx.textAlign = 'center';
    ctx.fillText(fLabel(f), xp(f), PAD.t + ch + 18);
  });

  // EQ band markers — same four verticals as FFT mode
  [100, state.loMidFreq, state.hiMidFreq, 5000].forEach(f => {
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
    ctx.beginPath(); ctx.moveTo(xp(f), PAD.t); ctx.lineTo(xp(f), PAD.t + ch); ctx.stroke();
    ctx.setLineDash([]);
  });

  ctx.fillStyle = TH.axisTitle; ctx.font = '9px Share Tech Mono,monospace'; ctx.textAlign = 'center';
  ctx.fillText('FREQUENCY (Hz)', PAD.l + cw / 2, analyzerH() - 3);
  ctx.save(); ctx.translate(11, PAD.t + ch / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText('TIME ↓', 0, 0); ctx.restore();

  if (!fftEnabled) {
    ctx.fillStyle = TH.axisLabel; ctx.font = '11px Share Tech Mono,monospace'; ctx.textAlign = 'center';
    ctx.fillText(audioRunning ? 'Press Run to start the analyzer'
                              : 'Enable audio, then press Run', PAD.l + cw / 2, PAD.t + ch / 2);
  }
}

function sgFrame() {
  if (!fftEnabled || !fftAnalyser || !sgImg || !sgMap) return;

  // Below 1×, hold the picture for `skip` frames instead of advancing.
  if (++sgSkipCount < sgSkip()) return;
  sgSkipCount = 0;

  const cv = document.getElementById('sgCanvas');
  const ctx = cv.getContext('2d');
  const th = sgPx();

  fftAnalyser.getByteFrequencyData(fftByteBuf);

  // Scroll the plot region down by `th` rows, then write the new slice on top.
  ctx.drawImage(cv,
    PAD.l, PAD.t,      sgPlotW, sgPlotH - th,
    PAD.l, PAD.t + th, sgPlotW, sgPlotH - th);

  renderColumn(sgImg, fftByteBuf, sgMap, sgPlotW, th, false);
  ctx.putImageData(sgImg, PAD.l, PAD.t);
}

function setAnalyzerMode(mode) {
  if (mode !== 'fft' && mode !== 'sg') return;
  analyzerMode = mode;
  document.getElementById('modeFftBtn').classList.toggle('active', mode === 'fft');
  document.getElementById('modeSgBtn').classList.toggle('active', mode === 'sg');
  document.getElementById('layerFft').classList.toggle('active', mode === 'fft');
  document.getElementById('layerSg').classList.toggle('active', mode === 'sg');
  document.getElementById('speedRow').style.display = mode === 'sg' ? '' : 'none';
  hideProbe();
  if (mode === 'sg') { sizeSpectrogram(); drawSgOverlay(); }
  else drawFftChart();
}

// ═══════════════════════════════════════════════════════════
// MIX CHART — schematic curves + live FFT underneath
// ═══════════════════════════════════════════════════════════
function drawMixChart() {
  const s = setupCanvas('mixChart', 220);
  if (!s) return;
  const { ctx, W, H } = s;
  const { cw, ch, xp, yp } = drawAxes(ctx, W, H);

  const refY = PAD.t + ch - DISPLAY_FLAT * ch;
  ctx.strokeStyle = TH.refLine; ctx.lineWidth = 1; ctx.setLineDash([4, 6]);
  ctx.beginPath(); ctx.moveTo(PAD.l, refY); ctx.lineTo(PAD.l + cw, refY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = TH.refText; ctx.font = '8px Share Tech Mono,monospace'; ctx.textAlign = 'left';
  ctx.fillText('0 dB', PAD.l + 3, refY - 3);

  drawBandMarkers(ctx, ch, xp);

  // Live FFT sits underneath the schematic curves
  drawFftOverlay(ctx, cw, ch, xp, false);

  if (showInstruments) {
    drawCurve(ctx, hhCurve,     xp, yp, TH.hh,     1.3, false);
    drawCurve(ctx, snareCurve,  xp, yp, TH.snare,  1.3, false);
    drawCurve(ctx, kickCurve,   xp, yp, TH.kick,   1.8, false);
    drawCurve(ctx, guitarCurve, xp, yp, TH.guitar, 2.0, true);
  }
  drawCurve(ctx, flatBassCurve, xp, yp, TH.bassGhost, 1.5, false, [4, 5]);
  drawCurve(ctx, applyEQ(flatBassCurve), xp, yp, TH.bass, 2.8, true);
}

function toggleInstruments() {
  showInstruments = !showInstruments;
  const btn = document.getElementById('instrBtn');
  btn.textContent = showInstruments ? 'Mix: ON' : 'Mix: OFF';
  btn.classList.toggle('active', showInstruments);
  drawMixChart();
  if (document.getElementById('refModal').classList.contains('open')) drawRefChart();
}

// ═══════════════════════════════════════════════════════════
// ANALYZER RUN / PEAK HOLD
// ═══════════════════════════════════════════════════════════
function toggleFFT() {
  if (!audioRunning || !fftAnalyser) {
    document.getElementById('fftInfo').textContent = 'Enable audio first';
    return;
  }
  fftEnabled = !fftEnabled;
  const btn = document.getElementById('fftBtn');
  btn.textContent = fftEnabled ? 'Run: ON' : 'Run: OFF';
  btn.classList.toggle('active', fftEnabled);
  document.getElementById('holdBtn').style.display  = fftEnabled ? '' : 'none';
  document.getElementById('resetBtn').style.display = fftEnabled ? '' : 'none';

  if (fftEnabled) {
    document.getElementById('fftInfo').innerHTML =
      `<em>${(audioCtx.sampleRate / 2 / 1000).toFixed(0)} kHz · ${fftAnalyser.frequencyBinCount} bins · ${(audioCtx.sampleRate / fftAnalyser.fftSize).toFixed(1)} Hz/bin</em>`;
    resetPeakHold();
    if (analyzerMode === 'sg') sizeSpectrogram();
  } else {
    peakHoldFrozen = false;
    document.getElementById('fftInfo').textContent = '';
  }
  redrawStatic();
}

function togglePeakHold() {
  if (!fftEnabled) return;
  peakHoldFrozen = !peakHoldFrozen;
  const btn = document.getElementById('holdBtn');
  btn.textContent = peakHoldFrozen ? 'Hold: ON' : 'Hold: OFF';
  btn.classList.toggle('active', peakHoldFrozen);
}

function resetPeakHold() {
  if (peakHoldBuf) peakHoldBuf.fill(-Infinity);
  if (peakHoldAge) peakHoldAge.fill(0);
  peakHoldFrozen = false;
  const btn = document.getElementById('holdBtn');
  if (btn) { btn.textContent = 'Hold: OFF'; btn.classList.remove('active'); }
}

function togglePeakLine() {
  showPeakHoldLine = !showPeakHoldLine;
  const btn = document.getElementById('peakLineBtn');
  btn.textContent = showPeakHoldLine ? 'Peak line: ON' : 'Peak line: OFF';
  btn.classList.toggle('active', showPeakHoldLine);
  if (!fftEnabled) redrawStatic();
}

// ═══════════════════════════════════════════════════════════
// OSCILLOSCOPE (behind a disclosure button)
// ═══════════════════════════════════════════════════════════
let scopeMode = 'in';
let scopeOpen = false;
let scopeInAna = null, scopeOutAna = null;
let scopeInWave = null, scopeOutWave = null;
let scopePeakDecay = 0;

function toggleScopePanel() {
  scopeOpen = !scopeOpen;
  const btn = document.getElementById('scopeDisclosure');
  const card = document.getElementById('scopeCard');
  btn.textContent = (scopeOpen ? '▾ ' : '▸ ') + 'Oscilloscope';
  btn.classList.toggle('open', scopeOpen);
  card.classList.toggle('open', scopeOpen);
  if (scopeOpen && !audioRunning) stopScope();
}

function setScopeMode(mode) {
  scopeMode = mode;
  ['In', 'Out', 'Both'].forEach(m => {
    document.getElementById('scopeBtn' + m).classList.toggle('active', mode === m.toLowerCase());
  });
}

function buildScopeNodes() {
  scopeInAna  = audioCtx.createAnalyser();
  scopeOutAna = audioCtx.createAnalyser();
  scopeInAna.fftSize  = CFG.scopeFftSize;
  scopeOutAna.fftSize = CFG.scopeFftSize;
  scopeInAna.smoothingTimeConstant  = 0;
  scopeOutAna.smoothingTimeConstant = 0;
  inGainNode.connect(scopeInAna);
  outGainNode.connect(scopeOutAna);
  scopeInWave  = new Float32Array(scopeInAna.fftSize);
  scopeOutWave = new Float32Array(scopeOutAna.fftSize);
}

function sizeScope() {
  const canvas = document.getElementById('scopeCanvas');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.parentElement.clientWidth, H = 140;
  if (W < 2) return null;
  if (canvas.width !== Math.round(W * dpr)) {
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  }
  return { canvas, dpr, W, H };
}

function drawScopeFrame() {
  if (!scopeInAna || !scopeOutAna) return;
  const sz = sizeScope();
  if (!sz) return;
  const { canvas, dpr, W, H } = sz;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  scopeInAna.getFloatTimeDomainData(scopeInWave);
  scopeOutAna.getFloatTimeDomainData(scopeOutWave);

  ctx.fillStyle = TH.scopeBg; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = TH.scopeGrid; ctx.lineWidth = 1;
  [0.25, 0.5, 0.75].forEach(fr => {
    ctx.beginPath(); ctx.moveTo(0, fr * H); ctx.lineTo(W, fr * H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(fr * W, 0); ctx.lineTo(fr * W, H); ctx.stroke();
  });
  ctx.strokeStyle = TH.scopeZero;
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();

  const clipY0 = H * 0.04, clipY1 = H * 0.96;
  ctx.strokeStyle = 'rgba(255,77,77,0.30)'; ctx.setLineDash([4, 6]);
  ctx.beginPath(); ctx.moveTo(0, clipY0); ctx.lineTo(W, clipY0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, clipY1); ctx.lineTo(W, clipY1); ctx.stroke();
  ctx.setLineDash([]);

  function drawWave(data, color, glowColor, yOffset) {
    let triggerIdx = 0;
    for (let i = 1; i < data.length - W; i++) {
      if (data[i - 1] < 0 && data[i] >= 0) { triggerIdx = i; break; }
    }
    ctx.save();
    if (CFG.glow) { ctx.shadowColor = glowColor; ctx.shadowBlur = 8; }
    ctx.strokeStyle = color; ctx.lineWidth = 1.8;
    ctx.beginPath();
    const drawLen = Math.min(data.length - triggerIdx, W * 2);
    for (let i = 0; i < drawLen; i++) {
      const x = (i / drawLen) * W;
      const y = (H / 2) - (data[triggerIdx + i] * (H * 0.45)) + yOffset;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.restore();
    let peak = 0;
    for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
    return peak;
  }

  let peakValIn = 0, peakValOut = 0;
  if (scopeMode === 'in' || scopeMode === 'both')
    peakValIn = drawWave(scopeInWave, TH.bass, TH.fftGlow, scopeMode === 'both' ? -6 : 0);
  if (scopeMode === 'out' || scopeMode === 'both')
    peakValOut = drawWave(scopeOutWave, TH.snare, TH.snare, scopeMode === 'both' ? 6 : 0);

  const clipping = peakValIn > 0.95 || peakValOut > 0.95;
  if (clipping) scopePeakDecay = 60;
  else if (scopePeakDecay > 0) scopePeakDecay--;

  ctx.beginPath(); ctx.arc(W - 12, 12, 5, 0, Math.PI * 2);
  ctx.fillStyle = scopePeakDecay > 0 ? '#ff4d4d' : '#1e2e2e';
  ctx.fill();

  const peak = Math.max(peakValIn, peakValOut);
  const peakDb = peak > 0.0001 ? (20 * Math.log10(peak)).toFixed(1) + ' dBFS' : '-inf';
  document.getElementById('scopeInfo').innerHTML =
    `<em>Peak: ${peakDb}</em>${scopePeakDecay > 0 ? ' &nbsp;<span style="color:#ff4d4d">CLIP</span>' : ''}`;

  ctx.fillStyle = TH.scopeText; ctx.font = '8px Share Tech Mono,monospace'; ctx.textAlign = 'left';
  ctx.fillText('+1.0', 4, clipY0 + 9);
  ctx.fillText('-1.0', 4, clipY1 - 3);
  ctx.fillText('0', 4, H / 2 - 3);
}

function stopScope() {
  const sz = sizeScope();
  if (!sz) return;
  const { canvas, dpr, W, H } = sz;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = TH.scopeBg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = TH.scopeZero; ctx.font = '11px Share Tech Mono,monospace'; ctx.textAlign = 'center';
  ctx.fillText('Enable audio to activate oscilloscope', W / 2, H / 2);
  document.getElementById('scopeInfo').innerHTML = '<em>—</em>';
}

// ═══════════════════════════════════════════════════════════
// UNIFIED UI LOOP + FRAME-TIME READOUT
// One rAF for meters, gate, analyzer, scope and spectrum. The frame
// timer exists so the first Pi Zero boot gives real numbers, not guesses.
// ═══════════════════════════════════════════════════════════
let uiRaf = null;
// ── Draw budget ────────────────────────────────────────────
// Mobile caps analyzer redraws at 30 fps: imperceptible for a spectrum
// display, and roughly halves main-thread work over 8192 bins.
//
// "Mobile" uses the same query as the CSS touch breakpoint, so the two
// definitions cannot drift apart.
const mqCoarse = window.matchMedia ? window.matchMedia('(hover: none) and (pointer: coarse)') : null;
const DRAW_MS_MOBILE = 1000 / 30;   // 33.3 ms
const DRAW_MS_SCRIPTPROC = 50;      // ~20 fps, see below
function drawIntervalMs() {
  let ms = (mqCoarse && mqCoarse.matches) ? DRAW_MS_MOBILE : 0;
  // The ScriptProcessor host shares this thread. A 512-sample buffer is
  // 10.7 ms of headroom and a full-rate canvas redraw will eat it and
  // crackle. Stricter than the mobile cap, so it wins where both apply.
  if (detune.engaged && dtLoadedVia === 'ScriptProcessor') ms = Math.max(ms, DRAW_MS_SCRIPTPROC);
  return ms;
}

let frameWorkMs = 0, frameDeltaMs = 0, frameLastT = 0, frameReportT = 0;

function startUiLoop() {
  if (uiRaf) cancelAnimationFrame(uiRaf);
  frameLastT = 0; frameReportT = 0;
  const loop = ts => {
    uiRaf = requestAnimationFrame(loop);
    const t0 = performance.now();

    // Meters stay at full rate: they are cheap and they should feel live.
    tickMeters();

    // Drawing is what gets throttled. Returning here leaves the frame-time
    // readout measuring draw-to-draw, which is the rate we actually care
    // about, rather than the rAF rate underneath it.
    const minMs = drawIntervalMs();
    if (minMs && frameLastT && t0 - frameLastT < minMs) return;

    if (frameLastT) frameDeltaMs = frameDeltaMs * 0.9 + (t0 - frameLastT) * 0.1;
    frameLastT = t0;

    if (activeTab === 'preamp') {
      if (fftEnabled) { if (analyzerMode === 'fft') drawFftChart(); else sgFrame(); }
      if (scopeOpen) drawScopeFrame();
    } else if (activeTab === 'mix') {
      if (fftEnabled) drawMixChart();
    } else if (activeTab === 'spectrum') {
      sxFrame();
    }

    const t1 = performance.now();
    frameWorkMs = frameWorkMs * 0.9 + (t1 - t0) * 0.1;

    if (t1 - frameReportT > 500) {
      frameReportT = t1;
      const el = document.getElementById('frameInfo');
      const fps = frameDeltaMs > 0 ? (1000 / frameDeltaMs) : 0;
      el.innerHTML = `frame <em>${frameWorkMs.toFixed(1)} ms</em> · ${fps.toFixed(0)} fps`;
      el.classList.toggle('hot', frameWorkMs > 12);
    }
  };
  uiRaf = requestAnimationFrame(loop);
}

function stopUiLoop() {
  if (uiRaf) { cancelAnimationFrame(uiRaf); uiRaf = null; }
  frameWorkMs = frameDeltaMs = 0;
}

// ═══════════════════════════════════════════════════════════
// FREQUENCY CROSSHAIR (FFT mode only — the spectrogram's axes differ)
// ═══════════════════════════════════════════════════════════
const NOTE_MAP = [
  [41.2,'E1'],[43.7,'F1'],[46.2,'F#1'],[49.0,'G1'],[51.9,'G#1'],
  [55.0,'A1'],[58.3,'A#1'],[61.7,'B1'],[65.4,'C2'],[69.3,'C#2'],
  [73.4,'D2'],[77.8,'D#2'],[82.4,'E2'],[87.3,'F2'],[92.5,'F#2'],
  [98.0,'G2'],[103.8,'G#2'],[110,'A2'],[116.5,'A#2'],[123.5,'B2'],
  [130.8,'C3'],[138.6,'C#3'],[146.8,'D3'],[155.6,'D#3'],[164.8,'E3'],
  [174.6,'F3'],[185,'F#3'],[196,'G3'],[207.7,'G#3'],[220,'A3'],
  [233.1,'A#3'],[246.9,'B3'],[261.6,'C4'],[277.2,'C#4'],[293.7,'D4'],
  [311.1,'D#4'],[329.6,'E4'],[349.2,'F4'],[370,'F#4'],[392,'G4'],
  [415.3,'G#4'],[440,'A4']
];
function nearestNote(freq) {
  let best = NOTE_MAP[0], bestDist = Infinity;
  for (const [f, n] of NOTE_MAP) {
    const cents = Math.abs(1200 * Math.log2(freq / f));
    if (cents < bestDist) { bestDist = cents; best = [f, n]; }
  }
  return bestDist < 50 ? best[1] : null;
}
function chartXtoFreq(canvas, clientX) {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const cw = rect.width - PAD.l - PAD.r;
  const t = (x - PAD.l) / cw;
  if (t < 0 || t > 1) return null;
  return AX_FMIN * Math.pow(AX_FMAX / AX_FMIN, t);
}
function freqDisplay(f) {
  if (f >= 1000) return (f / 1000).toFixed(f >= 10000 ? 1 : 2) + ' kHz';
  return f.toFixed(0) + ' Hz';
}
// Both analyzer modes share the same log-frequency X axis, so one probe
// serves both. Only the dB lookup differs: FFT mode reads the float buffer,
// spectrogram mode reads the byte buffer it just blitted.
const PROBE_LAYERS = {
  fft: { hit: 'fftCanvas',   draw: 'crosshairCanvas' },
  sg:  { hit: 'sgCrosshair', draw: 'sgCrosshair' }
};

function drawProbeLine(drawId, rect, clientX) {
  const cc = document.getElementById(drawId);
  const dpr = window.devicePixelRatio || 1;
  const W = rect.width, H = analyzerH();
  if (W < 2) return;
  cc.width = W * dpr; cc.height = H * dpr;
  cc.style.width = W + 'px'; cc.style.height = H + 'px';
  const ctx = cc.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const x = clientX - rect.left;
  const ch = H - PAD.t - PAD.b;
  ctx.strokeStyle = TH.crosshair; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
  ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + ch); ctx.stroke();
  ctx.setLineDash([]);
  // A small tick at the top edge so the line is findable on a busy spectrogram
  ctx.fillStyle = TH.crosshair;
  ctx.beginPath(); ctx.moveTo(x - 4, PAD.t); ctx.lineTo(x + 4, PAD.t); ctx.lineTo(x, PAD.t + 6);
  ctx.closePath(); ctx.fill();
}

function probeDbAt(freq) {
  if (!fftEnabled || !fftAnalyser || !audioCtx) return null;
  const nyquist = audioCtx.sampleRate / 2;
  const bin = Math.round((freq / nyquist) * fftAnalyser.frequencyBinCount);
  if (bin <= 0 || bin >= fftAnalyser.frequencyBinCount) return null;
  const minDb = fftAnalyser.minDecibels, maxDb = fftAnalyser.maxDecibels;
  if (analyzerMode === 'sg') {
    if (!fftByteBuf) return null;
    // Byte data is the same dB window, quantised to 0..255.
    const db = minDb + (fftByteBuf[bin] / 255) * (maxDb - minDb);
    return fftByteBuf[bin] > 2 ? db : null;
  }
  if (!fftBuf) return null;
  return fftBuf[bin] > minDb + 1 ? fftBuf[bin] : null;
}

function showProbe(clientX, clientY) {
  const layer = PROBE_LAYERS[analyzerMode];
  if (!layer) return;
  const hitEl = document.getElementById(layer.hit);
  const rect = hitEl.getBoundingClientRect();
  const freq = chartXtoFreq(hitEl, clientX);
  if (!freq) { hideProbe(); return; }

  drawProbeLine(layer.draw, rect, clientX);

  const note = nearestNote(freq);
  let label = freqDisplay(freq);
  if (note) label += '  ·  ' + note;
  const db = probeDbAt(freq);
  if (db !== null) label += '  ·  ' + db.toFixed(1) + ' dB';

  const tip = document.getElementById('freqTooltip');
  tip.textContent = label;
  tip.style.display = 'block';
  tip.style.left = Math.max(6, Math.min(clientX + 14, window.innerWidth - tip.offsetWidth - 16)) + 'px';
  tip.style.top  = Math.max(6, clientY - 30) + 'px';
}

function hideProbe() {
  document.getElementById('freqTooltip').style.display = 'none';
  ['crosshairCanvas', 'sgCrosshair'].forEach(id => {
    const cc = document.getElementById(id);
    if (!cc) return;
    const ctx = cc.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cc.width, cc.height);
  });
}

// Pointer events cover mouse, pen and touch in one path. On touch the probe
// follows the finger while held and clears on release; on a mouse it tracks
// hover, as before.
// A touch drag that starts on the analyzer must still scroll the page. The
// analyzer is sticky, so it is under the thumb for most of a portrait screen;
// claiming every pointerdown here (which this used to do) meant a swipe that
// began on the chart scrolled nothing.
//
// Two halves: touch-action: pan-y in the CSS lets the browser take vertical
// pans natively and hand us a pointercancel, and the handler below refuses to
// claim a touch gesture until it is clearly horizontal — the only direction a
// frequency probe travels in. A tap still reads a frequency.
const PROBE_SLOP = 8;   // px of travel before deciding scroll vs probe

function wireProbe() {
  ['fftCanvas', 'sgCrosshair'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    let held = false, pid = null, x0 = 0, y0 = 0, decided = false;

    const capture = e => {
      if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (err) {} }
    };
    const release = () => { held = false; pid = null; decided = false; hideProbe(); };

    el.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse') {
        held = true; decided = true; pid = e.pointerId;
        capture(e); showProbe(e.clientX, e.clientY); e.preventDefault();
        return;
      }
      // Touch: read the frequency immediately so a tap still works, but do not
      // capture and do not preventDefault — the page has to stay scrollable.
      pid = e.pointerId; x0 = e.clientX; y0 = e.clientY;
      held = false; decided = false;
      showProbe(e.clientX, e.clientY);
    });

    el.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse') { showProbe(e.clientX, e.clientY); return; }
      if (e.pointerId !== pid) return;
      if (!decided) {
        const dx = Math.abs(e.clientX - x0), dy = Math.abs(e.clientY - y0);
        if (dx < PROBE_SLOP && dy < PROBE_SLOP) return;   // too small to call
        decided = true;
        if (dy >= dx) { release(); return; }              // vertical: let it scroll
        held = true; capture(e);
      }
      if (held) { showProbe(e.clientX, e.clientY); e.preventDefault(); }
    });

    el.addEventListener('pointerup',     release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave',  e => { if (e.pointerType === 'mouse') hideProbe(); });
  });
}

// ═══════════════════════════════════════════════════════════
// MODAL
// ═══════════════════════════════════════════════════════════
function openRef() {
  document.getElementById('refModal').classList.add('open');
  requestAnimationFrame(drawRefChart);
}
function closeRef() { document.getElementById('refModal').classList.remove('open'); }
function closeRefModal(e) { if (e.target === document.getElementById('refModal')) closeRef(); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeRef(); });
