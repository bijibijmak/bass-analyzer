#!/usr/bin/env python3
"""Handoff §9: raw latency diagnostic instead of a guessed unit conversion.

The old line multiplied baseLatency + outputLatency by 1000 unconditionally
and displayed the result, which is what produced the implausible four-digit
figure on the phone. Per the handoff: print the raw values unmodified, then
clamp and label the derived one, rather than guessing which browser reports
what unit.
"""
import sys, io

audio = sys.argv[1] if len(sys.argv) > 1 else 'parts/04_audio.js'
head  = sys.argv[2] if len(sys.argv) > 2 else 'parts/01_head.html'

HELPER = '''// ── Latency readout ────────────────────────────────────────
// baseLatency and outputLatency are specified in SECONDS. A four-digit
// millisecond result therefore means a browser is reporting something
// else -- most likely already-milliseconds. Rather than guess the unit,
// show the raw values untouched and clamp + flag the derived figure.
const LAT_MAX_MS = 500;
function latencyLine() {
  if (!audioCtx) return '';
  const bl = audioCtx.baseLatency;
  const ol = audioCtx.outputLatency;
  const sr = audioCtx.sampleRate;
  if (!Number.isFinite(bl) && !Number.isFinite(ol)) return '';
  const ms = ((Number.isFinite(bl) ? bl : 0) + (Number.isFinite(ol) ? ol : 0)) * 1000;
  const over = ms > LAT_MAX_MS;
  const shown = over ? LAT_MAX_MS : Math.round(ms);
  const fmt = v => Number.isFinite(v) ? String(Number(v.toPrecision(4))) : 'n/a';
  const diag = `base ${fmt(bl)} · out ${fmt(ol)} · sr ${sr}`;
  return ` · Latency: ${over ? '&gt;' : '~'}${shown} ms`
       + `<small class="lat-raw">${diag}</small>`;
}

'''

OLD_LAT = """    const lat = audioCtx.baseLatency
      ? ` · Latency: ~${Math.round((audioCtx.baseLatency + (audioCtx.outputLatency || 0)) * 1000)} ms`
      : '';
"""
NEW_LAT = "    const lat = latencyLine();\n"

s = io.open(audio, encoding='utf-8').read()

if 'function latencyLine()' in s:
    print('latency helper already present')
else:
    # insert the helper just above the parameter setter, which is a stable anchor
    anchor = '// ── Parameter setter.'
    if anchor not in s:
        raise SystemExit('anchor not found: ' + anchor)
    s = s.replace(anchor, HELPER + anchor, 1)

    if OLD_LAT not in s:
        raise SystemExit('old latency block not found')
    s = s.replace(OLD_LAT, NEW_LAT, 1)

    # the device-switch path rewrote the status line without any latency at all
    old_sw = """    document.getElementById('audioStatus').innerHTML = `<em>Live · ctx:${audioCtx.state}</em> · ${track.label}`;"""
    new_sw = """    document.getElementById('audioStatus').innerHTML = `<em>Live · ctx:${audioCtx.state}</em> · ${track.label}` + latencyLine();"""
    if old_sw in s:
        s = s.replace(old_sw, new_sw, 1)
    else:
        print('note: device-switch status line not matched, left as-is')

    io.open(audio, 'w', encoding='utf-8').write(s)
    print('latency helper added; both status paths use it')

h = io.open(head, encoding='utf-8').read()
CSS_ANCHOR = '.audio-status.err { color: #ff6666; }'
CSS_NEW = (CSS_ANCHOR +
  "\n.audio-status .lat-raw { display: block; margin-top: 2px; opacity: 0.6;"
  " font-size: 0.92em; letter-spacing: 0.05em; }")
if '.lat-raw' in h:
    print('lat-raw css already present')
else:
    if CSS_ANCHOR not in h:
        raise SystemExit('css anchor not found')
    io.open(head, 'w', encoding='utf-8').write(h.replace(CSS_ANCHOR, CSS_NEW, 1))
    print('lat-raw css added')
