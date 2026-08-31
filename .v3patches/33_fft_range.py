#!/usr/bin/env python3
"""Give the FFT a display range that suits a bass.

The analyser window was fixed at -90..-10 dBFS. A passive bass through an
iRig puts most FFT bins between about -75 and -45, so the trace lived in the
bottom third and never crossed the -50 line. Nothing was wrong with the
audio -- the chart was simply scaled for a line-level source.

Three display ranges, selectable and remembered. These change the ANALYSER
WINDOW ONLY: no gain is applied, nothing about what you hear moves, and the
dB labels stay absolute so the numbers still mean something.
"""
import sys, io
anal, audio, body = sys.argv[1:4]

s = io.open(anal, encoding='utf-8').read()
if 'FFT_RANGES' in s:
    print('already applied'); raise SystemExit(0)

BLOCK = '''// ── Display range ──────────────────────────────────────────
// The analyser's dB window, not a gain. A passive bass through an iRig sits
// far below line level, so the old fixed -90..-10 window left the trace in
// the bottom third of the chart. The labels stay absolute dBFS either way.
const FFT_RANGES = [
  { id: 'line',  label: 'Line',  min: -90,  max: -10 },
  { id: 'inst',  label: 'Instr', min: -95,  max: -35 },
  { id: 'quiet', label: 'Quiet', min: -100, max: -50 }
];
const FFT_RANGE_KEY = 'b7k_fftrange';
let fftRangeId = 'inst';

function fftRange() { return FFT_RANGES.find(r => r.id === fftRangeId) || FFT_RANGES[1]; }

function applyFftRange() {
  const r = fftRange();
  if (fftAnalyser) { fftAnalyser.minDecibels = r.min; fftAnalyser.maxDecibels = r.max; }
  document.querySelectorAll('[data-fftrange]').forEach(b =>
    b.classList.toggle('active', b.dataset.fftrange === fftRangeId));
}
function setFftRange(id) {
  if (!FFT_RANGES.some(r => r.id === id)) return;
  fftRangeId = id;
  try { localStorage.setItem(FFT_RANGE_KEY, id); } catch (e) {}
  applyFftRange();
  redrawStatic();
}
function initFftRange() {
  let saved = null;
  try { saved = localStorage.getItem(FFT_RANGE_KEY); } catch (e) {}
  if (FFT_RANGES.some(r => r.id === saved)) fftRangeId = saved;
  applyFftRange();
}

'''
A = '// ═══════════════════════════════════════════════'
i = s.index('function drawFftChart()')
j = s.rindex('\n//', 0, i) + 1
k = s.rindex('\n', 0, j) + 1
s = s[:k] + BLOCK + s[k:]
io.open(anal, 'w', encoding='utf-8').write(s)
print('analyzer: three display ranges')

a = io.open(audio, encoding='utf-8').read()
OLD = "    fftAnalyser.minDecibels = -90;\n    fftAnalyser.maxDecibels = -10;"
NEW = "    applyFftRange();     // window comes from the saved display range, not a literal"
if OLD not in a: raise SystemExit('analyser dB window not found')
io.open(audio, 'w', encoding='utf-8').write(a.replace(OLD, NEW, 1))
print('audio: analyser window follows the selected range')

b = io.open(body, encoding='utf-8').read()
if 'data-fftrange' in b:
    print('markup already present')
else:
    OLD_B = '''    <span class="frame-info" id="frameInfo">frame <em>—</em></span>
  </div>'''
    NEW_B = '''    <span class="frame-info" id="frameInfo">frame <em>—</em></span>
  </div>
  <div class="fft-toggle-row">
    <span class="ctrl-sub" style="margin:0 4px 0 0">Range</span>
    <button class="fft-btn" type="button" data-fftrange="line"  onclick="setFftRange('line')">Line</button>
    <button class="fft-btn" type="button" data-fftrange="inst"  onclick="setFftRange('inst')">Instrument</button>
    <button class="fft-btn" type="button" data-fftrange="quiet" onclick="setFftRange('quiet')">Quiet</button>
  </div>'''
    if OLD_B not in b: raise SystemExit('analyzer toolbar not found')
    io.open(body, 'w', encoding='utf-8').write(b.replace(OLD_B, NEW_B, 1))
    print('markup: range selector in the analyzer toolbar')
