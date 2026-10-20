import './style.css';

import { AudioEngine } from './audio';
import { SourceManager } from './source';
import { Scanner } from './scanner';
import { Threader } from './thread';
import { Renderer, SPEC_BANDS } from './renderer';
import { Recorder, download, stamp } from './exporter';
import { demoImage, demoTrack } from './demo';
import {
  DEFAULTS, DUOS, GAIN_SLIDER, LOOP_SLIDER, MAP_PRESETS, MAP_SLIDERS, SCAN_PRESETS, SCAN_SLIDERS,
  hexToRgb, loadParams, outputSize, saveParams,
  type Params, type NumKey,
} from './state';
import { $, cssVar, fit2d, fmtTime, seg, slider, toast, type Slider } from './ui';

// ───────── Core objects ─────────

const params: Params = loadParams();

let renderer: Renderer;
try {
  renderer = new Renderer($<HTMLCanvasElement>('gl'));
} catch (err) {
  const f = $('fatal');
  f.hidden = false;
  f.textContent = 'Visual Scan needs WebGL2. Try a recent Chrome, Edge, Firefox or Safari.';
  throw err;
}
const audio = new AudioEngine();
const source = new SourceManager();
const scanner = new Scanner();
const threader = new Threader();
const recorder = new Recorder();

const AXIS = { horizontal: 0, vertical: 1, radial: 2 } as const;
const COLOUR = { source: 0, mono: 1, duo: 2 } as const;

let uploadedVersion = -1;
let hasPlayed = false;
let completeShown = false;

const passMode = () => params.fill === 'pass' && audio.mode === 'file' && audio.duration > 0;
const hasSource = () => source.kind !== 'none';

// ───────── Theme ─────────

const THEME_KEY = 'visual-scan:theme';
let theme = { bg: hexToRgb('#f3f3f0'), grid: hexToRgb('#d6d6d0'), accent: '#ff4a1c', ink: '#0d0d0d', rule: '#d6d6d0', mid: '#85857f' };

function readTheme() {
  theme = {
    bg: hexToRgb(cssVar('--paper') || '#f3f3f0'),
    grid: hexToRgb(cssVar('--rule') || '#d6d6d0'),
    accent: cssVar('--accent') || '#ff4a1c',
    ink: cssVar('--ink') || '#0d0d0d',
    rule: cssVar('--rule') || '#d6d6d0',
    mid: cssVar('--mid') || '#85857f',
  };
  const dark = isDark();
  $('b-theme').textContent = dark ? 'Light' : 'Dark';
}

function isDark(): boolean {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

try {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light') document.documentElement.dataset.theme = saved;
} catch {
  /* storage unavailable */
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readTheme);
$('b-theme').addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage unavailable */
  }
  readTheme();
});
readTheme();

// ───────── Output sizing ─────────

function configureOutput() {
  const [w, h] = outputSize(params, source.width, source.height);
  const sweep = params.axis === 'horizontal' ? w : params.axis === 'vertical' ? h : 4096;
  const before = renderer.width * renderer.height;
  renderer.resize(w, h, sweep);
  scanner.setSweepRes(renderer.sweepRes);
  if (before && before !== renderer.width * renderer.height && hasSource()) toast('New format. Canvas cleared.');
  layoutFrame();
  const label = `${renderer.width} × ${renderer.height}`;
  $('m-res').textContent = label;
  $('out-size').textContent = label;
}

function layoutFrame() {
  const stage = $('stage');
  const frame = $('frame');
  const perform = document.body.classList.contains('perform');
  const pad = perform ? 0 : Math.round(Math.max(16, Math.min(40, stage.clientWidth * 0.03)));
  const a = renderer.width / renderer.height || 16 / 9;
  // On narrow screens the stage hugs the canvas instead of filling a fixed height
  const narrow = !perform && window.innerWidth <= 900;
  const wantH = narrow ? Math.round(Math.min(window.innerHeight * 0.7, (stage.clientWidth - pad * 2) / a + pad * 2)) + 'px' : '';
  if (stage.style.height !== wantH) stage.style.height = wantH;
  const sw = Math.max(10, stage.clientWidth - pad * 2);
  const sh = Math.max(10, stage.clientHeight - pad * 2);
  let w = sw;
  let h = sw / a;
  if (h > sh) {
    h = sh;
    w = sh * a;
  }
  frame.style.width = Math.floor(w) + 'px';
  frame.style.height = Math.floor(h) + 'px';
}
new ResizeObserver(layoutFrame).observe($('stage'));

// ───────── Parameters → UI ─────────

const sliders = new Map<NumKey, Slider>();
const presetsFor = () => (params.engine === 'map' ? MAP_PRESETS : SCAN_PRESETS);
const slidersFor = () => (params.engine === 'map' ? MAP_SLIDERS : SCAN_SLIDERS);

