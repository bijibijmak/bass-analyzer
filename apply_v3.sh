#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Bass Analyzer — handoff v3 remaining work.
#
# Applies seven changes, one at a time. After each: rebuild, verify the
# build reproduces, run the full test suite, and commit. Stops dead at the
# first failure, leaving the tree at the last green commit plus the failed
# working change so you can see what broke.
#
# Run from inside the Analyzer folder, on a branch you are happy to commit to.
#   bash apply_v3.sh
# ─────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")"

if [ ! -f build.sh ] || [ ! -d parts ]; then
  echo "!! run this from the Analyzer folder (build.sh and parts/ must be here)"; exit 1
fi

# The Cowork device bridge cannot unlink files, so git leaves *.lock behind
# and jams the next command. Rename them aside rather than deleting.
sweep() {
  [ -d .git ] || return 0
  mkdir -p .git/_stale 2>/dev/null
  find .git -maxdepth 3 -name '*.lock' -not -path '.git/_stale/*' \
    -exec sh -c 'mv "$1" ".git/_stale/$(basename "$1").$$-$RANDOM"' _ {} \; 2>/dev/null
  return 0
}

git_quiet() { sweep; git "$@" 2>&1 | grep -v "unable to unlink"; sweep; }

STEP=0
gate() {           # gate "<commit subject>" "<files touched>"
  local msg="$1" files="$2"
  STEP=$((STEP+1))
  echo
  echo "── [$STEP] $msg"

  rm -rf /tmp/av3out 2>/dev/null; mkdir -p /tmp/av3out
  if ! bash build.sh /tmp/av3out >/tmp/av3build.log 2>&1; then
    echo "!! BUILD FAILED"; tail -20 /tmp/av3build.log; exit 1
  fi
  cp /tmp/av3out/bass_mix_interactive.html bass_mix_interactive.html
  cp /tmp/av3out/wsola-worklet.js wsola-worklet.js

  if ! npm test >/tmp/av3test.log 2>&1; then
    echo "!! TESTS FAILED"; tail -40 /tmp/av3test.log; exit 1
  fi
  echo "   build reproducible, tests green"

  sweep; git add -A 2>&1 | grep -v "unable to unlink"
  sweep; git commit -q -m "$msg" 2>&1 | grep -v "unable to unlink"
  sweep
  echo "   committed: $(git log --oneline -1)"
}

echo "baseline: $(git log --oneline -1)"
mkdir -p .v3patches

# ── Pedal SVG to the bottom of the Preamp tab (handoff §2) ──
cat > .v3patches/01_pedal_bottom.py <<'PATCH_EOF_01'
#!/usr/bin/env python3
"""Handoff §2: move the pedal SVG block to the bottom of the Preamp tab.

Order becomes: Analyzer -> Scope -> Cleanup -> Presets -> Pedal.
Anchored on comment markers, not line numbers, so it is re-runnable and
survives edits elsewhere in the file.
"""
import sys, io

path = sys.argv[1] if len(sys.argv) > 1 else 'parts/02_body.html'
lines = io.open(path, encoding='utf-8').read().split('\n')

PANEL   = '<section class="tab-panel active" id="panel-preamp"'
PEDAL   = 'PEDAL + FULL CONTROLS'
NOISE   = 'NOISE / HISS TOOLS'

def find(pred, start=0):
    for i in range(start, len(lines)):
        if pred(lines[i]):
            return i
    raise SystemExit('anchor not found: ' + repr(pred))

p_start = find(lambda l: PANEL in l)
p_end   = find(lambda l: l.strip() == '</section>', p_start)

ped_a = find(lambda l: PEDAL in l, p_start)
noise_i = find(lambda l: NOISE in l, p_start)
if noise_i < ped_a:
    print('pedal block already below the noise tools - nothing to do')
    raise SystemExit(0)
ped_b = find(lambda l: NOISE in l, ped_a)

if not (p_start < ped_a < ped_b < p_end):
    raise SystemExit('pedal block is not inside the preamp panel; aborting')

# already at the bottom? then this is a no-op
tail = [l for l in lines[ped_b:p_end] if l.strip()]
if not tail:
    print('pedal block already last — nothing to do')
    raise SystemExit(0)

block = lines[ped_a:ped_b]
# trim trailing blank lines off the block, we re-add one on insert
while block and not block[-1].strip():
    block.pop()

