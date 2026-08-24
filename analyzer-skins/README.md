# Skins patch — three looks, each with light + dark

Adds a `skin` axis alongside the existing `theme` axis, so the app has
**4 skins × 2 modes = 8 looks**, switchable at runtime and persisted.

| skin | dark | light |
|---|---|---|
| `classic` | original teal / cyan | original |
| `aria` | glossy black, gold, oxblood | ivory, antique gold, oxblood |
| `minimal` | pure black, white trace, one red | pure white, black trace, one red |
| `lab` | CRT phosphor green + amber | paper chart recorder, ink blue on cream |

`classic` is the default, so nothing changes for an existing user until
they tap the new button.

## Three edits

**1 — `parts/01_head.html`**
Append the whole of `skins.css` at the **end** of the existing `<style>`
block (just before `</style>`). Source order matters: these rules must
come after the current `:root` and `:root[data-theme="light"]` blocks.

**2 — `parts/03_core.js`**
Replace the block from the `// THEME (canvas colours …)` banner comment
down to the end of `initTheme()` — currently **lines 56–118**, i.e. from
`const THEMES = {` through the closing `}` of `initTheme` — with the whole
of `skins.js`.

Nothing else in the file needs touching: `TH`, `applyTheme(mode, persist)`,
`toggleTheme()`, `initTheme()` and `bootDone` all keep their old names and
signatures, so `initTheme()` at the bottom of
`07_tuner_presets_init.js` and the `onclick` in the markup keep working.

**3 — `parts/02_body.html`**
Replace the `.header-row` block (currently **lines 4–10**) with
`header-row.html`.

Then `./build.sh` as usual.

## New API

```js
setSkin('aria')     // jump straight to a skin
cycleSkin()         // classic → aria → minimal → lab → classic
toggleTheme()       // light ⇄ dark, keeps the current skin
applyLook(skin, mode, persist)   // the single place both axes land
```

Persistence: `b7k_skin` (new) and `b7k_theme` (unchanged, so an existing
user's light/dark preference survives the upgrade).

## One thing worth fixing while you're in there

`parts/05_analyzer.js` line 286 draws the band markers with a hardcoded
`rgba(255,255,255,0.22)`. That is invisible on the Minimal and Lab light
skins. Change it to `TH.bandMarker`, which every skin defines:

```js
ctx.strokeStyle = TH.bandMarker; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
```

## Notes on the accent slot

Each skin repoints `--darkgas-teal` rather than renaming it — it is the
app's single accent variable, used by tab selection, section labels, knob
pointers and focus rings. Renaming it would mean touching ~60 call sites
for no visual gain. Aria points it at gold, Minimal at the red, Lab at
phosphor green (dark) / ink blue (light).
