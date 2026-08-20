// ═══════════════════════════════════════════════════════════
// SPECTRUM TAB — port of overtone-scope.html
//
// Faithful to the original except for three deliberate changes:
//   · The scope's own autocorrelation pitch detector is NOT ported.
//     The ladder is fed from the tuner's MPM/NSDF detector on the
//     pre-EQ tap, which is strictly better on a weak fundamental.
//   · File-load and test-tone sources are NOT ported. Live input only.
//   · The filter chain is connected on tab entry and disconnected on
//     tab exit, so nothing here can alter your tone on the Preamp tab.
//     Mute/solo state lives in JS and is restored on re-entry.
//
// Node count: 12 notches (one per harmonic) + 2 bandpass for solo = 14
// BiquadFilterNodes, exactly as in the original NF = NH + 2.
// ═══════════════════════════════════════════════════════════

const SX_NH = 12;                 // harmonics tracked
const SX_NF = SX_NH + 2;          // 12 notches + 2 bandpass
const SX_FMIN = 60, SX_FMAX = 6000;
const SX_LOGMIN = Math.log(SX_FMIN);
const SX_LOGSPAN = Math.log(SX_FMAX) - Math.log(SX_FMIN);

let sxChain = [];
let sxIn = null, sxDispAn = null, sxFreqData = null;
let sxConnected = false;
let sxMuted = {}, sxSolo = 0, sxMode = 'mute', sxLocked = false;
let sxF0 = 0, sxHist = [];
let sxDpr = 1, sxW = 0, sxH = 0, sxMap = null, sxImg = null;
let sxChips = [];
let sxFrameCount = 0;

function sxSay(msg, warn) {
  const el = document.getElementById('sxStatus');
  el.textContent = msg || '';
  el.style.color = warn ? '#ffb26b' : '';
}

function sxFToY(f) { return (1 - (Math.log(f) - SX_LOGMIN) / SX_LOGSPAN) * (sxH / sxDpr); }

// ── Layout / sizing ────────────────────────────────────────
function sxLayout() {
  const spec = document.getElementById('sxSpec');
  const over = document.getElementById('sxOver');
  const axis = document.getElementById('sxAxis');
  const r = spec.getBoundingClientRect();
  if (r.width < 2) return;   // panel hidden

  sxDpr = Math.min(window.devicePixelRatio || 1, 2);
  sxW = Math.max(2, Math.round(r.width * sxDpr));
  sxH = Math.max(2, Math.round(r.height * sxDpr));
  spec.width = sxW; spec.height = sxH;
  over.width = sxW; over.height = sxH;

  const sctx = spec.getContext('2d', { alpha: false });
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.fillStyle = '#000'; sctx.fillRect(0, 0, sxW, sxH);

  const cw = CFG.sgColumns * Math.round(sxDpr);
  sxImg = sctx.createImageData(cw, sxH);
  sxBuildMap();
  sxDrawAxis();
  sxDrawOverlay();
}

function sxBuildMap() {
  if (!sxDispAn || !audioCtx) { sxMap = null; return; }
  // reverse=true → lowest frequency at the bottom of the plot
  sxMap = buildLogMap(sxH, sxDispAn.frequencyBinCount, audioCtx.sampleRate, SX_FMIN, SX_FMAX, true);
}

function sxDrawAxis() {
  const axis = document.getElementById('sxAxis');
  const spec = document.getElementById('sxSpec');
  const r = axis.getBoundingClientRect();
  const h = spec.getBoundingClientRect().height;
  if (r.width < 2) return;
  axis.width = Math.round(r.width * sxDpr);
  axis.height = Math.round(h * sxDpr);
  const ctx = axis.getContext('2d');
  ctx.setTransform(sxDpr, 0, 0, sxDpr, 0, 0);
  const w = r.width;
  ctx.fillStyle = '#05070a'; ctx.fillRect(0, 0, w, h);
  ctx.font = '9px Share Tech Mono,monospace';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  [60, 80, 100, 150, 200, 300, 400, 600, 800, 1000, 1500, 2000, 3000, 4000, 6000].forEach(f => {
    if (f < SX_FMIN || f > SX_FMAX) return;
    const y = (1 - (Math.log(f) - SX_LOGMIN) / SX_LOGSPAN) * h;
    ctx.strokeStyle = '#1b222c';
    ctx.beginPath(); ctx.moveTo(w - 5, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.fillStyle = '#7e8b9c';
    ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), w - 8, Math.min(h - 6, Math.max(6, y)));
  });
  ctx.save();
  ctx.translate(10, h / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.fillStyle = '#4d5866';
  ctx.fillText('frequency (Hz)', 0, 0);
  ctx.restore();
}

