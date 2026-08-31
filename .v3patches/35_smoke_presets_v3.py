#!/usr/bin/env python3
"""smoke [7] pinned the v2 schema.

Three things it assumed: that every non-name field is a finite number (v3
adds a string and an array), that the store key is b7k_presets_v2, and that
it could drop a v2 payload in mid-test -- which no longer works, because by
then the v1 migration has already written a v3 store that takes precedence,
so the garbage preset was never read and the assertions were measuring the
earlier preset.

Rewritten around v3, with each migration path isolated by a clear(), and a
new assertion for the thing that actually cost Bijan an evening: that an EQ
curve survives save -> flat -> recall.
"""
import sys, io
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
if 'geqGains round-trip' in s:
    print('already applied'); raise SystemExit(0)

OLD = """    const bad0 = Object.entries(p).filter(([k, v]) => k !== 'name' && !Number.isFinite(v));
    if (bad0.length) bad('migrated preset has non-finite fields: ' + JSON.stringify(bad0));
    else ok('v1 → v2 migration produced only finite numbers');"""
NEW = """    // v3 adds a string (preamp) and an array (geqGains); everything else must
    // still be a finite number.
    const SKIP = new Set(['name', 'preamp', 'geqGains']);
    const bad0 = Object.entries(p).filter(([k, v]) => !SKIP.has(k) && !Number.isFinite(v));
    if (bad0.length) bad('migrated preset has non-finite fields: ' + JSON.stringify(bad0));
    else ok('v1 → v3 migration produced only finite numbers');
    if (Array.isArray(p.geqGains) && p.geqGains.length === 11 && p.geqGains.every(Number.isFinite))
      ok('migrated preset carries 11 finite EQ band gains');
    else bad('geqGains is ' + JSON.stringify(p.geqGains));
    if (p.preamp === 'b7k') ok('migrated preset defaults to the B7K preamp');
    else bad('preamp defaulted to ' + p.preamp);"""
assert OLD in s
s = s.replace(OLD, NEW, 1)

OLD = """    if (!w.localStorage.getItem('b7k_presets_v2')) bad('v2 store not written on migrate');
    else ok('v2 store written');

    // Deliberately hostile: hand-edited garbage must not reach a gain node.
    w.localStorage.setItem('b7k_presets_v2', JSON.stringify(["""
NEW = """    if (!w.localStorage.getItem('b7k_presets_v3')) bad('v3 store not written on migrate');
    else ok('v3 store written');

    // v2 is the store most users are actually on, so migrate that too.
    w.localStorage.clear();
    w.localStorage.setItem('b7k_presets_v2', JSON.stringify([{
      name: 'Old v2', low: 2, blend: 40, level: 90, drive: 30, grunt: 2, attack: 0
    }]));
    const v2p = ev('loadPresetsFromStorage')()[0];
    if (v2p && v2p.blend === 40 && v2p.grunt === 2 && v2p.geqGains.every(g => g === 0))
      ok('v2 → v3 keeps the drive section and adds a flat EQ');
    else bad('v2 migration gave ' + JSON.stringify(v2p));

    // Deliberately hostile: hand-edited garbage must not reach a gain node.
    // Written to the CURRENT store, or the migration above would shadow it.
    w.localStorage.clear();
    w.localStorage.setItem('b7k_presets_v3', JSON.stringify(["""
assert OLD in s
s = s.replace(OLD, NEW, 1)

OLD = """        level: 'unity', drive: {}, grunt: 9, attack: -3, loMidFreq: 777, hiMidFreq: 'abc' }
    ]));
    const j = ev('loadPresetsFromStorage')()[0];
    const junkBad = Object.entries(j).filter(([k, v]) => k !== 'name' && !Number.isFinite(v));"""
NEW = """        level: 'unity', drive: {}, grunt: 9, attack: -3, loMidFreq: 777, hiMidFreq: 'abc',
        geqGains: ['x', null, undefined, NaN, 99, -99, {}, [], 'y', 3, 'z'],
        geqUserFreq: 'nope', geqGain: {}, geqVolume: NaN, preamp: 'nonsense' }
    ]));
    const j = ev('loadPresetsFromStorage')()[0];
    const junkBad = Object.entries(j).filter(([k, v]) => !SKIP.has(k) && !Number.isFinite(v));"""
assert OLD in s
s = s.replace(OLD, NEW, 1)

OLD = """    else ok('garbage preset fully coerced to finite defaults');"""
NEW = """    else ok('garbage preset fully coerced to finite defaults');
    if (j.geqGains.every(Number.isFinite) && j.geqGains[4] === 12 && j.geqGains[5] === -12 &&
        j.geqGains[9] === 3 && j.preamp === 'b7k' && Number.isFinite(j.geqUserFreq))
      ok('garbage EQ bands coerced and clamped to ±12, preamp falls back to b7k');
    else bad('geq garbage gave ' + JSON.stringify({g: j.geqGains, p: j.preamp, f: j.geqUserFreq}));"""
assert OLD in s
s = s.replace(OLD, NEW, 1)

OLD = """    ev('deletePreset')(0);
    if (ev('loadPresetsFromStorage')().length === 0) ok('delete works');
    else bad('delete failed');"""
NEW = """    ev('deletePreset')(0);
    if (ev('loadPresetsFromStorage')().length === 0) ok('delete works');
    else bad('delete failed');

    // geqGains round-trip — the failure that cost an evening: a curve dialled
    // in, saved, flattened, then recalled must come back.
    w.localStorage.clear();
    ev('setPreamp')('geq');
    const g = ev('geq');
    g.gains[0] = 7.5; g.gains[5] = -9; g.gains[10] = 4;
    g.userFreq = 820; g.gain = 2.5; g.volume = -3;
    d.getElementById('presetName').value = 'Curve';
    ev('savePreset')();
    ev('geqReset')(); g.userFreq = 700; g.gain = 0; g.volume = 0;
    ev('applyPreset')(0);
    const back = ev('geq');
    if (back.gains[0] === 7.5 && back.gains[5] === -9 && back.gains[10] === 4 &&
        back.userFreq === 820 && back.gain === 2.5 && back.volume === -3 &&
        ev('preampKind') === 'geq')
      ok('EQ curve survives save → flat → recall, and the preamp comes back with it');
    else bad('EQ did not round-trip: ' + JSON.stringify({
      g: back.gains, f: back.userFreq, gain: back.gain, vol: back.volume, p: ev('preampKind') }));
    ev('setPreamp')('b7k'); w.localStorage.clear();"""
assert OLD in s
s = s.replace(OLD, NEW, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('smoke [7] rewritten for v3, with an EQ round-trip assertion')
