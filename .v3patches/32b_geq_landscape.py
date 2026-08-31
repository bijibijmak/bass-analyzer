#!/usr/bin/env python3
"""Use the width on a desktop: Output | EQ | Drive, side by side.

Everything was one tall column, so on a wide screen two thirds of the display
sat empty and the drive section needed a scroll to reach. Above 900px the
panel becomes three columns.

Split on the section-label lines rather than a structural regex — the drive
block's shape changed when its faders became switches, and a regex written
against the old shape is exactly the kind of thing that breaks silently.

DOM order keeps the EQ first, so a phone is unchanged; the columns are
re-ordered with `order` only inside the media query.
"""
import sys, io
body, head = sys.argv[1:3]

b = io.open(body, encoding='utf-8').read()
if 'geq-layout' in b:
    print('layout already applied')
else:
    OPEN = '<div id="preampGeq" style="display:none">'
    s = b.index(OPEN) + len(OPEN)
    e = b.index('\n</div>\n', s)
    lines = b[s:e].split('\n')

    def at(pred):
        for i, l in enumerate(lines):
            if pred(l): return i
        raise SystemExit('marker not found')

    i_out = at(lambda l: 'section-label">Output' in l)
    i_drv = at(lambda l: 'section-label">Drive' in l)
    if not (0 < i_out < i_drv):
        raise SystemExit('unexpected section order')

    main = '\n'.join(lines[:i_out]).strip('\n')
    out  = '\n'.join(lines[i_out:i_drv]).strip('\n')
    drv  = '\n'.join(lines[i_drv:]).strip('\n')
    for name, blk in [('main', main), ('output', out), ('drive', drv)]:
        if not blk.strip(): raise SystemExit(name + ' block came out empty')

    pad = lambda t: '\n'.join(('    ' + l if l.strip() else l) for l in t.split('\n'))
    new = ('\n  <div class="geq-layout">\n'
           '    <div class="geq-col geq-col-main">\n' + pad(main) + '\n    </div>\n'
           '    <div class="geq-col geq-col-left">\n' + pad(out) + '\n    </div>\n'
           '    <div class="geq-col geq-col-right">\n' + pad(drv) + '\n    </div>\n'
           '  </div>\n')
    io.open(body, 'w', encoding='utf-8').write(b[:s] + new + b[e:])
    print('markup: three columns (DOM order keeps the EQ first)')

h = io.open(head, encoding='utf-8').read()
if '.geq-layout' in h:
    print('layout css already present')
else:
    CSS = """/* Desktop uses the width: Output | EQ | Drive. Below 900px it stays one
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
    A = '.geq-switch-row {'
    h = h.replace(A, CSS + A, 1) if A in h else h.replace('</style>', CSS + '</style>', 1)
    io.open(head, 'w', encoding='utf-8').write(h)
    print('css: three-column grid above 900px')
