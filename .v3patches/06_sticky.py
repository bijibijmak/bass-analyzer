#!/usr/bin/env python3
"""Handoff §2: sticky analyzer, 220 px in flow, ~120 px when pinned.

CSS alone cannot tell you an element is stuck, so a zero-height sentinel above
the wrapper drives an IntersectionObserver. The canvases are sized in device
pixels by JS, so the height has to become a function rather than a constant --
SG_H and the two literal 220s in the analyzer path all route through
analyzerH(). The Mix chart's 220 is a different chart and stays put.
"""
import sys, io

core, anal, body, head, init = sys.argv[1:6]

# ── 1. core: state, helpers, observer ──────────────────────
CORE_BLOCK = '''// ── Sticky analyzer ────────────────────────────────────────
// Full height in flow, shrunk when pinned: enough to read spectrum shape
// with a thumb on a knob, without eating a portrait viewport that is
// already giving space to the island.
//
// Height is a function, not a constant, because the canvases are sized in
// device pixels from JS -- a CSS-only shrink would just crop them.
const ANALYZER_H_FULL  = 220;
const ANALYZER_H_STUCK = 120;
let analyzerStuck = false;
function analyzerH() { return analyzerStuck ? ANALYZER_H_STUCK : ANALYZER_H_FULL; }

function resizeAnalyzer() {
  const slot = document.getElementById('analyzerSlot');
  if (slot) slot.style.height = analyzerH() + 'px';
  if (analyzerMode === 'sg') sizeSpectrogram();
  redrawStatic();
}

// A zero-height sentinel just above the sticky wrapper: when it scrolls out
// of view the wrapper is pinned. There is no CSS :stuck selector.
function initStickyAnalyzer() {
  const sentinel = document.getElementById('analyzerSentinel');
  const wrap = document.getElementById('analyzerSticky');
  if (!sentinel || !wrap) return;
  if (!('IntersectionObserver' in window)) return;   // stays 220 px, still usable
  new IntersectionObserver(entries => {
    const stuck = !entries[0].isIntersecting;
    if (stuck === analyzerStuck) return;
    analyzerStuck = stuck;
    wrap.classList.toggle('stuck', stuck);
    resizeAnalyzer();
  }, { threshold: 0 }).observe(sentinel);
}

'''
s = io.open(core, encoding='utf-8').read()
if 'function analyzerH()' in s:
    print('core: already applied')
else:
    anchor = '// Island must never overlap content'
    if anchor not in s: raise SystemExit('core anchor missing')
    s = s.replace(anchor, CORE_BLOCK + anchor, 1)
    io.open(core, 'w', encoding='utf-8').write(s)
    print('core: sticky helpers added')

# ── 2. analyzer: route heights through analyzerH() ─────────
s = io.open(anal, encoding='utf-8').read()
if 'const SG_H = 220;' in s:
    s = s.replace("const SG_H = 220;\n", "", 1)
    n = s.count('SG_H')
    s = s.replace('SG_H', 'analyzerH()')
    s = s.replace("const s = setupCanvas('fftCanvas', 220);",
                  "const s = setupCanvas('fftCanvas', analyzerH());", 1)
    s = s.replace("const W = rect.width, H = 220;",
                  "const W = rect.width, H = analyzerH();", 1)
    io.open(anal, 'w', encoding='utf-8').write(s)
    print('analyzer: SG_H -> analyzerH() (%d sites) + fft canvas + probe line' % n)
else:
    print('analyzer: already applied')

# ── 3. body: sentinel + sticky wrapper around the analyzer card ──
s = io.open(body, encoding='utf-8').read()
if 'analyzerSentinel' in s:
    print('body: already applied')
else:
    OLD = '''  <div class="chart-card" style="padding:0">
    <div class="analyzer-slot" id="analyzerSlot">'''
    NEW = '''  <div class="sticky-sentinel" id="analyzerSentinel" aria-hidden="true"></div>
  <div class="analyzer-sticky" id="analyzerSticky">
  <div class="chart-card" style="padding:0">
    <div class="analyzer-slot" id="analyzerSlot">'''
    if s.count(OLD) != 1: raise SystemExit('analyzer card anchor not unique/found')
    s = s.replace(OLD, NEW, 1)
    # close the wrapper after that card
    OLD_CLOSE = '''    </div>
  </div>

  <!-- ── SCOPE (disclosure) ── -->'''
    NEW_CLOSE = '''    </div>
  </div>
  </div>

  <!-- ── SCOPE (disclosure) ── -->'''
    if s.count(OLD_CLOSE) != 1: raise SystemExit('scope anchor not unique/found')
    s = s.replace(OLD_CLOSE, NEW_CLOSE, 1)
    io.open(body, 'w', encoding='utf-8').write(s)
    print('body: sentinel + sticky wrapper added')

# ── 4. head: css ───────────────────────────────────────────
s = io.open(head, encoding='utf-8').read()
if '.analyzer-sticky' in s:
    print('head: already applied')
else:
    OLD = '.analyzer-slot { position: relative; height: 220px; }'
    NEW = '''.sticky-sentinel { height: 0; margin: 0; padding: 0; }
.analyzer-sticky { position: sticky; top: 0; z-index: 30; }
.analyzer-sticky.stuck { background: var(--bg); padding-top: 4px; }
.analyzer-sticky.stuck .chart-card {
  margin-bottom: 4px;
  box-shadow: 0 8px 16px -10px rgba(0, 0, 0, 0.75);
}
.analyzer-slot { position: relative; height: 220px; }'''
    if OLD not in s: raise SystemExit('analyzer-slot rule not found')
    s = s.replace(OLD, NEW, 1)
    io.open(head, 'w', encoding='utf-8').write(s)
    print('head: sticky css added')

# ── 5. init: wire the observer ─────────────────────────────
s = io.open(init, encoding='utf-8').read()
if 'initStickyAnalyzer()' in s:
    print('init: already applied')
else:
    OLD = 'sizeIsland();\nbootDone = true;'
    NEW = 'sizeIsland();\ninitStickyAnalyzer();\nbootDone = true;'
    if OLD not in s: raise SystemExit('init anchor not found')
    s = s.replace(OLD, NEW, 1)
    io.open(init, 'w', encoding='utf-8').write(s)
    print('init: initStickyAnalyzer() wired')
