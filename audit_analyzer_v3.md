# Audit — handoff_analyzer_v3.md vs. current code

**Date:** 2026-08-20
**Baseline commit:** `5591148` on branch `analyzer-v3`
**Method:** section-by-section read of `parts/*`, cross-checked against the built
`bass_mix_interactive.html`. `npm test` green (verify.js + dsptest.js + smoke.js) and
`build.sh` reproduces the checked-in HTML byte-for-byte, so `parts/` is the source of truth.

---

## Headline

The handoff is **substantially stale**. Roughly 75% of it is already implemented, in several
places more carefully than it asked for. What remains is five genuine gaps, one confirmed bug,
and one deliberate deviation that needs a decision.

The codebase has also moved past the handoff in ways it doesn't mention: it is now assembled
from `parts/` by `build.sh` (the handoff describes editing a single 108 KB file — that file is
now `bass_mix_interactive.v2-backup.html`), and there is a **fifth tab, Detune**, with a WSOLA
time-stretch engine that post-dates the document entirely.

---

## Section by section

### §1 Naming — **DONE**

| Item | Evidence |
|---|---|
| `<title>` | `01_head.html:6` → `Bass Analyzer` |
| `<h1>` | `02_body.html:6` → `Bass <em>Analyzer</em>` |
| Subtitle | `02_body.html:7` → `Darkglass B7K v2 · preamp · tuner · spectrum` (exact match) |
| manifest | `name` / `short_name` both `Bass Analyzer` |
| "cuts through" removed | 0 occurrences anywhere |

### §2 Tab architecture — **PARTIAL**

Done:

- Island fixed to bottom, safe-area aware, icon-over-label (`01_head.html:84–107`)
- One panel active at a time, `role="tablist"` / `aria-selected` maintained (`03_core.js:126–142`)
- Bottom padding is **measured from the island at runtime** (`03_core.js:144–149`) rather than
  hardcoded — better than the handoff specified, and it survives the font-size change at the
  mobile breakpoint

Not done:

- **Preamp layout order.** Current: Analyzer → Scope → **Pedal SVG** → Cleanup → Presets.
  The handoff wants the pedal SVG *last*. It currently sits mid-page, between the scope
  disclosure and the noise tools (`02_body.html:93–96`).
- **Sticky analyzer.** `.analyzer-slot { position: relative; height: 220px; }`
  (`01_head.html:423`). The string `sticky` appears **zero** times in the built file. No
  220 px → ~120 px shrink-on-stick.

Divergence: the handoff's table lists four tabs; there are five (`TABS`, `03_core.js:123`).

### §3 Removals — **DONE**

`toneKnob`, `pickupKnob`, `filterTone`, `state.tone`, `state.pickup` — **0 occurrences** in the
built HTML. `buildBassCurve()` takes no parameter (`03_core.js:168`), pickup character fixed at
`PICKUP_FIXED = 0.5` (`:166`) and computed once into `flatBassCurve` (`:207`).

### §4 B7K drive section — **DONE**, and faithfully

The wiring at `04_audio.js:258–286` matches the handoff's ASCII diagram node for node:

- Level (`levelGainNode`) sits between clipper and `wetBlendNode` — **wet path only**, not a master
- Grunt → Attack → Drive → clipper are all pre-clipper; the dry leg from `inGainNode` is untouched
- EQ is post-sum: `sumBus → Low → LoMid → HiMid → Treble`
- Equal-power crossfade via `blendGains()`
- Asymmetric clipper, `04_audio.js:65–72`: `x >= 0 ? tanh(1.7x) : 0.78·tanh(2.6x)`
- Level card dimmed at Blend 0 (`03_core.js:452`, CSS `01_head.html:182`)
- Tooltips on all five controls with tap-to-toggle + a `(hover: none)` breakpoint
  (`02_body.html:160–211`, CSS `:220–242`)
- Confidence disclosed in the footer (`02_body.html:557`)
- The flagged-for-later post-clipper voicing filter is correctly **not** built