function setParam<K extends keyof Params>(k: K, v: Params[K], fromPreset = false) {
  params[k] = v;
  saveParams(params);
  if (!fromPreset && presetsFor().some((p) => k in p.values)) {
    presetHost.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
  }
  if (k === 'axis' || k === 'format' || k === 'size') configureOutput();
  if (k === 'axis') {
    $('preview').classList.toggle('vertical', v === 'vertical');
    refreshCursor();
  }
  if (k === 'fill' || k === 'loopSeconds') refreshFill();
  if (k === 'colour') refreshColour();
}

const mapHost = $('sliders-map');
const scanHost = $('sliders-scan');
for (const def of [...MAP_SLIDERS, ...SCAN_SLIDERS]) {
  const host = MAP_SLIDERS.includes(def) ? mapHost : scanHost;
  if (def.group) {
    const h = document.createElement('div');
    h.className = 'group';
    h.textContent = def.group;
    host.append(h);
  }
  const s = slider(def, params[def.key], (v) => setParam(def.key, v));
  sliders.set(def.key, s);
  host.append(s.el);
}
const loopSlider = slider(LOOP_SLIDER, params.loopSeconds, (v) => setParam('loopSeconds', v));
sliders.set('loopSeconds', loopSlider);
$('loop-row').append(loopSlider.el);
const gainSlider = slider(GAIN_SLIDER, params.gain, (v) => setParam('gain', v));
sliders.set('gain', gainSlider);
$('gain-row').append(gainSlider.el);

const axisSeg = seg($('seg-axis'), params.axis, (v) => {
  setParam('axis', v as Params['axis']);
  axisSeg.set(v);
});
$('preview').classList.toggle('vertical', params.axis === 'vertical');

const invertSeg = seg($('seg-invert'), params.invert ? '1' : '0', (v) => {
  setParam('invert', v === '1');
  invertSeg.set(v);
});

// Presets (per engine)
const presetHost = $('seg-preset');
function buildPresets() {
  presetHost.innerHTML = '';
  presetsFor().forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.v = String(i);
    b.textContent = p.name;
    b.title = `Preset ${i + 1}`;
    b.addEventListener('click', () => applyPreset(i));
    presetHost.append(b);
  });
}

function applyPreset(i: number) {
  const p = presetsFor()[i];
  if (!p) return;
  for (const [k, v] of Object.entries(p.values) as [keyof Params, never][]) {
    setParam(k, v, true);
    sliders.get(k as NumKey)?.set(v as number);
  }
  axisSeg.set(params.axis);
  presetHost.querySelectorAll('button').forEach((b, j) => b.classList.toggle('on', j === i));
  toast(`Preset: ${p.name}`);
}

// Engine: Map (pitch picks pixels by tone) or Scan (slit-scan)
const ENGINE_NOTE = {
  map: 'Each note picks a pixel of matching tone. High notes take dark pixels, low notes light. Every column is the image along the thread between picks.',
  scan: 'A slit crosses the image. The sound moves it, bends it and stretches it.',
};
const engineSeg = seg($('seg-engine'), params.engine, (v) => setEngine(v as Params['engine']));
function setEngine(e: Params['engine']) {
  setParam('engine', e);
  engineSeg.set(e);
  mapHost.hidden = e !== 'map';
  $('invert-row').hidden = e !== 'map';
  scanHost.hidden = e !== 'scan';
  $('engine-note').textContent = ENGINE_NOTE[e];
  $('src-note').textContent = e === 'map' ? 'Drag on the image to move the thread.' : 'Drag across the image to steer the slit.';
  buildPresets();
}
setEngine(params.engine);

$('b-reset').addEventListener('click', () => {
  for (const def of slidersFor()) {
    setParam(def.key, DEFAULTS[def.key]);
    sliders.get(def.key)?.set(DEFAULTS[def.key]);
  }
  if (params.engine === 'map') {
    setParam('invert', DEFAULTS.invert);
    invertSeg.set(DEFAULTS.invert ? '1' : '0');
  }
  setParam('axis', DEFAULTS.axis);
  axisSeg.set(DEFAULTS.axis);
  toast('Engine settings reset.');
});

// Fill (pass / loop)
const fillSeg = seg($('seg-fill'), params.fill, (v) => setParam('fill', v as Params['fill']));
function refreshFill() {
  const mic = audio.mode === 'mic';
  fillSeg.disable('pass', mic);
  const effective = mic ? 'loop' : params.fill;
  fillSeg.set(effective);
  $('loop-row').hidden = effective !== 'loop';
  audio.el.loop = params.fill === 'loop';
}
refreshFill();

