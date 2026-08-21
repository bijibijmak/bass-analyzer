#!/usr/bin/env python3
"""The analyzer only shrinks on a touch device.

The shrink exists to protect a portrait phone viewport that is already giving
space to the tab island. A desktop window has no such problem, and keeping the
full 220 px there means the spectrum stays readable while you work the knobs.

It also removes the whole failure mode from the desktop path: with a constant
height there is no document-height change for the wheel to fight, on top of
the reserved wrapper that already prevents it.

Uses the same media query as the fps throttle and the CSS touch breakpoint, so
'is this a touch device' has exactly one definition in the codebase.
"""
import sys, io
core = sys.argv[1]
s = io.open(core, encoding='utf-8').read()

if 'analyzerShrinks' in s:
    print('already applied'); raise SystemExit(0)

OLD = """let analyzerStuck = false;
function analyzerH() { return analyzerStuck ? ANALYZER_H_STUCK : ANALYZER_H_FULL; }"""
NEW = """let analyzerStuck = false;

// Only a touch device shrinks. The shrink is there to protect a portrait
// phone viewport that is already giving space to the island; a desktop window
// has room, and the full height keeps the spectrum readable while you work the
// knobs. mqCoarse is the same query the fps throttle and the CSS touch
// breakpoint use, so "is this a touch device" has one definition.
function analyzerShrinks() { return !!(typeof mqCoarse !== 'undefined' && mqCoarse && mqCoarse.matches); }
function analyzerH() { return (analyzerStuck && analyzerShrinks()) ? ANALYZER_H_STUCK : ANALYZER_H_FULL; }"""

if OLD not in s: raise SystemExit('analyzerH anchor not found')
io.open(core, 'w', encoding='utf-8').write(s.replace(OLD, NEW, 1))
print('analyzer shrinks on touch devices only')
