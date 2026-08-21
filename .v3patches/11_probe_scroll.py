#!/usr/bin/env python3
"""The sticky analyzer made an old probe bug fatal.

wireProbe claimed every pointerdown with setPointerCapture + preventDefault.
That was survivable while the analyzer scrolled away, because you rarely
started a drag on it. Now it is pinned to the top of the viewport and sits
under the thumb for most of a portrait screen, so a swipe that starts on the
chart scrolls nothing at all.

Reproduced in Chromium at 390x780 with touch: swipe from the analyzer moved
scrollY 0 -> 0; the same swipe 260 px lower moved it 0 -> 224.

Fix is two-sided. touch-action: pan-y lets the browser take vertical pans
natively (it then hands us a pointercancel). And the handler no longer claims
a touch gesture until it is clearly horizontal, which is the only direction a
frequency probe travels in. A tap still reads a frequency.
"""
import sys, io

anal = sys.argv[1] if len(sys.argv) > 1 else 'parts/05_analyzer.js'
head = sys.argv[2] if len(sys.argv) > 2 else 'parts/01_head.html'

OLD = """function wireProbe() {
  ['fftCanvas', 'sgCrosshair'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    let held = false;
    el.addEventListener('pointerdown', e => {
      held = true;
      if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (err) {} }
      showProbe(e.clientX, e.clientY);
      e.preventDefault();
    });
    el.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse' || held) showProbe(e.clientX, e.clientY);
    });
    el.addEventListener('pointerup',     () => { held = false; hideProbe(); });
    el.addEventListener('pointercancel', () => { held = false; hideProbe(); });
    el.addEventListener('pointerleave',  e => { if (e.pointerType === 'mouse') hideProbe(); });
  });
}"""

NEW = """// A touch drag that starts on the analyzer must still scroll the page. The
// analyzer is sticky, so it is under the thumb for most of a portrait screen;
// claiming every pointerdown here (which this used to do) meant a swipe that
// began on the chart scrolled nothing.
//
// Two halves: touch-action: pan-y in the CSS lets the browser take vertical
// pans natively and hand us a pointercancel, and the handler below refuses to
// claim a touch gesture until it is clearly horizontal — the only direction a
// frequency probe travels in. A tap still reads a frequency.
const PROBE_SLOP = 8;   // px of travel before deciding scroll vs probe

function wireProbe() {
  ['fftCanvas', 'sgCrosshair'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    let held = false, pid = null, x0 = 0, y0 = 0, decided = false;

    const capture = e => {
      if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (err) {} }
    };
    const release = () => { held = false; pid = null; decided = false; hideProbe(); };

    el.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse') {
        held = true; decided = true; pid = e.pointerId;
        capture(e); showProbe(e.clientX, e.clientY); e.preventDefault();
        return;
      }
      // Touch: read the frequency immediately so a tap still works, but do not
      // capture and do not preventDefault — the page has to stay scrollable.
      pid = e.pointerId; x0 = e.clientX; y0 = e.clientY;
      held = false; decided = false;
      showProbe(e.clientX, e.clientY);
    });

    el.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse') { showProbe(e.clientX, e.clientY); return; }
      if (e.pointerId !== pid) return;
      if (!decided) {
        const dx = Math.abs(e.clientX - x0), dy = Math.abs(e.clientY - y0);
        if (dx < PROBE_SLOP && dy < PROBE_SLOP) return;   // too small to call
        decided = true;
        if (dy >= dx) { release(); return; }              // vertical: let it scroll
        held = true; capture(e);
      }
      if (held) { showProbe(e.clientX, e.clientY); e.preventDefault(); }
    });

    el.addEventListener('pointerup',     release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave',  e => { if (e.pointerType === 'mouse') hideProbe(); });
  });
}"""

s = io.open(anal, encoding='utf-8').read()
if 'PROBE_SLOP' in s:
    print('probe handler already updated')
else:
    if OLD not in s:
        raise SystemExit('wireProbe anchor not found')
    io.open(anal, 'w', encoding='utf-8').write(s.replace(OLD, NEW, 1))
    print('wireProbe: touch gestures no longer swallow vertical scroll')

h = io.open(head, encoding='utf-8').read()
if 'touch-action: pan-y' in h:
    print('touch-action css already present')
else:
    A = '.analyzer-slot { position: relative; height: 220px; }'
    B = (A + "\n/* The browser keeps vertical pans; the probe only claims horizontal drags. */\n"
             "#fftCanvas, #sgCrosshair { touch-action: pan-y; }")
    if A not in h: raise SystemExit('analyzer-slot rule not found')
    io.open(head, 'w', encoding='utf-8').write(h.replace(A, B, 1))
    print('touch-action: pan-y added to the probe canvases')