### §5 Analyzer modes — **PARTIAL**

Done: two separate canvases swapped in a fixed slot via `.layer.active`; spectrogram is
frequency-on-X / time-down and shares the FFT axis; column generation shared through
`buildLogMap(..., reverse)`; reuses `fftAnalyser`, zero new audio nodes; schematic curve removed
from the Preamp FFT (curves now only in `drawMixChart`).

**Not done: the 10 kHz ceiling.** This is the item most likely to be botched by a find-and-replace,
so here is every site:

| File:line | What it is | Action |
|---|---|---|
| `03_core.js:155` | `freqs` sweep 20 → 20000, 500 steps; feeds every schematic curve | change |
| `03_core.js:156` | `LABEL_FREQS` ends at `20000` | change |
| `03_core.js:255` | `xp = f => PAD.l + Math.log10(f/20) / Math.log10(1000) * cw` — **Mix chart axis** | change |
| `05_analyzer.js:163` | FFT fill clip bounds | change |
| `05_analyzer.js:184` | FFT line clip bounds | change |
| `05_analyzer.js:200` | peak-hold clip bounds | change |
| `05_analyzer.js:252` | spectrogram `buildLogMap(..., 20, 20000, false)` | change |
| `05_analyzer.js:278` | **same `Math.log10(1000)` mapping — analyzer axis** | change |
| `05_analyzer.js:649` | `chartXtoFreq` inverse: `20 * Math.pow(20000/20, t)` | change |
| `04_audio.js:122` | `filterHiss` "off" cutoff — **not axis code** | **leave alone** |

Two traps here:

1. **The two `Math.log10(1000)` sites contain no `20000`.** That literal encodes "three decades
   above 20 Hz" = 20 kHz. The handoff's own static check — *"confirm no `20000` remains in
   frequency-axis code"* — passes while the axis is still drawn over three decades. The result
   would be data clipped at 10 kHz plotted on a 20 kHz axis: every curve squashed into the left
   ~90% of the chart with wrong labels, and the crosshair reading frequencies that don't match
   what's under it. Recommend replacing all of this with named constants
   (`AX_FMIN`, `AX_FMAX`, `AX_DECADES = Math.log10(AX_FMAX/AX_FMIN)`).
2. **The hi-hat curve loses its peak.** `hhCurve` is built from lobes at 8 k, 12 k and 16 kHz
   (`03_core.js:198`) and `snareCurve` has an 11 kHz lobe (`:195`). At a 10 kHz ceiling the
   hi-hat trace just rises and gets cut off at the right edge — its actual peak is off-chart.
   Needs a call: reshape `hhCurve` for the new range, or accept the truncation.

Note: `06_spectrum.js:19` sets `SX_FMAX = 6000` for the Spectrum tab's own axis. Already below
10 kHz, so §5 doesn't touch it.

### §6 Spectrum tab — **PARTIAL, one confirmed bug**

Done: chain connects on tab entry and disconnects on exit (`03_core.js:137–138` →
`spectrumEnter` / `spectrumExit`), splicing at `gateGainNode → outGainNode` exactly where
`04_audio.js:284` says it should; there is a **neutral ramp before the unsplice**
(`06_spectrum.js:152–176`) so the tab switch shouldn't click. Mute/solo persists in JS while the
nodes only exist for the open tab. No autocorrelation detector, no file-load, no test tones.

**BUG — the 55 Hz floor is back.** `06_spectrum.js:232`:

```js
if (p > 0 && p >= 55 && p <= 1600) {
```

The handoff rejected the scope's autocorrelation detector *specifically because* it bottoms out
at 55 Hz, above low E. The code correctly feeds from the tuner's MPM detector on the pre-EQ tap
— and then clamps that detector's output to ≥ 55 Hz anyway, reintroducing the exact limitation
as a range check. The harmonic ladder will not track open E1 (41.2 Hz), and on the SR305's low B
(~30.9 Hz) it is nowhere near.