// ── Filter chain, created on entry and destroyed on exit ───
function sxBuildNodes() {
  if (!audioCtx || sxChain.length) return;
  sxIn = audioCtx.createGain();
  let prev = sxIn;
  for (let i = 0; i < SX_NF; i++) {
    const f = audioCtx.createBiquadFilter();
    f.type = 'peaking'; f.gain.value = 0; f.Q.value = 1; f.frequency.value = 1000;
    prev.connect(f); prev = f; sxChain.push(f);
  }
  sxDispAn = audioCtx.createAnalyser();
  sxDispAn.fftSize = 4096;
  sxDispAn.smoothingTimeConstant = CFG.sgSmoothing;
  sxDispAn.minDecibels = -96;
  sxDispAn.maxDecibels = -18;
  prev.connect(sxDispAn);
  sxFreqData = new Uint8Array(sxDispAn.frequencyBinCount);
}

function sxDestroyNodes() {
  try { if (sxIn) sxIn.disconnect(); } catch (e) {}
  sxChain.forEach(f => { try { f.disconnect(); } catch (e) {} });
  try { if (sxDispAn) sxDispAn.disconnect(); } catch (e) {}
  sxChain = []; sxIn = null; sxDispAn = null; sxFreqData = null;
}

// Splice the chain into the live path: gate → [chain] → outGain
function spectrumEnter() {
  sxBuildChips();
  sxBuildKeys();
  requestAnimationFrame(sxLayout);

  if (!audioRunning || !audioCtx || !CFG.spectrumFilters) {
    sxSay(audioRunning ? 'Overtone filters disabled in lite mode.'
                       : 'Enable audio on the Preamp tab to see the spectrum.', !audioRunning);
    return;
  }
  if (sxConnected) return;

  sxBuildNodes();
  gateGainNode.disconnect(outGainNode);
  gateGainNode.connect(sxIn);
  sxDispAn.connect(outGainNode);
  sxConnected = true;
  sxBuildMap();

  // Restore mute/solo a beat after splicing so the graph change and the
  // filter-type change don't land in the same render quantum (avoids a click).
  setTimeout(() => { if (sxConnected) sxApplyFilters(); }, 50);
  sxSay('Filters connected. Play a steady note.');
}

// Ramp neutral, then unsplice. force=true skips the ramp (audio is going away).
function spectrumExit(force) {
  if (!sxConnected) { if (force) sxDestroyNodes(); sxConnected = false; return; }

  const unsplice = () => {
    if (!sxConnected) return;
    try {
      gateGainNode.disconnect(sxIn);
      sxDispAn.disconnect(outGainNode);
      gateGainNode.connect(outGainNode);
    } catch (e) { console.warn('[Spectrum] unsplice', e); }
    sxDestroyNodes();
    sxConnected = false;
  };

  if (force || !audioCtx) { unsplice(); return; }

  // Neutralise every filter first so removing them isn't a step change.
  const t = audioCtx.currentTime;
  sxChain.forEach(f => {
    f.type = 'peaking';
    f.Q.value = 1;
    f.gain.setTargetAtTime(0, t, 0.01);
  });
  setTimeout(unsplice, 60);
}

