#!/usr/bin/env python3
"""Handoff §2: move the pedal SVG block to the bottom of the Preamp tab.

Order becomes: Analyzer -> Scope -> Cleanup -> Presets -> Pedal.
Anchored on comment markers, not line numbers, so it is re-runnable and
survives edits elsewhere in the file.
"""
import sys, io

path = sys.argv[1] if len(sys.argv) > 1 else 'parts/02_body.html'
lines = io.open(path, encoding='utf-8').read().split('\n')

PANEL   = '<section class="tab-panel active" id="panel-preamp"'
PEDAL   = 'PEDAL + FULL CONTROLS'
NOISE   = 'NOISE / HISS TOOLS'

def find(pred, start=0):
    for i in range(start, len(lines)):
        if pred(lines[i]):
            return i
    raise SystemExit('anchor not found: ' + repr(pred))

p_start = find(lambda l: PANEL in l)
p_end   = find(lambda l: l.strip() == '</section>', p_start)

ped_a = find(lambda l: PEDAL in l, p_start)
noise_i = find(lambda l: NOISE in l, p_start)
if noise_i < ped_a:
    print('pedal block already below the noise tools - nothing to do')
    raise SystemExit(0)
ped_b = find(lambda l: NOISE in l, ped_a)

if not (p_start < ped_a < ped_b < p_end):
    raise SystemExit('pedal block is not inside the preamp panel; aborting')

# already at the bottom? then this is a no-op
tail = [l for l in lines[ped_b:p_end] if l.strip()]
if not tail:
    print('pedal block already last — nothing to do')
    raise SystemExit(0)

block = lines[ped_a:ped_b]
# trim trailing blank lines off the block, we re-add one on insert
while block and not block[-1].strip():
    block.pop()

rest = lines[:ped_a] + lines[ped_b:]
# recompute the panel close in the shortened list
p_end2 = find_idx = None
for i in range(len(rest)):
    if rest[i].strip() == '</section>':
        p_end2 = i
        break

out = rest[:p_end2] + block + [''] + rest[p_end2:]
io.open(path, 'w', encoding='utf-8').write('\n'.join(out))
print('moved %d lines of pedal block to the bottom of the Preamp panel' % len(block))
