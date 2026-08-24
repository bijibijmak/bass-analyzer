#!/usr/bin/env python3
"""Apply the analyzer-skins pack: 4 skins x 2 modes = 8 looks.

Four edits, exactly as the pack's README specifies, but anchored on content
rather than the line numbers it quotes (those have moved).

  1. 01_head.html  — append skins.css at the end of the <style> block.
                     Source order matters: it must follow the existing :root
                     and :root[data-theme="light"] blocks so it can override.
  2. 03_core.js    — replace the THEME block (banner .. end of initTheme)
                     with skins.js. TH, applyTheme, toggleTheme, initTheme
                     and bootDone keep their names and signatures, so every
                     existing call site still works.
  3. 02_body.html  — header row gains the skin cycler beside the theme toggle.
  4. 05_analyzer.js— the spectrogram's EQ band markers were hardcoded white at
                     0.22 alpha, which is invisible on the Minimal and Lab
                     light skins (and already near-invisible on Classic light
                     today). Now TH.bandMarker, which every skin defines.
"""
import sys, io, re

head, core, body, anal, skindir = sys.argv[1:6]

# ── 1. css ─────────────────────────────────────────────────
h = io.open(head, encoding='utf-8').read()
css = io.open(skindir + '/skins.css', encoding='utf-8').read().rstrip('\n')
if 'data-skin="aria"' in h:
    print('1. css already appended')
else:
    if h.count('</style>') != 1:
        raise SystemExit('expected exactly one </style>')
    h = h.replace('</style>', css + '\n</style>', 1)
    io.open(head, 'w', encoding='utf-8').write(h)
    print('1. skins.css appended at the end of the style block')

# ── 2. theme block -> skins.js ─────────────────────────────
s = io.open(core, encoding='utf-8').read()
js = io.open(skindir + '/skins.js', encoding='utf-8').read().rstrip('\n')
if 'const SKINS = {' in s:
    print('2. skins.js already in place')
else:
    marker = '// THEME (canvas colours'
    i = s.index(marker)
    start = s.rindex('\n//', 0, i) + 1          # the banner line above it
    j = s.index('function initTheme()', i)
    k = s.index('{', j)
    depth = 0
    for n in range(k, len(s)):
        if s[n] == '{': depth += 1
        elif s[n] == '}':
            depth -= 1
            if depth == 0: end = n + 1; break
    old = s[start:end]
    if 'const THEMES' not in old or 'function initTheme' not in old:
        raise SystemExit('theme block boundaries look wrong')
    io.open(core, 'w', encoding='utf-8').write(s[:start] + js + s[end:])
    print('2. THEME block replaced (%d lines -> %d)' % (old.count('\n') + 1, js.count('\n') + 1))

# ── 3. header row ──────────────────────────────────────────
b = io.open(body, encoding='utf-8').read()
if 'skinToggle' in b:
    print('3. header row already updated')
else:
    hdr = io.open(skindir + '/header-row.html', encoding='utf-8').read()
    hdr = re.sub(r'<!--.*?-->\s*', '', hdr, count=1, flags=re.S).strip()   # drop the instruction comment
    m = re.search(r'<div class="header-row">.*?\n</div>\n', b, re.S)
    if not m: raise SystemExit('header-row block not found')
    b = b[:m.start()] + hdr + '\n' + b[m.end():]
    io.open(body, 'w', encoding='utf-8').write(b)
    print('3. header row now carries the skin cycler')

# ── 4. band markers ────────────────────────────────────────
a = io.open(anal, encoding='utf-8').read()
OLD = "ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);"
NEW = "ctx.strokeStyle = TH.bandMarker; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);"
if OLD in a:
    if a.count(OLD) != 1: raise SystemExit('band marker line is not unique')
    io.open(anal, 'w', encoding='utf-8').write(a.replace(OLD, NEW, 1))
    print('4. spectrogram band markers now use TH.bandMarker')
else:
    print('4. band markers already themed')
