// ═══════════════════════════════════════════════════════════
// DETUNE — WSOLA pitch shifter
//
// Placement: FIRST in the chain, ahead of the drive section, the way a
// drop-tune pedal goes in front of a preamp.
//
//   inGain ─┬─ inAnalyser
//           ├─ tunerAnalyser        ← always UNSHIFTED, so you tune strings
//           └─ [wsola] ─┬─ dryGain  (B7K clean leg)
//                       └─ grunt…   (B7K wet leg)
//
// Unlike the Spectrum tab this is an EFFECT, not an analysis tool, so it is
// not tab-scoped: it stays engaged when you leave the tab. To keep that from
// being invisible, the Preamp audio bar carries a badge while it is on.
// ═══════════════════════════════════════════════════════════

const detune = { semis: 0, cents: 0, mix: 100, engaged: false, profile: 'balanced' };
const DETUNE_KEY = 'b7k_detune';

let dtNode = null;
let dtEngine = null;
let dtModuleUrl = null;
let dtModuleLoaded = false;
let dtLoadedVia = null;
let dtLatencySec = 0;
let dtMomentary = false;

// Open strings on the SR305, 4-string standard tuning.
const OPEN_STRINGS = [
  { name: 'E1', hz: 41.203 },
  { name: 'A1', hz: 55.000 },
  { name: 'D2', hz: 73.416 },
  { name: 'G2', hz: 98.000 }
];

function detuneRatio() {
  const s = dtMomentary ? -12 : detune.semis;
  const c = dtMomentary ? 0 : detune.cents;
  return Math.pow(2, (s + c / 100) / 12);
}
function detuneIsUnity() {
  return !dtMomentary && detune.semis === 0 && detune.cents === 0;
}

function dtSay(msg, err) {
  const el = document.getElementById('dtStatus');
  el.innerHTML = msg;
  el.classList.toggle('err', !!err);
}

function saveDetune() {
  try {
    localStorage.setItem(DETUNE_KEY, JSON.stringify({
      semis: detune.semis, cents: detune.cents, mix: detune.mix, profile: detune.profile
    }));
  } catch (e) {}
}
function loadDetune() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem(DETUNE_KEY) || 'null'); } catch (e) {}
  if (!o || typeof o !== 'object') return;
  detune.semis = pnum(o.semis, 0, -12, 12);
  detune.cents = pnum(o.cents, 0, -50, 50);
  detune.mix   = pnum(o.mix, 100, 0, 100);
  if (WSOLA_PROFILES[o.profile]) detune.profile = o.profile;
}

// ── Engine hosting ─────────────────────────────────────────
// The DSP (createWsolaCore) is identical either way; only the host differs.
//
//   AudioWorklet  — audio thread, glitch-resistant. Needs the module to LOAD,
//                   which is impossible from file:// no matter what you do.
//   ScriptProcessor — main thread, deprecated but universally available and
//                   requires no module loading at all. This is what makes the
//                   app work as a standalone double-clicked file.
//
// NOTE: isSecureContext is TRUE on file:// in Chrome, so it is not a usable
// guard for this — the protocol has to be checked directly.
const DT_WORKLET_BLOCKED = (typeof location !== 'undefined' && location.protocol === 'file:');

