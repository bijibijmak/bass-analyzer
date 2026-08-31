#!/usr/bin/env python3
"""Use the width on a desktop: Output | EQ | Drive, side by side.

Everything was one tall column, so on a wide screen two thirds of the display
sat empty and the drive section needed a scroll to reach. Above 900 px the
panel becomes three columns -- Gain and Volume on the left, the eleven faders
in the middle, the drive section on the right.

DOM order stays EQ first, so on a phone the important thing is still at the
top; the columns are re-ordered with `order` only where the grid applies.
"""
import sys, io, re
body, head = sys.argv[1:3]

b = io.open(body, encoding='utf-8').read()
if 'geq-layout' in b:
    print('layout already applied')
else:
    start = b.index('<div id="preampGeq" style="display:none">')
    inner_start = start + len('<div id="preampGeq" style="display:none">')
    end = b.index('\n</div>\n', inner_start)
    inner = b[inner_start:end]

    def grab(label):
        m = re.search(r'( *<div class="section-label">' + label + r'.*?</div>\s*<div class="noise-section">.*?\n  </div>\n)', inner, re.S)
        if not m: raise SystemExit('could not find the ' + label + ' block')
        return m.group(1)

    out_block = grab('Output')
    drv_block = grab('Drive')
    main = inner.replace(out_block, '').replace(drv_block, '').strip('\n')

    def indent(t, pad='    '):
        return '\n'.join((pad + l if l.strip() else l) for l in t.split('\n'))

    new_inner = ('\n  <div class="geq-layout">\n'
                 '    <div class="geq-col geq-col-main">\n' + indent(main) + '\n    </div>\n'
                 '    <div class="geq-col geq-col-left">\n' + indent(out_block.strip('\n')) + '\n    </div>\n'
                 '    <div class="geq-col geq-col-right">\n' + indent(drv_block.strip('\n')) + '\n    </div>\n'
                 '  </div>\n')
    io.open(body, 'w', encoding='utf-8').write(b[:inner_start] + new_inner + b[end:])
    print('markup: three columns (DOM order keeps the EQ first for phones)')

h = io.open(head, encoding='utf-8').read()
if '.geq-layout' in h:
    print('layout css already present')
else:
    CSS = """
/* Desktop uses the width: Output | EQ | Drive. Below 900px it stays one
   column in DOM order, which puts the EQ first where it belongs on a phone. */
.geq-layout { display: block; }
.geq-col { min-width: 0; }
@media (min-width: 900px) {
  .geq-layout {
    display: grid; align-items: start; gap: 18px;
    grid-template-columns: minmax(150px, 0.85fr) minmax(360px, 2.4fr) minmax(165px, 0.95fr);
  }
  .geq-col-left  { order: 1; }
  .geq-col-main  { order: 2; }
  .geq-col-right { order: 3; }
  .geq-col .noise-section { margin-bottom: 0; }
  .geq-col-right .geq-switch-row { gap: 16px; }
}
"""
    A = '/* ── Graphic EQ preamp ─────────────────────────────────────'
    h = h.replace(A, CSS.lstrip('\n') + '\n' + A, 1) if A in h else h.replace('</style>', CSS + '</style>', 1)
    io.open(head, 'w', encoding='utf-8').write(h)
    print('css: three-column grid above 900px')
