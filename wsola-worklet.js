// GENERATED — do not edit.
// Source of truth is parts/wsola_core.js + parts/wsola_wrapper.js.
// An identical copy lives inline in bass_mix_interactive.html.
//@@GENERATED-HEADER-END
// ═══════════════════════════════════════════════════════════
// WSOLA pitch-shift core — host-agnostic.
//
// Deliberately plain: no AudioWorklet references, no DOM, no imports. It is
// compiled into TWO places by the build, byte for byte identical:
//   · the AudioWorklet module (wsola-worklet.js + the inline copy)
//   · the main page script, for the ScriptProcessorNode fallback
// verify.js fails if the two copies ever drift.
//
// Pitch shift = time-stretch by the pitch ratio, then resample by the same
// ratio. Net duration unchanged; net pitch multiplied.
//
// The stretch is WSOLA: each output frame is spliced from the input at the
// offset (within a search window) whose leading samples correlate best with
// the tail being crossfaded out. That search is what keeps successive frames
// phase-coherent — without it you get the periodic warble of naive granular.
// ═══════════════════════════════════════════════════════════
// Response profiles. `coreMs` is the MEASURED onset delay of each profile
// (dsptest re-measures and fails if these numbers drift), not a formula.
// `floorHz` is the lowest input fundamental that still shifts accurately —
// below it the pitch goes wrong, it does not merely sound worse.
var WSOLA_PROFILES = {
  tight:    { label: 'Tight',    seqMs: 16, ovlMs: 5,  seekMs: 9.2,  floorHz: 55, coreMs: 26.2, note: 'A string and up' },
  balanced: { label: 'Balanced', seqMs: 20, ovlMs: 6,  seekMs: 12.2, floorHz: 41, coreMs: 39.1, note: 'full 4-string range' },
  deep:     { label: 'Deep',     seqMs: 32, ovlMs: 10, seekMs: 16.7, floorHz: 31, coreMs: 63.5, note: '5-string low B' }
};