async function loadWorkletModule() {
  if (DT_WORKLET_BLOCKED) throw new Error('file:// cannot load worklet modules');
  if (!audioCtx.audioWorklet) throw new Error('no AudioWorklet in this browser');
  if (dtModuleLoaded) return;

  const tried = [];
  // 1. Sibling file: same origin, real MIME type, no CSP question.
  try {
    await audioCtx.audioWorklet.addModule('wsola-worklet.js');
    dtModuleLoaded = true; return;
  } catch (e) { tried.push('wsola-worklet.js → ' + (e.name || 'Error') + ': ' + e.message); }

  // 2. Inline copy via Blob: works when the sibling file isn't deployed;
  //    a script-src CSP forbidding blob: will reject it.
  try {
    if (!dtModuleUrl) {
      const el = document.getElementById('wsolaSrc');
      if (!el || !el.textContent.trim()) throw new Error('inline worklet source is empty');
      dtModuleUrl = URL.createObjectURL(new Blob([el.textContent], { type: 'text/javascript' }));
    }
    await audioCtx.audioWorklet.addModule(dtModuleUrl);
    dtModuleLoaded = true; return;
  } catch (e) { tried.push('inline blob → ' + (e.name || 'Error') + ': ' + e.message); }

  const err = new Error('worklet module would not load');
  err.detail = tried;
  throw err;
}

// Builds whichever engine this environment can actually run.
// Returns { node, setParams(ratio, mix), latencySec, kind, dispose() }.
async function buildDetuneEngine() {
  if (!audioCtx) throw new Error('audio is not running');

  if (!DT_WORKLET_BLOCKED && audioCtx.audioWorklet) {
    try {
      await loadWorkletModule();
      const node = new AudioWorkletNode(audioCtx, 'wsola', {
        numberOfInputs: 1, numberOfOutputs: 1,
        outputChannelCount: [1], channelCount: 1,
        channelCountMode: 'explicit', channelInterpretation: 'discrete',
        processorOptions: { profile: WSOLA_PROFILES[detune.profile] }
      });
      const pRatio = node.parameters.get('ratio');
      const pMix   = node.parameters.get('mix');
      return {
        node, kind: 'AudioWorklet',
        latencySec: (WSOLA_PROFILES[detune.profile].coreMs + 128 / audioCtx.sampleRate * 1000) / 1000,
        setParams(r, m) {
          const t = audioCtx.currentTime;
          // Glide rather than jump: a step change in ratio lurches the read
          // head and ticks audibly.
          pRatio.setTargetAtTime(r, t, 0.03);
          pMix.setTargetAtTime(m, t, 0.02);
        },
        dispose() { try { node.port.onmessage = null; } catch (e) {} try { node.disconnect(); } catch (e) {} }
      };
    } catch (e) {
      console.warn('[Detune] worklet unavailable, falling back to ScriptProcessor', e, e.detail || '');
    }
  }

  // ── ScriptProcessorNode fallback ──
  // Deprecated, main-thread, and it will glitch if the page is busy. It is
  // also the only thing that runs from a plain double-clicked file, which
  // matters more here than the deprecation warning does.
  if (!audioCtx.createScriptProcessor) throw new Error('no AudioWorklet and no ScriptProcessor — nothing can host the shifter');
  // 512 rather than 4096. The big buffer was costing 85 ms of pure block
  // latency for glitch headroom we can get more cheaply by throttling the
  // analyzer while this host is live (see uiLoop).
  const BUF = 512;
  const node = audioCtx.createScriptProcessor(BUF, 1, 1);
  const core = createWsolaCore(audioCtx.sampleRate, WSOLA_PROFILES[detune.profile]);
  let ratio = 1, mix = 1, tRatio = 1, tMix = 1;
  node.onaudioprocess = e => {
    // Smooth toward the target in the audio callback — there are no
    // AudioParams here, so the glide has to be done by hand.
    ratio += (tRatio - ratio) * 0.35;
    mix   += (tMix - mix) * 0.35;
    const out = e.outputBuffer.getChannelData(0);
    const inCh = e.inputBuffer.numberOfChannels ? e.inputBuffer.getChannelData(0) : null;
    core.process(inCh, out, out.length, ratio, mix);
  };
  return {
    node, kind: 'ScriptProcessor',
    latencySec: WSOLA_PROFILES[detune.profile].coreMs / 1000 + BUF / audioCtx.sampleRate,
    setParams(r, m) { tRatio = r; tMix = m; },
    dispose() { try { node.onaudioprocess = null; } catch (e) {} try { node.disconnect(); } catch (e) {} }
  };
}