// Output
const formatSeg = seg($('seg-format'), params.format, (v) => {
  setParam('format', v as Params['format']);
  formatSeg.set(v);
});
const sizeSeg = seg($('seg-size'), params.size, (v) => {
  setParam('size', v as Params['size']);
  sizeSeg.set(v);
});
const colourSeg = seg($('seg-colour'), params.colour, (v) => {
  setParam('colour', v as Params['colour']);
  colourSeg.set(v);
});
const swatchHost = $('swatches');
DUOS.forEach(([a, b], i) => {
  const s = document.createElement('button');
  s.type = 'button';
  s.className = 'swatch';
  s.title = `Pair ${i + 1}`;
  s.innerHTML = `<i style="background:${a}"></i><i style="background:${b}"></i>`;
  s.addEventListener('click', () => {
    setParam('duo', i);
    if (params.colour !== 'duo') {
      setParam('colour', 'duo');
      colourSeg.set('duo');
    }
    refreshColour();
  });
  swatchHost.append(s);
});
function refreshColour() {
  swatchHost.querySelectorAll('.swatch').forEach((el, i) => el.classList.toggle('on', i === params.duo && params.colour === 'duo'));
}
refreshColour();

const headToggle = $<HTMLInputElement>('t-head');
const gridToggle = $<HTMLInputElement>('t-grid');
headToggle.checked = params.head;
gridToggle.checked = params.grid;
headToggle.addEventListener('change', () => setParam('head', headToggle.checked));
gridToggle.addEventListener('change', () => setParam('grid', gridToggle.checked));

// ───────── Loading ─────────

const fImage = $<HTMLInputElement>('f-image');
const fVideo = $<HTMLInputElement>('f-video');
const fTrack = $<HTMLInputElement>('f-track');

// Hosted inside claude.ai the page is framed, and the frame blocks camera and mic
const HOSTED = window.self !== window.top;

const sourceSeg = seg($('seg-source'), 'image', (v) => {
  if (v === 'image') fImage.click();
  else if (v === 'video') fVideo.click();
  else startCamera();
});

$('src-drop').addEventListener('click', () => fImage.click());
$('b-src-replace').addEventListener('click', () => (source.kind === 'video' ? fVideo : fImage).click());

fImage.addEventListener('change', () => {
  const f = fImage.files?.[0];
  if (f) loadImage(f);
  fImage.value = '';
});
fVideo.addEventListener('change', () => {
  const f = fVideo.files?.[0];
  if (f) loadVideo(f);
  fVideo.value = '';
});
fTrack.addEventListener('change', () => {
  const f = fTrack.files?.[0];
  if (f) loadTrack(f, f.name);
  fTrack.value = '';
});
$('b-track').addEventListener('click', () => fTrack.click());

async function loadImage(f: File) {
  try {
    await source.loadImage(f, f.name);
    toast('Image loaded.');
  } catch {
    toast('Could not read that image.');
  }
}

async function loadVideo(f: File) {
  try {
    await source.loadVideo(f, f.name);
    toast('Video loaded. Try Time warp.');
  } catch {
    toast('Could not play that video.');
  }
}

async function startCamera() {
  try {
    await source.useCamera();
    toast('Camera on. Try Time warp.');
  } catch {
    toast('Camera unavailable or blocked.');
  }
}

function onSourceChanged() {
  sourceSeg.set(source.kind === 'camera' ? 'camera' : source.kind === 'video' ? 'video' : 'image');
  $('preview').classList.toggle('loaded', hasSource());
  $('src-name').textContent = source.name || 'Nothing loaded';
  $('src-name').title = source.name;
  $('b-src-replace').hidden = !hasSource() || source.kind === 'camera';
  sliders.get('timewarp')?.enable(source.dynamic);
  refreshEmpty();
}

async function loadTrack(file: Blob, name: string) {
  $('b-track-t').textContent = 'Decoding…';
  try {
    await audio.loadFile(file, name);
  } catch {
    toast('Could not decode that audio file.');
    $('b-track-t').textContent = audio.trackName || 'Choose a track';
    return;
  }
  audioSeg.set('track');
  showAudioPanel('track');
  $('b-track-t').textContent = name;
  scanner.reset();
  renderer.clear();
  completeShown = false;
  refreshFill();
  refreshSoundName();
  refreshEmpty();
  toast('Track loaded. Press Space.');
}

function refreshSoundName() {
  const el = $('snd-name');
  if (audio.mode === 'mic') el.textContent = 'Live input';
  else if (audio.mode === 'file') el.textContent = fmtTime(audio.duration).replace(/\.\d$/, '');
  else el.textContent = 'Nothing loaded';
}
audio.el.addEventListener('loadedmetadata', () => {
  refreshSoundName();
  refreshFill();
});

// Sound source
const audioSeg = seg($('seg-audio'), 'track', async (v) => {
  if (v === 'track') {
    audio.useTrack();
    audioSeg.set('track');
    showAudioPanel('track');
    if (!audio.trackName) fTrack.click();
  } else {
    await startInput();
  }
  refreshFill();
  refreshSoundName();
  refreshEmpty();
});

function showAudioPanel(which: 'track' | 'input') {
  $('snd-track').hidden = which !== 'track';
  $('snd-input').hidden = which !== 'input';
}

