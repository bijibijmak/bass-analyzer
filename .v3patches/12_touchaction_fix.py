#!/usr/bin/env python3
"""The pan-y rule was landing above two pre-existing touch-action: none rules
on the very same IDs, so it lost on source order and fftCanvas still computed
to none. Chromium confirmed it: `fftCanvas ta=none`, and touchmove arriving
with cancelable=false — the browser had already ruled out scrolling before any
handler ran, so no amount of JS restraint could have helped.

Fix the declarations where they actually live and drop the duplicate.
"""
import sys, io
path = sys.argv[1] if len(sys.argv) > 1 else 'parts/01_head.html'
s = io.open(path, encoding='utf-8').read()

DUP = ("/* The browser keeps vertical pans; the probe only claims horizontal drags. */\n"
       "#fftCanvas, #sgCrosshair { touch-action: pan-y; }\n")
if DUP in s:
    s = s.replace(DUP, "", 1)
    print('removed the duplicate rule that lost on source order')

subs = [
("#sgCrosshair { pointer-events: auto; cursor: crosshair; touch-action: none; }",
 "/* pan-y, not none: the browser keeps vertical scrolling (the analyzer is\n"
 "   sticky and sits under the thumb), the probe only claims horizontal drags. */\n"
 "#sgCrosshair { pointer-events: auto; cursor: crosshair; touch-action: pan-y; }"),
("#fftCanvas { cursor: crosshair; touch-action: none; }",
 "#fftCanvas { cursor: crosshair; touch-action: pan-y; }"),
]
for old, new in subs:
    if old not in s:
        if 'touch-action: pan-y' in s: print('already applied:', old[:24]); continue
        raise SystemExit('anchor not found: %r' % old)
    s = s.replace(old, new, 1)

io.open(path, 'w', encoding='utf-8').write(s)
print('probe canvases now touch-action: pan-y')