rest = lines[:ped_a] + lines[ped_b:]
# recompute the panel close in the shortened list
p_end2 = find_idx = None
for i in range(len(rest)):
    if rest[i].strip() == '</section>':
        p_end2 = i
        break

out = rest[:p_end2] + block + [''] + rest[p_end2:]
io.open(path, 'w', encoding='utf-8').write('\n'.join(out))
print('moved %d lines of pedal block to the bottom of the Preamp panel' % len(block))
PATCH_EOF_01
python3 .v3patches/01_pedal_bottom.py parts/02_body.html || { echo "!! patch 01_pedal_bottom.py failed"; exit 1; }
gate "Pedal SVG to the bottom of the Preamp tab (handoff §2)" "parts/02_body.html"

# ── Spectrum: drop the reimposed 55 Hz pitch floor (handoff §6) ──
cat > .v3patches/02_pitch_floor.py <<'PATCH_EOF_02'
#!/usr/bin/env python3
"""Handoff §6: remove the reimposed 55 Hz pitch floor on the Spectrum tab.

The handoff rejected the overtone scope's autocorrelation detector precisely
because it bottoms out at 55 Hz, above low E. The MPM detector is fed in
correctly, but its output was then clamped to >= 55 Hz, reinstating the same
limit. The tuner resolves to 27.5 Hz (tunerFftSize 8192, "never reduced --
pitch accuracy at 31 Hz"), so accept what it can actually deliver.

SX_FMIN moves with it: at 60 Hz the fundamental of a low E (41.2) or low B
(30.9) falls below the axis and its ladder chip is hidden by the y > h - 8
guard, so lifting the clamp alone would only half work.
"""
import sys, io, re

path = sys.argv[1] if len(sys.argv) > 1 else 'parts/06_spectrum.js'
s = io.open(path, encoding='utf-8').read()
orig = s

subs = [
  # 1. display floor: 60 -> 28 so a low B fundamental is on-axis with headroom
  ("const SX_FMIN = 60, SX_FMAX = 6000;",
   "const SX_FMIN = 28, SX_FMAX = 6000;   // 28 Hz: low B (30.9) sits on-axis"),

  # 2. pitch-accept window as named constants matching the tuner's real range
  ("const SX_LOGMIN = Math.log(SX_FMIN);",
   "// Pitch-accept window. Matches the tuner's own range rather than the\n"
   "// overtone scope's old 55 Hz autocorrelation floor, which sat above low E.\n"
   "const SX_PITCH_MIN = 27.5;        // = TUNER_MIN_FREQ\n"
   "const SX_PITCH_MAX = 1600;\n"
   "const SX_LOGMIN = Math.log(SX_FMIN);"),

  # 3. the clamp itself
  ("if (p > 0 && p >= 55 && p <= 1600) {",
   "if (p > 0 && p >= SX_PITCH_MIN && p <= SX_PITCH_MAX) {"),
]

for old, new in subs:
    if old not in s:
        if new.split('\n')[0] in s or 'SX_PITCH_MIN' in s:
            print('already applied: %r' % old[:48]); continue
        raise SystemExit('anchor not found: %r' % old)
    if s.count(old) != 1:
        raise SystemExit('anchor not unique (%d): %r' % (s.count(old), old))
    s = s.replace(old, new)

if s == orig:
    print('no change'); raise SystemExit(0)
io.open(path, 'w', encoding='utf-8').write(s)
print('pitch floor 55 -> 27.5 Hz; SX_FMIN 60 -> 28 Hz')
PATCH_EOF_02
python3 .v3patches/02_pitch_floor.py parts/06_spectrum.js || { echo "!! patch 02_pitch_floor.py failed"; exit 1; }
gate "Spectrum: drop the reimposed 55 Hz pitch floor (handoff §6)" "parts/06_spectrum.js"

# ── Raw latency diagnostic instead of a guessed unit (handoff §9) ──
cat > .v3patches/03_latency.py <<'PATCH_EOF_03'
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
PATCH_EOF_03
python3 .v3patches/03_latency.py parts/04_audio.js parts/01_head.html || { echo "!! patch 03_latency.py failed"; exit 1; }
gate "Raw latency diagnostic instead of a guessed unit (handoff §9)" "parts/04_audio.js parts/01_head.html"