const selInput = $<HTMLSelectElement>('sel-input');
if (HOSTED) {
  sourceSeg.disable('camera', true);
  audioSeg.disable('input', true);
  const why = 'Camera and live input are blocked on the hosted page. Run the app locally to use them.';
  $('seg-source').querySelector<HTMLElement>('[data-v="camera"]')!.title = why;
  $('seg-audio').querySelector<HTMLElement>('[data-v="input"]')!.title = why;
}
async function startInput(deviceId?: string) {
  try {
    await audio.useMic(deviceId || selInput.value || undefined);
  } catch {
    toast('Microphone unavailable or blocked.');
    return;
  }
  audioSeg.set('input');
  showAudioPanel('input');
  const inputs = await audio.listInputs();
  const current = deviceId || selInput.value;
  selInput.innerHTML = '';
  for (const d of inputs) {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || 'Input ' + (selInput.length + 1);
    selInput.append(o);
  }
  if (current) selInput.value = current;
  toast('Listening. The canvas loops while live.');
  refreshFill();
  refreshSoundName();
  refreshEmpty();
}
selInput.addEventListener('change', () => startInput(selInput.value));

// Demo
$('b-demo').addEventListener('click', loadDemo);
async function loadDemo() {
  const btn = $<HTMLButtonElement>('b-demo');
  btn.disabled = true;
  btn.textContent = 'Rendering…';
  try {
    await audio.resume();
    await document.fonts.load('800 100px "Inter Tight Variable"').catch(() => undefined);
    const img = demoImage();
    source.setStill(img, img.width, img.height, 'Demo image');
    const wav = await demoTrack();
    await loadTrack(wav, 'Demo track · 118 BPM');
    try {
      await audio.toggle();
    } catch {
      toast('Ready. Press Space to start.');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load the demo';
  }
}

// Drag and drop anywhere
const dropzone = $('dropzone');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  dropzone.classList.add('on');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropzone.classList.remove('on');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove('on');
  for (const f of Array.from(e.dataTransfer?.files || [])) {
    const t = f.type;
    const ext = f.name.split('.').pop()?.toLowerCase() || '';
    if (t.startsWith('image/')) loadImage(f);
    else if (t.startsWith('video/') || ['mp4', 'mov', 'webm', 'm4v'].includes(ext)) loadVideo(f);
    else if (t.startsWith('audio/') || ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'aif', 'aiff'].includes(ext)) loadTrack(f, f.name);
    else toast(`Can't use ${f.name}.`);
  }
});

// ───────── Transport ─────────

async function togglePlay() {
  if (audio.mode === 'none') {
    if (!hasSource()) toast('Load an image and a track first, or try the demo.');
    else fTrack.click();
    return;
  }
  try {
    await audio.toggle();
  } catch {
    toast('Playback was blocked. Click play again.');
  }
}
$('b-play').addEventListener('click', togglePlay);

const timeline = $('timeline');
let seeking = false;
const seekTo = (e: PointerEvent) => {
  const r = timeline.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  audio.seek(f * audio.duration);
};
timeline.addEventListener('pointerdown', (e) => {
  if (audio.mode !== 'file') return;
  seeking = true;
  timeline.setPointerCapture(e.pointerId);
  seekTo(e);
});
timeline.addEventListener('pointermove', (e) => seeking && seekTo(e));
timeline.addEventListener('pointerup', () => (seeking = false));
timeline.addEventListener('pointercancel', () => (seeking = false));

// ───────── Export ─────────

function clearCanvas() {
  renderer.clear();
  completeShown = false;
  toast('Canvas cleared.');
}
$('b-clear').addEventListener('click', clearCanvas);

function displayUniforms(grid: boolean) {
  const [a, b] = DUOS[params.duo] || DUOS[0];
  return {
    colour: COLOUR[params.colour],
    duoA: hexToRgb(a),
    duoB: hexToRgb(b),
    bg: theme.bg,
    gridCol: theme.grid,
    grid,
  };
}

function savePng() {
  if (!hasSource()) return toast('Nothing to save yet.');
  // Draw a clean frame (no live edge, no grid) and grab it in the same task
  renderer.display(displayUniforms(false), true);
  renderer.canvas.toBlob(async (blob) => {
    if (!blob) return toast('Could not create the PNG.');
    const r = await download(blob, `visual-scan-${stamp()}.png`);
    toast(r === 'saved' ? `Saved PNG · ${renderer.width} × ${renderer.height}` : r === 'declined' ? 'Save cancelled.' : 'Could not save the PNG.');
  }, 'image/png');
}
$('b-png').addEventListener('click', savePng);

