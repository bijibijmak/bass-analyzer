#!/usr/bin/env python3
"""Presets learn the graphic EQ.

v2 stored only the B7K's tone stack and drive section, so saving a preset
while the graphic EQ was selected quietly lost every fader. v3 adds the
eleven band gains, the user band's frequency, the EQ's Gain and Volume, and
which preamp was active -- so recalling a preset puts you back on the right
preamp with the right curve.

v2 presets migrate with the EQ flat and the preamp set to b7k, which is the
state they were captured in. Both older stores are left in place.
"""
import sys, io
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
if 'b7k_presets_v3' in s:
    print('already applied'); raise SystemExit(0)

s = s.replace(
"const PRESET_KEY    = 'b7k_presets_v2';\nconst PRESET_KEY_V1 = 'b7k_presets_v1';",
"const PRESET_KEY    = 'b7k_presets_v3';\nconst PRESET_KEY_V2 = 'b7k_presets_v2';\nconst PRESET_KEY_V1 = 'b7k_presets_v1';", 1)

s = s.replace(
"""function normalizePreset(p) {
  const o = (p && typeof p === 'object') ? p : {};
  return {""",
"""// The band array is rebuilt element by element rather than trusted, for the
// same reason every scalar is: one undefined reaching setTargetAtTime turns a
// filter's gain into NaN and silences it with no error.
function pgains(a) {
  const out = new Array(GEQ_N).fill(0);
  if (Array.isArray(a)) for (let i = 0; i < GEQ_N; i++) out[i] = pnum(a[i], 0, -12, 12);
  return out;
}

function normalizePreset(p) {
  const o = (p && typeof p === 'object') ? p : {};
  return {""", 1)

s = s.replace(
"""    grunt:     ppick(o.grunt,  1, [0, 1, 2]),
    attack:    ppick(o.attack, 1, [0, 1, 2])
  };""",
"""    grunt:     ppick(o.grunt,  1, [0, 1, 2]),
    attack:    ppick(o.attack, 1, [0, 1, 2]),
    preamp:      o.preamp === 'geq' ? 'geq' : 'b7k',
    geqGains:    pgains(o.geqGains),
    geqUserFreq: pnum(o.geqUserFreq, 700, 20, 10000),
    geqGain:     pnum(o.geqGain,   0, -12, 12),
    geqVolume:   pnum(o.geqVolume, 0, -12, 12)
  };""", 1)

s = s.replace(
"""  if (raw === null || raw === undefined) {
    // No v2 store yet — migrate v1 if there is one. v1 is left in place.
    let v1 = null;
    try { v1 = JSON.parse(localStorage.getItem(PRESET_KEY_V1) || 'null'); } catch (e) {}
    if (Array.isArray(v1) && v1.length) {
      const migrated = v1.map(normalizePreset);
      savePresetsToStorage(migrated);
      console.log('[Presets] migrated', migrated.length, 'preset(s) from v1 → v2');
      return migrated;
    }
    return [];
  }""",
"""  if (raw === null || raw === undefined) {
    // No v3 store yet — migrate the newest older store there is. Both are
    // left in place, so a downgrade still finds its own data.
    for (const [key, from] of [[PRESET_KEY_V2, 'v2'], [PRESET_KEY_V1, 'v1']]) {
      let old = null;
      try { old = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) {}
      if (Array.isArray(old) && old.length) {
        const migrated = old.map(normalizePreset);
        savePresetsToStorage(migrated);
        console.log('[Presets] migrated', migrated.length, 'preset(s) from ' + from + ' → v3');
        return migrated;
      }
    }
    return [];
  }""", 1)

s = s.replace(
"""    blend: state.blend, level: state.level, drive: state.drive,
    grunt: state.grunt, attack: state.attack
  }));""",
"""    blend: state.blend, level: state.level, drive: state.drive,
    grunt: state.grunt, attack: state.attack,
    preamp: preampKind,
    geqGains: geq.gains.slice(),
    geqUserFreq: geq.userFreq,
    geqGain: geq.gain,
    geqVolume: geq.volume
  }));""", 1)

s = s.replace(
"""  ['low','loMid','loMidFreq','hiMid','hiMidFreq','treble',
   'blend','level','drive','grunt','attack'].forEach(k => { state[k] = p[k]; });
  syncUI();
  render();""",
"""  ['low','loMid','loMidFreq','hiMid','hiMidFreq','treble',
   'blend','level','drive','grunt','attack'].forEach(k => { state[k] = p[k]; });

  for (let i = 0; i < GEQ_N; i++) geq.gains[i] = p.geqGains[i];
  geq.userFreq = p.geqUserFreq;
  geq.gain     = p.geqGain;
  geq.volume   = p.geqVolume;
  if (geqNodes) geqApply(false);
  geqSyncUI(); geqSave();
  setPreamp(p.preamp);      // also redraws, so the curve follows the recall

  syncUI();
  render();""", 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('presets v3: graphic EQ and preamp choice are saved and recalled')
