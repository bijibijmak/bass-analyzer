#!/usr/bin/env python3
"""Permanent smoke coverage for the skins axis.

Pins the things that would break silently: a skin that forgets a canvas
colour (drawing code reads TH.* blind), a skin whose palette is accidentally
a copy of another, the cycle order, persistence under the documented keys,
and the back-compatible names the rest of the app calls.
"""
import sys, io
p = sys.argv[1] if len(sys.argv) > 1 else 'smoke.js'
s = io.open(p, encoding='utf-8').read()
if '[18] skins' in s:
    print('already applied'); raise SystemExit(0)

BLOCK = """  console.log('\\n[18] skins');
  try {
    const order = ev('SKIN_ORDER');
    const seen = new Map();
    let skinFails = 0;
    order.forEach(skin => ['dark', 'light'].forEach(mode => {
      ev('applyLook')(skin, mode, false);
      const th = ev('TH');
      const keys = Object.keys(th);
      // Drawing code reads TH.* blind, so a missing key paints with whatever
      // was last set on the context rather than throwing.
      if (keys.length !== 24 || keys.some(k => !th[k])) {
        bad(`${skin}/${mode}: ${keys.length} colours, empty: ${keys.filter(k => !th[k])}`); skinFails++;
      } else if (d.documentElement.getAttribute('data-skin') !== skin ||
                 d.documentElement.getAttribute('data-theme') !== mode) {
        bad(`${skin}/${mode}: root attributes not set`); skinFails++;
      } else {
        const sig = JSON.stringify(th);
        if (seen.has(sig)) { bad(`${skin}/${mode} is a copy of ${seen.get(sig)}`); skinFails++; }
        else seen.set(sig, skin + '/' + mode);
      }
    }));
    if (!skinFails) ok(`${order.length} skins x 2 modes = ${seen.size} distinct 24-colour palettes`);

    ev('applyLook')('classic', 'dark', false);
    const labels = [];
    for (let i = 0; i < 5; i++) { labels.push(d.getElementById('skinToggle').textContent); ev('cycleSkin')(); }
    if (labels.join('>') === 'Classic>Aria>Minimal>Lab>Classic') ok('cycleSkin wraps: ' + labels.join(' > '));
    else bad('cycle order is ' + labels.join(' > '));

    ev('setSkin')('lab');
    ev('applyLook')('lab', 'light', true);
    if (w.localStorage.getItem('b7k_skin') === 'lab' && w.localStorage.getItem('b7k_theme') === 'light')
      ok('skin and mode persist under b7k_skin / b7k_theme');
    else bad('persistence wrong');

    // The rest of the app still calls these by their old names.
    const api = ['applyTheme', 'toggleTheme', 'initTheme', 'applyLook', 'setSkin', 'cycleSkin'];
    const missing = api.filter(n => ev('typeof ' + n) !== 'function');
    if (!missing.length) ok('API intact: ' + api.join(', '));
    else bad('missing: ' + missing.join(', '));

    // The band markers must follow the skin, or they vanish on light skins.
    if (/ctx\\.strokeStyle = TH\\.bandMarker/.test(ev('drawSgOverlay').toString()))
      ok('spectrogram band markers are themed, not hardcoded white');
    else bad('spectrogram band markers are hardcoded — invisible on light skins');

    ev('applyLook')('classic', 'dark', true);
  } catch (e) { bad('skins threw: ' + e.stack); }

"""
A = "  console.log('\\n[13] no late errors');"
if A not in s: raise SystemExit('anchor not found')
io.open(p, 'w', encoding='utf-8').write(s.replace(A, BLOCK + A, 1))
print('smoke.js [18] skins added')