async function toggleRecord() {
  const btn = $('b-rec');
  if (recorder.active) {
    const { blob, ext } = await recorder.stop();
    btn.classList.remove('on');
    $('b-rec-t').textContent = 'Record';
    const r = await download(blob, `visual-scan-${stamp()}.${ext}`);
    toast(r === 'saved' ? `Saved ${ext.toUpperCase()} · ${(blob.size / 1e6).toFixed(1)} MB` : r === 'declined' ? 'Save cancelled.' : 'Could not save the video.');
    return;
  }
  if (!Recorder.supported()) return toast("Recording isn't supported in this browser.");
  if (!hasSource()) return toast('Load a source first.');
  await audio.resume();
  try {
    recorder.start(renderer.canvas, audio.recordDest.stream);
  } catch {
    return toast('Could not start recording.');
  }
  btn.classList.add('on');
  toast('Recording. Press R to stop.');
}
$('b-rec').addEventListener('click', toggleRecord);

// ───────── Perform mode ─────────

let idleTimer = 0;
function togglePerform(on = !document.body.classList.contains('perform')) {
  document.body.classList.toggle('perform', on);
  if (on) {
    document.documentElement.requestFullscreen?.().catch(() => undefined);
    toast('Perform mode. F or Esc to exit.');
  } else if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => undefined);
  }
  requestAnimationFrame(layoutFrame);
}
$('b-perform').addEventListener('click', () => togglePerform());
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('perform')) togglePerform(false);
});
window.addEventListener('pointermove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => document.body.classList.add('idle'), 2000);
});

// ───────── Keyboard ─────────

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t instanceof HTMLSelectElement) return;
  if (t instanceof HTMLInputElement && !['range', 'checkbox'].includes(t.type)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ') {
    e.preventDefault();
    togglePlay();
  } else if (k === 'c') clearCanvas();
  else if (k === 's') savePng();
  else if (k === 'r') toggleRecord();
  else if (k === 'f') togglePerform();
  else if (k === 'escape' && document.body.classList.contains('perform')) togglePerform(false);
  else if (['1', '2', '3', '4'].includes(k)) applyPreset(Number(k) - 1);
  else if (k === 'e') setEngine(params.engine === 'map' ? 'scan' : 'map');
  else if (k === 'h') {
    setParam('head', !params.head);
    headToggle.checked = params.head;
  }
});

// Mouse clicks shouldn't leave buttons focused (Space would re-trigger them)
document.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (b && e.detail > 0) b.blur();
});

// ───────── Steering from the preview ─────────
// Map: drag to move the thread. Scan: drag to steer the slit.

const pc = $<HTMLCanvasElement>('src-canvas');
let previewRect = { ox: 0, oy: 0, w: 1, h: 1 };
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const steerFrom = (e: PointerEvent) => {
  const r = pc.getBoundingClientRect();
  const fx = (e.clientX - r.left - previewRect.ox) / previewRect.w;
  const fy = (e.clientY - r.top - previewRect.oy) / previewRect.h;
  if (params.engine === 'map') threader.steer([clamp01(source.flipX ? 1 - fx : fx), clamp01(1 - fy)]);
  else scanner.steer(params.axis === 'vertical' ? fy : fx);
};
pc.addEventListener('pointerdown', (e) => {
  if (!hasSource()) return;
  pc.setPointerCapture(e.pointerId);
  steerFrom(e);
});
pc.addEventListener('pointermove', (e) => {
  if (pc.hasPointerCapture(e.pointerId)) steerFrom(e);
});
const release = () => {
  scanner.steer(null);
  threader.steer(null);
};
pc.addEventListener('pointerup', release);
pc.addEventListener('pointercancel', release);

// ───────── Dragging on the canvas ─────────
// Pass mode: the canvas is the timeline, so dragging seeks.
// Loop mode: dragging moves the write-head and paints as it goes.

const frameEl = $('frame');
let scrubbing = false;
const sweepFromPointer = (e: PointerEvent): number => {
  const r = frameEl.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  if (params.axis === 'horizontal') return Math.max(0, Math.min(1, x));
  if (params.axis === 'vertical') return Math.max(0, Math.min(1, y));
  const a = Math.atan2((x - 0.5) * r.width, -(y - 0.5) * r.height);
  return (((a / (Math.PI * 2)) % 1) + 1) % 1;
};
const scrub = (e: PointerEvent) => {
  const s = sweepFromPointer(e);
  if (passMode()) audio.seek(Math.min(0.999, s) * audio.duration);
  else scanner.scratch(s);
};
frameEl.addEventListener('pointerdown', (e) => {
  if (!hasSource() || !$('empty').classList.contains('hidden')) return;
  scrubbing = true;
  frameEl.setPointerCapture(e.pointerId);
  scrub(e);
});
frameEl.addEventListener('pointermove', (e) => scrubbing && scrub(e));
const endScrub = () => {
  scrubbing = false;
  scanner.scratch(null);
};
frameEl.addEventListener('pointerup', endScrub);
frameEl.addEventListener('pointercancel', endScrub);

function refreshCursor() {
  const ready = hasSource() && $('empty').classList.contains('hidden');
  frameEl.style.cursor = !ready ? '' : params.axis === 'horizontal' ? 'ew-resize' : params.axis === 'vertical' ? 'ns-resize' : 'grab';
}