function applyDetuneParams() {
  if (!dtEngine) return;
  const r = Math.max(0.25, Math.min(4, num(detuneRatio(), 1)));
  const m = Math.max(0, Math.min(1, num(detune.mix / 100, 1)));
  dtEngine.setParams(r, m);
}

async function toggleDetune() {
  if (detune.engaged) { detuneDisengage(); return; }
  if (!audioRunning || !audioCtx) {
    dtSay('Enable audio on the Preamp tab first', true);
    return;
  }
  const btn = document.getElementById('dtEngage');
  btn.disabled = true;
  dtSay('Starting pitch-shift engine…');
  try {
    dtEngine = await buildDetuneEngine();
    if (!audioCtx || !inGainNode) { dtEngine.dispose(); dtEngine = null; throw new Error('audio stopped while loading'); }

    dtNode = dtEngine.node;
    dtLoadedVia = dtEngine.kind;
    dtLatencySec = dtEngine.latencySec;
    if (dtNode.port) {
      dtNode.port.onmessage = e => {
        if (e.data && e.data.type === 'ready') { dtLatencySec = e.data.latencySec; renderDetune(); }
      };
    }
    dtNode.onprocessorerror = () => {
      dtSay('Pitch-shift processor failed — disengaged.', true);
      detuneDisengage();
    };

    applyDetuneParams();

    // Splice in ahead of the drive section.
    inGainNode.disconnect(dryGainNode);
    inGainNode.disconnect(gruntFilter);
    inGainNode.connect(dtNode);
    dtNode.connect(dryGainNode);
    dtNode.connect(gruntFilter);

    detune.engaged = true;
    dtSay(`<em>Engaged</em> · ${dtEngine.kind}`);
    renderDetune();
  } catch (err) {
    console.error('[Detune]', err, err.detail || '');
    let msg = 'Could not start: ' + err.message;
    if (err.detail) {
      msg += '<br><span style="color:var(--dim)">on ' + location.origin +
             '<br>' + err.detail.map(t => '· ' + t).join('<br>') + '</span>';
    }
    dtSay(msg, true);
    dtEngine = null; dtNode = null;
    detune.engaged = false;
    renderDetune();
  } finally {
    btn.disabled = false;
  }
}

function detuneDisengage() {
  if (detune.engaged && dtNode && inGainNode) {
    try {
      inGainNode.disconnect(dtNode);
      inGainNode.connect(dryGainNode);
      inGainNode.connect(gruntFilter);
    } catch (e) { console.warn('[Detune] unsplice', e); }
  }
  if (dtEngine) { try { dtEngine.dispose(); } catch (e) {} }
  dtEngine = null;
  dtNode = null;
  detune.engaged = false;
  dtSay(audioRunning ? 'Disengaged — signal path is direct again'
                     : 'Enable audio on the Preamp tab, then engage');
  renderDetune();
}

// Called from stopAudio(): the context is going away, so drop everything.
function detuneReset() {
  if (dtEngine) { try { dtEngine.dispose(); } catch (e) {} }
  dtEngine = null;
  dtNode = null;
  detune.engaged = false;
  dtModuleLoaded = false;   // a new AudioContext needs the module added again
  dtLatencySec = 0;
  dtMomentary = false;
  renderDetune();
}

// ── Controls ───────────────────────────────────────────────
async function setDetuneProfile(name) {
  if (!WSOLA_PROFILES[name] || name === detune.profile) return;
  detune.profile = name;
  saveDetune();
  if (detune.engaged) {
    // Window sizes are baked in at construction, so the engine has to be
    // rebuilt. Drop out and back in rather than trying to resize live.
    detuneDisengage();
    await toggleDetune();
  }
  renderDetune();
}

function setDetunePreset(semis) {
  detune.semis = pnum(semis, 0, -12, 12);
  detune.cents = 0;
  saveDetune();
  applyDetuneParams();
  renderDetune();
}

