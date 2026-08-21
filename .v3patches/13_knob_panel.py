#!/usr/bin/env python3
"""Replace the pedal SVG + slider grid with the knob panel from the preset sheet.

Layout ported from the printed B7K sheet: 21 detents from 7 to 5 o'clock --
the positions you can read off the real pedal and copy back onto it. The
detent is a UI affordance only; state stays in real units (dB and %), so
presets, the Mix tab twins and the DSP are all untouched.

Styled from the app's CSS variables, so it is correct in both themes.
Tooltips are lifted verbatim out of the old markup rather than retyped.
"""
import sys, io, re

head, body, core, audio = sys.argv[1:5]

# ── pull the five tooltips out of the existing markup ──────
b = io.open(body, encoding='utf-8').read()
tips = {}
for m in re.finditer(r'<button class="tip-btn"[^>]*aria-label="About (\w+)"[^>]*>\?'
                     r'(<span class="tip-bub">.*?</span>)</button>', b, re.S):
    tips[m.group(1).lower()] = m.group(2)
if len(tips) != 5:
    raise SystemExit('expected 5 tooltips, found %d: %s' % (len(tips), sorted(tips)))

def tip(name):
    return ('<button class="tip-btn" type="button" onclick="toggleTip(event,this)" '
            'aria-label="About %s">?%s</button>' % (name.capitalize(), tips[name]))

# ── markup ─────────────────────────────────────────────────
def knob(key, label, tipname=None, cellid=''):
    t = (' ' + tip(tipname)) if tipname else ''
    idattr = (' id="%s"' % cellid) if cellid else ''
    return f'''      <div class="knobcell"{idattr}>
        <div class="knob-label">{label}{t}</div>
        <div class="knob" data-knob="{key}" tabindex="0" role="slider"
             aria-label="{label}" aria-valuemin="0" aria-valuemax="20">
          <div class="knob-ptr"></div><div class="knob-hub"></div>
        </div>
        <div class="knob-read"><span class="val" data-val="{key}">0</span></div>
        <div class="knob-clock" data-clock="{key}">7:00</div>
      </div>'''

def switch(key, caption, positions, tipname=None, n=3):
    # positions are listed top -> bottom, each as (value, text)
    spans = ''.join('<span data-v="%s">%s</span>' % (v, t) for v, t in positions)
    t = (' ' + tip(tipname)) if tipname else ''
    return f'''      <div class="swcell">
        <div class="sw-main">
          <div class="sw-pill n{n}" data-sw="{key}" tabindex="0" role="button"
               aria-label="{caption} switch"><div class="sw-dot"></div></div>
          <div class="sw-labels" data-swlabels="{key}">{spans}</div>
        </div>
        <div class="sw-cap">{caption}{t}</div>
        <div class="sw-read"><span class="val" data-val="{key}"></span></div>
      </div>'''

PANEL = f'''  <!-- ── PEDAL PANEL — knobs and switches ── -->
  <div class="section-label">Pedal — <span>Microtubes B7K v2</span></div>
  <div class="pedal-panel">
    <div class="pedal-row top">
{knob("blend","Blend","blend")}
{switch("grunt","Grunt",[(2,"Fat"),(1,"Raw"),(0,"Thin")],"grunt")}
{knob("level","Level","level","cardLevel")}
{switch("attack","Attack",[(2,"Boost"),(1,"Flat"),(0,"Cut")],"attack")}
{knob("drive","Drive","drive")}
    </div>
    <div class="pedal-row grid4">
{knob("low","Low")}
{knob("loMid","Lo Mids")}
{knob("hiMid","Hi Mids")}
{knob("treble","Treble")}
    </div>
    <div class="pedal-row grid4">
      <div></div>
{switch("loMidFreq","Lo-Mid",[(1000,"1 kHz"),(500,"500 Hz")],None,2)}
{switch("hiMidFreq","Hi-Mid",[(3000,"3 kHz"),(1500,"1.5 kHz")],None,2)}
      <div></div>
    </div>
    <div class="pedal-caption">Microtubes B7K &middot; Analog Bass Preamp</div>
  </div>
  <p class="hint">
    Drag a knob, or use the scroll wheel and arrow keys. Detents are the 21
    positions of the real pedal, so a setting here transfers straight onto it.
    EQ is <em style="color:var(--darkgas-teal);font-style:normal">post-blend</em> —
    it acts on the summed clean + distorted signal, not on the clean path alone.
  </p>

'''