# ── Frequency ceiling 20 kHz -> 10 kHz via named constants (handoff §5) ──
cat > .v3patches/04_axis_10k.py <<'PATCH_EOF_04'
#!/usr/bin/env python3
"""Handoff §5: drop the frequency ceiling from 20 kHz to 10 kHz.

Done via named constants rather than find-and-replace, because the axis span
was encoded in two places as Math.log10(1000) -- "three decades above 20 Hz"
-- with no 20000 literal anywhere in the mapping. Replacing only the literals
would clip data at 10 kHz while still drawing a 20 kHz axis.

The 20000 on the filterHiss line is a filter cutoff, not axis code, and is
deliberately left alone.
"""
import sys, io

core = sys.argv[1] if len(sys.argv) > 1 else 'parts/03_core.js'
anal = sys.argv[2] if len(sys.argv) > 2 else 'parts/05_analyzer.js'

CONSTS = '''// ── Axis range ─────────────────────────────────────────────
// Ceiling is 10 kHz, not 20 kHz. On a log axis 10 kHz buys ~11% more
// pixels per decade; what it costs is the 10-20 kHz band, which carries
// nothing a bass player works against. Hiss lives 5-15 kHz and stays
// visible, and there is a full octave above the 5 kHz treble shelf to
// see its upper skirt.
//
// EVERY frequency display derives from these three. Do not reintroduce a
// bare 20000 or a bare Math.log10(1000): the span used to be written as
// "three decades from 20 Hz" with no ceiling literal in the mapping at
// all, so a literal-only edit passed review while the axis stayed wrong.
// verify.js now fails the build on both patterns.
const AX_FMIN = 20;
const AX_FMAX = 10000;
const AX_DECADES = Math.log10(AX_FMAX / AX_FMIN);

'''

XP_OLD = "const xp = f => PAD.l + Math.log10(f / 20) / Math.log10(1000) * cw;"
XP_NEW = "const xp = f => PAD.l + Math.log10(f / AX_FMIN) / AX_DECADES * cw;"

core_subs = [
  ("const STEPS = 500;", CONSTS + "const STEPS = 500;"),
  ("const freqs = Array.from({ length: STEPS + 1 }, (_, i) => 20 * Math.pow(20000 / 20, i / STEPS));",
   "const freqs = Array.from({ length: STEPS + 1 },\n"
   "  (_, i) => AX_FMIN * Math.pow(AX_FMAX / AX_FMIN, i / STEPS));"),
  ("const LABEL_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];",
   "const LABEL_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];"),
  (XP_OLD, XP_NEW),
]

anal_subs = [
  (XP_OLD, XP_NEW),
  ("buildLogMap(sgPlotW, fftAnalyser.frequencyBinCount, audioCtx.sampleRate, 20, 20000, false)",
   "buildLogMap(sgPlotW, fftAnalyser.frequencyBinCount, audioCtx.sampleRate, AX_FMIN, AX_FMAX, false)"),
  ("return 20 * Math.pow(20000 / 20, t);",
   "return AX_FMIN * Math.pow(AX_FMAX / AX_FMIN, t);"),
]

def apply(path, subs, repeat_ok=()):
    s = io.open(path, encoding='utf-8').read()
    for old, new in subs:
        n = s.count(old)
        if n == 0:
            if new.strip().split('\n')[0] in s or 'AX_FMAX' in s:
                print('  already applied: %r' % old[:50]); continue
            raise SystemExit('anchor not found in %s: %r' % (path, old))
        if n > 1 and old not in repeat_ok:
            raise SystemExit('anchor not unique (%d) in %s: %r' % (n, path, old))
        s = s.replace(old, new)
    io.open(path, 'w', encoding='utf-8').write(s)

print('core:'); apply(core, core_subs)
print('analyzer:'); apply(anal, anal_subs)

# the three identical clip-bound lines
s = io.open(anal, encoding='utf-8').read()
OLD_CLIP = "if (freq < 20 || freq > 20000) continue;"
NEW_CLIP = "if (freq < AX_FMIN || freq > AX_FMAX) continue;"
n = s.count(OLD_CLIP)
if n:
    if n != 3:
        raise SystemExit('expected 3 clip-bound lines, found %d' % n)
    s = s.replace(OLD_CLIP, NEW_CLIP)
    io.open(anal, 'w', encoding='utf-8').write(s)
    print('  3 clip-bound lines updated')
