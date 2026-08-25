#!/usr/bin/env python3
"""isSecureContext is TRUE on file:// in Chrome, so it cannot be the guard.

verify.js [13] already encodes that lesson for the worklet and caught my new
tilt diagnostic repeating the mistake: on a file:// page it would have
cheerfully reported 'secure yes' while the sensor stayed dead. Classify the
context by protocol first, exactly as DT_WORKLET_BLOCKED does.
"""
import sys, io
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
if 'wahContext()' in s:
    print('already applied'); raise SystemExit(0)

HELPER = '''// isSecureContext is TRUE on file:// in Chrome, so it cannot classify this
// on its own — the protocol has to be checked first. Same lesson the detune
// worklet guard learned, and verify.js [13] enforces it.
function wahContext() {
  if (typeof location === 'undefined') return 'unknown';
  if (location.protocol === 'file:') return 'file';
  return window.isSecureContext ? 'secure' : 'insecure';
}
const WAH_CTX_NOTE = {
  file:     'opened as a local file — browsers do not report motion from file://',
  insecure: 'not a secure context — browsers only report motion over https or from localhost',
  secure:   'secure',
  unknown:  'unknown'
};

'''

s = s.replace('let wahLastBeta = null, wahTiltSeen = 0', HELPER + 'let wahLastBeta = null, wahTiltSeen = 0', 1)

s = s.replace(
  "    'secure <em>' + (window.isSecureContext ? 'yes' : 'NO') + '</em>' +",
  "    'context <em>' + wahContext() + '</em>' +", 1)

s = s.replace(
  """  if (!window.isSecureContext) {
    // Warn, then try anyway: if it somehow works the watchdog will say so.
    wahSay('Heads up: ' + location.origin + ' is not a secure context, and most browsers ' +
           'only report motion over https or from localhost. Trying anyway…');
  }""",
  """  const ctx = wahContext();
  if (ctx !== 'secure') {
    // Warn, then try anyway: if it somehow works the watchdog will say so.
    wahSay('Heads up — this page is ' + WAH_CTX_NOTE[ctx] + '. Trying anyway…');
  }""", 1)

s = s.replace(
  """    if (wahTiltSeen === before) {
      wahSay(window.isSecureContext
        ? 'Listener attached but the device is sending no orientation events. ' +
          'Either there is no sensor, or the browser is withholding it.'
        : 'No orientation events — ' + location.origin + ' is not a secure context. ' +
          'Serve over https, or from localhost, and tilt will work.');
    } else {""",
  """    if (wahTiltSeen === before) {
      const c = wahContext();
      wahSay(c === 'secure'
        ? 'Listener attached but the device is sending no orientation events. ' +
          'Either there is no sensor, or the browser is withholding it.'
        : 'No orientation events — this page is ' + WAH_CTX_NOTE[c] +
          '. Serve it over https, or from localhost, and tilt will work.');
    } else {""", 1)

if 'window.isSecureContext' in s.replace("return window.isSecureContext ? 'secure' : 'insecure';", ''):
    raise SystemExit('a bare isSecureContext use remains')
io.open(p, 'w', encoding='utf-8').write(s)
print('tilt context classified by protocol first')