// ───────── Drawing helpers (2D UI canvases) ─────────

const specLive = new Float32Array(SPEC_BANDS);
const specRecord = new Float32Array(SPEC_BANDS);
let specMean = 0;
const mirror = (x: number) => 1 - Math.abs(1 - (((x % 2) + 2) % 2));

// Gaussian blur across bands so rows bend in smooth waves, not per-harmonic spikes
const BLUR = (() => {
  const r = 7;
  const sigma = 3.2;
  const k: number[] = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    sum += v;
  }
  return k.map((v) => v / sum);
})();

function blurBands(src: Float32Array, dst: Float32Array) {
  const n = src.length;
  const r = (BLUR.length - 1) / 2;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -r; j <= r; j++) acc += src[Math.min(n - 1, Math.max(0, i + j))] * BLUR[j + r];
    dst[i] = acc;
  }
}

function drawOverlay() {
  const c = $<HTMLCanvasElement>('overlay');
  const g = fit2d(c);
  const W = c.clientWidth;
  const H = c.clientHeight;
  g.clearRect(0, 0, W, H);
  if (!params.head || !hasSource()) return;
  const h = scanner.head;
  g.strokeStyle = theme.accent;
  g.fillStyle = theme.accent;
  g.lineWidth = 1;
  g.beginPath();
  let tx = 0;
  let ty = 0;
  if (params.axis === 'horizontal') {
    const x = Math.round(h * W) + 0.5;
    g.moveTo(x, 0);
    g.lineTo(x, H);
    tx = x;
    ty = 0;
  } else if (params.axis === 'vertical') {
    const y = Math.round(h * H) + 0.5;
    g.moveTo(0, y);
    g.lineTo(W, y);
    tx = 0;
    ty = y;
  } else {
    const a = h * Math.PI * 2;
    const r = Math.hypot(W, H) / 2;
    g.moveTo(W / 2, H / 2);
    g.lineTo(W / 2 + Math.sin(a) * r, H / 2 - Math.cos(a) * r);
    g.arc(W / 2, H / 2, 2.5, 0, Math.PI * 2);
    tx = W / 2;
    ty = H / 2;
  }
  g.stroke();
  // Time tag on the head
  const label = passMode() ? fmtTime(audio.currentTime) : `${String(Math.floor(h * 100)).padStart(2, '0')}%`;
  g.font = '600 10px "Inter Tight Variable", Helvetica, Arial, sans-serif';
  const tw = g.measureText(label).width + 10;
  let lx = tx;
  let ly = ty;
  if (params.axis === 'horizontal') lx = Math.min(W - tw, tx);
  if (params.axis === 'vertical') ly = Math.min(H - 16, ty);
  g.fillRect(lx, ly, tw, 16);
  g.fillStyle = '#fff';
  g.fillText(label, lx + 5, ly + 11.5);
}