For contrast: the tuner itself handles down to `TUNER_MIN_FREQ = 27.5` Hz
(`07_tuner_presets_init.js:7`) and `OPEN_STRINGS` starts at E1 41.203 (`08_detune.js:30`).

Related, and needs fixing in the same change: `SX_FMIN = 60` (`06_spectrum.js:19`) is the
*display* floor, so even with the clamp lifted a low-E fundamental chip would sit below the axis
and be hidden by the `y > h - 8` test at `:297`. Both numbers have to move together, or low-E
tracking only half works.

**Deviation — 14 filter nodes, not 26.** `06_spectrum.js:13` documents it: *"12 notches (one per
harmonic) + 2 bandpass = 14"*. The handoff specified 12 harmonics × **2** notches + 2 bandpass.
This looks like a deliberate Pi-budget decision rather than an oversight, but it has an audible
consequence — one notch per harmonic gives shallower rejection, so "mute H3" attenuates rather
than removes. Verification step 7 says *"muting H3 is audible"*, which a single notch will still
satisfy, so this could easily pass review while being quietly weaker than intended.

### §7 Mix tab — **DONE**

Schematic curves + legend, live FFT overlay, reference modal and all four annotation cards, and
the compact EQ strip (four sliders + two frequency toggles, `02_body.html:519–546`). No pedal
SVG, no drive controls, exactly as specified.

### §8 Presets — **DONE**, exceeds spec

`b7k_presets_v1` → `b7k_presets_v2` with migration on read (`07_tuner_presets_init.js:170–227`).
`tone` / `pickup` dropped by omission in `normalizePreset`. New fields default to the handoff's
neutral values: blend 0, level 100, drive 0, grunt 1 (Raw), attack 1 (Flat).

The NaN guard is stronger than asked: `pnum()` / `ppick()` clamp **every field on every read**,
not just on migrate (`:175–183`, and the comment at `:168` states the reasoning). The v1 store is
left in place rather than deleted, so a rollback is possible.

### §9 Mobile performance / Pi — **PARTIAL**

Done:

- LITE config gate (`03_core.js:8–21`) via `LITE_DEFAULT` or `?lite=1`, gating `fftSize`,
  scope FFT size, spectrogram columns and smoothing, and canvas glow. Stripping for the Pi is a
  flag flip, as intended.
- Frame-time readout (`05_analyzer.js:605–611`) — EMA-smoothed ms and fps into `#frameInfo`,
  with a `hot` class above 12 ms.
- No Pi fork started.

Not done:

- **30 fps mobile throttle.** The only throttle in the render loop (`05_analyzer.js:588–591`) is
  gated on `detune.engaged && dtLoadedVia === 'ScriptProcessor'` and targets ~20 fps. That is a
  different trigger for a different reason — ScriptProcessor thread contention, which post-dates
  the handoff. There is no mobile detection and no general cap.
- **Latency raw diagnostic.** `04_audio.js:298–300` still reads:

  ```js
  const lat = audioCtx.baseLatency
    ? ` · Latency: ~${Math.round((audioCtx.baseLatency + (audioCtx.outputLatency || 0)) * 1000)} ms`
    : '';
  ```

  That is precisely the line the handoff identified as the bug. No raw `baseLatency` /
  `outputLatency` / `sampleRate` values printed, no clamp, no label. The implausible four-digit
  number will still appear on the phone.

### History / regression checks — **all clean**

| Historical bug | Status |
|---|---|
| `buildAudioGraph()` calling `disconnect()` on every run | Not reintroduced. `applyAudioParams()` is a pure parameter setter with an explicit comment at `04_audio.js:74–75` and contains no `disconnect()`. |
| Forcing `sampleRate: 48000` | Not reintroduced. Comment at `04_audio.js:198` records why. |
| `const orig = render; function render(){ orig(); }` recursion | No wrapping pattern anywhere in `parts/`. |

---

## Remaining work, ranked

