#!/usr/bin/env python3
"""The three-column EQ had nowhere to go: .app-wrap is capped at 600px.

Measured at a 1400px viewport: the layout box was 600px wide while its three
tracks needed 711, so the grid overflowed instead of expanding and every
column sat at its minimum. That is why the EQ strip was 48px right of centre
at every width — it was not a centring bug so much as a container that was
never given room.

Two changes:

  · Above 900px the shell widens to 1180px. Almost every inner panel already
    carries `max-width: 560px; margin: 0 auto`, so the other tabs are
    unchanged apart from wider margins — only the EQ grid, which has no cap,
    actually uses the space.

  · The side columns become symmetric 1fr with the centre column bounded, so
    the faders are centred on the page by construction rather than by
    arithmetic that happens to work out.
"""
import sys, io
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
if '--shell-wide' in s:
    print('already applied'); raise SystemExit(0)

OLD = '.app-wrap { max-width: 600px; margin: 0 auto; }'
NEW = """/* 600px is right for a phone and wastes a desktop. Widened above 900px;
   the inner panels keep their own 560px caps, so only the layouts that ask
   for the room take it. */
:root { --shell-wide: 1180px; }
.app-wrap { max-width: 600px; margin: 0 auto; }
@media (min-width: 900px) { .app-wrap { max-width: var(--shell-wide); } }"""
if OLD not in s: raise SystemExit('app-wrap rule not found')
s = s.replace(OLD, NEW, 1)

OLD_G = """  .geq-layout {
    display: grid; align-items: start; gap: 18px;
    grid-template-columns: minmax(150px, 0.85fr) minmax(360px, 2.4fr) minmax(165px, 0.95fr);
  }"""
NEW_G = """  .geq-layout {
    display: grid; align-items: start; gap: 20px;
    /* Symmetric sides: the faders are centred on the page by construction. */
    grid-template-columns: 1fr minmax(340px, 620px) 1fr;
  }"""
if OLD_G not in s: raise SystemExit('geq grid rule not found')
s = s.replace(OLD_G, NEW_G, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('shell widens above 900px; EQ columns are symmetric')
