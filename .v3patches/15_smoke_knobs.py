#!/usr/bin/env python3
"""smoke.js drove the Preamp tab through its sliders and 3-way buttons.

Those are now knobs and pill switches. The assertions are unchanged in
intent -- twins stay in sync, Level is inert at Blend 0, a switch writes
state and the UI follows -- but they have to be made through the new
controls. Each test also now checks the detent maths, which is the new
thing that could silently be wrong.
"""
import sys, io
p = sys.argv[1] if len(sys.argv) > 1 else 'smoke.js'
s = io.open(p, encoding='utf-8').read()

if 'data-knob="low"' in s:
    print('already applied'); raise SystemExit(0)

OLD4 = """  console.log('\\n[4] twin controls stay in sync');
  // Two `low` sliders exist: Preamp full grid and Mix compact strip.
  const lows = [...d.querySelectorAll('input[data-bind="low"]')];
  if (lows.length < 2) bad(`expected ≥2 twinned "low" sliders, found ${lows.length}`);
  else {
    lows[0].value = '6';
    lows[0].dispatchEvent(new w.Event('input', { bubbles: true }));
    if (ev('state.low') !== 6) bad('state.low did not follow the Preamp slider');
    else if (parseFloat(lows[1].value) !== 6) bad('Mix twin did not follow (got ' + lows[1].value + ')');
    else {
      const labels = [...d.querySelectorAll('[data-val="low"]')].map(e => e.textContent);
      if (labels.every(t => t === '+6.0 dB')) ok(`twin sliders + ${labels.length} labels all synced`);
      else bad('value labels out of sync: ' + JSON.stringify(labels));
    }
    lows[0].value = '0'; lows[0].dispatchEvent(new w.Event('input', { bubbles: true }));
  }"""

NEW4 = """  console.log('\\n[4] twin controls stay in sync');
  // Preamp is a knob now; the Mix compact strip keeps its slider. Both are
  // views onto the same `state`, which is why the knob could be swapped in
  // without touching the preset schema or the DSP.
  const lowKnob = d.querySelector('[data-knob="low"]');
  const mixLow  = d.querySelector('input[data-bind="low"]');
  if (!lowKnob || !mixLow) bad('expected a Preamp low knob and a Mix low slider');
  else {
    ev('setParam')('low', 6);
    const labels = [...d.querySelectorAll('[data-val="low"]')].map(e => e.textContent);
    const step = lowKnob.getAttribute('aria-valuenow');
    const clock = d.querySelector('[data-clock="low"]').textContent;
    if (parseFloat(mixLow.value) !== 6) bad('Mix twin did not follow (got ' + mixLow.value + ')');
    else if (!labels.every(t => t === '+6.0 dB')) bad('labels out of sync: ' + JSON.stringify(labels));
    else if (step !== '15') bad('+6 dB should be detent 15, knob says ' + step);
    else if (clock !== '2:30') bad('detent 15 should read 2:30, knob says ' + clock);
    else ok(`knob + Mix twin + ${labels.length} labels synced (+6 dB = detent 15, ${clock})`);

    // 0 dB must land exactly on the centre detent, or the EQ knobs will not
    // return to flat by eye.
    ev('setParam')('low', 0);
    if (lowKnob.getAttribute('aria-valuenow') === '10' &&
        d.querySelector('[data-clock="low"]').textContent === '12:00')
      ok('0 dB is dead centre (detent 10, 12:00)');
    else bad('0 dB is not centred: detent ' + lowKnob.getAttribute('aria-valuenow'));

    // and the knob writes back to state
    lowKnob.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    if (Math.abs(ev('state.low') - 12) < 1e-9) ok('knob End drives state to +12 dB');
    else bad('knob keyboard did not set state: ' + ev('state.low'));
    ev('setParam')('low', 0);
  }"""

