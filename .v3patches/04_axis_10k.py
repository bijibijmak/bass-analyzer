#!/usr/bin/env python3
"""Handoff §5: drop the frequency ceiling from 20 kHz to 10 kHz.

Done via named constants rather than find-and-replace, because the axis span
was encoded in two places as Math.log10(1000) -- "three decades above 20 Hz"
-- with no 20000 literal anywhere in the mapping. Replacing only the literals
would clip data at 10 kHz while still drawing a 20 kHz axis.

The 20000 on the filterHiss line is a filter cutoff, not axis code, and is
deliberately left alone.
"""
import sys, io

core = sys.argv[1] if len(sys.argv) > 1 else 'parts/03_core.js'
anal = sys.argv[2] if len(sys.argv) > 2 else 'parts/05_analyzer.js'

CONSTS = '''// ── Axis range ─────────────────────────────────────────────
// Ceiling is 10 kHz, not 20 kHz. On a log axis 10 kHz buys ~11% more
// pixels per decade; what it costs is the 10-20 kHz band, which carries
// nothing a bass player works against. Hiss lives 5-15 kHz and stays
// visible, and there is a full octave above the 5 kHz treble shelf to
// see its upper skirt.
//
// EVERY frequency display derives from these three. Do not reintroduce a
// bare 20000 or a bare Math.log10(1000): the span used to be written as
// "three decades from 20 Hz" with no ceiling literal in the mapping at
// all, so a literal-only edit passed review while the axis stayed wrong.
// verify.js now fails the build on both patterns.
const AX_FMIN = 20;
const AX_FMAX = 10000;
const AX_DECADES = Math.log10(AX_FMAX / AX_FMIN);

'''

XP_OLD = "const xp = f => PAD.l + Math.log10(f / 20) / Math.log10(1000) * cw;"
XP_NEW = "const xp = f => PAD.l + Math.log10(f / AX_FMIN) / AX_DECADES * cw;"

core_subs = [
  ("const STEPS = 500;", CONSTS + "const STEPS = 500;"),
  ("const freqs = Array.from({ length: STEPS + 1 }, (_, i) => 20 * Math.pow(20000 / 20, i / STEPS));",
   "const freqs = Array.from({ length: STEPS + 1 },\n"
   "  (_, i) => AX_FMIN * Math.pow(AX_FMAX / AX_FMIN, i / STEPS));"),
  ("const LABEL_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];",
   "const LABEL_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];"),
  (XP_OLD, XP_NEW),
]

anal_subs = [
  (XP_OLD, XP_NEW),
  ("buildLogMap(sgPlotW, fftAnalyser.frequencyBinCount, audioCtx.sampleRate, 20, 20000, false)",
   "buildLogMap(sgPlotW, fftAnalyser.frequencyBinCount, audioCtx.sampleRate, AX_FMIN, AX_FMAX, false)"),
  ("return 20 * Math.pow(20000 / 20, t);",
   "return AX_FMIN * Math.pow(AX_FMAX / AX_FMIN, t);"),
]

def apply(path, subs, repeat_ok=()):
    s = io.open(path, encoding='utf-8').read()
    for old, new in subs:
        n = s.count(old)
        if n == 0:
            if new.strip().split('\n')[0] in s or 'AX_FMAX' in s:
                print('  already applied: %r' % old[:50]); continue
            raise SystemExit('anchor not found in %s: %r' % (path, old))
        if n > 1 and old not in repeat_ok:
            raise SystemExit('anchor not unique (%d) in %s: %r' % (n, path, old))
        s = s.replace(old, new)
    io.open(path, 'w', encoding='utf-8').write(s)

print('core:'); apply(core, core_subs)
print('analyzer:'); apply(anal, anal_subs)

# the three identical clip-bound lines
s = io.open(anal, encoding='utf-8').read()
OLD_CLIP = "if (freq < 20 || freq > 20000) continue;"
NEW_CLIP = "if (freq < AX_FMIN || freq > AX_FMAX) continue;"
n = s.count(OLD_CLIP)
if n:
    if n != 3:
        raise SystemExit('expected 3 clip-bound lines, found %d' % n)
    s = s.replace(OLD_CLIP, NEW_CLIP)
    io.open(anal, 'w', encoding='utf-8').write(s)
    print('  3 clip-bound lines updated')
else:
    print('  clip bounds already updated')
print('done')
