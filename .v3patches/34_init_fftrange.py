#!/usr/bin/env python3
"""Restore the saved display range at boot."""
import sys, io
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
if 'initFftRange()' in s:
    print('already wired'); raise SystemExit(0)
A = 'initGeq();'
if A not in s: raise SystemExit('boot anchor not found')
io.open(p, 'w', encoding='utf-8').write(s.replace(A, A + '\ninitFftRange();', 1))
print('initFftRange() wired at boot')