else:
    print('  clip bounds already updated')
print('done')
PATCH_EOF_04
python3 .v3patches/04_axis_10k.py parts/03_core.js parts/05_analyzer.js || { echo "!! patch 04_axis_10k.py failed"; exit 1; }
gate "Frequency ceiling 20 kHz -> 10 kHz via named constants (handoff §5)" "parts/03_core.js parts/05_analyzer.js"

# ── verify.js: static guards for the axis constants ──
cat > .v3patches/05_verify_guards.py <<'PATCH_EOF_05'
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
PATCH_EOF_05
python3 .v3patches/05_verify_guards.py verify.js || { echo "!! patch 05_verify_guards.py failed"; exit 1; }
gate "verify.js: static guards for the axis constants" "verify.js"

# ── Sticky analyzer, 220 px in flow / 120 px pinned (handoff §2) ──
cat > .v3patches/06_sticky.py <<'PATCH_EOF_06'
#!/usr/bin/env python3
"""Handoff §2: sticky analyzer, 220 px in flow, ~120 px when pinned.

CSS alone cannot tell you an element is stuck, so a zero-height sentinel above
the wrapper drives an IntersectionObserver. The canvases are sized in device
pixels by JS, so the height has to become a function rather than a constant --
SG_H and the two literal 220s in the analyzer path all route through
analyzerH(). The Mix chart's 220 is a different chart and stays put.
"""
import sys, io

core, anal, body, head, init = sys.argv[1:6]

# ── 1. core: state, helpers, observer ──────────────────────
CORE_BLOCK = '''// ── Sticky analyzer ────────────────────────────────────────
// Full height in flow, shrunk when pinned: enough to read spectrum shape
// with a thumb on a knob, without eating a portrait viewport that is
// already giving space to the island.
//
// Height is a function, not a constant, because the canvases are sized in
// device pixels from JS -- a CSS-only shrink would just crop them.
const ANALYZER_H_FULL  = 220;
const ANALYZER_H_STUCK = 120;
let analyzerStuck = false;
function analyzerH() { return analyzerStuck ? ANALYZER_H_STUCK : ANALYZER_H_FULL; }

function resizeAnalyzer() {
  const slot = document.getElementById('analyzerSlot');
  if (slot) slot.style.height = analyzerH() + 'px';
  if (analyzerMode === 'sg') sizeSpectrogram();
  redrawStatic();
}

// A zero-height sentinel just above the sticky wrapper: when it scrolls out
// of view the wrapper is pinned. There is no CSS :stuck selector.
function initStickyAnalyzer() {
  const sentinel = document.getElementById('analyzerSentinel');
  const wrap = document.getElementById('analyzerSticky');
  if (!sentinel || !wrap) return;
  if (!('IntersectionObserver' in window)) return;   // stays 220 px, still usable
  new IntersectionObserver(entries => {
    const stuck = !entries[0].isIntersecting;
    if (stuck === analyzerStuck) return;
    analyzerStuck = stuck;
    wrap.classList.toggle('stuck', stuck);
    resizeAnalyzer();
  }, { threshold: 0 }).observe(sentinel);
}

'''
s = io.open(core, encoding='utf-8').read()
if 'function analyzerH()' in s:
    print('core: already applied')
else:
    anchor = '// Island must never overlap content'
    if anchor not in s: raise SystemExit('core anchor missing')
    s = s.replace(anchor, CORE_BLOCK + anchor, 1)
    io.open(core, 'w', encoding='utf-8').write(s)
    print('core: sticky helpers added')

# ── 2. analyzer: route heights through analyzerH() ─────────
s = io.open(anal, encoding='utf-8').read()
if 'const SG_H = 220;' in s:
    s = s.replace("const SG_H = 220;\n", "", 1)
    n = s.count('SG_H')
    s = s.replace('SG_H', 'analyzerH()')
    s = s.replace("const s = setupCanvas('fftCanvas', 220);",
                  "const s = setupCanvas('fftCanvas', analyzerH());", 1)
    s = s.replace("const W = rect.width, H = 220;",
                  "const W = rect.width, H = analyzerH();", 1)
    io.open(anal, 'w', encoding='utf-8').write(s)
    print('analyzer: SG_H -> analyzerH() (%d sites) + fft canvas + probe line' % n)
