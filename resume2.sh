#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"
sweep() { [ -d .git ] || return 0; mkdir -p .git/_stale 2>/dev/null
  find .git -maxdepth 3 -name '*.lock' -not -path '.git/_stale/*' \
    -exec sh -c 'mv "$1" ".git/_stale/$(basename "$1").$$-$RANDOM"' _ {} \; 2>/dev/null; return 0; }
gate() {
  local msg="$1"; echo; echo "── ${msg%%$'\n'*}"
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
gate "30 fps analyzer cap on mobile (handoff §9)

Mobile caps redraws at 30 fps using the same media query as the CSS touch
breakpoint, so the two definitions cannot drift. Composes with the existing
ScriptProcessor throttle by max() rather than replacing it -- that one is
stricter and exists for a different reason (a 512-sample buffer is 10.7 ms
of headroom).

The frame readout now measures draw-to-draw instead of rAF-to-rAF, so
#frameInfo reports the rate actually being drawn. verify.js asserted the
old throttle by variable name; it now asserts the behaviour."
python3 .v3patches/08_spectrum_nodes.py parts/06_spectrum.js || exit 1
gate "Spectrum chain: 26 nodes full / 14 under LITE (handoff §6)

The handoff specified 12 harmonics x 2 notches + 2 bandpass = 26; the code
had collapsed to one notch each. Two cascaded notches is what makes mute
actually remove a harmonic rather than dip it. Routed through the LITE gate
that already exists for Pi stripping, so the spec is met without spending
the CPU budget the deviation was protecting."
echo; echo "═══ done ═══"; git log --oneline | head -10