function createWsolaCore(sr, opts) {
  // WINDOW SIZING IS NOT A FREE PARAMETER — it is a latency/range trade.
  //
  // The search span (2 x SEEK, symmetric) must cover at least one full period
  // of the lowest note ON THE INPUT, or the splice can never reach the
  // phase-continuous point and the shift gets quantised away: small shifts
  // vanish entirely and large ones land a percent off.
  //
  //   lowest input note   period    minimum span
  //   B0  30.9 Hz         32.4 ms   ±16.2 ms   (5-string)
  //   E1  41.2 Hz         24.3 ms   ±12.2 ms   (4-string, SR305)
  //   A1  55.0 Hz         18.2 ms   ± 9.1 ms
  //   D2  73.4 Hz         13.6 ms   ± 6.8 ms
  //
  // Latency tracks that span directly, which is why the profiles below buy
  // responsiveness by giving up the bottom of the range. Everything above the
  // chosen floor still shifts correctly; below it the pitch goes wrong.
  const o = opts || {};
  const SEQ    = Math.round(sr * (o.seqMs  !== undefined ? o.seqMs  : 32) / 1000);
  const OVL    = Math.round(sr * (o.ovlMs  !== undefined ? o.ovlMs  : 10) / 1000);
  const SEEK   = Math.round(sr * (o.seekMs !== undefined ? o.seekMs : 16.7) / 1000);
  const OUT    = SEQ - OVL;                // samples emitted per frame
  const DIRECT = SEQ - 2 * OVL;

  const CAP = 1 << 16;                     // power of two: cheap wrap
  const M   = CAP - 1;
  const inBuf = new Float32Array(CAP);
  const stBuf = new Float32Array(CAP);

  const mid = new Float32Array(OVL);
  const fadeIn = new Float32Array(OVL);
  const fadeOut = new Float32Array(OVL);
  for (let i = 0; i < OVL; i++) {
    const w = 0.5 - 0.5 * Math.cos(Math.PI * i / (OVL - 1));
    fadeIn[i] = w; fadeOut[i] = 1 - w;
  }

  const dryDelay = SEQ + SEEK;             // align dry with the wet latency

  let inWrite = 0;        // absolute sample count written
  let inRead  = SEEK;     // absolute float read head (the search looks back by SEEK)
  let stWrite = 0;        // absolute count written into the stretched FIFO
  let stRead  = 0;        // absolute float read head (resampling)
  let midValid = false;
  let primed = false;     // see the jitter-buffer note in process()

  // Best splice offset in [-SEEK, +SEEK]: maximise normalised correlation
  // between the tail being faded out and the candidate's leading samples.
  //
  // The range is SYMMETRIC on purpose. The per-frame phase correction needed
  // is (OUT - nominalSkip) mod period, which accumulates in one direction and
  // must be able to wrap by a whole period in the other. A one-sided [0,SEEK]
  // range hits the boundary and locks onto a wrong offset, which is precisely
  // how the shift gets quantised away.
  //
  // Coarse pass on a decimated grid, then a narrow refine. The small |off|
  // penalty breaks ties toward the least disruptive splice; on a steady tone
  // every period-multiple correlates equally well.
  function seekBest(pos) {
    let best = 0, bestScore = -1e30;
    const scan = (from, to, step) => {
      for (let off = from; off <= to; off += step) {
        let corr = 0, norm = 1e-9;
        let idx = (pos + off) & M;
        for (let i = 0; i < OVL; i += 4) {
          const s = inBuf[idx];
          corr += mid[i] * s;
          norm += s * s;
          idx = (idx + 4) & M;
        }
        const score = corr / Math.sqrt(norm) - 0.02 * (off < 0 ? -off : off) / SEEK;
        if (score > bestScore) { bestScore = score; best = off; }
      }
    };
    scan(-SEEK, SEEK, 4);
    scan(Math.max(-SEEK, best - 4), Math.min(SEEK, best + 4), 1);
    return best;
  }

  function produceFrame(ratio) {
    const pos = Math.floor(inRead) & M;
    const off = midValid ? seekBest(pos) : 0;
    let src = (pos + off) & M;
    let dst = stWrite & M;

    if (midValid) {
      for (let i = 0; i < OVL; i++) {
        stBuf[dst] = mid[i] * fadeOut[i] + inBuf[src] * fadeIn[i];
        dst = (dst + 1) & M; src = (src + 1) & M;
      }
    } else {
      for (let i = 0; i < OVL; i++) {
        stBuf[dst] = inBuf[src];
        dst = (dst + 1) & M; src = (src + 1) & M;
      }
    }
    for (let i = 0; i < DIRECT; i++) {
      stBuf[dst] = inBuf[src];
      dst = (dst + 1) & M; src = (src + 1) & M;
    }
    for (let i = 0; i < OVL; i++) {
      mid[i] = inBuf[src]; src = (src + 1) & M;
    }
    midValid = true;
    stWrite += OUT;
    // Stretch factor equals the pitch ratio; the resampler undoes the duration
    // change, so input and output consume at the same average rate.
    inRead += OUT / ratio;
  }

  function resync() {
    inRead = inWrite - SEQ - SEEK;
    if (inRead < SEEK) inRead = SEEK;
    stRead = stWrite;
    midValid = false;
    primed = false;
  }

  return {
    latencySec: (SEQ + SEEK) / sr,
    seq: SEQ, ovl: OVL, seek: SEEK,
    reset() { inWrite = 0; inRead = SEEK; stWrite = 0; stRead = 0; midValid = false; },

    // inCh may be null (no input connected). out is written in place.
    process(inCh, out, n, ratioRaw, mixRaw) {
      let w = inWrite & M;
      if (inCh) for (let i = 0; i < n; i++) { inBuf[w] = inCh[i]; w = (w + 1) & M; }
      else      for (let i = 0; i < n; i++) { inBuf[w] = 0;       w = (w + 1) & M; }
      inWrite += n;

      let ratio = ratioRaw;
      if (!(ratio > 0.25)) ratio = 0.25;
      if (!(ratio < 4)) ratio = ratio > 4 ? 4 : (ratio >= 0.25 ? ratio : 1);
      if (!Number.isFinite(ratio)) ratio = 1;
      let mix = Number.isFinite(mixRaw) ? mixRaw : 1;
      if (mix < 0) mix = 0; else if (mix > 1) mix = 1;

      // Unity: skip the machine and pass through, but keep the same delay so
      // crossing unity doesn't jump in time.
      if (Math.abs(ratio - 1) < 1e-4) {
        const base = inWrite - n - dryDelay;
        for (let i = 0; i < n; i++) out[i] = inBuf[(base + i) & M];
        resync();
        return;
      }

      // JITTER BUFFER.
      // Frames are produced whole (OUT samples) but consumed continuously, so
      // a block wanting 2.9 frames gets 2 or 3. With 128-sample blocks that
      // rounding is invisible. With the 4096-sample blocks the ScriptProcessor
      // host uses, a single block needs ~3 frames at once and the input
      // lookahead cannot stretch that far — production stalls mid-block and
      // the shortfall came out as zero-filled samples, which measured as a
      // ~15 cent pitch error and sounded like dropouts.
      //
      // Fix: keep one spare frame in hand whenever a block spans more than one
      // frame, and don't start consuming until that cushion exists. Cost is a
      // frame of extra latency on the large-block host only; the worklet path
      // asks for zero cushion and is unchanged.
      const cushion = (n * ratio > OUT) ? OUT : 0;
      const target = stRead + n * ratio + 2 + cushion;
      let guard = 0;
      while (stWrite < target && guard++ < 512) {
        // Need SEQ+SEEK of lookahead ahead of the read head, and SEEK of
        // history behind it for the backward half of the search.
        if (inWrite - Math.floor(inRead) < SEQ + SEEK + 4) break;
        if (inRead < SEEK) break;
        produceFrame(ratio);
      }

      const dryBase = inWrite - n - dryDelay;

      // While filling the cushion, pass the dry signal rather than silence —
      // engaging then sounds like the effect fading in, not like a dropout.
      if (!primed) {
        if (stWrite - stRead >= n * ratio + cushion) primed = true;
        else {
          for (let i = 0; i < n; i++) out[i] = inBuf[(dryBase + i) & M];
          return;
        }
      }

      for (let i = 0; i < n; i++) {
        let wet = 0;
        if (stRead + 1 < stWrite) {
          const i0 = Math.floor(stRead);
          const fr = stRead - i0;
          wet = stBuf[i0 & M] * (1 - fr) + stBuf[(i0 + 1) & M] * fr;
          stRead += ratio;
        }
        const dry = inBuf[(dryBase + i) & M];
        out[i] = wet * mix + dry * (1 - mix);
      }

      // If the read head has fallen far behind (long stall, context suspend),
      // snap forward rather than grinding through the backlog.
      if (inWrite - inRead > CAP * 0.75) resync();
    }
  };
}
// @@WSOLA-CORE-END

// ── AudioWorklet host ───────────────────────────────────────
// Thin wrapper. All the DSP is in createWsolaCore above, which is shared
// byte-for-byte with the ScriptProcessorNode fallback in the page.
class WsolaProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4.0, automationRate: 'k-rate' },
      { name: 'mix',   defaultValue: 1, minValue: 0,    maxValue: 1,   automationRate: 'k-rate' }
    ];
  }
  constructor(options) {
    super();
    // Window sizes come across at construction; they cannot change live.
    const profile = (options && options.processorOptions && options.processorOptions.profile)
      || WSOLA_PROFILES.balanced;
    this.core = createWsolaCore(sampleRate, profile);
    this.port.postMessage({
      type: 'ready',
      latencySec: this.core.latencySec,
      seq: this.core.seq, ovl: this.core.ovl, seek: this.core.seek
    });
  }
  process(inputs, outputs, params) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const inCh = inputs[0] && inputs[0][0];
    this.core.process(inCh, out, out.length, params.ratio[0], params.mix[0]);
    return true;
  }
}
registerProcessor('wsola', WsolaProcessor);
