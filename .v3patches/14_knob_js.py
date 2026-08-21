#!/usr/bin/env python3
"""Knob + switch behaviour, and removal of the pedal SVG renderer."""
import sys, io, re

core, audio = sys.argv[1:3]
s = io.open(core, encoding='utf-8').read()

if 'KNOB_STEPS' in s:
    print('knob js already present'); raise SystemExit(0)

JS = '''// ═══════════════════════════════════════════════════════════
// PEDAL PANEL — knobs and switches
//
// 21 detents from 7 to 5 o'clock, the positions printed on the real pedal,
// so a setting here can be copied straight onto it. The detent is a UI
// affordance ONLY: state stays in real units (dB and %), which is why the
// Mix tab twins, the preset schema and the DSP all needed no changes.
// ═══════════════════════════════════════════════════════════
const KNOB_STEPS = 20;    // 21 positions, 0..20
const KNOB_SWEEP = 300;   // degrees swept, 7 o'clock → 5 o'clock
const KNOB_RANGE = {
  blend: [0, 100], level: [0, 100], drive: [0, 100],
  low: [-12, 12], loMid: [-12, 12], hiMid: [-12, 12], treble: [-12, 12]
};

function knobToValue(key, step) {
  const r = KNOB_RANGE[key]; if (!r) return 0;
  return r[0] + (step / KNOB_STEPS) * (r[1] - r[0]);
}
function knobToStep(key, v) {
  const r = KNOB_RANGE[key]; if (!r) return 0;
  const val = Number.isFinite(v) ? v : r[0];
  const t = (val - r[0]) / (r[1] - r[0]);
  return Math.max(0, Math.min(KNOB_STEPS, Math.round(t * KNOB_STEPS)));
}
function knobDeg(step) { return -KNOB_SWEEP / 2 + (step / KNOB_STEPS) * KNOB_SWEEP; }
function knobClock(step) {
  const total = 420 + step * 30;              // minutes from midnight, 7:00 base
  const h = Math.floor(total / 60) % 12 || 12;
  return h + ':' + (total % 60 ? '30' : '00');
}

// Switch positions live in the markup, listed top to bottom, so the physical
// order on screen and the state value can never drift apart in code.
function swSpec(id) {
  const wrap = document.querySelector('[data-swlabels="' + id + '"]');
  if (!wrap) return null;
  const spans = Array.from(wrap.querySelectorAll('span'));
  return { spans, values: spans.map(sp => parseFloat(sp.dataset.v)) };
}
function syncSwitch(id) {
  const sp = swSpec(id); if (!sp) return;
  const n = sp.values.length;
  let i = sp.values.indexOf(state[id]);
  if (i < 0) i = n >> 1;
  const dot = document.querySelector('[data-sw="' + id + '"] .sw-dot');
  if (dot) dot.style.top = (n === 3 ? [15, 50, 85][i] : [25, 75][i]) + '%';
  sp.spans.forEach((el, k) => el.classList.toggle('on', k === i));
}
function advanceSwitch(id) {
  const sp = swSpec(id); if (!sp) return;
  const i = sp.values.indexOf(state[id]);
  setParam(id, sp.values[i < 0 ? 0 : (i + 1) % sp.values.length]);
}

function syncPedalPanel() {
  document.querySelectorAll('[data-knob]').forEach(k => {
    const key = k.dataset.knob;
    const step = knobToStep(key, state[key]);
    k.style.setProperty('--deg', knobDeg(step) + 'deg');
    k.setAttribute('aria-valuenow', String(step));
    const f = VAL_FMT[key];
    k.setAttribute('aria-valuetext', (f ? f(state[key]) : String(state[key])) +
                   ', ' + knobClock(step) + " o'clock");
    const c = document.querySelector('[data-clock="' + key + '"]');
    if (c) c.textContent = knobClock(step);
  });
  ['grunt', 'attack', 'loMidFreq', 'hiMidFreq'].forEach(syncSwitch);
}

function wirePedalPanel() {
  document.querySelectorAll('[data-knob]').forEach(k => {
    const key = k.dataset.knob;
    const off = () => k.getAttribute('aria-disabled') === 'true';
    const setStep = st => setParam(key, knobToValue(key, Math.max(0, Math.min(KNOB_STEPS, st))));
    let dragging = false;

    // Angle from the knob centre; straight up is 0, clockwise positive.
    const fromPointer = e => {
      const r = k.getBoundingClientRect();
      const deg = Math.atan2(e.clientX - (r.left + r.width / 2),
                             -(e.clientY - (r.top + r.height / 2))) * 180 / Math.PI;
      const cl = Math.max(-KNOB_SWEEP / 2, Math.min(KNOB_SWEEP / 2, deg));
      setStep(Math.round(((cl + KNOB_SWEEP / 2) / KNOB_SWEEP) * KNOB_STEPS));
    };

    k.addEventListener('pointerdown', e => {
      if (off()) return;
      dragging = true;
      try { k.setPointerCapture(e.pointerId); } catch (err) {}
      fromPointer(e); e.preventDefault();
    });
    k.addEventListener('pointermove', e => { if (dragging) fromPointer(e); });
    k.addEventListener('pointerup', e => {
      dragging = false; try { k.releasePointerCapture(e.pointerId); } catch (err) {}
    });
    k.addEventListener('pointercancel', () => { dragging = false; });
    k.addEventListener('wheel', e => {
      if (off()) return;
      e.preventDefault();
      setStep(knobToStep(key, state[key]) + (e.deltaY < 0 ? 1 : -1));
    }, { passive: false });
    k.addEventListener('keydown', e => {
      if (off()) return;
      const cur = knobToStep(key, state[key]);
      let d = 0;
      switch (e.key) {
        case 'ArrowUp': case 'ArrowRight': d = 1; break;
        case 'ArrowDown': case 'ArrowLeft': d = -1; break;
        case 'PageUp': d = 2; break;
        case 'PageDown': d = -2; break;
        case 'Home': setStep(0); e.preventDefault(); return;
        case 'End': setStep(KNOB_STEPS); e.preventDefault(); return;
        default: return;
      }
      setStep(cur + d); e.preventDefault();
    });
  });

  document.querySelectorAll('[data-sw]').forEach(p => {
    const id = p.dataset.sw;
    p.addEventListener('click', () => advanceSwitch(id));
    p.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { advanceSwitch(id); e.preventDefault(); }
    });
  });
}

'''