// ── Mute / solo ────────────────────────────────────────────
function sxApplyFilters() {
  if (!audioCtx || !sxChain.length) return;
  const t = audioCtx.currentTime;
  for (let i = 0; i < SX_NF; i++) {
    const f = sxChain[i];
    f.type = 'peaking'; f.gain.value = 0; f.Q.value = 1;
  }
  if (!sxF0) return;
  const nyqLimit = audioCtx.sampleRate / 2 - 100;
  if (sxSolo) {
    for (let k = 0; k < 2; k++) {
      const b = sxChain[SX_NH + k];
      b.type = 'bandpass'; b.Q.value = 14;
      b.frequency.setTargetAtTime(Math.min(sxF0 * sxSolo, nyqLimit), t, 0.02);
    }
  } else {
    for (let n = 1; n <= SX_NH; n++) {
      if (!sxMuted[n]) continue;
      const c = sxChain[n - 1];
      c.type = 'notch'; c.Q.value = 22;
      c.frequency.setTargetAtTime(Math.min(sxF0 * n, nyqLimit), t, 0.02);
    }
  }
}

function sxRetune() {
  if (!audioCtx || !sxF0 || !sxChain.length) return;
  const t = audioCtx.currentTime;
  const nyqLimit = audioCtx.sampleRate / 2 - 100;
  if (sxSolo) {
    for (let k = 0; k < 2; k++) sxChain[SX_NH + k].frequency.setTargetAtTime(Math.min(sxF0 * sxSolo, nyqLimit), t, 0.05);
  } else {
    for (let n = 1; n <= SX_NH; n++) {
      if (sxMuted[n]) sxChain[n - 1].frequency.setTargetAtTime(Math.min(sxF0 * n, nyqLimit), t, 0.05);
    }
  }
}

function sxMedian(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  return a[a.length >> 1];
}

// ── Per-frame ──────────────────────────────────────────────
function sxFrame() {
  if (!sxDispAn || !sxMap || !sxImg) return;
  sxFrameCount++;

  // Pitch comes from the tuner's MPM detector on the pre-EQ tap.
  if (!sxLocked && sxFrameCount % 3 === 0 && tunerAnalyser && tunerBuf) {
    tunerAnalyser.getFloatTimeDomainData(tunerBuf);
    const p = detectPitch(tunerBuf, audioCtx.sampleRate);
    if (p > 0 && p >= 55 && p <= 1600) {
      sxHist.push(p); if (sxHist.length > 7) sxHist.shift();
      const m = sxMedian(sxHist);
      if (!sxF0 || Math.abs(m - sxF0) / sxF0 > 0.004) { sxF0 = m; sxRetune(); }
      else sxF0 = m;
    }
  }

  const spec = document.getElementById('sxSpec');
  const sctx = spec.getContext('2d', { alpha: false });
  const cw = CFG.sgColumns * Math.round(sxDpr);

  sxDispAn.getByteFrequencyData(sxFreqData);
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.drawImage(spec, -cw, 0);                                  // scroll left
  renderColumn(sxImg, sxFreqData, sxMap, sxH, cw, true);         // freq on Y
  sctx.putImageData(sxImg, sxW - cw, 0);

  sxDrawOverlay();
  if (sxFrameCount % 5 === 0) sxUpdateReadout();
}

function sxDrawOverlay() {
  const over = document.getElementById('sxOver');
  if (!over || !sxW) return;
  const ctx = over.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, sxW, sxH);
  if (!sxF0) { sxPositionChips(sxH / sxDpr); return; }
  ctx.setTransform(sxDpr, 0, 0, sxDpr, 0, 0);
  const w = sxW / sxDpr;
  for (let n = 1; n <= SX_NH; n++) {
    const f = sxF0 * n;
    if (f > SX_FMAX) break;
    const y = sxFToY(f);
    const off = sxSolo ? (n !== sxSolo) : !!sxMuted[n];
    ctx.strokeStyle = off ? 'rgba(255,90,90,0.55)' : 'rgba(255,255,255,0.28)';
    ctx.setLineDash(off ? [4, 4] : []);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke();
  }
  ctx.setLineDash([]);
  sxPositionChips(sxH / sxDpr);
}

