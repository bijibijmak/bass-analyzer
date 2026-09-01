#!/usr/bin/env bash
# Assembles bass_mix_interactive.html + wsola-worklet.js from parts/.
#
# The WSOLA core is emitted into three places and must stay identical in all
# of them: the standalone worklet file, the inline <script id="wsolaSrc">
# fallback copy, and the page script (for the ScriptProcessor host).
# verify.js fails the build if they drift.
set -euo pipefail
cd "$(dirname "$0")"
P=parts
OUT=${1:-/tmp}

# 1. worklet module = core + AudioWorklet wrapper
cat "$P/wsola_core.js" "$P/wsola_wrapper.js" > /tmp/wsola_module.js
node --check /tmp/wsola_module.js

# 2. page script = app parts, with the core included for the fallback host
cat "$P/03_core.js" "$P/04_audio.js" "$P/05_analyzer.js" "$P/06_spectrum.js" \
    "$P/wsola_core.js" "$P/08_detune.js" "$P/09_wah.js" "$P/10_geq.js" "$P/11_comp.js" "$P/12_loop.js" "$P/07_tuner_presets_init.js" > /tmp/app.js
node --check /tmp/app.js

# 3. substitute the worklet source into the inert inline block
python3 - "$OUT" <<'PY'
import sys, io
out = sys.argv[1]
head = open('parts/01_head.html').read()
body = open('parts/02_body.html').read()
app  = open('/tmp/app.js').read()
mod  = open('/tmp/wsola_module.js').read()

assert '@@WSOLA_SRC@@' in body, 'placeholder missing from 02_body.html'
assert '</script>' not in mod, 'worklet source contains </script> and would break the inline block'
body = body.replace('@@WSOLA_SRC@@', mod.strip('\n'))

html = head + body + '\n<script>\n' + app + '</script>\n</body>\n</html>\n'
open(out + '/bass_mix_interactive.html', 'w').write(html)

hdr = ("// GENERATED — do not edit.\n"
       "// Source of truth is parts/wsola_core.js + parts/wsola_wrapper.js.\n"
       "// An identical copy lives inline in bass_mix_interactive.html.\n"
       "//@@GENERATED-HEADER-END\n")
open(out + '/wsola-worklet.js', 'w').write(hdr + mod.strip('\n') + '\n')
print('built ->', out)
PY
node --check "$OUT/wsola-worklet.js"
