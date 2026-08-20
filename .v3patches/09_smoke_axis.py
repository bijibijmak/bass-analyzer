#!/usr/bin/env python3
"""smoke.js encoded the old axis range in its own probe test.

xFor() divided by a literal 3 -- three decades above 20 Hz, i.e. 20 kHz --
so after the ceiling moved it clicked the x that used to mean 110 Hz and
correctly got 93 Hz. The test was stale, not the code.

Derive the x from the page's own constants instead, so it cannot drift
again. What it asserts is unchanged and still meaningful: 110 Hz must land
on A2, whatever the span happens to be.
"""
import sys, io

path = sys.argv[1] if len(sys.argv) > 1 else 'smoke.js'
s = io.open(path, encoding='utf-8').read()

if "ev('AX_DECADES')" in s:
    print('already applied'); raise SystemExit(0)

subs = [
("    // Note naming at a known frequency: x for 110 Hz on the log axis\n"
 "    ev('hideProbe')();\n"
 "    const xFor = f => 38 + Math.log10(f / 20) / 3 * (542 - 38);",

 "    // Note naming at a known frequency. The x is derived from the page's own\n"
 "    // axis constants rather than a duplicated span, so this cannot go stale\n"
 "    // when the range changes -- it asserts that 110 Hz lands on A2, whatever\n"
 "    // the ceiling is. (It used to divide by a literal 3: three decades above\n"
 "    // 20 Hz, i.e. a hardcoded 20 kHz.)\n"
 "    ev('hideProbe')();\n"
 "    const xFor = f => 38 + Math.log10(f / ev('AX_FMIN')) / ev('AX_DECADES') * (542 - 38);"),

("    // Canvas spans x=0..560; PAD.l=38, PAD.r=18 → plot is 38..542.\n"
 "    // Midpoint of a 20 Hz–20 kHz log axis is ~632 Hz.",
 "    // Canvas spans x=0..560; PAD.l=38, PAD.r=18 → plot is 38..542.\n"
 "    // Midpoint of the log axis: ~632 Hz over 20 Hz–20 kHz, ~447 Hz over\n"
 "    // 20 Hz–10 kHz. The assertion below only requires that some frequency\n"
 "    // is reported, so it holds either way."),
]

for old, new in subs:
    n = s.count(old)
    if n != 1:
        raise SystemExit('anchor count %d (expected 1): %r' % (n, old[:60]))
    s = s.replace(old, new, 1)

io.open(path, 'w', encoding='utf-8').write(s)
print('smoke.js probe test now derives x from AX_FMIN / AX_DECADES')
