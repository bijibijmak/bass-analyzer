# Handoff — Bass Analyzer v3 restructure

**For:** a Cowork session with write access to `bass-pedalboard/analyzer/`.
**Target file:** `bass_mix_interactive.html` (single-file PWA, ~108 KB) plus `manifest.json`.
**Status:** every decision below is settled from a grill-me session. Don't re-litigate — implement.

Git is clean. Work on a branch, commit per working change.

---

## Who this is for

Bijan — bassist in Helsinki, not a coder by background, learning incrementally. Prefers GUI tools over CLI and explanations framed as teaching moments. Signal chain: Ibanez SR305 → Darkglass Microtubes B7K v2 → iRig (passive) → computer or phone.

This app is the software track of a three-part project (browser analyzer / KiCad carrier PCB / Pi software). It will eventually run on a Raspberry Pi Zero 2W driving a 480×320 TFT inside a pedalboard enclosure. **Design for that target but do not fork for it yet** — see §9.

---

## 1. Naming

- `<h1>` → **Bass Analyzer**
- subtitle → `Darkglass B7K v2 · preamp · tuner · spectrum`
- `<title>` and `manifest.json` `name` / `short_name` to match
- Remove all "cuts through the mix" framing from the page head — it survives only as the Mix tab

## 2. Tab architecture

Persistent island fixed to the bottom of the viewport. **Keep it compact** — this is a portrait phone app and vertical space is scarce. Icon-over-label or short labels; aim well under the current chrome budget.

One tab active at a time. All tabs share a single `state` object, so a control on one tab moves its twin on another.

| Tab | Contents |
|---|---|
| **Preamp** | Audio bar → analyzer (sticky) → scope (disclosure) → noise tools → presets → pedal SVG |
| **Tuner** | Tuner only — existing MPM/NSDF implementation, unchanged |
| **Spectrum** | Faithful overtone-scope port |
| **Mix** | Schematic curves + live FFT overlay + compact EQ strip |

Content needs bottom padding equal to island height so nothing hides underneath.

### Preamp layout order (changed)

Pedal SVG moves to the **bottom** of the tab. The analyzer becomes **sticky** so it stays visible while you scroll down to the controls.

Sticky analyzer should **shrink to ~120 px when stuck** (full height ~220 px when in flow). Enough to read spectrum shape with a thumb on a knob, without eating a portrait viewport that's already giving space to the island.

## 3. Removals

- Bass Tone slider (`toneKnob`) and its `filterTone` node
- Pickup slider (`pickupKnob`)
- `buildBassCurve(pickupNorm)` loses its parameter — fix the pickup character at the current 0.5 midpoint for the Mix tab's schematic curve

## 4. B7K drive section

