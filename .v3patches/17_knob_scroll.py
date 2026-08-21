#!/usr/bin/env python3
"""Knobs were touch-action: none, so a thumb passing over one froze the page.

Same class of bug as the probe canvases, reintroduced by the new panel: seven
52 px targets sitting mid-page, each of which stops scrolling dead. Chromium
confirms it -- a vertical swipe with the thumb on the Low knob left scrollY at
533 and moved nothing.

pan-y hands vertical gestures back to the browser. A knob then claims a touch
only once the gesture is clearly horizontal, and from there tracks RELATIVE
movement rather than absolute angle, so the value does not jump to wherever
the finger happens to be. Mouse keeps absolute-angle rotation, unchanged.
"""
import sys, io

core, head = sys.argv[1:3]
s = io.open(core, encoding='utf-8').read()
if 'TOUCH_PX_PER_STEP' in s:
    print('already applied'); raise SystemExit(0)

OLD = """    k.addEventListener('pointerdown', e => {
      if (off()) return;
      dragging = true;
      try { k.setPointerCapture(e.pointerId); } catch (err) {}
      fromPointer(e); e.preventDefault();
    });
    k.addEventListener('pointermove', e => { if (dragging) fromPointer(e); });
    k.addEventListener('pointerup', e => {
      dragging = false; try { k.releasePointerCapture(e.pointerId); } catch (err) {}
    });
    k.addEventListener('pointercancel', () => { dragging = false; });"""

NEW = """    // Touch must never steal a vertical scroll. The panel sits mid-page and a
    // thumb crossing a knob would otherwise freeze the page — the same bug the
    // probe canvases had. touch-action: pan-y in the CSS hands vertical
    // gestures to the browser; we claim only clearly horizontal ones, and then
    // track RELATIVE movement so the value does not jump to the finger.
    const TOUCH_SLOP = 8;         // px before deciding scroll vs turn
    const TOUCH_PX_PER_STEP = 5;  // ~100 px of drag covers the full sweep
    let tPid = null, tX = 0, tY = 0, tStep = 0, tClaimed = false;
    const dropTouch = () => { tPid = null; tClaimed = false; };

    k.addEventListener('pointerdown', e => {
      if (off()) return;
      if (e.pointerType === 'mouse') {
        dragging = true;
        try { k.setPointerCapture(e.pointerId); } catch (err) {}
        fromPointer(e); e.preventDefault();
        return;
      }
      tPid = e.pointerId; tX = e.clientX; tY = e.clientY;
      tStep = knobToStep(key, state[key]); tClaimed = false;
    });

    k.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse') { if (dragging) fromPointer(e); return; }
      if (e.pointerId !== tPid || off()) return;
      if (!tClaimed) {
        const dx = Math.abs(e.clientX - tX), dy = Math.abs(e.clientY - tY);
        if (dx < TOUCH_SLOP && dy < TOUCH_SLOP) return;
        if (dy >= dx) { dropTouch(); return; }     // vertical: let the page scroll
        tClaimed = true;
        try { k.setPointerCapture(e.pointerId); } catch (err) {}
      }
      setStep(tStep + Math.round((e.clientX - tX) / TOUCH_PX_PER_STEP));
      e.preventDefault();
    });

    k.addEventListener('pointerup', e => {
      dragging = false; dropTouch();
      try { k.releasePointerCapture(e.pointerId); } catch (err) {}
    });
    k.addEventListener('pointercancel', () => { dragging = false; dropTouch(); });"""

if OLD not in s: raise SystemExit('knob pointer block not found')
io.open(core, 'w', encoding='utf-8').write(s.replace(OLD, NEW, 1))
print('knob touch: yields to vertical gestures, relative tracking once claimed')

h = io.open(head, encoding='utf-8').read()
OLDC = "        cursor: grab; touch-action: none; }"
NEWC = ("        cursor: grab; touch-action: pan-y; }   /* pan-y: a thumb crossing a knob\n"
        "        must still scroll the page — the knob claims horizontal drags only */")
if 'touch-action: pan-y; }   /* pan-y' in h:
    print('knob css already applied')
else:
    if OLDC not in h: raise SystemExit('knob css anchor not found')
    h = h.replace(OLDC, NEWC, 1)

# zero-height sentinels are unreliable for IntersectionObserver, notably on
# iOS Safari with its dynamic toolbar. Give it a real pixel.
OLDS = ".sticky-sentinel { height: 0; margin: 0; padding: 0; }"
NEWS = ("/* 1px, not 0: zero-area sentinels are unreliable with IntersectionObserver,\n"
        "   notably on iOS Safari where the toolbar resizes the scrollport. */\n"
        ".sticky-sentinel { height: 1px; margin: 0; padding: 0; }")
if OLDS in h:
    h = h.replace(OLDS, NEWS, 1); print('sticky sentinel 0 -> 1px')
io.open(head, 'w', encoding='utf-8').write(h)
print('knob css: touch-action pan-y')
