#!/usr/bin/env python3
"""Align the main column now that the shell is wider.

Widening .app-wrap left the page inconsistent: the analyzer chart has no cap
so it went full width, while eight content panels kept their 560px cap and
sat centred inside it. Above 900px those panels take the shell width too, so
the page reads as one column instead of a wide chart with narrow cards
floating under it.

The noise tools and the preset list become multi-column at that width, which
is where most of the scrolling on this tab was coming from.
"""
import sys, io, re
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
if '--panel-wide' in s:
    print('already applied'); raise SystemExit(0)

CSS = """
/* Above 900px the content panels follow the shell rather than staying at
   their phone width, so the page is one column instead of a full-width chart
   with narrow cards under it. The list-like panels also go multi-column,
   which is where most of the scrolling was. */
@media (min-width: 900px) {
  .audio-bar, .disclosure, .noise-section, .preset-section,
  .pedal-panel, .controls-grid, .tuner-section, .dt-card { max-width: var(--shell-wide); }
  .noise-section { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; align-items: start; }
  .noise-section > .geq-switch-row { grid-column: 1 / -1; }
  .geq-col .noise-section { display: block; }
  .preset-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px; }
}
"""
A = '/* Desktop uses the width: Output | EQ | Drive.'
if A not in s: raise SystemExit('anchor not found')
io.open(p, 'w', encoding='utf-8').write(s.replace(A, CSS.lstrip('\n') + '\n' + A, 1))
print('content panels follow the shell above 900px; lists go multi-column')
