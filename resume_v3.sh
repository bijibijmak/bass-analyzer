#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"
sweep() { [ -d .git ] || return 0; mkdir -p .git/_stale 2>/dev/null
  find .git -maxdepth 3 -name '*.lock' -not -path '.git/_stale/*' \
    -exec sh -c 'mv "$1" ".git/_stale/$(basename "$1").$$-$RANDOM"' _ {} \; 2>/dev/null; return 0; }
gate() {
  local msg="$1"
  echo; echo "── $msg"
  rm -rf /tmp/av3out; mkdir -p /tmp/av3out
  if ! bash build.sh /tmp/av3out >/tmp/av3build.log 2>&1; then
    echo "!! BUILD FAILED"; tail -20 /tmp/av3build.log; exit 1; fi
  cp /tmp/av3out/bass_mix_interactive.html bass_mix_interactive.html
  cp /tmp/av3out/wsola-worklet.js wsola-worklet.js
  if ! npm test >/tmp/av3test.log 2>&1; then
    echo "!! TESTS FAILED"; grep -E "FAIL|FAILURE" /tmp/av3test.log | head -20; exit 1; fi
  echo "   build reproducible, tests green"
  sweep; git add -A 2>&1 | grep -v "unable to unlink"
  sweep; git commit -q -m "$msg" 2>&1 | grep -v "unable to unlink"; sweep
  echo "   committed: $(git log --oneline -1)"
}
gate "Frequency ceiling 20 kHz -> 10 kHz via named constants (handoff §5)

The span was encoded twice as Math.log10(1000) -- three decades above
20 Hz -- with no ceiling literal in the mapping at all, so changing the
20000 literals alone would clip the data while still drawing a 20 kHz
axis. Everything now derives from AX_FMIN / AX_FMAX / AX_DECADES.

The filterHiss 20000 is a filter cutoff, not axis code, and is untouched.

smoke.js had the same span baked into its probe test (a literal /3); it
now reads the page's own constants, so it cannot go stale again."
for p in 05_verify_guards 06_sticky 07_throttle 08_spectrum_nodes; do
  case $p in
    05_verify_guards) files="verify.js"; msg="verify.js: static guards for the axis constants";;
    06_sticky) files="parts/03_core.js parts/05_analyzer.js parts/02_body.html parts/01_head.html parts/07_tuner_presets_init.js"; msg="Sticky analyzer, 220 px in flow / 120 px pinned (handoff §2)";;
    07_throttle) files="parts/05_analyzer.js"; msg="30 fps analyzer cap on mobile (handoff §9)";;
    08_spectrum_nodes) files="parts/06_spectrum.js"; msg="Spectrum chain: 26 nodes full / 14 under LITE (handoff §6)";;
  esac
  python3 .v3patches/$p.py $files || { echo "!! patch $p failed"; exit 1; }
  gate "$msg"
done
echo; echo "═══ done ═══"; git log --oneline | head -8