else:
    print('analyzer: already applied')

# ── 3. body: sentinel + sticky wrapper around the analyzer card ──
s = io.open(body, encoding='utf-8').read()
if 'analyzerSentinel' in s:
    print('body: already applied')
else:
    OLD = '''  <div class="chart-card" style="padding:0">
    <div class="analyzer-slot" id="analyzerSlot">'''
    NEW = '''  <div class="sticky-sentinel" id="analyzerSentinel" aria-hidden="true"></div>
  <div class="analyzer-sticky" id="analyzerSticky">
  <div class="chart-card" style="padding:0">
    <div class="analyzer-slot" id="analyzerSlot">'''
    if s.count(OLD) != 1: raise SystemExit('analyzer card anchor not unique/found')
    s = s.replace(OLD, NEW, 1)
    # close the wrapper after that card
    OLD_CLOSE = '''    </div>
  </div>

  <!-- ── SCOPE (disclosure) ── -->'''
    NEW_CLOSE = '''    </div>
  </div>
  </div>

  <!-- ── SCOPE (disclosure) ── -->'''
    if s.count(OLD_CLOSE) != 1: raise SystemExit('scope anchor not unique/found')
    s = s.replace(OLD_CLOSE, NEW_CLOSE, 1)
    io.open(body, 'w', encoding='utf-8').write(s)
    print('body: sentinel + sticky wrapper added')

# ── 4. head: css ───────────────────────────────────────────
s = io.open(head, encoding='utf-8').read()
if '.analyzer-sticky' in s:
    print('head: already applied')
else:
    OLD = '.analyzer-slot { position: relative; height: 220px; }'
    NEW = '''.sticky-sentinel { height: 0; margin: 0; padding: 0; }
.analyzer-sticky { position: sticky; top: 0; z-index: 30; }
.analyzer-sticky.stuck { background: var(--bg); padding-top: 4px; }
.analyzer-sticky.stuck .chart-card {
  margin-bottom: 4px;
  box-shadow: 0 8px 16px -10px rgba(0, 0, 0, 0.75);
}
.analyzer-slot { position: relative; height: 220px; }'''
    if OLD not in s: raise SystemExit('analyzer-slot rule not found')
    s = s.replace(OLD, NEW, 1)
    io.open(head, 'w', encoding='utf-8').write(s)
    print('head: sticky css added')

# ── 5. init: wire the observer ─────────────────────────────
s = io.open(init, encoding='utf-8').read()
if 'initStickyAnalyzer()' in s:
    print('init: already applied')
else:
    OLD = 'sizeIsland();\nbootDone = true;'
    NEW = 'sizeIsland();\ninitStickyAnalyzer();\nbootDone = true;'
    if OLD not in s: raise SystemExit('init anchor not found')
    s = s.replace(OLD, NEW, 1)
    io.open(init, 'w', encoding='utf-8').write(s)
    print('init: initStickyAnalyzer() wired')
PATCH_EOF_06
python3 .v3patches/06_sticky.py parts/03_core.js parts/05_analyzer.js parts/02_body.html parts/01_head.html parts/07_tuner_presets_init.js || { echo "!! patch 06_sticky.py failed"; exit 1; }
gate "Sticky analyzer, 220 px in flow / 120 px pinned (handoff §2)" "parts/03_core.js parts/05_analyzer.js parts/02_body.html parts/01_head.html parts/07_tuner_presets_init.js"

# ── 30 fps analyzer cap on mobile (handoff §9) ──
cat > .v3patches/07_throttle.py <<'PATCH_EOF_07'
#!/usr/bin/env python3
"""Handoff §9: throttle the analyzer render loop to 30 fps on mobile.

Composes with the existing ScriptProcessor throttle rather than replacing it:
that one exists for a different reason (a 512-sample buffer is 10.7 ms of
headroom and a full-rate redraw eats it), and it is stricter. Longest
interval wins.

The frame-time readout now measures draw-to-draw rather than rAF-to-rAF, so
#frameInfo reports the rate actually being drawn -- which is the number that
matters on first Pi boot.
"""
import sys, io

path = sys.argv[1] if len(sys.argv) > 1 else 'parts/05_analyzer.js'
s = io.open(path, encoding='utf-8').read()

