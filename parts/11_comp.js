// ═══════════════════════════════════════════════════════════
// COMPRESSOR — feed-forward, no lookahead
//
// Measured by impulse at 48 kHz before this was written:
//     BiquadFilter                 0 samples   0.00 ms
//     WaveShaper oversample none   0 samples   0.00 ms
//     WaveShaper oversample 4x    91 samples   1.90 ms
//     DynamicsCompressorNode     288 samples   6.00 ms
//     AudioWorklet, no lookahead   0 samples   0.00 ms
//
// The built-in node's 6 ms is its lookahead, which is what buys it a softer
// knee. Doing without costs a slightly harder knee and buys back every
// sample — which is the trade this app has made everywhere else.
//
// The DSP core is written ONCE, below, and handed to the worklet as source
// text via Function.prototype.toString(). One source of truth, so the copy
// running in the audio thread cannot drift from the copy you can read — the
// failure the WSOLA core needs a build-time equality check to prevent.
// ═══════════════════════════════════════════════════════════

// NOTE: stringified into an AudioWorklet. It must close over nothing.
function makeCompCore(sampleRate) {
  let env = 0, gr = 0;
  return {
    reduction: function () { return gr; },
    reset: function () { env = 0; gr = 0; },
    process: function (inp, out, p) {
      const aC = Math.exp(-1 / (sampleRate * p.attack));
      const rC = Math.exp(-1 / (sampleRate * p.release));
      const mk = Math.pow(10, p.makeup / 20);
      const th = p.threshold, kn = p.knee;
      const slope = 1 - 1 / p.ratio;
      let worst = 0;
      for (let i = 0; i < inp.length; i++) {
        const x = inp[i];
        const ax = x < 0 ? -x : x;
        // One-pole envelope. Attack when rising, release when falling.
        const co = ax > env ? aC : rC;
        env = co * env + (1 - co) * ax;
        const db = 20 * Math.log10(env > 1e-8 ? env : 1e-8);
        const over = db - th;
        let red = 0;
        if (kn > 0 && over > -kn / 2 && over < kn / 2) {
          const t = over + kn / 2;          // quadratic soft knee
          red = -slope * t * t / (2 * kn);
        } else if (over >= kn / 2) {
          red = -slope * over;
        }
        if (red < worst) worst = red;
        out[i] = x * Math.pow(10, red / 20) * mk;
      }
      gr = worst;
    }
  };
}

const COMP_WRAPPER = `
class BassComp extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.core = makeCompCore(sampleRate);
    // Params arrive at CONSTRUCTION, not by message: a postMessage is
    // delivered asynchronously, so the first blocks would otherwise run on
    // defaults and the envelope would start from the wrong coefficients.
    this.p = (options && options.processorOptions) ||
             { threshold: -24, ratio: 4, attack: 0.005, release: 0.12, makeup: 0, knee: 6 };
    this.n = 0;
    this.port.onmessage = e => { this.p = e.data; };
  }
  process(inputs, outputs) {
    const i = inputs[0], o = outputs[0];
    if (!o || !o.length) return true;
    if (!i || !i.length) { for (const c of o) c.fill(0); return true; }
    this.core.process(i[0], o[0], this.p);
    for (let c = 1; c < o.length; c++) o[c].set(o[0]);
    if ((this.n++ & 7) === 0) this.port.postMessage(this.core.reduction());
    return true;
  }
}
registerProcessor('bass-comp', BassComp);
`;

// AudioWorklet modules cannot be fetched from file://; the protocol has to be
// checked directly, because isSecureContext is true there. Same lesson as the
// detune worklet and the wah's tilt.
const COMP_WORKLET_BLOCKED = (typeof location !== 'undefined' && location.protocol === 'file:');

const COMP_KEY = 'b7k_comp';
const comp = {
  on: false, threshold: -24, ratio: 4, attack: 5, release: 120, makeup: 0, knee: 6
};
let compNode = null, compOut = null, compSpliced = false;
let compHost = '—', compGr = 0, compModuleAdded = false;

const compParams = () => ({
  threshold: num(comp.threshold, -24),
  ratio:     Math.max(1, num(comp.ratio, 4)),
  attack:    Math.max(0.0002, num(comp.attack, 5) / 1000),
  release:   Math.max(0.01, num(comp.release, 120) / 1000),
  makeup:    num(comp.makeup, 0),
  knee:      Math.max(0, num(comp.knee, 6))
});

function compSend() {
  if (!compNode) return;
  const p = compParams();
  if (compNode.port) { compNode.port.postMessage(p); return; }
  // built-in fallback
  const t = audioCtx.currentTime;
  compNode.threshold.setTargetAtTime(p.threshold, t, 0.01);
  compNode.ratio.setTargetAtTime(p.ratio, t, 0.01);
  compNode.attack.setTargetAtTime(p.attack, t, 0.01);
  compNode.release.setTargetAtTime(p.release, t, 0.01);
  compNode.knee.setTargetAtTime(p.knee, t, 0.01);
}

async function compBuild() {
  if (!audioCtx || compNode) return;
  if (!COMP_WORKLET_BLOCKED && audioCtx.audioWorklet) {
    try {
      if (!compModuleAdded) {
        const src = makeCompCore.toString() + '\n' + COMP_WRAPPER;
        const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
        await audioCtx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        compModuleAdded = true;
      }
      compNode = new AudioWorkletNode(audioCtx, 'bass-comp', { processorOptions: compParams() });
      compNode.port.onmessage = e => { compGr = e.data; };
      compHost = 'AudioWorklet · 0 ms';
      compSend(); compSyncUI();
      return;
    } catch (e) {
      console.warn('[Comp] worklet unavailable, falling back:', e.message);
    }
  }
  // Fallback is the built-in node, not a ScriptProcessor: 6 ms of lookahead
  // beats ~10 ms of block latency, and it is native code rather than more of
  // ours running on the main thread.
  compNode = audioCtx.createDynamicsCompressor();
  compHost = 'DynamicsCompressor · 6 ms';
  compSend(); compSyncUI();
}