| # | Item | § | Size | Notes |
|---|---|---|---|---|
| 1 | Spectrum 55 Hz pitch clamp | 6 | S | Confirmed bug. Decide whether `SX_FMIN` 60 → ~35 moves with it. |
| 2 | 10 kHz frequency ceiling | 5 | **M** | 9 literal sites (7 change, 2 leave) + 2 hidden `Math.log10(1000)` mappings + a hi-hat curve decision. Do this with named constants. |
| 3 | Latency raw diagnostic | 9 | S | Self-contained, one function. |
| 4 | Sticky analyzer 220 → 120 | 2 | M | CSS + scroll hook. The iOS Safari sticky-vs-fixed risk the handoff flagged is real here since the island is `position: fixed`. |
| 5 | Pedal SVG to bottom of Preamp | 2 | S | DOM move in `02_body.html`. |
| 6 | 30 fps mobile throttle | 9 | S | Needs a decision on how "mobile" is detected, and how it composes with the existing ScriptProcessor throttle. |
| 7 | Spectrum node count 14 vs 26 | 6 | — | **Decision, not code.** Accept and amend the handoff, or restore double notches. |

---

## Verification plan

### Static gate — every commit

1. `bash build.sh /tmp/out` then `diff` against the checked-in HTML — proves `parts/` and the
   built file haven't drifted
2. `npm test` — `verify.js` (which already implements handoff static checks 1–5), `dsptest.js`,
   `smoke.js`
3. **Two new assertions to add to `verify.js`** so item 2 can't half-land or silently regress:
   - no bare `Math.log10(1000)` outside the axis-constant definition
   - the only surviving `20000` literals are the two on the `filterHiss` line

### Runtime — only the steps each change can actually break

| Change | Handoff steps | Plus |
|---|---|---|
| 10 kHz ceiling | 1, 4, 9 | `smoke.js [15]` already asserts *"spectrogram probe reports the same frequency at the same x — axes agree"*. That is exactly the axis/data mismatch this change risks, so it is the primary automated guard. Eyeball the hi-hat curve's right edge. |
| 55 Hz fix | 6, 7 | Play open E1 (41.2 Hz) and low B if the SR305 is to hand — ladder should lock and chips appear. |
| Latency diagnostic | 2 | Read the raw numbers on the phone before deciding on a clamp. |
| Sticky analyzer | 10, 13 | iOS Safari specifically, with the dynamic toolbar showing and hidden. |
| Pedal SVG move | 1, 10 | |
| 30 fps throttle | 13 | Watch `#frameInfo` — it should now report ~30, and confirm it composes sanely with Detune engaged. |

### Standing regression risks (unchanged from the handoff)

- `NaN` into gain nodes from preset migration → step 11
- Orphaned nodes after repeated Spectrum enter/exit → switch tabs ten times, watch `#frameInfo` for creep
- Island overlapping scrollable content on a short viewport
- Sticky element fighting the fixed island on iOS Safari

---

## One process note

`git` works in this folder but the desktop bridge cannot delete files, so every git command
leaves a `.lock` behind that jams the next one. Each git call in this session is preceded by a
sweep that *renames* stale locks into `.git/_stale/` rather than deleting them. It works, but
that directory will accumulate junk — worth clearing out by hand at some point.

---

# Implementation record — 2026-08-20

All seven items implemented on branch `analyzer-v3`, eight commits, each one
built, reproducibility-checked and tested before being committed. Nothing pushed.

```
f126908  Spectrum chain: 26 nodes full / 14 under LITE      (§6)
d2e7e11  30 fps analyzer cap on mobile                      (§9)
cae6e83  Sticky analyzer, 220 px in flow / 120 px pinned     (§2)
cd9853a  verify.js: static guards for the axis constants
324611f  Frequency ceiling 20 kHz -> 10 kHz                  (§5)
b8356d6  Raw latency diagnostic                              (§9)
36dc571  Spectrum: drop the reimposed 55 Hz pitch floor      (§6)
79c7c6b  Pedal SVG to the bottom of the Preamp tab           (§2)
```

