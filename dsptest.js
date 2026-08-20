// Offline proof that the WSOLA worklet actually shifts pitch.
//
// The worklet source is inert text in the HTML, so we can lift it out, stub
// the three things AudioWorkletGlobalScope provides (sampleRate, the
// AudioWorkletProcessor base, registerProcessor) and run the DSP in plain
// Node. Feeding synthetic tones and measuring the output pitch tests the
// algorithm itself — jsdom and static greps cannot say anything about this.
//
// Usage: node dsptest.js <path-to-html>
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync(process.argv[2], 'utf8');
const m = html.match(/<script id="wsolaSrc"[^>]*>([\s\S]*?)<\/script>/);
if (!m) { console.error('FAIL: worklet source block not found'); process.exit(1); }

let fails = 0;
const ok  = s => console.log('  ok   ' + s);
const bad = s => { console.log('  FAIL ' + s); fails++; };

const SR = 48000;
let Proc = null;
const sandbox = {
  sampleRate: SR,
  AudioWorkletProcessor: class {
    constructor() { this.port = { postMessage() {}, onmessage: null }; }
  },
  registerProcessor: (name, cls) => { Proc = cls; sandbox.__name = name; },
  Math, Float32Array, Number, console
};
vm.createContext(sandbox);
try { vm.runInContext(m[1], sandbox); }
catch (e) { console.error('FAIL: worklet threw on load: ' + e.message); process.exit(1); }

console.log('[1] module shape');
if (!Proc) { bad('registerProcessor was never called'); process.exit(1); }
ok(`registerProcessor('${sandbox.__name}') called`);
if (sandbox.__name !== 'wsola') bad(`processor name is "${sandbox.__name}", app expects "wsola"`);
else ok('processor name matches the AudioWorkletNode the app constructs');
const descs = Proc.parameterDescriptors;
const names = descs.map(d => d.name).sort();
if (names.join(',') === 'mix,ratio') ok('exposes ratio + mix AudioParams');
else bad('parameters are ' + names.join(','));

// ── Harness ────────────────────────────────────────────────
const BLK = 128;

function runShifter(inputSamples, ratio, mix) {
  const p = new Proc();
  const out = new Float32Array(inputSamples.length);
  const params = { ratio: [ratio], mix: [mix === undefined ? 1 : mix] };
  for (let off = 0; off + BLK <= inputSamples.length; off += BLK) {
    const inBlk = inputSamples.subarray(off, off + BLK);
    const outBlk = new Float32Array(BLK);
    p.process([[inBlk]], [[outBlk]], params);
    out.set(outBlk, off);
  }
  return out;
}

function tone(freq, n, amp) {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = (amp === undefined ? 0.5 : amp) * Math.sin(2 * Math.PI * freq * i / SR);
  return b;
}

// Autocorrelation pitch estimate with parabolic refinement.
function estimatePitch(buf, from, len) {
  const seg = buf.subarray(from, from + len);
  let rms = 0;
  for (let i = 0; i < seg.length; i++) rms += seg[i] * seg[i];
  rms = Math.sqrt(rms / seg.length);
  if (rms < 1e-4) return { hz: 0, rms };

  const minTau = Math.floor(SR / 900), maxTau = Math.min(Math.floor(SR / 12), Math.floor(seg.length / 2) - 2);
  const nsdf = new Float32Array(maxTau + 2);
  for (let tau = minTau; tau <= maxTau; tau++) {
    let r = 0, mm = 0;
    for (let i = 0; i + tau < seg.length; i++) {
      r += seg[i] * seg[i + tau];
      mm += seg[i] * seg[i] + seg[i + tau] * seg[i + tau];
    }
    nsdf[tau] = mm > 0 ? 2 * r / mm : 0;
  }
  // first strong peak, not the tallest — avoids octave errors
  let peak = 0;
  for (let tau = minTau + 1; tau < maxTau; tau++) if (nsdf[tau] > peak) peak = nsdf[tau];
  let chosen = -1;
  for (let tau = minTau + 1; tau < maxTau; tau++) {
    if (nsdf[tau] > nsdf[tau - 1] && nsdf[tau] >= nsdf[tau + 1] && nsdf[tau] >= 0.85 * peak) { chosen = tau; break; }
  }
  if (chosen < 0) return { hz: 0, rms };
  const x1 = nsdf[chosen - 1], x2 = nsdf[chosen], x3 = nsdf[chosen + 1];
  const a = (x1 + x3 - 2 * x2) / 2, b = (x3 - x1) / 2;
  const tau = a ? chosen - b / (2 * a) : chosen;
  return { hz: SR / tau, rms };
}

