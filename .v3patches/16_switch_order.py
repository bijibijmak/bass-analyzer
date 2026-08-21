#!/usr/bin/env python3
"""Grunt and Attack take the physical order from Bijan's printed preset sheet.

Grunt:  Fat / Thin / Raw     (top to bottom)
Attack: Flat / Boost / Cut

Not descending by dB, which is what I had guessed -- but the sheet mirrors how
the real pedal is labelled, and matching the hardware is the whole point of
being able to copy a setting between the two.

Markup-only: the switch code reads its values out of these spans, so the
physical order and the state value cannot drift apart in code.
"""
import sys, io
p = sys.argv[1] if len(sys.argv) > 1 else 'parts/02_body.html'
s = io.open(p, encoding='utf-8').read()

subs = [
 ('<div class="sw-labels" data-swlabels="grunt"><span data-v="2">Fat</span><span data-v="1">Raw</span><span data-v="0">Thin</span></div>',
  '<div class="sw-labels" data-swlabels="grunt"><span data-v="2">Fat</span><span data-v="0">Thin</span><span data-v="1">Raw</span></div>'),
 ('<div class="sw-labels" data-swlabels="attack"><span data-v="2">Boost</span><span data-v="1">Flat</span><span data-v="0">Cut</span></div>',
  '<div class="sw-labels" data-swlabels="attack"><span data-v="1">Flat</span><span data-v="2">Boost</span><span data-v="0">Cut</span></div>'),
]
for old, new in subs:
    if old not in s:
        if new in s: print('already applied'); continue
        raise SystemExit('anchor not found: %r' % old[:60])
    s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('grunt -> Fat/Thin/Raw, attack -> Flat/Boost/Cut')
