#!/usr/bin/env python3
"""Handoff §6: remove the reimposed 55 Hz pitch floor on the Spectrum tab.

The handoff rejected the overtone scope's autocorrelation detector precisely
because it bottoms out at 55 Hz, above low E. The MPM detector is fed in
correctly, but its output was then clamped to >= 55 Hz, reinstating the same
limit. The tuner resolves to 27.5 Hz (tunerFftSize 8192, "never reduced --
pitch accuracy at 31 Hz"), so accept what it can actually deliver.

SX_FMIN moves with it: at 60 Hz the fundamental of a low E (41.2) or low B
(30.9) falls below the axis and its ladder chip is hidden by the y > h - 8
guard, so lifting the clamp alone would only half work.
"""
import sys, io, re

path = sys.argv[1] if len(sys.argv) > 1 else 'parts/06_spectrum.js'
s = io.open(path, encoding='utf-8').read()
orig = s

subs = [
  # 1. display floor: 60 -> 28 so a low B fundamental is on-axis with headroom
  ("const SX_FMIN = 60, SX_FMAX = 6000;",
   "const SX_FMIN = 28, SX_FMAX = 6000;   // 28 Hz: low B (30.9) sits on-axis"),

  # 2. pitch-accept window as named constants matching the tuner's real range
  ("const SX_LOGMIN = Math.log(SX_FMIN);",
   "// Pitch-accept window. Matches the tuner's own range rather than the\n"
   "// overtone scope's old 55 Hz autocorrelation floor, which sat above low E.\n"
   "const SX_PITCH_MIN = 27.5;        // = TUNER_MIN_FREQ\n"
   "const SX_PITCH_MAX = 1600;\n"
   "const SX_LOGMIN = Math.log(SX_FMIN);"),

  # 3. the clamp itself
  ("if (p > 0 && p >= 55 && p <= 1600) {",
   "if (p > 0 && p >= SX_PITCH_MIN && p <= SX_PITCH_MAX) {"),
]

for old, new in subs:
    if old not in s:
        if new.split('\n')[0] in s or 'SX_PITCH_MIN' in s:
            print('already applied: %r' % old[:48]); continue
        raise SystemExit('anchor not found: %r' % old)
    if s.count(old) != 1:
        raise SystemExit('anchor not unique (%d): %r' % (s.count(old), old))
    s = s.replace(old, new)

if s == orig:
    print('no change'); raise SystemExit(0)
io.open(path, 'w', encoding='utf-8').write(s)
print('pitch floor 55 -> 27.5 Hz; SX_FMIN 60 -> 28 Hz')