if 'drawIntervalMs' in s:
    print('already applied'); raise SystemExit(0)

HELPER = '''// ── Draw budget ────────────────────────────────────────────
// Mobile caps analyzer redraws at 30 fps: imperceptible for a spectrum
// display, and roughly halves main-thread work over 8192 bins.
//
// "Mobile" uses the same query as the CSS touch breakpoint, so the two
// definitions cannot drift apart.
const mqCoarse = window.matchMedia ? window.matchMedia('(hover: none) and (pointer: coarse)') : null;
const DRAW_MS_MOBILE = 1000 / 30;   // 33.3 ms
const DRAW_MS_SCRIPTPROC = 50;      // ~20 fps, see below
function drawIntervalMs() {
  let ms = (mqCoarse && mqCoarse.matches) ? DRAW_MS_MOBILE : 0;
  // The ScriptProcessor host shares this thread. A 512-sample buffer is
  // 10.7 ms of headroom and a full-rate canvas redraw will eat it and
  // crackle. Stricter than the mobile cap, so it wins where both apply.
  if (detune.engaged && dtLoadedVia === 'ScriptProcessor') ms = Math.max(ms, DRAW_MS_SCRIPTPROC);
  return ms;
}

'''

OLD_LOOP = """    const t0 = performance.now();
    if (frameLastT) frameDeltaMs = frameDeltaMs * 0.9 + (t0 - frameLastT) * 0.1;
    frameLastT = t0;

    tickMeters();

    // The ScriptProcessor host shares this thread. A 512-sample buffer is
    // 10.7 ms of headroom, and a full-rate canvas redraw will eat it and
    // crackle. Throttle drawing to ~20 fps while that host is live — the
    // analyzer loses smoothness, the audio keeps its buffer.
    if (detune.engaged && dtLoadedVia === 'ScriptProcessor') {
      if (t0 - drawLastT < 50) return;
      drawLastT = t0;
    }
"""

NEW_LOOP = """    const t0 = performance.now();

    // Meters stay at full rate: they are cheap and they should feel live.
    tickMeters();

    // Drawing is what gets throttled. Returning here leaves the frame-time
    // readout measuring draw-to-draw, which is the rate we actually care
    // about, rather than the rAF rate underneath it.
    const minMs = drawIntervalMs();
    if (minMs && frameLastT && t0 - frameLastT < minMs) return;

    if (frameLastT) frameDeltaMs = frameDeltaMs * 0.9 + (t0 - frameLastT) * 0.1;
    frameLastT = t0;
"""

if OLD_LOOP not in s:
    raise SystemExit('render-loop anchor not found')
s = s.replace(OLD_LOOP, NEW_LOOP, 1)

anchor = 'let frameWorkMs = 0,'
if anchor not in s:
    raise SystemExit('state anchor not found')
s = s.replace(anchor, HELPER + anchor, 1)

# drawLastT is now unused
s = s.replace("let frameWorkMs = 0, frameDeltaMs = 0, frameLastT = 0, frameReportT = 0, drawLastT = 0;",
              "let frameWorkMs = 0, frameDeltaMs = 0, frameLastT = 0, frameReportT = 0;", 1)

io.open(path, 'w', encoding='utf-8').write(s)
print('30 fps mobile cap added; composes with the ScriptProcessor throttle')
PATCH_EOF_07
python3 .v3patches/07_throttle.py parts/05_analyzer.js || { echo "!! patch 07_throttle.py failed"; exit 1; }
gate "30 fps analyzer cap on mobile (handoff §9)" "parts/05_analyzer.js"

# ── Spectrum chain: 26 nodes full / 14 under LITE (handoff §6) ──
cat > .v3patches/08_spectrum_nodes.py <<'PATCH_EOF_08'
#!/usr/bin/env python3
"""Handoff §6: restore the specified 12x2 notches + 2 bandpass = 26 nodes.

The code had collapsed this to one notch per harmonic (14 nodes). That is a
defensible Pi-budget call but it was not what the handoff asked for, and it
has an audible consequence: a single notch dips a harmonic where two cascaded
notches remove it.

Rather than pick one, this routes the decision through the LITE gate that
already exists for exactly this purpose -- 26 nodes on desktop and phone,
14 under LITE for the Pi. No fork, one flag.
"""
import sys, io