// Sits between the input and the preamp, the way a comp sits ahead of a
// preamp on a board. The tuner and input meter stay on inGainNode, so they
// keep seeing the raw instrument.
function compSplice() {
  if (compSpliced || !compNode || !compOut || !dtOut || !audioCtx) return;
  try {
    dtOut.disconnect(compOut);
    dtOut.connect(compNode);
    compNode.connect(compOut);
    compSpliced = true;
  } catch (e) { console.warn('[Comp] splice', e); }
}
function compUnsplice() {
  if (!compSpliced) return;
  try {
    dtOut.disconnect(compNode);
    compNode.disconnect(compOut);
    dtOut.connect(compOut);
  } catch (e) { console.warn('[Comp] unsplice', e); }
  compSpliced = false;
  compGr = 0;
}

// Called from stopAudio(). compBuild() returns early when compNode is set,
// so without this a second Enable Audio would splice a node belonging to a
// closed context into the new graph — and pass no sound at all.
function compReset() {
  compNode = null; compOut = null; compSpliced = false;
  compModuleAdded = false; compGr = 0; compHost = '—';
  compSyncUI();
}

async function compApply() {
  if (!audioRunning || !audioCtx) { compSyncUI(); return; }
  const want = comp.on && !bypassed;
  if (want) { await compBuild(); compSplice(); }
  else compUnsplice();
  compSend();
  compSyncUI();
}

function compToggle() { comp.on = !comp.on; compSave(); compApply(); }
function compSet(key, v) { comp[key] = v; compSave(); compSend(); compSyncUI(); }

function compSave() { try { localStorage.setItem(COMP_KEY, JSON.stringify(comp)); } catch (e) {} }
function compLoad() {
  let raw = null;
  try { raw = localStorage.getItem(COMP_KEY); } catch (e) {}
  if (!raw) return;
  try {
    const o = JSON.parse(raw) || {};
    comp.on = !!o.on;
    comp.threshold = Math.max(-60, Math.min(0,  num(parseFloat(o.threshold), -24)));
    comp.ratio     = Math.max(1,   Math.min(20, num(parseFloat(o.ratio), 4)));
    comp.attack    = Math.max(0.2, Math.min(100, num(parseFloat(o.attack), 5)));
    comp.release   = Math.max(10,  Math.min(1000, num(parseFloat(o.release), 120)));
    comp.makeup    = Math.max(0,   Math.min(24, num(parseFloat(o.makeup), 0)));
    comp.knee      = Math.max(0,   Math.min(24, num(parseFloat(o.knee), 6)));
  } catch (e) {}
}

function compReduction() {
  if (!compSpliced || !compNode) return 0;
  return compNode.port ? compGr : (compNode.reduction || 0);
}

function compSyncUI() {
  const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
  set('compBtn', el => { el.textContent = 'Comp: ' + (comp.on ? 'ON' : 'OFF'); el.classList.toggle('active', comp.on); });
  set('compHost', el => { el.innerHTML = 'engine <em>' + compHost + '</em>'; });
  set('compThreshVal', el => el.textContent = num(comp.threshold, -24).toFixed(0) + ' dB');
  set('compRatioVal',  el => el.textContent = num(comp.ratio, 4).toFixed(1) + ':1');
  set('compAttackVal', el => el.textContent = num(comp.attack, 5).toFixed(1) + ' ms');
  set('compRelVal',    el => el.textContent = Math.round(num(comp.release, 120)) + ' ms');
  set('compMakeupVal', el => el.textContent = '+' + num(comp.makeup, 0).toFixed(1) + ' dB');
  set('compKneeVal',   el => el.textContent = num(comp.knee, 6).toFixed(0) + ' dB');
  document.querySelectorAll('input[data-comp]').forEach(el => {
    const k = el.dataset.comp;
    if (parseFloat(el.value) !== comp[k]) el.value = comp[k];
  });
}

// Gain reduction meter, driven from the existing UI loop.
function compTickMeter() {
  const bar = document.getElementById('compGrBar');
  const txt = document.getElementById('compGrVal');
  if (!bar) return;
  const gr = Math.max(-24, Math.min(0, compReduction()));
  bar.style.width = (Math.abs(gr) / 24 * 100) + '%';
  if (txt) txt.textContent = gr <= -0.1 ? gr.toFixed(1) + ' dB' : '0.0 dB';
}

function wireComp() {
  document.querySelectorAll('input[data-comp]').forEach(el => {
    const k = el.dataset.comp;
    el.addEventListener('input', () => compSet(k, parseFloat(el.value)));
    el.addEventListener('wheel', e => {
      if (document.activeElement !== el) return;   // the wheel belongs to the page
      e.preventDefault();
      const step = parseFloat(el.step) || 1, dir = e.deltaY < 0 ? 1 : -1;
      const v = Math.min(parseFloat(el.max), Math.max(parseFloat(el.min), parseFloat(el.value) + dir * step));
      el.value = v; compSet(k, v);
    }, { passive: false });
  });
}

function initComp() { compLoad(); wireComp(); compSyncUI(); }
