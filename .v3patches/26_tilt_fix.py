#!/usr/bin/env python3
"""Make tilt work, and make it say why when it cannot.

Three defects, found by reading rather than guessing:

1. SILENT FAILURE. deviceorientation needs a secure context. Over plain http
   -- which `npm run serve` gives you on the LAN -- the event never fires. On
   Android there is no permission prompt to fail, so the old code sailed past
   both guards, attached its listener, announced "Tilt live" and then sat
   there receiving nothing. Worst possible failure mode, and it was mine.
   Now: an explicit secure-context warning naming the origin, plus a watchdog
   that reports the silent case if no event arrives within 1.5 s.

2. TILT MOVED A FILTER THAT WAS MIXED OUT. wahExpress sets the wah frequency,
   but wah.on gates the wet/dry mix. On a phone there was no obvious step
   between "enable tilt" and hearing anything, while the panel text claimed
   tilt "does the same job". Enabling tilt now engages the wah.

3. THE DEFAULT RANGE MISSED THE WAY YOU HOLD A PHONE. 20-70 degrees, while a
   phone held naturally in the hand sits around beta 50-80. Half the range
   was unreachable and the value pinned at toe -- indistinguishable from
   broken. Now 25-80 by default, plus a 3-second auto-calibrate that records
   the range as you actually rock it.

And a live readout, so "doesn't work" can never again be indistinguishable
from "works, wrong range".
"""
import sys, io
js, body = sys.argv[1:3]

s = io.open(js, encoding='utf-8').read()
if 'wahTiltDiag' in s:
    print('already applied'); raise SystemExit(0)

OLD_START = s[s.index('// ── Tilt (phone)'):s.index("function wahSay(msg)")]