function sxBuildChips() {
  const ladder = document.getElementById('sxLadder');
  if (sxChips.length) return;
  ladder.innerHTML = ''; sxChips = [];
  for (let n = 1; n <= SX_NH; n++) {
    const c = document.createElement('button');
    c.className = 'chip'; c.type = 'button';
    c.dataset.n = n; c.textContent = 'H' + n;
    c.style.display = 'none';
    c.addEventListener('click', sxOnChip);
    ladder.appendChild(c); sxChips.push(c);
  }
}

function sxPositionChips(h) {
  let last = -99;
  for (let n = 1; n <= SX_NH; n++) {
    const c = sxChips[n - 1];
    if (!c) continue;
    const f = sxF0 * n, y = sxFToY(f);
    if (!sxF0 || f > SX_FMAX || y < 8 || y > h - 8 || (y - last) < 17) { c.style.display = 'none'; continue; }
    last = y;
    c.style.display = 'block';
    c.style.top = y + 'px';
    c.textContent = 'H' + n + ' ' + Math.round(f);
    c.dataset.state = sxSolo === n ? 'solo' : (sxSolo ? 'off' : (sxMuted[n] ? 'muted' : 'on'));
    c.style.opacity = (sxSolo && sxSolo !== n) ? 0.35 : 1;
  }
}

function sxOnChip(e) {
  const n = +e.currentTarget.dataset.n;
  if (sxMode === 'solo') sxSolo = (sxSolo === n) ? 0 : n;
  else { if (sxMuted[n]) delete sxMuted[n]; else sxMuted[n] = 1; }
  sxApplyFilters(); sxSyncKeys(); sxPositionChips(sxH / sxDpr);
}

function sxBuildKeys() {
  const keys = document.getElementById('sxKeys');
  if (keys.children.length) return;
  keys.innerHTML = '';
  for (let n = 1; n <= SX_NH; n++) {
    const b = document.createElement('button');
    b.className = 'sc-btn'; b.type = 'button';
    b.dataset.n = n; b.textContent = 'H' + n;
    b.addEventListener('click', sxOnChip);
    keys.appendChild(b);
  }
}

function sxSyncKeys() {
  const bs = document.getElementById('sxKeys').children;
  for (let i = 0; i < bs.length; i++) {
    const n = +bs[i].dataset.n;
    bs[i].setAttribute('aria-pressed', String(sxMode === 'solo' ? sxSolo === n : !!sxMuted[n]));
  }
}

function sxUpdateReadout() {
  document.getElementById('sxF0').textContent = sxF0 ? sxF0.toFixed(1) : '—';
  document.getElementById('sxNote').textContent = sxNoteOf(sxF0);
}

function sxNoteOf(f) {
  if (!f) return '—';
  const n = Math.round(12 * Math.log2(f / 440)) + 69;
  const cents = Math.round(1200 * Math.log2(f / (440 * Math.pow(2, (n - 69) / 12))));
  return NOTE_NAMES_ASCII[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1) + (cents >= 0 ? ' +' : ' ') + cents + 'c';
}

// ── Toolbar ────────────────────────────────────────────────
function sxToggleMode() {
  sxMode = sxMode === 'mute' ? 'solo' : 'mute';
  const btn = document.getElementById('sxMode');
  btn.textContent = sxMode === 'mute' ? 'Click = mute' : 'Click = solo';
  btn.setAttribute('aria-pressed', String(sxMode === 'solo'));
  sxSolo = 0;
  sxApplyFilters(); sxSyncKeys(); sxPositionChips(sxH / sxDpr);
}
function sxToggleLock() {
  sxLocked = !sxLocked;
  document.getElementById('sxLock').setAttribute('aria-pressed', String(sxLocked));
  sxSay(sxLocked ? ('Pitch locked at ' + sxF0.toFixed(1) + ' Hz.') : 'Pitch tracking resumed.');
}
function sxResetHarmonics() {
  sxMuted = {}; sxSolo = 0;
  sxApplyFilters(); sxSyncKeys(); sxPositionChips(sxH / sxDpr);
  sxSay('All harmonics back on.');
}
