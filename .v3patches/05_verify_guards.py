#!/usr/bin/env python3
"""Add static guards so the 10 kHz axis work cannot half-land or regress.

The failure this is aimed at: the axis span used to be written as
Math.log10(1000) -- three decades above 20 Hz -- carrying no ceiling literal
at all. A literal-only edit clips the data at 10 kHz while still drawing a
20 kHz axis, and every existing check passes.
"""
import sys, io

path = sys.argv[1] if len(sys.argv) > 1 else 'verify.js'
s = io.open(path, encoding='utf-8').read()

if '[15] frequency axis' in s:
    print('axis guards already present'); raise SystemExit(0)

BLOCK = r'''
// ── 15. frequency axis is defined once, in named constants ──
// The span used to be encoded as Math.log10(1000) ("three decades above
// 20 Hz") with no ceiling literal anywhere in the mapping, so changing the
// 20000 literals alone clipped the data while leaving the axis 20 kHz wide.
// Both patterns are now build failures. Comments are stripped first so the
// commentary explaining this does not trip it.
console.log('\n[15] frequency axis');
(() => {
  const code = js
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"\\])\/\/.*$/gm, '$1');

  const fmax = (code.match(/const AX_FMAX\s*=\s*(\d+)/) || [])[1];
  const fmin = (code.match(/const AX_FMIN\s*=\s*(\d+)/) || [])[1];
  if (!fmin || !fmax) return bad('AX_FMIN / AX_FMAX not defined — axis range is not centralised');
  ok(`axis constants defined: ${fmin} Hz – ${fmax} Hz`);
  if (fmax !== '10000') bad(`AX_FMAX is ${fmax}, expected 10000 (handoff §5)`);
  if (!/const AX_DECADES\s*=\s*Math\.log10\(AX_FMAX \/ AX_FMIN\)/.test(code))
    bad('AX_DECADES not derived from AX_FMIN/AX_FMAX');

  const hardSpan = (code.match(/Math\.log10\(1000\)/g) || []).length;
  if (hardSpan) bad(`${hardSpan}× bare Math.log10(1000) — that is a hardcoded 20 kHz span`);
  else ok('no hardcoded decade span');

  // Every surviving 20000 must be the filterHiss cutoff, which is a filter
  // parameter and not axis code.
  const stray = code.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /\b20000\b/.test(l) && !/filterHiss/.test(l));
  if (stray.length) bad('20000 outside the hiss filter at line(s) ' + stray.map(x => x[0]).join(', '));
  else ok('the only 20000 literals are the hiss filter cutoff');

  const mapped = (code.match(/Math\.log10\(f \/ AX_FMIN\) \/ AX_DECADES/g) || []).length;
  if (mapped === 2) ok('both x-axis mappings derive from the constants');
  else bad(`${mapped} axis mappings use AX_DECADES, expected 2 (drawAxes + spectrogram overlay)`);

  if (/AX_FMIN \* Math\.pow\(AX_FMAX \/ AX_FMIN, t\)/.test(code)) ok('crosshair inverse matches the forward map');
  else bad('chartXtoFreq does not invert the AX_ mapping — probe will report the wrong frequency');

  const labels = (code.match(/const LABEL_FREQS = \[([^\]]+)\]/) || [])[1];
  if (labels) {
    const top = Math.max(...labels.split(',').map(n => parseInt(n, 10)));
    if (String(top) === fmax) ok(`highest axis label (${top}) matches the ceiling`);
    else bad(`highest axis label is ${top} but the ceiling is ${fmax}`);
  } else bad('LABEL_FREQS not found');
})();

'''

TAIL = "console.log('\\n' + (fails ? `${fails} FAILURE(S)` : 'ALL STATIC CHECKS PASSED'));"
if TAIL not in s:
    raise SystemExit('summary line not found')
s = s.replace(TAIL, BLOCK.lstrip('\n') + TAIL, 1)
io.open(path, 'w', encoding='utf-8').write(s)
print('added [15] frequency axis guards')
