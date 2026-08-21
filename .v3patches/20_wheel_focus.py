#!/usr/bin/env python3
"""Wheel adjusts a control only when that control is focused.

Seven knobs and six sliders sit in the middle of a long scrolling page, and
every one of them swallowed the wheel to change its own value. On a phone
that never came up; on a desktop it means the page stops scrolling whenever
the cursor happens to be over a control, and you silently change a setting
instead. That is most of what 'it still doesn't scroll' turns out to be.

Click a control to focus it and the wheel adjusts it, which is the behaviour
worth keeping. Otherwise the wheel belongs to the page.
"""
import sys, io
core = sys.argv[1]
s = io.open(core, encoding='utf-8').read()

if 'wheel belongs to the page' in s:
    print('already applied'); raise SystemExit(0)

# knobs
OLD_K = """    k.addEventListener('wheel', e => {
      if (off()) return;
      e.preventDefault();
      setStep(knobToStep(key, state[key]) + (e.deltaY < 0 ? 1 : -1));
    }, { passive: false });"""
NEW_K = """    // Only a focused knob takes the wheel; otherwise the wheel belongs to the
    // page. Without this, scrolling past the panel silently retunes whatever
    // the cursor crosses and the page stops moving.
    k.addEventListener('wheel', e => {
      if (off() || document.activeElement !== k) return;
      e.preventDefault();
      setStep(knobToStep(key, state[key]) + (e.deltaY < 0 ? 1 : -1));
    }, { passive: false });"""
if OLD_K not in s: raise SystemExit('knob wheel handler not found')
s = s.replace(OLD_K, NEW_K, 1)

# sliders (trim, noise tools, Mix EQ strip) — same hazard, same rule
OLD_S = """    el.addEventListener('wheel', e => {
      e.preventDefault();"""
NEW_S = """    el.addEventListener('wheel', e => {
      if (document.activeElement !== el) return;   // the wheel belongs to the page
      e.preventDefault();"""
if OLD_S not in s: raise SystemExit('slider wheel handler not found')
s = s.replace(OLD_S, NEW_S, 1)

io.open(core, 'w', encoding='utf-8').write(s)
print('wheel now requires focus, on both knobs and sliders')