function wireDetune() {
  const bind = (id, key, min, max) => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      detune[key] = pnum(el.value, detune[key], min, max);
      saveDetune(); applyDetuneParams(); renderDetune();
    });
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const step = parseFloat(el.step) || 1;
      const next = Math.min(max, Math.max(min, num(parseFloat(el.value), 0) + (e.deltaY < 0 ? step : -step)));
      el.value = next; detune[key] = next;
      saveDetune(); applyDetuneParams(); renderDetune();
    }, { passive: false });
  };
  bind('dtSemisKnob', 'semis', -12, 12);
  bind('dtCentsKnob', 'cents', -50, 50);
  bind('dtBlendKnob', 'mix',     0, 100);

  const mom = document.getElementById('dtMom');
  const down = e => {
    e.preventDefault();
    if (dtMomentary) return;
    dtMomentary = true;
    mom.classList.add('held');
    applyDetuneParams(); renderDetune();
  };
  const up = () => {
    if (!dtMomentary) return;
    dtMomentary = false;
    mom.classList.remove('held');
    applyDetuneParams(); renderDetune();
  };
  mom.addEventListener('pointerdown', e => {
    if (mom.setPointerCapture) { try { mom.setPointerCapture(e.pointerId); } catch (err) {} }
    down(e);
  });
  mom.addEventListener('pointerup', up);
  mom.addEventListener('pointercancel', up);
  mom.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') up(); });
  // Keyboard: space/enter held
  mom.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') down(e); });
  mom.addEventListener('keyup',   e => { if (e.key === ' ' || e.key === 'Enter') up(); });
}

// ── Readout ────────────────────────────────────────────────
function hzToNoteLabel(hz) {
  if (!(hz > 0)) return { name: '—', cents: 0 };
  const midi = 12 * Math.log2(hz / 440) + 69;
  const r = Math.round(midi);
  return {
    name: NOTE_NAMES_ASCII[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1),
    cents: Math.round((midi - r) * 100)
  };
}

