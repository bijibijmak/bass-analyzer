#!/usr/bin/env python3
"""The real scroll bug, and it was never about touch.

A sticky element still occupies its flow box. Shrinking the analyzer from 220
to 120 px therefore shortens the DOCUMENT by 100 px, and that has two effects
on a desktop mouse wheel:

  1. At the boundary, a 100 px wheel tick is exactly cancelled by the 100 px
     shrink -- the browser's scroll anchoring compensates and scrollY does not
     move. The page refuses to cross.
  2. While stuck the document is permanently 100 px shorter, so the last
     100 px of content simply cannot be reached.

Measured in Chromium at 1000x800, ten 100 px ticks from just above the
boundary: tick 2 moved +0 as stuck flipped and docH went 1430 -> 1330, then
the page dead-ended at scrollY 530 with six further ticks moving nothing.

Fix: reserve the full height in flow at all times and shrink only the card
inside it, so the document height never changes. The reserved box is
pointer-transparent when stuck so it does not swallow clicks on the content
scrolling underneath.
"""
import sys, io

core, head, init = sys.argv[1:4]

s = io.open(core, encoding='utf-8').read()
if 'reserveAnalyzerHeight' in s:
    print('already applied'); raise SystemExit(0)

OLD = """function resizeAnalyzer() {
  const slot = document.getElementById('analyzerSlot');
  if (slot) slot.style.height = analyzerH() + 'px';
  if (analyzerMode === 'sg') sizeSpectrogram();
  redrawStatic();
}"""

NEW = """function resizeAnalyzer() {
  const slot = document.getElementById('analyzerSlot');
  if (slot) slot.style.height = analyzerH() + 'px';
  if (analyzerMode === 'sg') sizeSpectrogram();
  redrawStatic();
}

// A sticky element still occupies its flow box, so shrinking the analyzer
// shortens the DOCUMENT by the same 100 px. On a mouse wheel that is fatal:
// a 100 px tick at the boundary is exactly cancelled by the 100 px shrink
// (scroll anchoring compensates), so the page will not cross it -- and while
// stuck the document is 100 px shorter, so the last 100 px of content cannot
// be reached at all.
//
// Reserve the unshrunk height on the wrapper and let only the card inside
// change size. The document height then never moves.
function reserveAnalyzerHeight() {
  const wrap = document.getElementById('analyzerSticky');
  const slot = document.getElementById('analyzerSlot');
  if (!wrap || !slot) return;
  const prevWrap = wrap.style.height, prevSlot = slot.style.height;
  wrap.style.height = '';
  slot.style.height = ANALYZER_H_FULL + 'px';     // measure at full size
  const h = wrap.offsetHeight;
  slot.style.height = prevSlot || analyzerH() + 'px';
  wrap.style.height = h > 0 ? h + 'px' : prevWrap;
}"""

if OLD not in s: raise SystemExit('resizeAnalyzer not found')
s = s.replace(OLD, NEW, 1)

OLD2 = """    analyzerStuck = stuck;
    wrap.classList.toggle('stuck', stuck);
    resizeAnalyzer();"""
NEW2 = """    analyzerStuck = stuck;
    wrap.classList.toggle('stuck', stuck);
    resizeAnalyzer();          // wrapper height is reserved, so this cannot
                               // change the document height"""
if OLD2 in s: s = s.replace(OLD2, NEW2, 1)

OLD3 = "  new IntersectionObserver(entries => {"
NEW3 = "  reserveAnalyzerHeight();\n  new IntersectionObserver(entries => {"
if OLD3 not in s: raise SystemExit('observer anchor not found')
s = s.replace(OLD3, NEW3, 1)
io.open(core, 'w', encoding='utf-8').write(s)
print('core: wrapper height reserved; document height now constant')

h = io.open(head, encoding='utf-8').read()
OLDC = """.analyzer-sticky.stuck { background: var(--bg); padding-top: 4px; }
.analyzer-sticky.stuck .chart-card {
  margin-bottom: 4px;
  box-shadow: 0 8px 16px -10px rgba(0, 0, 0, 0.75);
}"""
NEWC = """/* The wrapper keeps its full height in flow at all times (set from JS) so
   that sticking never changes the document height -- see
   reserveAnalyzerHeight(). Only the card inside shrinks, and the reserved
   space below it is pointer-transparent so content scrolling underneath
   stays clickable. */
.analyzer-sticky.stuck { pointer-events: none; }
.analyzer-sticky.stuck > .chart-card {
  pointer-events: auto;
  margin-bottom: 4px;
  box-shadow: 0 8px 16px -10px rgba(0, 0, 0, 0.75);
}"""
if OLDC not in h: raise SystemExit('sticky css anchor not found')
io.open(head, 'w', encoding='utf-8').write(h.replace(OLDC, NEWC, 1))
print('css: reserved box is pointer-transparent, card carries the shadow')

i = io.open(init, encoding='utf-8').read()
if 'reserveAnalyzerHeight()' not in i:
    OLDI = """window.addEventListener('resize', () => {
  sizeIsland();"""
    NEWI = """window.addEventListener('resize', () => {
  sizeIsland();
  reserveAnalyzerHeight();"""
    if OLDI not in i: raise SystemExit('resize handler not found')
    io.open(init, 'w', encoding='utf-8').write(i.replace(OLDI, NEWI, 1))
    print('init: height re-reserved on resize')
