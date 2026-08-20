#!/usr/bin/env python3
"""Handoff §6: restore the specified 12x2 notches + 2 bandpass = 26 nodes.

The code had collapsed this to one notch per harmonic (14 nodes). That is a
defensible Pi-budget call but it was not what the handoff asked for, and it
has an audible consequence: a single notch dips a harmonic where two cascaded
notches remove it.

Rather than pick one, this routes the decision through the LITE gate that
already exists for exactly this purpose -- 26 nodes on desktop and phone,
14 under LITE for the Pi. No fork, one flag.
"""
import sys, io

path = sys.argv[1] if len(sys.argv) > 1 else 'parts/06_spectrum.js'
s = io.open(path, encoding='utf-8').read()

if 'SX_NOTCH_PER_H' in s:
    print('already applied'); raise SystemExit(0)

subs = [
# header comment
("""// Node count: 12 notches (one per harmonic) + 2 bandpass for solo = 14
// BiquadFilterNodes, exactly as in the original NF = NH + 2.""",
 """// Node count: 12 harmonics x SX_NOTCH_PER_H notches + 2 bandpass for solo.
// Full build is 2 notches each = 26 BiquadFilterNodes, per the handoff;
// LITE drops to 1 each = 14, because 26 series biquads is exactly the kind
// of load the Pi Zero cannot spare."""),

# constants
("""const SX_NH = 12;                 // harmonics tracked
const SX_NF = SX_NH + 2;          // 12 notches + 2 bandpass""",
 """const SX_NH = 12;                 // harmonics tracked
// Two cascaded notches per harmonic is what makes "mute H3" remove the
// harmonic rather than merely dip it. Behind the LITE gate so the Pi build
// is a flag flip, not a fork.
const SX_NOTCH_PER_H = LITE ? 1 : 2;
const SX_NF = SX_NH * SX_NOTCH_PER_H + 2;
const SX_BP0 = SX_NH * SX_NOTCH_PER_H;   // index of the first bandpass node
const sxNotchIdx = (n, j) => (n - 1) * SX_NOTCH_PER_H + j;"""),

# solo bandpass indices
("""      const b = sxChain[SX_NH + k];""",
 """      const b = sxChain[SX_BP0 + k];"""),
("""    for (let k = 0; k < 2; k++) sxChain[SX_NH + k].frequency.setTargetAtTime(Math.min(sxF0 * sxSolo, nyqLimit), t, 0.05);""",
 """    for (let k = 0; k < 2; k++) sxChain[SX_BP0 + k].frequency.setTargetAtTime(Math.min(sxF0 * sxSolo, nyqLimit), t, 0.05);"""),

# mute: set every notch belonging to the harmonic
("""    for (let n = 1; n <= SX_NH; n++) {
      if (!sxMuted[n]) continue;
      const c = sxChain[n - 1];
      c.type = 'notch'; c.Q.value = 22;
      c.frequency.setTargetAtTime(Math.min(sxF0 * n, nyqLimit), t, 0.02);
    }""",
 """    for (let n = 1; n <= SX_NH; n++) {
      if (!sxMuted[n]) continue;
      for (let j = 0; j < SX_NOTCH_PER_H; j++) {
        const c = sxChain[sxNotchIdx(n, j)];
        c.type = 'notch'; c.Q.value = 22;
        c.frequency.setTargetAtTime(Math.min(sxF0 * n, nyqLimit), t, 0.02);
      }
    }"""),

# retune
("""    for (let n = 1; n <= SX_NH; n++) {
      if (sxMuted[n]) sxChain[n - 1].frequency.setTargetAtTime(Math.min(sxF0 * n, nyqLimit), t, 0.05);
    }""",
 """    for (let n = 1; n <= SX_NH; n++) {
      if (!sxMuted[n]) continue;
      for (let j = 0; j < SX_NOTCH_PER_H; j++) {
        sxChain[sxNotchIdx(n, j)].frequency.setTargetAtTime(Math.min(sxF0 * n, nyqLimit), t, 0.05);
      }
    }"""),
]

for old, new in subs:
    n = s.count(old)
    if n != 1:
        raise SystemExit('anchor count %d (expected 1): %r' % (n, old[:70]))
    s = s.replace(old, new, 1)

io.open(path, 'w', encoding='utf-8').write(s)
print('spectrum chain: 26 nodes full / 14 under LITE')