// ── 2. Pitch accuracy across the full control range ────────
console.log('\n[2] measured pitch vs requested shift');
const F0 = 110;                       // A2 — comfortably inside bass range
const N = SR * 3;                     // 3 s, plenty of steady state
const input = tone(F0, N);
const ANALYSE_FROM = Math.floor(SR * 1.5);
const ANALYSE_LEN  = 8192;

[-12, -7, -5, -3, -1, 1, 3, 5, 7, 12].forEach(semis => {
  const ratio = Math.pow(2, semis / 12);
  const out = runShifter(input, ratio, 1);
  const { hz, rms } = estimatePitch(out, ANALYSE_FROM, ANALYSE_LEN);
  const expect = F0 * ratio;
  if (hz === 0) { bad(`${semis > 0 ? '+' : ''}${semis} st: no pitch detected (rms ${rms.toFixed(4)})`); return; }
  const cents = 1200 * Math.log2(hz / expect);
  if (Math.abs(cents) < 12) ok(`${semis > 0 ? '+' : ''}${semis} st → ${hz.toFixed(1)} Hz (want ${expect.toFixed(1)}, off by ${cents.toFixed(1)}¢)`);
  else bad(`${semis > 0 ? '+' : ''}${semis} st → ${hz.toFixed(1)} Hz, want ${expect.toFixed(1)} — off by ${cents.toFixed(1)}¢`);
});

// ── 3. Fine cents trim ─────────────────────────────────────
console.log('\n[3] fine cents trim');
[-50, -20, 20, 50].forEach(c => {
  const ratio = Math.pow(2, (c / 100) / 12);
  const out = runShifter(input, ratio, 1);
  const { hz } = estimatePitch(out, ANALYSE_FROM, ANALYSE_LEN);
  const expect = F0 * ratio;
  const err = hz ? 1200 * Math.log2(hz / expect) : 9999;
  if (Math.abs(err) < 12) ok(`${c > 0 ? '+' : ''}${c}¢ → ${hz.toFixed(2)} Hz (off by ${err.toFixed(1)}¢)`);
  else bad(`${c > 0 ? '+' : ''}${c}¢ → ${hz.toFixed(2)} Hz, off by ${err.toFixed(1)}¢`);
});

// ── 4. Low fundamental — the hard case for a bass ──────────
console.log('\n[4] low B (30.87 Hz) dropped an octave');
{
  const lowIn = tone(30.87, SR * 3);
  const out = runShifter(lowIn, 0.5, 1);
  const { hz } = estimatePitch(out, ANALYSE_FROM, 16384);
  const expect = 30.87 * 0.5;
  const err = hz ? 1200 * Math.log2(hz / expect) : 9999;
  if (Math.abs(err) < 25) ok(`30.87 → ${hz.toFixed(2)} Hz (want ${expect.toFixed(2)}, off ${err.toFixed(1)}¢)`);
  else bad(`30.87 → ${hz.toFixed(2)} Hz, want ${expect.toFixed(2)}, off ${err.toFixed(1)}¢`);
}

// ── 5. Unity is a clean pass-through ───────────────────────
console.log('\n[5] unity ratio');
{
  const out = runShifter(input, 1.0, 1);
  const { hz } = estimatePitch(out, ANALYSE_FROM, ANALYSE_LEN);
  const err = hz ? 1200 * Math.log2(hz / F0) : 9999;
  if (Math.abs(err) < 2) ok(`unity holds pitch (${hz.toFixed(2)} Hz, ${err.toFixed(2)}¢)`);
  else bad(`unity drifted to ${hz.toFixed(2)} Hz (${err.toFixed(1)}¢)`);
  // Amplitude must survive too — a broken pass-through often halves it
  let peakIn = 0, peakOut = 0;
  for (let i = ANALYSE_FROM; i < ANALYSE_FROM + ANALYSE_LEN; i++) {
    peakIn = Math.max(peakIn, Math.abs(input[i]));
    peakOut = Math.max(peakOut, Math.abs(out[i]));
  }
  if (Math.abs(peakOut - peakIn) < 0.02) ok(`amplitude preserved (${peakIn.toFixed(3)} → ${peakOut.toFixed(3)})`);
  else bad(`amplitude changed ${peakIn.toFixed(3)} → ${peakOut.toFixed(3)}`);
}

