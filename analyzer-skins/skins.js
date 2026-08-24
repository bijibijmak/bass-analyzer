// ═══════════════════════════════════════════════════════════
// SKINS + THEME  (canvas colours — CSS handles the DOM)
//
// Two independent axes:
//   skin  = classic | aria | minimal | lab   (data-skin on <html>)
//   mode  = dark | light                     (data-theme on <html>)
//
// Every skin defines the full canvas key set, so no drawing code
// needs to know which skin is active — it keeps reading TH.*.
// Replaces the old THEMES / applyTheme / toggleTheme / initTheme
// block in 03_core.js. The old function names still exist and
// still behave, so existing call sites keep working.
// ═══════════════════════════════════════════════════════════
const SKINS = {

  // ── CLASSIC — the original teal/cyan instrument look ──
  classic: {
    label: 'Classic',
    dark: {
      chartBg:'#141418', gridLine:'#1c1c26', axisLabel:'#44445a', axisTitle:'#33334a',
      refLine:'rgba(255,255,255,0.10)', refText:'rgba(255,255,255,0.20)',
      unityLine:'rgba(255,255,255,0.08)', unityText:'rgba(255,255,255,0.18)',
      bandMarker:'rgba(0,229,255,0.18)',
      scopeBg:'#0a0a0e', scopeGrid:'#1a1a26', scopeZero:'#252535', scopeText:'#333348',
      bass:'#00e5ff', bassGhost:'rgba(0,229,255,0.28)',
      guitar:'#ff4d4d', kick:'#ffaa00', snare:'#c084fc', hh:'#86efac',
      fftFill0:'rgba(0,229,255,0.28)', fftFill1:'rgba(0,200,180,0.10)', fftLine:'rgba(0,229,255,0.85)',
      fftGlow:'#00e5ff', crosshair:'rgba(0,200,180,0.45)'
    },
    light: {
      chartBg:'#f7f8fb', gridLine:'#dde0ea', axisLabel:'#9498ad', axisTitle:'#aab0c2',
      refLine:'rgba(20,24,40,0.14)', refText:'rgba(20,24,40,0.40)',
      unityLine:'rgba(20,24,40,0.10)', unityText:'rgba(20,24,40,0.32)',
      bandMarker:'rgba(0,140,160,0.30)',
      scopeBg:'#eef0f6', scopeGrid:'#dde0ea', scopeZero:'#c2c6d4', scopeText:'#9498ad',
      bass:'#0096c8', bassGhost:'rgba(0,120,170,0.35)',
      guitar:'#d62b2b', kick:'#c97a00', snare:'#8a3fce', hh:'#2f9e57',
      fftFill0:'rgba(0,150,200,0.26)', fftFill1:'rgba(0,154,138,0.10)', fftLine:'rgba(0,120,170,0.85)',
      fftGlow:'#0096c8', crosshair:'rgba(0,154,138,0.55)'
    }
  },

  // ── ARIA — glossy black, gold and oxblood. Powerful, classy. ──
  aria: {
    label: 'Aria',
    dark: {
      chartBg:'#08080a', gridLine:'#1f1c15', axisLabel:'#6d6559', axisTitle:'#57503f',
      refLine:'rgba(239,233,220,0.10)', refText:'rgba(239,233,220,0.22)',
      unityLine:'rgba(239,233,220,0.08)', unityText:'rgba(239,233,220,0.20)',
      bandMarker:'rgba(224,56,74,0.30)',
      scopeBg:'#060607', scopeGrid:'#1c1913', scopeZero:'#2e2a20', scopeText:'#6d6559',
      bass:'#e8c96a', bassGhost:'rgba(232,201,106,0.28)',
      guitar:'#e0384a', kick:'#d98324', snare:'#cfc4ae', hh:'#8f9668',
      fftFill0:'rgba(201,162,39,0.46)', fftFill1:'rgba(201,162,39,0.03)', fftLine:'#e8c96a',
      fftGlow:'rgba(232,201,106,0.55)', crosshair:'rgba(224,56,74,0.50)'
    },
    light: {
      chartBg:'#fbf9f4', gridLine:'#e4dcc8', axisLabel:'#9b9382', axisTitle:'#ada48f',
      refLine:'rgba(26,23,19,0.14)', refText:'rgba(26,23,19,0.42)',
      unityLine:'rgba(26,23,19,0.10)', unityText:'rgba(26,23,19,0.34)',
      bandMarker:'rgba(168,18,31,0.28)',
      scopeBg:'#f4f0e6', scopeGrid:'#e4dcc8', scopeZero:'#c9bfa6', scopeText:'#9b9382',
      bass:'#8f6f0e', bassGhost:'rgba(143,111,14,0.32)',
      guitar:'#a8121f', kick:'#a86a12', snare:'#6b5f45', hh:'#4f6b3a',
      fftFill0:'rgba(143,111,14,0.30)', fftFill1:'rgba(143,111,14,0.02)', fftLine:'#8f6f0e',
      fftGlow:'rgba(143,111,14,0)', crosshair:'rgba(168,18,31,0.50)'
    }
  },

  // ── MINIMAL — pure contrast, one red. Value does the encoding. ──
  minimal: {
    label: 'Minimal',
    dark: {
      chartBg:'#000000', gridLine:'#232323', axisLabel:'#8c8c8c', axisTitle:'#6b6b6b',
      refLine:'rgba(255,255,255,0.16)', refText:'rgba(255,255,255,0.34)',
      unityLine:'rgba(255,255,255,0.12)', unityText:'rgba(255,255,255,0.30)',
      bandMarker:'rgba(255,47,0,0.45)',
      scopeBg:'#000000', scopeGrid:'#1c1c1c', scopeZero:'#333333', scopeText:'#8c8c8c',
      bass:'#ffffff', bassGhost:'rgba(255,255,255,0.30)',
      guitar:'#ff2f00', kick:'#b8b8b8', snare:'#7a7a7a', hh:'#4d4d4d',
      fftFill0:'rgba(255,255,255,0.18)', fftFill1:'rgba(255,255,255,0.01)', fftLine:'#ffffff',
      fftGlow:'rgba(0,0,0,0)', crosshair:'#ff2f00'
    },
    light: {
      chartBg:'#ffffff', gridLine:'#e6e6e6', axisLabel:'#767676', axisTitle:'#949494',
      refLine:'rgba(0,0,0,0.16)', refText:'rgba(0,0,0,0.40)',
      unityLine:'rgba(0,0,0,0.12)', unityText:'rgba(0,0,0,0.34)',
      bandMarker:'rgba(255,47,0,0.45)',
      scopeBg:'#ffffff', scopeGrid:'#ececec', scopeZero:'#c9c9c9', scopeText:'#767676',
      bass:'#000000', bassGhost:'rgba(0,0,0,0.26)',
      guitar:'#ff2f00', kick:'#565656', snare:'#8c8c8c', hh:'#b5b5b5',
      fftFill0:'rgba(0,0,0,0.14)', fftFill1:'rgba(0,0,0,0.01)', fftLine:'#000000',
      fftGlow:'rgba(0,0,0,0)', crosshair:'#ff2f00'
    }
  },

  // ── LAB — CRT phosphor in the dark, paper chart recorder in the light. ──
  lab: {
    label: 'Lab',
    dark: {
      chartBg:'#06110a', gridLine:'#183826', axisLabel:'#4e7a5c', axisTitle:'#3d6349',
      refLine:'rgba(214,228,198,0.12)', refText:'rgba(214,228,198,0.26)',
      unityLine:'rgba(214,228,198,0.09)', unityText:'rgba(214,228,198,0.22)',
      bandMarker:'rgba(255,179,71,0.35)',
      scopeBg:'#050e08', scopeGrid:'#14301f', scopeZero:'#26543a', scopeText:'#4e7a5c',
      bass:'#59ff8f', bassGhost:'rgba(89,255,143,0.26)',
      guitar:'#ffb347', kick:'#ffd166', snare:'#7ad7ff', hh:'#c3f7c8',
      fftFill0:'rgba(89,255,143,0.30)', fftFill1:'rgba(89,255,143,0.02)', fftLine:'#59ff8f',
      fftGlow:'rgba(89,255,143,0.60)', crosshair:'rgba(255,179,71,0.55)'
    },
    light: {
      chartBg:'#f6f1e2', gridLine:'#e0c3ae', axisLabel:'#9a8b74', axisTitle:'#ab9c85',
      refLine:'rgba(42,38,32,0.16)', refText:'rgba(42,38,32,0.42)',
      unityLine:'rgba(42,38,32,0.11)', unityText:'rgba(42,38,32,0.34)',
      bandMarker:'rgba(176,58,46,0.35)',
      scopeBg:'#f1ead8', scopeGrid:'#e0c3ae', scopeZero:'#c2ab92', scopeText:'#9a8b74',
      bass:'#1b2a4a', bassGhost:'rgba(27,42,74,0.28)',
      guitar:'#b03a2e', kick:'#8a6b1f', snare:'#2e6b57', hh:'#7a6a55',
      fftFill0:'rgba(27,42,74,0.20)', fftFill1:'rgba(27,42,74,0.01)', fftLine:'#1b2a4a',
      fftGlow:'rgba(0,0,0,0)', crosshair:'rgba(176,58,46,0.55)'
    }
  }
};

