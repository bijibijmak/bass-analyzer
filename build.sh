#!/usr/bin/env bash
# Assembles index.html + wsola-worklet.js from parts/.
# index.html, not a long filename: GitHub Pages then serves the app at the
# bare folder URL, which is what the phone adds to its home screen.
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
    "$P/wsola_core.js" "$P/08_detune.js" "$P/09_wah.js" "$P/10_geq.js" "$P/11_comp.js" "$P/12_loop.js" "$P/13_eqdrag.js" "$P/14_para.js" "$P/07_tuner_presets_init.js" > /tmp/app.js
node --check /tmp/app.js

# 3. substitute the worklet source into the inert inline block
python3 - "$OUT" <<'PY'
import sys, io, os
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
head = open('parts/01_head.html').read()
body = open('parts/02_body.html').read()
app  = open('/tmp/app.js').read()
mod  = open('/tmp/wsola_module.js').read()

import hashlib, re
ver = re.search(r"const APP_VERSION = '([^']+)'", app)
assert ver, 'APP_VERSION missing from the page script'
ver = ver.group(1)

# Hash the page as assembled but with the stamp still a placeholder, so the
# hash describes the source rather than itself.
stamp_hash = hashlib.sha256((head + body + app).encode('utf-8')).hexdigest()[:7]
build = 'v%s \u00b7 %s' % (ver, stamp_hash)
assert '@@BUILD@@' in body, 'build placeholder missing from 02_body.html'
body = body.replace('@@BUILD@@', build)

sw = open('parts/sw.js').read()
assert '@@CACHE@@' in sw, 'cache placeholder missing from parts/sw.js'
open(out + '/sw.js', 'w').write(sw.replace('@@CACHE@@', 'b7k-' + stamp_hash))

assert '@@WSOLA_SRC@@' in body, 'placeholder missing from 02_body.html'
assert '</script>' not in mod, 'worklet source contains </script> and would break the inline block'
body = body.replace('@@WSOLA_SRC@@', mod.strip('\n'))

html = head + body + '\n<script>\n' + app + '</script>\n</body>\n</html>\n'
open(out + '/index.html', 'w').write(html)

hdr = ("// GENERATED — do not edit.\n"
       "// Source of truth is parts/wsola_core.js + parts/wsola_wrapper.js.\n"
       "// An identical copy lives inline in index.html.\n"
       "//@@GENERATED-HEADER-END\n")
open(out + '/wsola-worklet.js', 'w').write(hdr + mod.strip('\n') + '\n')
print('built ->', out, build)
PY
node --check "$OUT/wsola-worklet.js"
