#!/usr/bin/env python3
"""Top band 16 kHz -> 10 kHz, matching the analyzer's ceiling.

A deliberate departure from the M108S, whose top band is a 16 kHz shelf. The
analyzer was capped at 10 kHz back in the handoff work, so a 16 kHz band was
a control whose effect you could hear but never see. It stays a SHELF, so it
still catches everything above it -- the band did not move so much as the
chart's edge did.

The user-definable band clamps to 10 kHz too, keeping the invariant that
every band is visible on the curve.
"""
import sys, io
js, body = sys.argv[1:3]

s = io.open(js, encoding='utf-8').read()
if '10000]' in s and 'GEQ_FIXED' in s and '16000' not in s.split('GEQ_FIXED')[1][:120]:
    print('already applied'); raise SystemExit(0)

subs = [
("const GEQ_FIXED = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];",
 "// Top band is 10 kHz, not the M108S's 16 kHz: the analyzer is capped at\n"
 "// 10 kHz, and a band above the chart is a control you can hear but never\n"
 "// see. Still a shelf, so it catches everything above it.\n"
 "const GEQ_FIXED = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 10000];"),

("const geqFreqAt = i => (i < GEQ_FIXED.length ? GEQ_FIXED[i]\n"
 "                                             : Math.max(20, Math.min(16000, num(geq.userFreq, 700))));",
 "const GEQ_USER_MAX = 10000;   // = AX_FMAX, so every band is on the chart\n"
 "const geqFreqAt = i => (i < GEQ_FIXED.length ? GEQ_FIXED[i]\n"
 "                                             : Math.max(20, Math.min(GEQ_USER_MAX, num(geq.userFreq, 700))));"),

("      geq.userFreq = Math.max(20, Math.min(16000, num(parseFloat(o.userFreq), 700)));",
 "      geq.userFreq = Math.max(20, Math.min(GEQ_USER_MAX, num(parseFloat(o.userFreq), 700)));"),

("  geq.userFreq = Math.max(20, Math.min(16000, num(parseFloat(hz), 700)));",
 "  geq.userFreq = Math.max(20, Math.min(GEQ_USER_MAX, num(parseFloat(hz), 700)));"),

("// The M108S is a TEN band: 31.25 · 62.5 · 125 · 250 · 500 · 1k · 2k · 4k ·\n"
 "// 8k Hz peaking, plus a ±12 dB shelf at 16k, with Volume and Gain sliders\n"
 "// alongside. The eleventh band here is ours: a peaking filter whose centre\n"
 "// frequency you type in.",
 "// The M108S is a TEN band: 31.25 · 62.5 · 125 · 250 · 500 · 1k · 2k · 4k ·\n"
 "// 8k Hz peaking, plus a ±12 dB shelf on top, with Volume and Gain sliders\n"
 "// alongside. Two deliberate departures: the top shelf sits at 10 kHz rather\n"
 "// than 16 kHz so it stays inside the analyzer's range, and the eleventh band\n"
 "// is ours -- a peaking filter whose centre frequency you type in."),
]
for old, new in subs:
    if old not in s:
        raise SystemExit('anchor not found: %r' % old[:70])
    s = s.replace(old, new, 1)
io.open(js, 'w', encoding='utf-8').write(s)
print('top band 16k -> 10k; user band clamps to 10k')

b = io.open(body, encoding='utf-8').read()
OLD = 'id="geqUserFreq" type="number" min="20" max="16000"'
NEW = 'id="geqUserFreq" type="number" min="20" max="10000"'
if OLD in b:
    io.open(body, 'w', encoding='utf-8').write(b.replace(OLD, NEW, 1))
    print('frequency input max 16000 -> 10000')
else:
    print('input already updated')