NEW = '''// ── Tilt (phone) ───────────────────────────────────────────
// Failure here has to be loud. deviceorientation needs a SECURE CONTEXT:
// over plain http (which `npm run serve` gives you on the LAN) the event
// never fires, and on Android there is no permission prompt to fail — so
// it is entirely possible to attach a listener, report success and receive
// nothing. Every branch below says what actually happened, and a watchdog
// catches the silent case.
let wahLastBeta = null, wahTiltSeen = 0, wahTiltWatch = null, wahCal = null;

function wahTiltDiag() {
  const el = document.getElementById('wahTiltDiag');
  if (!el) return;
  const has = typeof DeviceOrientationEvent !== 'undefined';
  el.innerHTML =
    'secure <em>' + (window.isSecureContext ? 'yes' : 'NO') + '</em>' +
    ' · sensor <em>' + (has ? 'yes' : 'no') + '</em>' +
    ' · grant <em>' + (has && typeof DeviceOrientationEvent.requestPermission === 'function'
                        ? 'required' : 'not needed') + '</em>' +
    ' · events <em>' + wahTiltSeen + '</em>' +
    (wahLastBeta == null ? '' : ' · beta <em>' + wahLastBeta.toFixed(1) + '°</em>');
}

function wahOnTilt(e) {
  if (e.beta == null) return;
  wahTiltSeen++;
  wahLastBeta = e.beta;                      // recorded before any early exit,
  if (wahCal) {                              // so calibration always has a value
    wahCal.lo = Math.min(wahCal.lo, e.beta);
    wahCal.hi = Math.max(wahCal.hi, e.beta);
  }
  wahTiltDiag();
  const lo = Math.min(wah.tiltHeel, wah.tiltToe), hi = Math.max(wah.tiltHeel, wah.tiltToe);
  if (hi - lo < 3) return;
  const inv = wah.tiltToe < wah.tiltHeel;
  const p = (e.beta - lo) / (hi - lo);
  wahExpress(inv ? 1 - p : p, null);
}

async function wahTiltStart() {
  if (typeof DeviceOrientationEvent === 'undefined') {
    wahSay('This browser exposes no orientation sensor — desktop browsers generally do not.');
    wahTiltDiag(); return;
  }
  if (!window.isSecureContext) {
    // Warn, then try anyway: if it somehow works the watchdog will say so.
    wahSay('Heads up: ' + location.origin + ' is not a secure context, and most browsers ' +
           'only report motion over https or from localhost. Trying anyway…');
  }
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') { wahSay('Motion access denied. Reload and allow it to use tilt.'); wahTiltDiag(); return; }
    } catch (err) {
      wahSay('Motion access could not be requested: ' + err.message +
             '. On iOS this needs an https page.');
      wahTiltDiag(); return;
    }
  }

  window.addEventListener('deviceorientation', wahOnTilt);
  wahTiltOn = true;
  wah.on = true;                 // tilt against a bypassed wah is silent
  wahApplyAll(false);
  wahSyncUI(); wahTiltDiag();

  const before = wahTiltSeen;
  clearTimeout(wahTiltWatch);
  wahTiltWatch = setTimeout(() => {
    if (wahTiltSeen === before) {
      wahSay(window.isSecureContext
        ? 'Listener attached but the device is sending no orientation events. ' +
          'Either there is no sensor, or the browser is withholding it.'
        : 'No orientation events — ' + location.origin + ' is not a secure context. ' +
          'Serve over https, or from localhost, and tilt will work.');
    } else {
      wahSay('Tilt live — rock the phone like a treadle. Wah engaged automatically.');
    }
    wahTiltDiag();
  }, 1500);
}

function wahTiltStop() {
  if (!wahTiltOn) return;
  clearTimeout(wahTiltWatch);
  window.removeEventListener('deviceorientation', wahOnTilt);
  wahTiltOn = false; wahSyncUI(); wahTiltDiag();
}
function wahTiltToggle() { wahTiltOn ? wahTiltStop() : wahTiltStart(); }

function wahSetTilt(which) {
  if (wahLastBeta == null) { wahSay('No tilt reading yet — enable tilt first.'); return; }
  wah[which === 'heel' ? 'tiltHeel' : 'tiltToe'] = Math.round(wahLastBeta);
  wahSyncUI();
  wahSay((which === 'heel' ? 'Heel' : 'Toe') + ' set at ' + Math.round(wahLastBeta) + '°.');
}

// Records the range you actually use, which beats guessing at how someone
// holds their phone.
function wahAutoCalibrate() {
  if (!wahTiltOn) { wahSay('Enable tilt first, then calibrate.'); return; }
  wahCal = { lo: 1e9, hi: -1e9 };
  wahSay('Rock the phone heel to toe for three seconds…');
  setTimeout(() => {
    const c = wahCal; wahCal = null;
    if (!c || c.hi - c.lo < 8) { wahSay('Not enough movement — try again, rocking further.'); return; }
    wah.tiltHeel = Math.round(c.lo); wah.tiltToe = Math.round(c.hi);
    wahSyncUI();
    wahSay('Calibrated: heel ' + Math.round(c.lo) + '° → toe ' + Math.round(c.hi) + '°.');
  }, 3000);
}

'''
s = s.replace(OLD_START, NEW, 1)
s = s.replace('tiltHeel: 20, tiltToe: 70', 'tiltHeel: 25, tiltToe: 80')
s = s.replace("  set('wahTiltRange', el => el.textContent",
              "  wahTiltDiag();\n  set('wahTiltRange', el => el.textContent", 1)
io.open(js, 'w', encoding='utf-8').write(s)
print('09_wah.js: diagnostics, watchdog, auto-engage, auto-calibrate')

b = io.open(body, encoding='utf-8').read()
if 'wahTiltDiag' in b:
    print('markup already updated')
else:
    OLD = '''      <div class="freq-btns">
        <button class="freq-btn" type="button" onclick="wahSetTilt('heel')">Set heel here</button>
        <button class="freq-btn" type="button" onclick="wahSetTilt('toe')">Set toe here</button>
      </div>'''
    NEW = '''      <div class="freq-btns">
        <button class="freq-btn" type="button" onclick="wahAutoCalibrate()">Auto-calibrate</button>
        <button class="freq-btn" type="button" onclick="wahSetTilt('heel')">Set heel here</button>
        <button class="freq-btn" type="button" onclick="wahSetTilt('toe')">Set toe here</button>
      </div>
      <div class="noise-tool-desc" id="wahTiltDiag">—</div>'''
    if OLD not in b: raise SystemExit('tilt buttons not found')
    io.open(body, 'w', encoding='utf-8').write(b.replace(OLD, NEW, 1))
    print('markup: auto-calibrate button + live diagnostic line')
