#!/usr/bin/env python3
"""Cleanup and Presets move to the bottom of the Preamp tab.

Order becomes: Analyzer -> Scope -> Pedal -> Cleanup -> Presets.

This reverses the handoff's §2 instruction to put the pedal last, and that is
fine: the reason for that instruction was a 540x300 SVG shoving every control
below the fold. The pedal is now a compact knob panel, so the thing worth
having near the analyzer is the pedal, and the housekeeping goes last.
"""
import sys, io
p = sys.argv[1] if len(sys.argv) > 1 else 'parts/02_body.html'
lines = io.open(p, encoding='utf-8').read().split('\n')

NOISE = 'NOISE / HISS TOOLS'
PRESETS = 'PRESETS'
PEDAL = 'PEDAL PANEL'

def find(pred, start=0):
    for i in range(start, len(lines)):
        if pred(lines[i]): return i
    return -1

p_start = find(lambda l: 'id="panel-preamp"' in l)
p_end = find(lambda l: l.strip() == '</section>', p_start)
a = find(lambda l: NOISE in l, p_start)
b = find(lambda l: PEDAL in l, p_start)

if a < 0 or b < 0 or not (p_start < a < p_end):
    raise SystemExit('anchors not found in the preamp panel')
if a > b:
    print('cleanup/presets already below the pedal panel'); raise SystemExit(0)

block = lines[a:b]                    # noise tools + presets, in order
while block and not block[-1].strip():
    block.pop()

rest = lines[:a] + lines[b:]
end2 = find(lambda l: l.strip() == '</section>')
for i, l in enumerate(rest):
    if l.strip() == '</section>': end2 = i; break

out = rest[:end2] + block + [''] + rest[end2:]
io.open(p, 'w', encoding='utf-8').write('\n'.join(out))
print('moved %d lines (Cleanup + Presets) below the pedal panel' % len(block))