function drawPreview() {
  const g = fit2d(pc);
  const W = pc.clientWidth;
  const H = pc.clientHeight;
  g.clearRect(0, 0, W, H);
  if (!hasSource()) return;
  const a = source.width / source.height || 1;
  let w = W;
  let h = W / a;
  if (h > H) {
    h = H;
    w = H * a;
  }
  const ox = (W - w) / 2;
  const oy = (H - h) / 2;
  previewRect = { ox, oy, w, h };
  const img = source.kind === 'image' ? source.still : source.video;
  if (img) {
    g.save();
    if (source.flipX) {
      g.translate(ox * 2 + w, 0);
      g.scale(-1, 1);
    }
    g.drawImage(img, ox, oy, w, h);
    g.restore();
  }
  if (params.engine === 'map') {
    drawWalk(g, ox, oy, w, h);
    return;
  }
  // The slit, bent by the same displacement the shader uses
  g.strokeStyle = theme.accent;
  g.lineWidth = scanner.manualActive ? 2.5 : 1.5;
  g.beginPath();
  const steps = 64;
  for (let k = 0; k <= steps; k++) {
    const c = k / steps;
    let cb = c;
    if (params.slices >= 1) cb = (Math.floor(c * params.slices) + 0.5) / params.slices;
    const spec = specLive[Math.min(SPEC_BANDS - 1, Math.floor(cb * SPEC_BANDS))];
    const ss = mirror(scanner.sx + params.displace * (spec - specMean) * 0.45);
    const x = params.axis === 'vertical' ? ox + c * w : ox + ss * w;
    const y = params.axis === 'vertical' ? oy + ss * h : oy + (1 - c) * h;
    if (k === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
}

/** Map engine: the sound's walk through the image, and the current thread. */
function drawWalk(g: CanvasRenderingContext2D, ox: number, oy: number, w: number, h: number) {
  const toX = (u: number) => ox + (source.flipX ? 1 - u : u) * w;
  const toY = (v: number) => oy + (1 - v) * h;
  // Wash the image back so the walk reads
  g.fillStyle = cssVar('--paper');
  g.globalAlpha = 0.5;
  g.fillRect(ox, oy, w, h);
  g.globalAlpha = 1;

  const T = threader.trail;
  const n = threader.trailCount;
  g.strokeStyle = theme.ink;
  g.lineWidth = 0.75;
  for (let k = 1; k < n; k++) {
    const i1 = (threader.trailHead - (n - 1 - k) + T.length) % (T.length / 2);
    const i0 = (i1 - 1 + T.length / 2) % (T.length / 2);
    g.globalAlpha = (k / n) * 0.7;
    g.beginPath();
    g.moveTo(toX(T[i0 * 2]), toY(T[i0 * 2 + 1]));
    g.lineTo(toX(T[i1 * 2]), toY(T[i1 * 2 + 1]));
    g.stroke();
  }
  g.globalAlpha = 1;

  // The line the newest column is sampling (same curve as the shader)
  if (threader.hasDrawn) {
    const D = threader.drawn;
    const a = [D[0], D[1]];
    const m = [D[2], D[3]];
    const b = [D[4], D[5]];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const c = [mid[0] + (2 * m[0] - mid[0] - mid[0]) * params.bend, mid[1] + (2 * m[1] - mid[1] - mid[1]) * params.bend];
    g.strokeStyle = theme.accent;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(toX(a[0]), toY(a[1]));
    g.quadraticCurveTo(toX(c[0]), toY(c[1]), toX(b[0]), toY(b[1]));
    g.stroke();
    g.fillStyle = theme.accent;
    g.fillRect(toX(a[0]) - 2, toY(a[1]) - 2, 4, 4);
  }
  const [u, v] = threader.pos;
  g.fillStyle = theme.accent;
  g.fillRect(toX(u) - 3, toY(v) - 3, 6, 6);
}

function drawMeter() {
  const c = $<HTMLCanvasElement>('meter');
  const g = fit2d(c);
  const W = c.clientWidth;
  const H = c.clientHeight;
  g.clearRect(0, 0, W, H);
  const F = audio.features;
  const bars = 48;
  const gap = 2;
  const bw = (W - gap * (bars - 1)) / bars;
  for (let i = 0; i < bars; i++) {
    const a = Math.floor((i / bars) * F.bands.length);
    const z = Math.floor(((i + 1) / bars) * F.bands.length);
    let v = 0;
    for (let j = a; j < z; j++) v = Math.max(v, F.bands[j]);
    const bh = Math.max(1, v * H);
    g.fillStyle = theme.rule;
    g.fillRect(i * (bw + gap), 0, bw, H);
    g.fillStyle = theme.ink;
    g.fillRect(i * (bw + gap), H - bh, bw, bh);
  }
  const pct = (x: number) => String(Math.round(x * 99)).padStart(2, '0');
  $('v-low').textContent = pct(F.low);
  $('v-mid').textContent = pct(F.mid);
  $('v-high').textContent = pct(F.high);
  $('v-hit').classList.toggle('on', F.pulse > 0.3);
  $('v-note').textContent = F.note;
  $('v-hz').textContent = F.pitchHz ? String(Math.round(F.pitchHz)) : '0';
  $('v-tone').style.left = threader.toneFor(F, params) * 100 + '%';
}

const levelHist = new Float32Array(200);
let levelIdx = 0;

function drawTimeline() {
  const c = $<HTMLCanvasElement>('tl-canvas');
  const g = fit2d(c);
  const W = c.clientWidth;
  const H = c.clientHeight;
  g.clearRect(0, 0, W, H);
  const mid = H / 2;
  if (audio.mode === 'file' && audio.overview) {
    const ov = audio.overview;
    const prog = audio.duration ? audio.currentTime / audio.duration : 0;
    const n = Math.min(ov.length, Math.floor(W / 3));
    const bw = W / n;
    for (let i = 0; i < n; i++) {
      const v = ov[Math.floor((i / n) * ov.length)];
      const bh = Math.max(1, v * (H - 8));
      g.fillStyle = (i + 0.5) / n <= prog ? theme.ink : theme.rule;
      g.fillRect(i * bw, mid - bh / 2, Math.max(1, bw - 1), bh);
    }
    g.fillStyle = theme.accent;
    g.fillRect(Math.round(prog * W), 0, 2, H);
  } else if (audio.mode === 'mic') {
    levelHist[levelIdx] = audio.features.level;
    levelIdx = (levelIdx + 1) % levelHist.length;
    const n = levelHist.length;
    const bw = W / n;
    g.fillStyle = theme.ink;
    for (let i = 0; i < n; i++) {
      const v = levelHist[(levelIdx + i) % n];
      const bh = Math.max(1, v * (H - 8));
      g.fillRect(i * bw, mid - bh / 2, Math.max(1, bw - 1), bh);
    }
    g.fillStyle = theme.accent;
    g.fillRect(W - 2, 0, 2, H);
  } else {
    g.fillStyle = theme.rule;
    g.fillRect(0, mid, W, 1);
  }
}

function updateTransport() {
  const playing = audio.playing;
  $('b-play').classList.toggle('playing', playing);
  $('b-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if (audio.mode === 'mic') {
    $('t-cur').textContent = fmtTime((performance.now() - audio.inputStartedAt) / 1000);
    $('t-dur').textContent = audio.hold ? 'Held' : 'Live';
  } else {
    $('t-cur').textContent = fmtTime(audio.currentTime);
    $('t-dur').textContent = fmtTime(audio.duration);
  }
  if (recorder.active) {
    $('b-rec-t').textContent = fmtTime((performance.now() - recorder.startedAt) / 1000).replace(/\.\d$/, '');
  }
}

function refreshEmpty() {
  $('step-src').classList.toggle('done', hasSource());
  $('step-snd').classList.toggle('done', audio.mode !== 'none');
  $('step-go').classList.toggle('done', hasPlayed);
  $('empty').classList.toggle('hidden', hasPlayed && hasSource());
  refreshCursor();
}

// ───────── Frame loop ─────────

let last = performance.now();
let toneAge = 0;
let fpsT = 0;
let fpsN = 0;

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, Math.max(0.0005, (now - last) / 1000));
  last = now;
  fpsT += dt;
  fpsN++;
  if (fpsT > 0.5) {
    $('m-fps').textContent = `${Math.round(fpsN / fpsT)} fps`;
    fpsT = 0;
    fpsN = 0;
  }

  audio.gainDb = params.gain;
  audio.update(dt);

  // Source upload
  if (hasSource()) {
    if (source.version !== uploadedVersion) {
      uploadedVersion = source.version;
      if (source.kind === 'image' && source.still) renderer.setStill(source.still, source.width, source.height);
      else renderer.setFrame(source.video, source.width, source.height, true);
      configureOutput();
      onSourceChanged();
      // Stills get a detailed tone map once; video/camera refresh it as frames change
      if (source.kind === 'image' && source.still) threader.tone.build(source.still, source.width, source.height, 640);
      toneAge = 1;
    } else if (source.dynamic) {
      if (source.syncSize() && params.format === 'source') configureOutput();
      if (source.takeNewFrame()) renderer.setFrame(source.video, source.width, source.height, true);
    }
    toneAge += dt;
    if (source.dynamic && params.engine === 'map' && toneAge > 0.08 && source.video.readyState >= 2) {
      threader.tone.build(source.video, source.width, source.height, 256);
      toneAge = 0;
    }
  }

  const pm = passMode();
  scanner.update({ dt, params, audio, passMode: pm });
  const map = params.engine === 'map';
  if (map && hasSource()) {
    threader.setSweepRes(renderer.sweepRes);
    threader.fill(scanner.swept, audio.features, params, renderer.srcW, renderer.srcH);
    renderer.uploadThread(threader.data, threader.dirtyLo, threader.dirtyHi);
    threader.clearDirty();
  }

  // Spectrum: fast for the live edge, smoothed (to head speed) for the record
  blurBands(audio.features.bands, specLive);
  const k = 1 - Math.exp(-dt / scanner.recordTau);
  let sum = 0;
  for (let i = 0; i < SPEC_BANDS; i++) {
    specRecord[i] += (specLive[i] - specRecord[i]) * k;
    sum += specRecord[i];
  }
  specMean = sum / SPEC_BANDS;

  if (hasSource()) {
    renderer.uploadSlit(scanner.slit);
    renderer.uploadSpectrum(specRecord, specLive);
    renderer.step({
      engine: map ? 1 : 0,
      bend: params.bend,
      axis: AXIS[params.axis],
      wrap: !pm,
      head: scanner.head,
      from: scanner.from,
      to: scanner.to,
      wet: params.wet * 0.16,
      displace: params.displace,
      slices: params.slices,
      specMean,
      timeWarp: source.dynamic ? params.timewarp : 0,
      flipX: source.flipX,
    });
  }
  renderer.display(displayUniforms(params.grid));

  if (audio.playing && !hasPlayed && hasSource()) {
    hasPlayed = true;
    refreshEmpty();
  }

  // Completion of a pass
  if (pm && scanner.complete && !completeShown) {
    completeShown = true;
    toast('Complete. S saves the PNG, C clears for a new pass.', 6000);
    if (recorder.active) setTimeout(() => recorder.active && toggleRecord(), 1500);
  } else if (!scanner.complete && scanner.head < 0.99) {
    completeShown = false;
  }

  drawOverlay();
  drawPreview();
  drawMeter();
  drawTimeline();
  updateTransport();
}

configureOutput();
onSourceChanged();
refreshEmpty();
requestAnimationFrame(frame);

// First interaction unlocks audio
window.addEventListener('pointerdown', () => audio.resume(), { once: true });
window.addEventListener('keydown', () => audio.resume(), { once: true });
