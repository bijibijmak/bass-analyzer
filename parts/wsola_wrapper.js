
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