const SKIN_ORDER = ['classic', 'aria', 'minimal', 'lab'];

let TH = SKINS.classic.dark;
const THEME_KEY = 'b7k_theme';
const SKIN_KEY  = 'b7k_skin';
let bootDone = false;

let curSkin = 'classic', curMode = 'dark';

// The single place both axes land. Everything else delegates here.
function applyLook(skin, mode, persist) {
  curSkin = SKINS[skin] ? skin : 'classic';
  curMode = mode === 'light' ? 'light' : 'dark';
  TH = SKINS[curSkin][curMode];

  const root = document.documentElement;
  root.setAttribute('data-skin', curSkin);
  root.setAttribute('data-theme', curMode);

  const tBtn = document.getElementById('themeToggle');
  if (tBtn) tBtn.textContent = curMode === 'light' ? '☀️' : '🌙';
  const sBtn = document.getElementById('skinToggle');
  if (sBtn) {
    sBtn.textContent = SKINS[curSkin].label;
    sBtn.setAttribute('title', 'Skin: ' + SKINS[curSkin].label + ' — tap to change');
  }

  if (persist) {
    try {
      localStorage.setItem(SKIN_KEY, curSkin);
      localStorage.setItem(THEME_KEY, curMode);
    } catch (e) {}
  }
  if (bootDone) {
    redrawStatic();
    if (document.getElementById('refModal').classList.contains('open')) drawRefChart();
    if (!audioRunning) stopScope();
  }
}

// Back-compatible names — same signatures as before.
function applyTheme(mode, persist) { applyLook(curSkin, mode, persist); }
function toggleTheme() { applyLook(curSkin, curMode === 'light' ? 'dark' : 'light', true); }

function setSkin(name) { applyLook(name, curMode, true); }
function cycleSkin() {
  const i = SKIN_ORDER.indexOf(curSkin);
  applyLook(SKIN_ORDER[(i + 1) % SKIN_ORDER.length], curMode, true);
}

function initTheme() {
  let savedMode = null, savedSkin = null;
  try {
    savedMode = localStorage.getItem(THEME_KEY);
    savedSkin = localStorage.getItem(SKIN_KEY);
  } catch (e) {}

  const skin = SKINS[savedSkin] ? savedSkin : 'classic';

  if (savedMode === 'light' || savedMode === 'dark') {
    applyLook(skin, savedMode, false);
    return;
  }
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  applyLook(skin, prefersLight ? 'light' : 'dark', false);

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', e => {
      let override = null;
      try { override = localStorage.getItem(THEME_KEY); } catch (err) {}
      if (!override) applyLook(curSkin, e.matches ? 'light' : 'dark', false);
    });
  }
}
