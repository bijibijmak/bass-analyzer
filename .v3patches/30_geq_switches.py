#!/usr/bin/env python3
"""Grunt and Attack become pill switches on the EQ side too.

They were range inputs there, which is wrong for a three-position control and
inconsistent with the B7K panel. The pill component already exists; it just
assumed a single instance per switch id. Generalised to every instance, so
the two panels' switches are twins the same way the drive faders and knobs
already are.
"""
import sys, io
core, body = sys.argv[1:3]

s = io.open(core, encoding='utf-8').read()
if 'sp.wraps' in s:
    print('switch code already generalised')
else:
    OLD = """function swSpec(id) {
  const wrap = document.querySelector('[data-swlabels="' + id + '"]');
  if (!wrap) return null;
  const spans = Array.from(wrap.querySelectorAll('span'));
  return { spans, values: spans.map(sp => parseFloat(sp.dataset.v)) };
}
function syncSwitch(id) {
  const sp = swSpec(id); if (!sp) return;
  const n = sp.values.length;
  let i = sp.values.indexOf(state[id]);
  if (i < 0) i = n >> 1;
  const dot = document.querySelector('[data-sw="' + id + '"] .sw-dot');
  if (dot) dot.style.top = (n === 3 ? [15, 50, 85][i] : [25, 75][i]) + '%';
  sp.spans.forEach((el, k) => el.classList.toggle('on', k === i));
}"""
    NEW = """// A switch id can appear on more than one panel — the B7K knob panel and the
// graphic EQ both carry Grunt and Attack. Every instance is read from the
// markup and every instance is synced, so they stay twins of each other.
function swSpec(id) {
  const wraps = Array.from(document.querySelectorAll('[data-swlabels="' + id + '"]'));
  if (!wraps.length) return null;
  const spans = Array.from(wraps[0].querySelectorAll('span'));
  return { wraps, spans, values: spans.map(sp => parseFloat(sp.dataset.v)) };
}
function syncSwitch(id) {
  const sp = swSpec(id); if (!sp) return;
  const n = sp.values.length;
  let i = sp.values.indexOf(state[id]);
  if (i < 0) i = n >> 1;
  const top = (n === 3 ? [15, 50, 85][i] : [25, 75][i]) + '%';
  document.querySelectorAll('[data-sw="' + id + '"] .sw-dot').forEach(d => { d.style.top = top; });
  sp.wraps.forEach(w => Array.from(w.querySelectorAll('span'))
    .forEach((el, k) => el.classList.toggle('on', k === i)));
}"""
    if OLD not in s: raise SystemExit('switch block not found')
    io.open(core, 'w', encoding='utf-8').write(s.replace(OLD, NEW, 1))
    print('pill switches now drive every instance of an id')

b = io.open(body, encoding='utf-8').read()
if 'data-swlabels="grunt"' in b.split('id="preampGeq"')[1]:
    print('geq switches already in place'); raise SystemExit(0)

OLD_G = """    <div class="noise-tool">
      <div class="ctrl-label">Grunt <span class="val" data-val="grunt">Raw</span></div>
      <input type="range" data-bind="grunt" min="0" max="2" value="1" step="1">
      <div class="noise-tool-desc">Thin · Raw · Fat</div>
    </div>
    <div class="noise-tool">
      <div class="ctrl-label">Attack <span class="val" data-val="attack">Flat</span></div>
      <input type="range" data-bind="attack" min="0" max="2" value="1" step="1">
      <div class="noise-tool-desc">Cut · Flat · Boost — these are twins of the knobs on the B7K panel.</div>
    </div>"""
NEW_G = """    <div class="noise-tool geq-switch-row">
      <div class="swcell">
        <div class="sw-main">
          <div class="sw-pill n3" data-sw="grunt" tabindex="0" role="button" aria-label="Grunt switch"><div class="sw-dot"></div></div>
          <div class="sw-labels" data-swlabels="grunt"><span data-v="2">Fat</span><span data-v="0">Thin</span><span data-v="1">Raw</span></div>
        </div>
        <div class="sw-cap">Grunt</div>
      </div>
      <div class="swcell">
        <div class="sw-main">
          <div class="sw-pill n3" data-sw="attack" tabindex="0" role="button" aria-label="Attack switch"><div class="sw-dot"></div></div>
          <div class="sw-labels" data-swlabels="attack"><span data-v="1">Flat</span><span data-v="2">Boost</span><span data-v="0">Cut</span></div>
        </div>
        <div class="sw-cap">Attack</div>
      </div>
      <div class="noise-tool-desc" style="flex:1 1 100%">Twins of the switches on the B7K panel — moving one moves the other.</div>
    </div>"""
if OLD_G not in b: raise SystemExit('geq drive switch markup not found')
io.open(body, 'w', encoding='utf-8').write(b.replace(OLD_G, NEW_G, 1))
print('geq drive: grunt and attack are switches')
