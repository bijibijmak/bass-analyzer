#!/usr/bin/env python3
"""Handoff §9: throttle the analyzer render loop to 30 fps on mobile.

Composes with the existing ScriptProcessor throttle rather than replacing it:
that one exists for a different reason (a 512-sample buffer is 10.7 ms of
headroom and a full-rate redraw eats it), and it is stricter. Longest
interval wins.

The frame-time readout now measures draw-to-draw rather than rAF-to-rAF, so
#frameInfo reports the rate actually being drawn -- which is the number that
matters on first Pi boot.
"""
import sys, io

path = sys.argv[1] if len(sys.argv) > 1 else 'parts/05_analyzer.js'
s = io.open(path, encoding='utf-8').read()

if 'drawIntervalMs' in s:
    print('already applied'); raise SystemExit(0)

HELPER = '''// ── Draw budget ────────────────────────────────────────────
// Mobile caps analyzer redraws at 30 fps: imperceptible for a spectrum
// display, and roughly halves main-thread work over 8192 bins.
//
// "Mobile" uses the same query as the CSS touch breakpoint, so the two
// definitions cannot drift apart.
const mqCoarse = window.matchMedia ? window.matchMedia('(hover: none) and (pointer: coarse)') : null;
const DRAW_MS_MOBILE = 1000 / 30;   // 33.3 ms
const DRAW_MS_SCRIPTPROC = 50;      // ~20 fps, see below
function drawIntervalMs() {
  let ms = (mqCoarse && mqCoarse.matches) ? DRAW_MS_MOBILE : 0;
  // The ScriptProcessor host shares this thread. A 512-sample buffer is
  // 10.7 ms of headroom and a full-rate canvas redraw will eat it and
  // crackle. Stricter than the mobile cap, so it wins where both apply.
  if (detune.engaged && dtLoadedVia === 'ScriptProcessor') ms = Math.max(ms, DRAW_MS_SCRIPTPROC);
  return ms;
}

'''

OLD_LOOP = """    const t0 = performance.now();
    if (frameLastT) frameDeltaMs = frameDeltaMs * 0.9 + (t0 - frameLastT) * 0.1;
    frameLastT = t0;

    tickMeters();

    // The ScriptProcessor host shares this thread. A 512-sample buffer is
    // 10.7 ms of headroom, and a full-rate canvas redraw will eat it and
    // crackle. Throttle drawing to ~20 fps while that host is live — the
    // analyzer loses smoothness, the audio keeps its buffer.
    if (detune.engaged && dtLoadedVia === 'ScriptProcessor') {
      if (t0 - drawLastT < 50) return;
      drawLastT = t0;
    }
"""

NEW_LOOP = """    const t0 = performance.now();

    // Meters stay at full rate: they are cheap and they should feel live.
    tickMeters();

    // Drawing is what gets throttled. Returning here leaves the frame-time
    // readout measuring draw-to-draw, which is the rate we actually care
    // about, rather than the rAF rate underneath it.
    const minMs = drawIntervalMs();
    if (minMs && frameLastT && t0 - frameLastT < minMs) return;

    if (frameLastT) frameDeltaMs = frameDeltaMs * 0.9 + (t0 - frameLastT) * 0.1;
    frameLastT = t0;
"""

if OLD_LOOP not in s:
    raise SystemExit('render-loop anchor not found')
s = s.replace(OLD_LOOP, NEW_LOOP, 1)

anchor = 'let frameWorkMs = 0,'
if anchor not in s:
    raise SystemExit('state anchor not found')
s = s.replace(anchor, HELPER + anchor, 1)

# drawLastT is now unused
s = s.replace("let frameWorkMs = 0, frameDeltaMs = 0, frameLastT = 0, frameReportT = 0, drawLastT = 0;",
              "let frameWorkMs = 0, frameDeltaMs = 0, frameLastT = 0, frameReportT = 0;", 1)

io.open(path, 'w', encoding='utf-8').write(s)
print('30 fps mobile cap added; composes with the ScriptProcessor throttle')