OLD5 = """  const card = d.getElementById('cardLevel');
  const lvl = d.querySelector('input[data-bind="level"]');
  if (card.classList.contains('dimmed') && lvl.disabled) ok('Level dimmed and disabled at blend 0');
  else bad(`blend 0 → dimmed=${card.classList.contains('dimmed')} disabled=${lvl.disabled}`);
  ev('setParam')('blend', 50);
  if (!card.classList.contains('dimmed') && !lvl.disabled) ok('Level re-enabled once Blend > 0');
  else bad('Level still dimmed at blend 50');"""

NEW5 = """  const card = d.getElementById('cardLevel');
  const lvlKnob = d.querySelector('[data-knob="level"]');
  const lvlOff = () => lvlKnob.getAttribute('aria-disabled') === 'true';
  if (card.classList.contains('dimmed') && lvlOff()) ok('Level dimmed and disabled at blend 0');
  else bad(`blend 0 → dimmed=${card.classList.contains('dimmed')} disabled=${lvlOff()}`);
  ev('setParam')('blend', 50);
  if (!card.classList.contains('dimmed') && !lvlOff()) ok('Level re-enabled once Blend > 0');
  else bad('Level still dimmed at blend 50');"""

OLD6 = """  console.log('\\n[6] 3-position switches');
  const fatBtn = d.querySelector('button[data-set="grunt"][data-v="2"]');
  fatBtn.dispatchEvent(new w.Event('click', { bubbles: true }));
  // onclick attribute handlers need an explicit call in jsdom event flow
  ev('setSwitch')(fatBtn);
  if (ev('state.grunt') === 2 && fatBtn.classList.contains('active') &&
      d.querySelector('[data-val="grunt"]').textContent === 'Fat') ok('Grunt → Fat sets state, button and label');
  else bad(`grunt=${ev('state.grunt')} label=${d.querySelector('[data-val="grunt"]').textContent}`);
  ev('setParam')('grunt', 1);"""

NEW6 = """  console.log('\\n[6] 3-position switches');
  const gruntPill = d.querySelector('[data-sw="grunt"]');
  const gruntSpans = [...d.querySelectorAll('[data-swlabels="grunt"] span')];
  // Listed top to bottom on screen. Reading the values out of the markup is
  // the point: the physical order and the state value cannot drift in code.
  const order = gruntSpans.map(sp => sp.textContent);
  if (order.join('/') === 'Fat/Raw/Thin') ok('grunt switch reads Fat/Raw/Thin top to bottom');
  else bad('grunt switch order is ' + order.join('/'));

  ev('setParam')('grunt', 1);
  gruntPill.dispatchEvent(new w.Event('click', { bubbles: true }));   // Raw → Thin
  gruntPill.dispatchEvent(new w.Event('click', { bubbles: true }));   // Thin → Fat
  const onSpan = gruntSpans.find(sp => sp.classList.contains('on'));
  if (ev('state.grunt') === 2 && onSpan && onSpan.textContent === 'Fat' &&
      d.querySelector('[data-val="grunt"]').textContent === 'Fat')
    ok('clicking the pill cycles to Fat and moves state, dot and label together');
  else bad(`grunt=${ev('state.grunt')} on=${onSpan && onSpan.textContent}`);

  const dot = d.querySelector('[data-sw="grunt"] .sw-dot');
  if (dot.style.top === '15%') ok('dot sits at the top position for Fat');
  else bad('dot is at ' + dot.style.top + ' for Fat');

  // The 2-position frequency switch shares the same code path.
  ev('setParam')('loMidFreq', 1000);
  const fPill = d.querySelector('[data-sw="loMidFreq"]');
  fPill.dispatchEvent(new w.Event('click', { bubbles: true }));
  if (ev('state.loMidFreq') === 500) ok('2-position frequency switch toggles 1 kHz → 500 Hz');
  else bad('loMidFreq=' + ev('state.loMidFreq'));
  ev('setParam')('loMidFreq', 1000);
  ev('setParam')('grunt', 1);"""

for old, new, label in [(OLD4, NEW4, '[4]'), (OLD5, NEW5, '[5]'), (OLD6, NEW6, '[6]')]:
    if old not in s:
        raise SystemExit('anchor %s not found' % label)
    s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('smoke.js tests [4] [5] [6] rewritten for the knob panel')