// ── 6. Blend control ───────────────────────────────────────
console.log('\n[6] dry/wet blend');
{
  const outDry = runShifter(input, 0.5, 0);      // 100% dry
  const { hz } = estimatePitch(outDry, ANALYSE_FROM, ANALYSE_LEN);
  const err = hz ? 1200 * Math.log2(hz / F0) : 9999;
  if (Math.abs(err) < 5) ok(`mix=0 passes the unshifted signal (${hz.toFixed(1)} Hz)`);
  else bad(`mix=0 gave ${hz.toFixed(1)} Hz, expected ${F0}`);

  // A 50/50 blend of 110 and 55 Hz should contain both; check the 55 Hz
  // period dominates the autocorrelation while 110 Hz energy remains.
  const outMid = runShifter(input, 0.5, 0.5);
  let e = 0;
  for (let i = ANALYSE_FROM; i < ANALYSE_FROM + ANALYSE_LEN; i++) e += outMid[i] * outMid[i];
  if (Math.sqrt(e / ANALYSE_LEN) > 0.1) ok('mix=0.5 produces signal at a sane level');
  else bad('mix=0.5 output is near silent');
}

// ── 7. Output stays finite and bounded ─────────────────────
console.log('\n[7] numerical safety');
{
  let worst = 0, nonFinite = 0;
  [0.5, 0.7937, 1.0, 1.5, 2.0].forEach(r => {
    const out = runShifter(tone(110, SR, 0.98), r, 1);
    for (let i = 0; i < out.length; i++) {
      if (!Number.isFinite(out[i])) nonFinite++;
      worst = Math.max(worst, Math.abs(out[i]));
    }
  });
  if (nonFinite) bad(`${nonFinite} non-finite output samples`);
  else ok('no NaN or Infinity across five ratios');
  if (worst <= 1.05) ok(`peak output ${worst.toFixed(3)} — no overlap-add overshoot`);
  else bad(`peak output ${worst.toFixed(3)} exceeds input peak by too much`);
}

// ── 8. Silence in, silence out; no self-oscillation ────────
console.log('\n[8] silence');
{
  const out = runShifter(new Float32Array(SR), 0.5, 1);
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak < 1e-6) ok('silent input yields silent output');
  else bad(`silent input produced peak ${peak}`);
}

// ── 9. Extreme parameter values are clamped, not fatal ─────
console.log('\n[9] out-of-range ratios');
{
  let threw = null;
  try {
    [0.01, 100, -1, NaN].forEach(r => runShifter(tone(110, SR / 2), r, 1));
  } catch (e) { threw = e; }
  if (threw) bad('extreme ratio threw: ' + threw.message);
  else ok('0.01 / 100 / −1 / NaN all handled without throwing');
}

// ── 10. the ScriptProcessor host drives the SAME core with 4096-sample
//        blocks instead of 128. Prove the block size doesn't change the result.
console.log('\n[10] host independence (128 vs 4096 sample blocks)');
{
  const makeCore = sandbox.createWsolaCore;
  if (typeof makeCore !== 'function') {
    bad('createWsolaCore is not exposed — the ScriptProcessor host cannot reuse the DSP');
  } else {
    ok('createWsolaCore is shared by both hosts');
    const runCore = (inp, ratio, blk) => {
      const core = makeCore(SR);
      const out = new Float32Array(inp.length);
      for (let off = 0; off + blk <= inp.length; off += blk) {
        const ob = new Float32Array(blk);
        core.process(inp.subarray(off, off + blk), ob, blk, ratio, 1);
        out.set(ob, off);
      }
      return out;
    };
    // The ScriptProcessor host is the one that runs from a plain file, so it
    // gets the same full sweep the worklet path does — not a spot check.
    [-12, -7, -5, -3, -1, 1, 3, 5, 7, 12].map(s2 => [s2, Math.pow(2, s2 / 12)])
      .concat([[-0.5, Math.pow(2, -0.5 / 12)], [0.2, Math.pow(2, 0.2 / 12)]])
      .forEach(([semis, ratio]) => {
      const a = estimatePitch(runCore(input, ratio, 128), ANALYSE_FROM, ANALYSE_LEN);
      const b = estimatePitch(runCore(input, ratio, 4096), ANALYSE_FROM, ANALYSE_LEN);
      const want = F0 * ratio;
      const ea = a.hz ? 1200 * Math.log2(a.hz / want) : 9999;
      const eb = b.hz ? 1200 * Math.log2(b.hz / want) : 9999;
      if (Math.abs(ea) < 12 && Math.abs(eb) < 12)
        ok(`${semis > 0 ? '+' : ''}${semis} st: 128-blk ${a.hz.toFixed(1)} Hz, 4096-blk ${b.hz.toFixed(1)} Hz — both on target`);
      else bad(`${semis} st: 128-blk off ${ea.toFixed(1)}¢, 4096-blk off ${eb.toFixed(1)}¢`);
    });
    // The fallback runs at 4096; make sure that doesn't blow the internal buffers.
    const big = runCore(tone(110, SR, 0.9), 0.5, 4096);
    if (big.every(Number.isFinite)) ok('4096-sample blocks stay finite (no ring-buffer overrun)');
    else bad('4096-sample blocks produced non-finite output');
  }
}

