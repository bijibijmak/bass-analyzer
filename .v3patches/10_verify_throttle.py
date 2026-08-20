#!/usr/bin/env python3
"""verify.js asserted the ScriptProcessor throttle by the name of a variable.

The throttle still exists, but it now lives in drawIntervalMs() alongside the
mobile cap and reuses frameLastT, so drawLastT is gone and the check failed on
a rename rather than on a regression.

Rewritten to assert the behaviour instead: the ScriptProcessor interval is
applied, and it composes with the mobile cap by max() rather than replacing
it -- which is the property that actually protects the audio buffer.
"""
import sys, io

path = sys.argv[1] if len(sys.argv) > 1 else 'verify.js'
s = io.open(path, encoding='utf-8').read()

if 'DRAW_MS_SCRIPTPROC' in s:
    print('already applied'); raise SystemExit(0)

OLD = ("if (/dtLoadedVia === 'ScriptProcessor'/.test(js) && /drawLastT/.test(js)) "
       "ok('analyzer throttled while the ScriptProcessor host is live');\n"
       "else bad('no analyzer throttle — the small buffer will crackle');")

NEW = ("""if (/dtLoadedVia === 'ScriptProcessor'/.test(js) && /Math\\.max\\(ms, DRAW_MS_SCRIPTPROC\\)/.test(js))
  ok('analyzer throttled while the ScriptProcessor host is live, and it wins over the mobile cap');
else bad('no analyzer throttle — the small buffer will crackle');
// The mobile cap is a separate concern with a separate failure mode: without
// it a phone redraws 8192 bins every frame.
if (/DRAW_MS_MOBILE = 1000 \\/ 30/.test(js) && /pointer: coarse/.test(js))
  ok('analyzer capped at 30 fps on touch devices');
else bad('no mobile draw cap — a phone will redraw every frame over 8192 bins');
// The readout has to measure draws, not rAF callbacks, or it reports 60 fps
// while drawing at 30 and is useless for sizing the Pi build.
if (/if \\(minMs && frameLastT && t0 - frameLastT < minMs\\) return;/.test(js) &&
    js.indexOf('frameDeltaMs = frameDeltaMs') > js.indexOf('if (minMs && frameLastT'))
  ok('frame readout measures draw-to-draw, not rAF-to-rAF');
else bad('frame readout still measures the rAF rate — it will not show the throttle');""")

if OLD not in s:
    raise SystemExit('throttle check anchor not found')
s = s.replace(OLD, NEW, 1)
io.open(path, 'w', encoding='utf-8').write(s)
print('verify.js throttle checks updated (behaviour, not variable names)')