anchor = '// Writes state → every bound input, every value label, every switch button.'
if anchor not in s: raise SystemExit('syncUI anchor not found')
s = s.replace(anchor, JS + anchor, 1)

# syncUI must also drive the panel, and dim/disable the Level knob
OLD = """  const dim = state.blend <= 0;
  const card = document.getElementById('cardLevel');
  if (card) card.classList.toggle('dimmed', dim);
  document.querySelectorAll('input[data-bind="level"]').forEach(el => { el.disabled = dim; });"""
NEW = """  syncPedalPanel();
  const dim = state.blend <= 0;
  const card = document.getElementById('cardLevel');
  if (card) card.classList.toggle('dimmed', dim);
  document.querySelectorAll('input[data-bind="level"]').forEach(el => { el.disabled = dim; });
  const lvlKnob = document.querySelector('[data-knob="level"]');
  if (lvlKnob) {
    lvlKnob.setAttribute('aria-disabled', String(dim));
    lvlKnob.tabIndex = dim ? -1 : 0;
  }"""
if OLD not in s: raise SystemExit('level-dim block not found')
s = s.replace(OLD, NEW, 1)

# drop the SVG renderer
m = re.search(r'\nfunction drawPedal\(\) \{.*?\n\}\n', s, re.S)
if not m: raise SystemExit('drawPedal not found')
s = s[:m.start()] + '\n' + s[m.end():]
s = re.sub(r'^[ \t]*drawPedal\(\);[ \t]*\n', '', s, flags=re.M)
io.open(core, 'w', encoding='utf-8').write(s)
print('core: knob module added, drawPedal removed')

a = io.open(audio, encoding='utf-8').read()
a2 = re.sub(r'^[ \t]*drawPedal\(\);[ \t]*\n', '', a, flags=re.M)
if a2 != a:
    io.open(audio, 'w', encoding='utf-8').write(a2)
    print('audio: drawPedal call removed')

# wire it at boot