Topology from the Darkglass manual (https://www.darkglass.com/manual-microtubes-b7k/) — ~95% confidence:

```
in ─┬───────────────── dry, unity gain ─────────────────┐
    └─ Grunt(LF) → Attack(HF) → Drive → clipper → Level ┤
                                                         ▼ sum
                                        → Low → LoMid → HiMid → Treble → out
```

Three points that contradict the obvious guess, all straight from the manual:

- **Level scales the wet path only.** Not a master volume. Clean stays at unity.
- **Grunt and Attack are pre-clipper and never touch the dry path.** Grunt picks between three bass-boost levels before the clipping stage; Attack is Boost / Flat / Cut on treble entering the clipper.
- **EQ is post-blend**, operating on the summed signal.

| Control | Node | Notes |
|---|---|---|
| Blend | two GainNodes, equal-power crossfade | dry = cos, wet = sin |
| Level | GainNode on wet path | **dim the control when Blend = 0** — it genuinely does nothing there |
| Drive | GainNode pre-clipper | |
| Grunt | lowshelf, 3 positions | Thin / Raw / Fat |
| Attack | highshelf, 3 positions | Cut / Flat / Boost |
| Clipper | WaveShaperNode | **asymmetric soft clip** — different curve above/below zero, yields even harmonics |

Clipper curve confidence ~40%; nobody publishes the real one. **Say so in the footer.** This will not sound like the real pedal — the goal is correct control *behaviour*, not tone matching.

**Flagged for later (do not build now):** a post-clipper voicing filter approximating the measured ~300 Hz scoop and ~2 kHz peak (TalkBass lab measurement of the B7K). Rejected because that measurement covers the whole pedal *including* its EQ, and our EQ is separate — baking it in double-counts. Good candidate for the `prototype` skill once (b) works.

### Tooltips

Hover bubbles on Blend / Level / Drive / Grunt / Attack carrying the manual's description of each. The CSS already has a `(hover: none)` breakpoint — wire as hover on pointer devices, tap-to-toggle on touch, same bubble both ways.

## 5. Analyzer modes

**Two separate canvases swapped into one fixed-height slot.** Not one canvas with a mode flag — there's no shared drawing code between a polyline and a pixel-column blit, and the crosshair's axis mapping differs between them.

**Frequency ceiling drops from 20 kHz to 10 kHz** across every frequency display (FFT, spectrogram, Mix curves, crosshair, axis labels, peak-hold).

Rationale, since it'll look arbitrary later: on a log axis, 5 kHz would buy ~25% more pixels per decade and 10 kHz buys ~11%. That extra 14% isn't worth losing hiss visibility — hiss lives 5–15 kHz and there are dedicated high-cut and notch tools that can't be tuned against an invisible band. 10 kHz also leaves a full octave above the 5 kHz treble shelf to see its upper skirt.

**Preamp tab:**
- FFT mode — existing line renderer. **Schematic curve removed here.** FFT + peak-hold only.
- Spectrogram mode — frequency on **X**, time scrolling **downward**. Deliberately matches FFT's axis so the EQ band markers (100 Hz / 500 Hz–1 kHz / 1.5–3 kHz / 5 kHz) stay meaningful as vertical lines. Boost Lo Mid and you watch a bright stripe thicken at the marker.
- Reuses the existing `fftAnalyser` via `getByteFrequencyData`. **Zero new audio nodes.**

**Spectrum tab:**
- Frequency on **Y**, time on **X** — faithful to the standalone tool. The harmonic ladder chips only work in this orientation.

Column generation is shared; only blit direction differs. One function, orientation parameter.

## 6. Spectrum tab — faithful port

Port from `overtone-scope_1.html` **including** its audio filtering: 12 harmonics × 2 notches + 2 bandpass = 26 BiquadFilterNodes, with mute and solo affecting what you hear.

- **Connect the chain on tab entry, disconnect on tab exit.** Mute/solo state persists in JS and restores on re-entry, but the nodes only exist while the tab is open. Nothing invisible should alter your tone on the Preamp tab, and 26 series biquads is exactly the kind of load the Pi can't spare.
- **Do not port** the scope's autocorrelation pitch detector — it bottoms out at 55 Hz, above low E. Feed the ladder from the existing tuner MPM/NSDF detector on the pre-EQ tap.
- **Do not port** file-load or test-tone sources. Live input only.

## 7. Mix tab

- Schematic instrument curves (guitar / kick / snare / hi-hat) + schematic bass curve — **retained here only**
- Live FFT overlay underneath them
- Reference chart modal + the four annotation cards
- **Compact EQ strip**: four EQ sliders + two frequency toggles. No pedal SVG, no drive section.
  - The SVG is 540×300 and would push the chart below the fold on the one tab whose job is showing the chart
  - Drive controls would visibly do nothing here, since the schematic curve is EQ-only — inviting exactly the "these knobs aren't functional" complaint that started this work

## 8. Presets

Bump `b7k_presets_v1` → `b7k_presets_v2`, migrate on read.

- Drop `tone`, `pickup`
- Add `blend`, `level`, `drive`, `grunt`, `attack`
- v1 presets migrate with the drive section neutral (blend 0, level unity, drive min, grunt Raw, attack Flat) — which is the tone they were captured at anyway

**Undefined reaching `setTargetAtTime` produces `NaN`, which kills the node silently with no console error.** Guard every field on load.

## 9. Mobile performance

**Throttle the analyzer render loop to 30 fps on mobile.** Currently redraws every frame over 8192 bins. Imperceptible for a spectrum display, roughly halves main-thread work.

**Latency, stated plainly so nobody chases it:**

- Measured on phone: ~100 ms perceptible. Displayed: implausible four-digit number.
- **The displayed figure is a bug.** `baseLatency` and `outputLatency` are in *seconds* and the code multiplies by 1000. Four digits implies over a second of real I/O, which would be unmistakable. Most likely a browser returning `outputLatency` already in ms. **Add a raw-value diagnostic** (`baseLatency`, `outputLatency`, `sampleRate` printed unmodified) rather than guessing, then clamp and label.
- **The ~100 ms is real and is not our code.** Biquads and waveshapers are sample-accurate — zero added delay. It's input buffer + output buffer, and mobile browsers allocate far larger ones than desktop. Throttling improves *stability* (less contention, fewer glitches) but cannot move the baseline. Nothing in JS can.
- This is the same latency gate as the hardware track: the Audio Injector Zero over I²S is the actual fix.

**Do not fork for the Pi yet.** The hardware target isn't settled — GPIO18 is ~80%, the tap network still needs its line-level redesign, the AIZ latency gate is untested. A fork would diverge against an unknown target during the period the code changes most. Instead:

- Config-gate heavy features (constant or `?lite=1`) so stripping is a flag flip, not a merge
- **Add a frame-time readout to the analyzer toolbar now** — real numbers on first Pi boot instead of guesses

---

## Verification plan

### Static — before opening a browser

1. Extract the `<script>` block and `node --check` it
2. Grep every `getElementById('...')` target; confirm the id exists
3. Grep every `onclick="fn(...)"`; confirm `fn` is defined
4. Confirm brace/paren balance
5. Confirm nothing references `toneKnob`, `pickupKnob`, `filterTone`, `state.tone`, `state.pickup`
6. Confirm no `20000` remains in frequency-axis code

### Runtime — in order, each step gates the next

1. **Loads clean.** No console errors. Four tabs switch. Island compact, overlaps nothing.
2. **Audio enables.** Meters move, `ctx:running`, latency line shows raw diagnostic values.
3. **Bypass A/B** audibly flattens EQ.
4. **EQ** — each of four bands audibly changes tone.
5. **Drive section — the critical block:**
   - Blend 0 → dry only; Level dimmed; moving Level does nothing
   - Blend up → distortion audible
   - Drive changes saturation amount
   - Grunt / Attack change character **only** when Blend > 0
   - **FFT shows new harmonics appear as drive engages** — this is the proof the clipper is actually in the path rather than a UI that looks connected
6. **Tuner.** Open strings E1 41.2 / A1 55 / D2 73.4 / G2 98 → correct names, cents near zero in tune.
7. **Spectrum tab.** Spectrogram scrolls, ladder tracks pitch, muting H3 is audible.
8. **Tab-exit disconnect.** Mute H3 → Preamp → harmonic restored, tone unaltered, no click on switch. Back to Spectrum → H3 still shown muted.
9. **Mix tab.** Schematic curve + FFT overlay both render. Compact EQ strip moves the Preamp pedal knobs.
10. **Sticky + layout.** Scroll Preamp: analyzer sticks and shrinks, pedal SVG sits at bottom, nothing hides behind the island.
11. **Presets.** Save → reload → recall. Then hand-insert a v1-schema preset into localStorage and confirm it migrates without `NaN` and without killing audio.
12. Scope disclosure, noise tools, theme toggle in both themes.
13. **Mobile.** Frame rate throttles, island compact, sticky analyzer usable in portrait.
14. **PWA.** Still installs, `sw.js` caches, offline load works.

### Regression risks specific to this refactor

- `NaN` into gain nodes from preset migration → step 11
- AudioContext suspending on tab switch → step 8
- Orphaned nodes after repeated Spectrum enter/exit → switch tabs ten times, watch for CPU creep
- Island overlapping scrollable content on a short viewport
- Sticky element fighting the fixed island on iOS Safari (known for sticky quirks with dynamic toolbars)

---

## History worth knowing

Bugs already found and fixed in this file — don't reintroduce:

- `buildAudioGraph()` once called `disconnect()` on the gain nodes every time it ran, tearing down the chain immediately after wiring it. Symptom: everything looked connected, no sound. **It is now a pure parameter setter and must stay one.**
- Forcing `sampleRate: 48000` on the AudioContext while the input stream ran at 44100 silently broke `MediaStreamSource` — connected, passed nothing. **Never force sample rate.**
- Wrapping `render()` via `const orig = render; function render(){ orig(); ... }` caused infinite recursion, since the captured name resolves to the new function. **Call things directly.**

Pattern across all three: the graph *looked* wired and passed no audio. Step 5 of the verification plan exists specifically to catch that class of failure.

## Suggested skills

- **`prototype`** — for the §4 clipper voicing variant later; a "try several, compare" job
- **`grill-me`** — if the Pi port opens new forks
