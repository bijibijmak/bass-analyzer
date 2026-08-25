#!/usr/bin/env python3
"""Make room for a sixth tab.

verify.js caught this: the island grid was repeat(5, 1fr) and its own check
said 'buttons would wrap'. Both the CSS and the check are updated, and the
check now derives the column count from TAB_NAMES so the next tab does not
need this edit at all.
"""
import sys, io
head, ver = sys.argv[1:3]

h = io.open(head, encoding='utf-8').read()
if 'repeat(5, 1fr)' in h:
    h = h.replace('repeat(5, 1fr)', 'repeat(6, 1fr)', 1)
    io.open(head, 'w', encoding='utf-8').write(h)
    print('island grid 5 -> 6 columns')
else:
    print('island grid already updated')

v = io.open(ver, encoding='utf-8').read()
OLD = "const TAB_NAMES = ['preamp','tuner','spectrum','detune','mix'];"
NEW = "const TAB_NAMES = ['preamp','tuner','spectrum','detune','wah','mix'];"
if OLD in v:
    v = v.replace(OLD, NEW, 1)
    print('TAB_NAMES now includes wah')

OLDG = ("if (/repeat\\(5, 1fr\\)/.test(html)) ok('island grid is five columns');\n"
        "else bad('island grid is not five columns — buttons would wrap');")
NEWG = ("// Derived, not literal: a new tab should not need this line edited.\n"
        "const cols = new RegExp('repeat\\\\(' + TAB_NAMES.length + ', 1fr\\\\)');\n"
        "if (cols.test(html)) ok(`island grid is ${TAB_NAMES.length} columns, one per tab`);\n"
        "else bad(`island grid is not ${TAB_NAMES.length} columns — buttons would wrap`);")
if OLDG in v:
    v = v.replace(OLDG, NEWG, 1)
    print('grid check now derives from the tab count')
elif 'TAB_NAMES.length + ' in v:
    print('grid check already derived')
else:
    raise SystemExit('grid check anchor not found')

io.open(ver, 'w', encoding='utf-8').write(v)