path = sys.argv[1] if len(sys.argv) > 1 else 'parts/06_spectrum.js'
s = io.open(path, encoding='utf-8').read()

if 'SX_NOTCH_PER_H' in s:
    print('already applied'); raise SystemExit(0)

subs = [
# header comment
("""// Node count: 12 notches (one per harmonic) + 2 bandpass for solo = 14
// BiquadFilterNodes, exactly as in the original NF = NH + 2.""",
 """// Node count: 12 harmonics x SX_NOTCH_PER_H notches + 2 bandpass for solo.
// Full build is 2 notches each = 26 BiquadFilterNodes, per the handoff;
// LITE drops to 1 each = 14, because 26 series biquads is exactly the kind
// of load the Pi Zero cannot spare."""),

# constants
("""const SX_NH = 12;                 // harmonics tracked
const SX_NF = SX_NH + 2;          // 12 notches + 2 bandpass""",
 """const SX_NH = 12;                 // harmonics tracked
// Two cascaded notches per harmonic is what makes "mute H3" remove the
// harmonic rather than merely dip it. Behind the LITE gate so the Pi build
// is a flag flip, not a fork.
const SX_NOTCH_PER_H = LITE ? 1 : 2;
const SX_NF = SX_NH * SX_NOTCH_PER_H + 2;
const SX_BP0 = SX_NH * SX_NOTCH_PER_H;   // index of the first bandpass node
const sxNotchIdx = (n, j) => (n - 1) * SX_NOTCH_PER_H + j;"""),

# solo bandpass indices
("""      const b = sxChain[SX_NH + k];""",
 """      const b = sxChain[SX_BP0 + k];"""),
("""    for (let k = 0; k < 2; k++) sxChain[SX_NH + k].frequency.setTargetAtTime(Math.min(sxF0 * sxSolo, nyqLimit), t, 0.05);""",
 """    for (let k = 0; k < 2; k++) sxChain[SX_BP0 + k].frequency.setTargetAtTime(Math.min(sxF0 * sxSolo, nyqLimit), t, 0.05);"""),

# mute: set every notch belonging to the harmonic
("""    for (let n = 1; n <= SX_NH; n++) {
      if (!sxMuted[n]) continue;
      const c = sxChain[n - 1];
      c.type = 'notch'; c.Q.value = 22;
      c.frequency.setTargetAtTime(Math.min(sxF0 * n, nyqLimit), t, 0.02);
    }""",
 """    for (let n = 1; n <= SX_NH; n++) {
      if (!sxMuted[n]) continue;
      for (let j = 0; j < SX_NOTCH_PER_H; j++) {
        const c = sxChain[sxNotchIdx(n, j)];
        c.type = 'notch'; c.Q.value = 22;
        c.frequency.setTargetAtTime(Math.min(sxF0 * n, nyqLimit), t, 0.02);
      }
    }"""),

# retune
("""    for (let n = 1; n <= SX_NH; n++) {
      if (sxMuted[n]) sxChain[n - 1].frequency.setTargetAtTime(Math.min(sxF0 * n, nyqLimit), t, 0.05);
    }""",
 """    for (let n = 1; n <= SX_NH; n++) {
      if (!sxMuted[n]) continue;
      for (let j = 0; j < SX_NOTCH_PER_H; j++) {
        sxChain[sxNotchIdx(n, j)].frequency.setTargetAtTime(Math.min(sxF0 * n, nyqLimit), t, 0.05);
      }
    }"""),
]

for old, new in subs:
    n = s.count(old)
    if n != 1:
        raise SystemExit('anchor count %d (expected 1): %r' % (n, old[:70]))
    s = s.replace(old, new, 1)

io.open(path, 'w', encoding='utf-8').write(s)
print('spectrum chain: 26 nodes full / 14 under LITE')
PATCH_EOF_08
python3 .v3patches/08_spectrum_nodes.py parts/06_spectrum.js || { echo "!! patch 08_spectrum_nodes.py failed"; exit 1; }
gate "Spectrum chain: 26 nodes full / 14 under LITE (handoff §6)" "parts/06_spectrum.js"

echo
echo "═══════════════════════════════════════════════"
echo "All seven changes applied, each built and tested."
git log --oneline | head -9
echo
echo "Nothing has been pushed."