`build.sh` reproduces the checked-in HTML byte-for-byte and all three suites
pass: verify.js static, dsptest.js DSP, smoke.js jsdom.

## Two stale tests the gates caught

Both were tests encoding an assumption that the change invalidated — neither
was a defect in the new code, and neither would have been obvious by reading.

**`smoke.js` had the old axis baked in.** Its probe test computed the click
position as `38 + Math.log10(f / 20) / 3 * (542 - 38)`. That literal `3` is
three decades above 20 Hz — the 20 kHz span again, in a *third* place the
audit hadn't found because it lives in the test harness, not the app. After
the ceiling moved it clicked the x that used to mean 110 Hz and correctly
read 93 Hz. Now derives from the page's own `AX_FMIN` / `AX_DECADES`, so it
cannot go stale again; what it asserts (110 Hz lands on A2) is unchanged.

**`verify.js` asserted the throttle by variable name.** It required
`drawLastT` to exist. The throttle still exists but moved into
`drawIntervalMs()` and reuses `frameLastT`, so the check failed on a rename.
Rewritten to assert behaviour instead — that the ScriptProcessor interval is
applied and composes with the mobile cap by `max()` rather than replacing it,
which is the property that actually protects the audio buffer.

## Correction to the audit above

**§5 was wrong about the hi-hat curve.** The audit warned that a 10 kHz
ceiling would cut `hhCurve` off mid-climb. It doesn't: `Math.min(..., 1)`
saturates that curve at full height from ~7 kHz to ~18 kHz, so at the new
ceiling it rises and then plateaus well inside the visible range. `snareCurve`
peaks at 7.5 kHz, also inside. Neither curve was reshaped.

## Two decisions taken rather than referred

**Spectrum node count (item 7, listed above as "decision, not code").** The
handoff wanted 26 nodes, the code had 14, and the stated reason for the
deviation was Pi CPU — which is what the `LITE` flag already exists for. So
`SX_NOTCH_PER_H = LITE ? 1 : 2`: 26 nodes on desktop and phone, 14 under
LITE. Index arithmetic verified for both modes. Reverting to 14 everywhere is
a one-line change.

**Pitch floor value.** Lifted to 27.5 Hz to match `TUNER_MIN_FREQ` rather
than to a bass-specific number, since the handoff's instruction was to feed
from the tuner's detector — so it should accept what that detector delivers.
`tunerFftSize` is 8192 and never reduced, which resolves the full 27.5 Hz at
both 44.1 and 48 kHz. `SX_FMIN` moved 60 → 28 in the same commit, without
which the clamp fix only half works.

## One consequence worth knowing

The high-cut slider still runs to 16 kHz, so its top third now sits off-chart.
That is a real tension in the handoff's own reasoning — it justified 10 kHz
partly on keeping hiss visible — so the control range was left alone rather
than quietly shrunk. Worth a decision at some point: cap the slider at 10 kHz,
or accept tuning it blind above that.

## What still needs a human

Static verification is complete. Everything below needs ears, eyes or a phone:

| Step | What to check |
|---|---|
| 2 | Latency line now shows raw `base · out · sr` — **read the actual numbers**, that is the whole point, then decide the clamp |
| 5 | Drive section: FFT shows new harmonics as drive engages |
| 6 | Tuner on open strings |
| 7 | Spectrum: **play open E1 (41.2 Hz) and low B** — the ladder should now lock and chips appear where it previously did nothing |
| 7 | Mute H3 — should now *remove* rather than dip it (26-node chain) |
| 8 | Tab-exit disconnect, no click on switch |
| 10 | Scroll Preamp: analyzer sticks and shrinks to 120 px, pedal SVG now at the bottom |
| 10 | **iOS Safari specifically** — sticky vs the fixed island, with the dynamic toolbar shown and hidden |
| 13 | `#frameInfo` should report ~30 fps on the phone, and compose sanely with Detune engaged |
| 14 | PWA still installs and loads offline |