start = b.index('  <!-- ── PEDAL + FULL CONTROLS ── -->')
end = b.index('\n</section>', start)
io.open(body, 'w', encoding='utf-8').write(b[:start] + PANEL + b[end + 1:])
print('markup: pedal SVG + slider grid -> knob panel')

# ── css ────────────────────────────────────────────────────
h = io.open(head, encoding='utf-8').read()
OLD_CSS = """/* Pedal & controls */
.pedal-section { display: flex; flex-direction: column; align-items: center; gap: 14px; }
.pedal-wrap { width: 100%; max-width: 560px; }
#pedalSvg { width: 100%; border-radius: 6px; display: block; }
"""
NEW_CSS = """/* Pedal panel — knobs and switches, ported from the printed preset sheet.
   Everything is a theme variable, so the panel is correct in both themes. */
.pedal-panel {
  width: 100%; max-width: 560px; margin: 0 auto;
  border: 1px solid var(--pedal-edge); border-radius: 10px;
  background: var(--panel); padding: 16px 12px 10px;
  display: flex; flex-direction: column; gap: 18px;
}
.pedal-row.top { display: flex; justify-content: space-between; align-items: flex-end; gap: 4px; }
.pedal-row.grid4 { display: grid; grid-template-columns: repeat(4, 1fr);
                   justify-items: center; align-items: start; gap: 10px 4px; }
.pedal-caption { text-align: center; font-size: 0.5rem; letter-spacing: 0.2em;
                 text-transform: uppercase; color: var(--dim); }

.knobcell { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 0; }
.knob-label { font-size: 0.55rem; letter-spacing: 0.07em; font-weight: 600;
              text-transform: uppercase; color: var(--text); white-space: nowrap; }
.knob { width: 52px; height: 52px; border-radius: 50%; flex: none; position: relative;
        border: 1px solid var(--pedal-edge); background: var(--panel-2);
        cursor: grab; touch-action: none; }
.knob:active { cursor: grabbing; }
.knob:focus-visible { outline: 2px solid var(--darkgas-teal); outline-offset: 2px; }
.knob-ptr { position: absolute; left: calc(50% - 1px); bottom: 50%; width: 2px; height: 40%;
            background: var(--darkgas-teal); border-radius: 1px;
            transform-origin: bottom center; transform: rotate(var(--deg, 0deg)); }
.knob-hub { position: absolute; left: 50%; top: 50%; width: 6px; height: 6px;
            background: var(--dim); border-radius: 50%; transform: translate(-50%, -50%); }
.knob-read .val { color: var(--darkgas-teal); font-size: 0.58rem; }
.knob-clock { font-size: 0.55rem; font-weight: 700; font-variant-numeric: tabular-nums;
              color: var(--dim); }
.knobcell.dimmed { opacity: 0.38; }
.knob[aria-disabled="true"] { cursor: not-allowed; }

.swcell { display: flex; flex-direction: column; align-items: center; gap: 5px; }
.sw-main { display: flex; gap: 6px; align-items: stretch; }
.sw-pill { width: 20px; flex: none; position: relative; cursor: pointer;
           border: 1px solid var(--pedal-edge); border-radius: 11px; background: var(--panel-2); }
.sw-pill.n3 { height: 52px; }
.sw-pill.n2 { height: 34px; }
.sw-pill:focus-visible { outline: 2px solid var(--darkgas-teal); outline-offset: 2px; }
.sw-dot { position: absolute; left: 50%; top: 50%; width: 12px; height: 12px; border-radius: 50%;
          background: var(--darkgas-teal); transform: translate(-50%, -50%); transition: top 0.1s ease; }
.sw-labels { display: flex; flex-direction: column; justify-content: space-between; padding: 1px 0; }
.sw-labels span { font-size: 0.5rem; line-height: 1; font-weight: 700; white-space: nowrap;
                  color: var(--dim); }
.sw-labels span.on { color: var(--text); }
.sw-cap { font-size: 0.52rem; letter-spacing: 0.09em; font-weight: 600;
          text-transform: uppercase; color: var(--dim); }
.sw-read .val { color: var(--darkgas-teal); font-size: 0.55rem; }
"""
if OLD_CSS not in h:
    raise SystemExit('pedal css anchor not found')
io.open(head, 'w', encoding='utf-8').write(h.replace(OLD_CSS, NEW_CSS, 1))
print('css: knob panel styles (theme variables only)')
