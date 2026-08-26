#!/usr/bin/env python3
"""Top band becomes peaking, because a shelf at the chart's edge reads wrong.

A highshelf reaches only HALF its gain at the corner frequency; the rest
develops above it. With the corner at 16 kHz that was invisible and
inaudible, so nobody cared. Moving it to 10 kHz -- the analyzer's ceiling --
turned it into a fader labelled +12 that delivers +6 at the highest
frequency you can see or hear on the chart. Measured: +12 on the top band
gave 0 dB at 2k, 1.1 at 6k and 6.0 at 10k.

Peaking, like every other band, so the label means what it says and the
curve shows the whole of it. The cost is that it no longer tilts everything
above 10 kHz wholesale -- but its skirt still reaches up there, and on a
bass rig what lives above 10 kHz is hiss, which the high-cut tool exists to
deal with.
"""
import sys, io
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
if 'geqIsShelf' not in s:
    print('already applied'); raise SystemExit(0)

s = s.replace(
"const geqIsShelf = i => i === GEQ_FIXED.length - 1;    // 16k is a shelf on the real pedal",
"// Every band is peaking, including the top one. The M108S's top band is a\n"
"// shelf, but a shelf only reaches half its gain at the corner frequency —\n"
"// with the corner at the chart's own ceiling that is a fader marked +12 that\n"
"// delivers +6 at the highest frequency you can see. Measured before the\n"
"// change: 0 dB at 2k, 1.1 at 6k, 6.0 at 10k for a +12 setting.", 1)

s = s.replace("    b.type = geqIsShelf(i) ? 'highshelf' : 'peaking';\n"
              "    b.frequency.value = geqFreqAt(i);\n"
              "    b.Q.value = GEQ_Q;\n"
              "    b.gain.value = num(geq.gains[i], 0);\n"
              "    b.getFrequencyResponse(f32, mag, phase);",
              "    b.type = 'peaking';\n"
              "    b.frequency.value = geqFreqAt(i);\n"
              "    b.Q.value = GEQ_Q;\n"
              "    b.gain.value = num(geq.gains[i], 0);\n"
              "    b.getFrequencyResponse(f32, mag, phase);", 1)

s = s.replace("    b.type = geqIsShelf(i) ? 'highshelf' : 'peaking';\n"
              "    b.frequency.value = geqFreqAt(i);\n"
              "    b.Q.value = GEQ_Q;\n"
              "    b.gain.value = num(geq.gains[i], 0);\n"
              "    prev.connect(b);",
              "    b.type = 'peaking';\n"
              "    b.frequency.value = geqFreqAt(i);\n"
              "    b.Q.value = GEQ_Q;\n"
              "    b.gain.value = num(geq.gains[i], 0);\n"
              "    prev.connect(b);", 1)

s = s.replace("// 8k Hz peaking, plus a ±12 dB shelf on top, with Volume and Gain sliders\n"
              "// alongside. Two deliberate departures: the top shelf sits at 10 kHz rather\n"
              "// than 16 kHz so it stays inside the analyzer's range, and the eleventh band\n"
              "// is ours -- a peaking filter whose centre frequency you type in.",
              "// 8k Hz peaking, plus a ±12 dB shelf on top, with Volume and Gain sliders\n"
              "// alongside. Three deliberate departures: the top band sits at 10 kHz rather\n"
              "// than 16 kHz so it stays inside the analyzer's range, it is peaking rather\n"
              "// than shelving so its label means what it says at that frequency, and the\n"
              "// eleventh band is ours -- a peaking filter whose centre you type in.", 1)

if 'geqIsShelf' in s:
    raise SystemExit('a geqIsShelf reference survived')
io.open(p, 'w', encoding='utf-8').write(s)
print('all bands peaking; top band now delivers its stated gain at 10 kHz')