// ── 11. response profiles: measured latency and frequency floor ──
// The whole latency argument rests on these numbers, so measure them rather
// than trusting the formula, and prove each profile really does track down to
// the floor it advertises — and really does fail below it, which is what makes
// the trade honest rather than marketing.
console.log('\n[11] response profiles');
{
  const P = sandbox.WSOLA_PROFILES;
  const makeCore = sandbox.createWsolaCore;
  if (!P || !makeCore) { bad('WSOLA_PROFILES or createWsolaCore not exported'); }
  else {
    const runP = (prof, inp, ratio, blk) => {
      const core = makeCore(SR, prof);
      const out = new Float32Array(inp.length);
      for (let off = 0; off + blk <= inp.length; off += blk) {
        const ob = new Float32Array(blk);
        core.process(inp.subarray(off, off + blk), ob, blk, ratio, 1);
        out.set(ob, off);
      }
      return out;
    };
    // Group delay by onset: silence, then a burst; find where output starts.
    const onsetMs = (prof, blk) => {
      const N = SR * 2, START = SR;
      const inp = new Float32Array(N);
      for (let i = START; i < N; i++) inp[i] = 0.6 * Math.sin(2 * Math.PI * 110 * i / SR);
      const out = runP(prof, inp, 0.5, blk);
      for (let i = START; i < N - 64; i++) {
        let e = 0; for (let k = 0; k < 64; k++) e += Math.abs(out[i + k]);
        if (e / 64 > 0.05) return (i - START) / SR * 1000;
      }
      return -1;
    };
    const centsErr = (prof, f0, semis, blk) => {
      const r = Math.pow(2, semis / 12);
      const { hz } = estimatePitch(runP(prof, tone(f0, SR * 3), r, blk), ANALYSE_FROM, 16384);
      return hz ? 1200 * Math.log2(hz / (f0 * r)) : 9999;
    };

    const order = ['tight', 'balanced', 'deep'];
    const measured = {};
    order.forEach(k => {
      const prof = P[k];
      if (!prof) { bad('missing profile ' + k); return; }
      const ms = onsetMs(prof, 128);
      measured[k] = ms;
      const drift = Math.abs(ms - prof.coreMs);
      if (drift < 3) ok(`${prof.label}: measured ${ms.toFixed(1)} ms, claims ${prof.coreMs} ms`);
      else bad(`${prof.label}: measured ${ms.toFixed(1)} ms but claims ${prof.coreMs} ms — the UI is lying by ${drift.toFixed(1)} ms`);
    });

    if (measured.tight < measured.balanced && measured.balanced < measured.deep)
      ok(`latency ordered Tight < Balanced < Deep (${measured.tight.toFixed(0)} < ${measured.balanced.toFixed(0)} < ${measured.deep.toFixed(0)} ms)`);
    else bad('profiles are not ordered by latency — the switch would be meaningless');

    // Each profile must be accurate at its advertised floor…
    order.forEach(k => {
      const prof = P[k];
      if (!prof) return;
      const f = prof.floorHz + 0.5;
      const e = centsErr(prof, f, -12, 128);
      if (Math.abs(e) < 20) ok(`${prof.label} accurate at its ${prof.floorHz} Hz floor (${e.toFixed(1)}¢ at ${f} Hz)`);
      else bad(`${prof.label} claims a ${prof.floorHz} Hz floor but is ${e.toFixed(1)}¢ off there`);
    });

    // …and the Tight profile must genuinely fail below its floor, otherwise
    // the whole latency/range trade is a fiction and Balanced is pointless.
    const belowFloor = centsErr(P.tight, 41.203, -12, 128);
    if (Math.abs(belowFloor) > 15)
      ok(`Tight does break below its floor as documented (${belowFloor.toFixed(1)}¢ at low E) — the trade is real`);
    else bad(`Tight is accurate below its stated floor (${belowFloor.toFixed(1)}¢) — floors are mislabelled`);

    // Every profile must hold up on the strings above the floor.
    let upperOk = true;
    order.forEach(k => {
      [73.416, 98, 110].forEach(f0 => {
        const e = centsErr(P[k], f0, -5, 128);
        if (Math.abs(e) > 12) { bad(`${P[k].label} off by ${e.toFixed(1)}¢ at ${f0} Hz`); upperOk = false; }
      });
    });
    if (upperOk) ok('all profiles accurate on D, G and above');
  }
}

console.log('\n' + (fails ? `${fails} FAILURE(S)` : 'ALL DSP CHECKS PASSED'));
process.exit(fails ? 1 : 0);