function renderDetune() {
  const panel = document.getElementById('panel-detune');
  if (!panel) return;

  const effSemis = dtMomentary ? -12 : detune.semis;
  const effCents = dtMomentary ? 0 : detune.cents;
  const r = detuneRatio();

  // Sliders + labels
  const semisEl = document.getElementById('dtSemisKnob');
  const centsEl = document.getElementById('dtCentsKnob');
  const blendEl = document.getElementById('dtBlendKnob');
  if (parseFloat(semisEl.value) !== detune.semis) semisEl.value = detune.semis;
  if (parseFloat(centsEl.value) !== detune.cents) centsEl.value = detune.cents;
  if (parseFloat(blendEl.value) !== detune.mix)   blendEl.value = detune.mix;
  document.getElementById('dtSemisVal').textContent = (detune.semis > 0 ? '+' : '') + detune.semis;
  document.getElementById('dtCentsVal').textContent = (detune.cents > 0 ? '+' : '') + detune.cents + ' ¢';
  document.getElementById('dtBlendVal').textContent =
    detune.mix >= 100 ? '100% shifted' : detune.mix <= 0 ? '100% dry' : detune.mix + '% shifted';

  // Big readout
  const big = document.getElementById('dtSemisBig');
  big.textContent = (effSemis > 0 ? '+' : '') + effSemis;
  big.classList.toggle('zero', effSemis === 0 && effCents === 0);
  document.getElementById('dtSemisSub').textContent =
    dtMomentary ? 'semitones · momentary octave'
    : (effSemis === 0 && effCents === 0) ? 'semitones · unity'
    : 'semitones' + (effCents ? ` ${effCents > 0 ? '+' : ''}${effCents} ¢` : '');
  document.getElementById('dtRatio').innerHTML =
    `ratio <em>${r.toFixed(4)}</em> · added latency <em>${
      detune.engaged && dtLatencySec ? (dtLatencySec * 1000).toFixed(0) + ' ms' : '—'}</em>`;

  // Response profile
  const prof = WSOLA_PROFILES[detune.profile] || WSOLA_PROFILES.balanced;
  document.getElementById('dtProfileVal').textContent = prof.label;
  const blockMs = dtEngine
    ? (dtEngine.kind === 'ScriptProcessor' ? 512 : 128) / (audioCtx ? audioCtx.sampleRate : 48000) * 1000
    : (DT_WORKLET_BLOCKED ? 512 : 128) / 48000 * 1000;
  document.getElementById('dtProfileSub').textContent =
    `tracks down to ${prof.floorHz} Hz · ${prof.note} · ~${Math.round(prof.coreMs + blockMs)} ms`;
  document.querySelectorAll('#dtProfiles button').forEach(b => {
    b.classList.toggle('active', b.dataset.prof === detune.profile);
  });

  // Preset buttons
  document.querySelectorAll('#dtPresets button').forEach(b => {
    b.classList.toggle('active', !dtMomentary && detune.cents === 0 &&
                                  parseInt(b.dataset.dt, 10) === detune.semis);
  });

  // Resulting open-string pitches
  document.getElementById('dtStrings').innerHTML = OPEN_STRINGS.map(s => {
    const hz = s.hz * r;
    const n = hzToNoteLabel(hz);
    const shifted = Math.abs(r - 1) > 1e-6;
    return `<div class="dt-string${shifted ? ' shifted' : ''}">
      <div class="from">${s.name} →</div>
      <div class="to">${n.name}</div>
      <div class="hz">${hz.toFixed(1)} Hz${n.cents ? ` ${n.cents > 0 ? '+' : ''}${n.cents}¢` : ''}</div>
    </div>`;
  }).join('');

  // Engage button + engine note
  const btn = document.getElementById('dtEngage');
  btn.textContent = detune.engaged ? '⏹ Disengage' : '⏻ Engage';
  btn.classList.toggle('active', detune.engaged);

  const eng = document.getElementById('dtEngine');
  if (detune.engaged && detuneIsUnity()) {
    eng.className = 'dt-engine';
    eng.innerHTML = 'Engaged at unity — the shifter passes through untouched. Move Semitones off zero to hear it work.';
  } else {
    eng.className = 'dt-engine';
    const hostNote = dtLoadedVia === 'ScriptProcessor'
      ? 'Host: <em>ScriptProcessor</em> (main thread — works from a plain file, but can glitch while the analyzer is drawing; leave Run off if you hear breakup). '
      : dtLoadedVia === 'AudioWorklet'
        ? 'Host: <em>AudioWorklet</em> (audio thread). '
        : (DT_WORKLET_BLOCKED ? 'Opened from <em>file://</em>, so the ScriptProcessor host will be used. ' : '');
    eng.innerHTML = hostNote +
      `Engine: <em>WSOLA</em> — ${prof.seqMs} ms window · ${prof.ovlMs} ms crossfade · ±${prof.seekMs} ms search. ` +
      'Latency is set almost entirely by that search, which must span one full period of the lowest note ' +
      'you want to track. Dropping the floor from 31 Hz to 55 Hz is what buys back the milliseconds — ' +
      `below <em>${prof.floorHz} Hz</em> on this setting the pitch goes wrong, not merely rough. ` +
      'Quality falls off on chords; single notes and power intervals hold up best.';
  }

  // Badge on the Preamp audio bar — this effect outlives the tab, so say so.
  const badge = document.getElementById('detuneBadge');
  if (detune.engaged && !detuneIsUnity()) {
    badge.style.display = '';
    badge.textContent = `· detune ${effSemis > 0 ? '+' : ''}${effSemis} st${effCents ? ` ${effCents > 0 ? '+' : ''}${effCents}¢` : ''}`;
  } else {
    badge.style.display = 'none';
  }
}
