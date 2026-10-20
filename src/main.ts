import './style.css';

import { AudioEngine } from './audio';
import { SourceManager } from './source';
import { Scanner } from './scanner';
import { Threader } from './thread';
import { Painter, type HitMark } from './paint';
import { ToneMap } from './tonemap';
import type { Walker } from './walker';
import { Renderer, SPEC_BANDS } from './renderer';
import { Recorder, download, stamp } from './exporter';
import { demoImage, demoTrack } from './demo';
import {
  DEFAULTS, DUOS, GAIN_SLIDER, LOOP_SLIDER, PAINT_PRESETS, THREAD_PRESETS, SCAN_PRESETS, SCAN_SLIDERS, WALK_SLIDERS,
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
const painter = new Painter();
const tone = new ToneMap();
const recorder = new Recorder();

const AXIS = { horizontal: 0, vertical: 1, radial: 2 } as const;
const COLOUR = { source: 0, mono: 1, duo: 2 } as const;
const INK = { colour: 0, clone: 1, smear: 2 } as const;

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
  if (before !== renderer.width * renderer.height && hasSource()) {
    if (params.engine === 'paint') resetCanvas();
    else if (before) toast('New format. Canvas cleared.');
  }
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
const PRESETS = { paint: PAINT_PRESETS, thread: THREAD_PRESETS, scan: SCAN_PRESETS };
const presetsFor = () => PRESETS[params.engine];
const slidersFor = () => (params.engine === 'scan' ? SCAN_SLIDERS : WALK_SLIDERS.filter((d) => d.engines?.includes(params.engine)));

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
  if (k === 'ink') inkSeg.set(v as string);
}

/** A fresh canvas: the image again in Paint, empty otherwise. */
function resetCanvas() {
  painter.reset();
  if (params.engine === 'paint' && hasSource()) renderer.fillWithSource();
  else renderer.clear();
  completeShown = false;
}

// Sliders: one host for the walk engines (rows shown per engine), one for Scan
const walkHost = $('sliders-map');
const scanHost = $('sliders-scan');
const engineRows: { el: HTMLElement; engines: Params['engine'][] }[] = [];
for (const def of [...WALK_SLIDERS, ...SCAN_SLIDERS]) {
  const inWalk = WALK_SLIDERS.includes(def);
  const host = inWalk ? walkHost : scanHost;
  const engines = def.engines ?? (inWalk ? ['paint', 'thread'] : ['scan']);
  if (def.group) {
    const h = document.createElement('div');
    h.className = 'group';
    h.textContent = def.group;
    host.append(h);
    engineRows.push({ el: h, engines });
  }
  const s = slider(def, params[def.key], (v) => setParam(def.key, v));
  sliders.set(def.key, s);
  host.append(s.el);
  engineRows.push({ el: s.el, engines });
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
const inkSeg = seg($('seg-ink'), params.ink, (v) => setParam('ink', v as Params['ink']));

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

// Engines: Paint (in place), Thread (columns), Scan (slit-scan)
const ENGINE_NOTE = {
  paint: 'The image is the canvas. Each note picks a pixel of matching tone and joins it to the last one. Big pixels first, finer as the track plays.',
  thread: 'Each note picks a pixel of matching tone. Every column is the image along the line between where the walk is and where it has been.',
  scan: 'A slit crosses the image. The sound moves it, bends it and stretches it.',
};
const SOURCE_NOTE = {
  paint: 'Drag on the image or the canvas to steer the walk.',
  thread: 'Drag on the image to move the walk.',
  scan: 'Drag across the image to steer the slit.',
};
const engineSeg = seg($('seg-engine'), params.engine, (v) => setEngine(v as Params['engine']));
function setEngine(e: Params['engine'], init = false) {
  const changed = e !== params.engine;
  setParam('engine', e);
  engineSeg.set(e);
  walkHost.hidden = e === 'scan';
  scanHost.hidden = e !== 'scan';
  for (const r of engineRows) r.el.hidden = !r.engines.includes(e);
  $('invert-row').hidden = e === 'scan';
  $('ink-row').hidden = e !== 'paint';
  $('axis-row').hidden = e === 'paint';
  $('engine-note').textContent = ENGINE_NOTE[e];
  $('src-note').textContent = SOURCE_NOTE[e];
  buildPresets();
  refreshCursor();
  if (!init && changed && e === 'paint') resetCanvas();
}
setEngine(params.engine, true);

$('b-reset').addEventListener('click', () => {
  for (const def of slidersFor()) {
    setParam(def.key, DEFAULTS[def.key]);
    sliders.get(def.key)?.set(DEFAULTS[def.key]);
  }
  if (params.engine !== 'scan') {
    setParam('invert', DEFAULTS.invert);
    invertSeg.set(DEFAULTS.invert ? '1' : '0');
  }
  if (params.engine === 'paint') setParam('ink', DEFAULTS.ink);
  else {
    setParam('axis', DEFAULTS.axis);
    axisSeg.set(DEFAULTS.axis);
  }
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
  resetCanvas();
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
// Default media: an image and a track in demo/, loaded on startup when present.
// Without them (e.g. a public build), the demo button renders a synth track.
const DEFAULT_IMAGE = 'demo/daffodil.jpg';
const DEFAULT_TRACK = 'demo/acid-dream.mp3';
let defaultsLoaded = false;

async function loadDefaults(): Promise<boolean> {
  try {
    const [img, trk] = await Promise.all([fetch(DEFAULT_IMAGE), fetch(DEFAULT_TRACK)]);
    const ok = img.ok && trk.ok && (img.headers.get('content-type') || '').startsWith('image/');
    if (!ok) return false;
    await source.loadImage(await img.blob(), 'Daffodil');
    await loadTrack(await trk.blob(), 'Anna Hjalmarsson – Acid Dream');
    defaultsLoaded = true;
    $('b-demo').textContent = 'Play';
    $('demo-note').textContent = 'Daffodil × Acid Dream. Drop your own image or track any time.';
    return true;
  } catch {
    return false;
  }
}

async function loadDemo() {
  const btn = $<HTMLButtonElement>('b-demo');
  if (defaultsLoaded && hasSource() && audio.mode === 'file') {
    await togglePlay();
    return;
  }
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
  resetCanvas();
  toast(params.engine === 'paint' ? 'Back to the image.' : 'Canvas cleared.');
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

// ───────── Panel: resize and hide ─────────

const PANEL_KEY = 'visual-scan:panel-w';
const app = $('app');
const resizer = $('resizer');
const clampPanel = (w: number) => Math.round(Math.max(248, Math.min(Math.min(600, window.innerWidth * 0.5), w)));
try {
  const w = Number(localStorage.getItem(PANEL_KEY));
  if (w) app.style.setProperty('--panel-w', clampPanel(w) + 'px');
} catch {
  /* storage unavailable */
}
resizer.addEventListener('pointerdown', (e) => {
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add('drag');
});
resizer.addEventListener('pointermove', (e) => {
  if (!resizer.hasPointerCapture(e.pointerId)) return;
  app.style.setProperty('--panel-w', clampPanel(e.clientX) + 'px');
});
const endResize = () => {
  resizer.classList.remove('drag');
  const w = parseInt(app.style.getPropertyValue('--panel-w'), 10);
  try {
    if (w) localStorage.setItem(PANEL_KEY, String(w));
  } catch {
    /* storage unavailable */
  }
};
resizer.addEventListener('pointerup', endResize);
resizer.addEventListener('pointercancel', endResize);
resizer.addEventListener('dblclick', () => {
  app.style.removeProperty('--panel-w');
  try {
    localStorage.removeItem(PANEL_KEY);
  } catch {
    /* storage unavailable */
  }
});
const togglePanel = () => document.body.classList.toggle('no-panel');
$('b-panel').addEventListener('click', togglePanel);

// ───────── Folding panel sections ─────────
// Headers fold their section; the state is remembered per browser. On short
// screens Output starts folded so the engine controls fit.

const FOLD_KEY = 'visual-scan:folds';
let folds: Record<string, boolean> = {};
try {
  folds = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}');
} catch {
  /* storage unavailable */
}
document.querySelectorAll<HTMLElement>('.panel .sec').forEach((sec) => {
  const head = sec.querySelector<HTMLElement>('.sec-h')!;
  const name = head.querySelector('h2')?.textContent || '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fold';
  btn.innerHTML = '<svg viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3" /></svg>';
  head.append(btn);
  const shortScreen = window.innerHeight < 820 && window.innerWidth > 900;
  const set = (collapsed: boolean) => {
    sec.classList.toggle('collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.setAttribute('aria-label', (collapsed ? 'Expand ' : 'Collapse ') + name);
  };
  set(folds[name] ?? (shortScreen && name === 'Output'));
  head.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('button, a') && !t.closest('.fold')) return;
    const collapsed = !sec.classList.contains('collapsed');
    set(collapsed);
    folds[name] = collapsed;
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify(folds));
    } catch {
      /* storage unavailable */
    }
  });
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
  else if (k === 'p') togglePanel();
  else if (k === 'e') setEngine(params.engine === 'paint' ? 'thread' : params.engine === 'thread' ? 'scan' : 'paint');
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

const activeWalker = () => (params.engine === 'paint' ? painter.walker : threader.walker);

// ───────── Steering from the preview ─────────
// Map: drag to move the thread. Scan: drag to steer the slit.

const pc = $<HTMLCanvasElement>('src-canvas');
let previewRect = { ox: 0, oy: 0, w: 1, h: 1 };
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const steerFrom = (e: PointerEvent) => {
  const r = pc.getBoundingClientRect();
  const fx = (e.clientX - r.left - previewRect.ox) / previewRect.w;
  const fy = (e.clientY - r.top - previewRect.oy) / previewRect.h;
  if (params.engine !== 'scan') activeWalker().steer([clamp01(source.flipX ? 1 - fx : fx), clamp01(1 - fy)]);
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
  threader.walker.steer(null);
  painter.walker.steer(null);
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
  if (params.engine === 'paint') {
    // Steer the walk to the pointer (canvas -> source uv)
    const r = frameEl.getBoundingClientRect();
    const [cx, cy] = renderer.cover();
    const x = (e.clientX - r.left) / r.width;
    const y = 1 - (e.clientY - r.top) / r.height;
    painter.walker.steer([clamp01(0.5 + (x - 0.5) * cx), clamp01(0.5 + (y - 0.5) * cy)]);
    return;
  }
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
  painter.walker.steer(null);
};
frameEl.addEventListener('pointerup', endScrub);
frameEl.addEventListener('pointercancel', endScrub);

function refreshCursor() {
  const ready = hasSource() && $('empty').classList.contains('hidden');
  $('frame').style.cursor = !ready
    ? ''
    : params.engine === 'paint'
      ? 'crosshair'
      : params.axis === 'horizontal'
        ? 'ew-resize'
        : params.axis === 'vertical'
          ? 'ns-resize'
          : 'grab';
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
  if (params.engine === 'paint') return drawPaintOverlay(g, W, H);
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
  if (params.engine !== 'scan') {
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

/** Draw a walker's recent trail as a fading web of lines. */
function drawTrail(g: CanvasRenderingContext2D, wk: Walker, toX: (u: number) => number, toY: (v: number) => number, col: string, alpha: number) {
  const T = wk.trail;
  const n = wk.trailCount;
  const N = T.length / 2;
  g.strokeStyle = col;
  g.lineWidth = 0.75;
  for (let k = 1; k < n; k++) {
    const i1 = (wk.trailHead - (n - 1 - k) + N * 4) % N;
    const i0 = (i1 - 1 + N) % N;
    g.globalAlpha = (k / n) * alpha;
    g.beginPath();
    g.moveTo(toX(T[i0 * 2]), toY(T[i0 * 2 + 1]));
    g.lineTo(toX(T[i1 * 2]), toY(T[i1 * 2 + 1]));
    g.stroke();
  }
  g.globalAlpha = 1;
}

/** Paint and Thread: the sound's walk through the image, on the source preview. */
function drawWalk(g: CanvasRenderingContext2D, ox: number, oy: number, w: number, h: number) {
  const toX = (u: number) => ox + (source.flipX ? 1 - u : u) * w;
  const toY = (v: number) => oy + (1 - v) * h;
  // Wash the image back so the walk reads
  g.fillStyle = cssVar('--paper');
  g.globalAlpha = 0.5;
  g.fillRect(ox, oy, w, h);
  g.globalAlpha = 1;
  const wk = activeWalker();
  drawTrail(g, wk, toX, toY, theme.ink, 0.7);

  g.strokeStyle = theme.accent;
  g.fillStyle = theme.accent;
  g.lineWidth = 2;
  if (params.engine === 'thread' && threader.hasDrawn) {
    // The line the newest column is sampling (same curve as the shader)
    const D = threader.drawn;
    const a = [D[0], D[1]];
    const m = [D[2], D[3]];
    const b = [D[4], D[5]];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const c = [mid[0] + (2 * m[0] - mid[0] - mid[0]) * params.bend, mid[1] + (2 * m[1] - mid[1] - mid[1]) * params.bend];
    g.beginPath();
    g.moveTo(toX(a[0]), toY(a[1]));
    g.quadraticCurveTo(toX(c[0]), toY(c[1]), toX(b[0]), toY(b[1]));
    g.stroke();
    g.fillRect(toX(a[0]) - 2, toY(a[1]) - 2, 4, 4);
  } else if (params.engine === 'paint' && wk.started) {
    // The newest stroke
    g.beginPath();
    g.moveTo(toX(wk.pu), toY(wk.pv));
    g.lineTo(toX(wk.u), toY(wk.v));
    g.stroke();
  }
  g.fillRect(toX(wk.u) - 3, toY(wk.v) - 3, 6, 6);
}

// Hits drawn this frame (canvas px) and a rolling score of recent hits + tone
const liveMarks: (HitMark & { t: number })[] = [];
type ScoreEvent = { t: number; type: HitMark['type'] | 'tone'; v: number };
const score: ScoreEvent[] = [];
const SCORE_SECONDS = 8;
let lastToneSample = 0;

function recordScore(F: typeof audio.features, playing: boolean) {
  const now = performance.now() / 1000;
  if (playing) {
    if (F.kick) score.push({ t: now, type: 'kick', v: F.kick });
    if (F.snare) score.push({ t: now, type: 'snare', v: F.snare });
    if (F.hat) score.push({ t: now, type: 'hat', v: F.hat });
    if (now - lastToneSample > 1 / 30) {
      score.push({ t: now, type: 'tone', v: params.invert ? F.tone : 1 - F.tone });
      lastToneSample = now;
    }
  }
  while (score.length && now - score[0].t > SCORE_SECONDS) score.shift();
  while (liveMarks.length && now - liveMarks[0].t > 0.4) liveMarks.shift();
}

/** Outlines where hits landed, fading over a few hundred ms. */
function drawMarks(g: CanvasRenderingContext2D, W: number, H: number) {
  const now = performance.now() / 1000;
  const sx = W / renderer.width;
  const sy = H / renderer.height;
  for (const m of liveMarks) {
    const a = 1 - (now - m.t) / 0.4;
    if (a <= 0) continue;
    const x = m.x * sx;
    const y = H - m.y * sy;
    const r = (m.size / 2) * sx;
    g.globalAlpha = a;
    g.strokeStyle = m.type === 'kick' ? theme.accent : '#ffffff';
    g.lineWidth = m.type === 'kick' ? 2 : 1;
    g.beginPath();
    if (m.type === 'kick') g.rect(x - r - 3, y - r - 3, r * 2 + 6, r * 2 + 6);
    else if (m.type === 'snare') g.arc(x, y, r * (1.2 - 0.4 * a), 0, Math.PI * 2);
    else {
      g.moveTo(x - r, y);
      g.lineTo(x + r, y);
      g.moveTo(x, y - r);
      g.lineTo(x, y + r);
    }
    g.stroke();
  }
  g.globalAlpha = 1;
}

/** The last few seconds as a strip: kicks, snares, hats and the tone being asked for. */
function drawScore(g: CanvasRenderingContext2D, W: number, H: number) {
  const now = performance.now() / 1000;
  const rowH = 9;
  const top = H - rowH * 4 - 10;
  const left = 46;
  const span = W - left - 8;
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(0, top - 6, W, H - top + 6);
  g.font = '500 9px "Inter Tight Variable", Helvetica, Arial, sans-serif';
  g.fillStyle = 'rgba(255,255,255,0.6)';
  ['Kick', 'Snare', 'Hat', 'Tone'].forEach((n, i) => g.fillText(n, 8, top + i * rowH + 7));
  const xAt = (t: number) => left + span * (1 - (now - t) / SCORE_SECONDS);
  g.beginPath();
  g.strokeStyle = 'rgba(255,255,255,0.8)';
  g.lineWidth = 1;
  let first = true;
  for (const e of score) {
    const x = xAt(e.t);
    if (e.type === 'kick') {
      const s = 3 + 4 * e.v;
      g.fillStyle = theme.accent;
      g.fillRect(x - s / 2, top + rowH * 0.5 - s / 2, s, s);
    } else if (e.type === 'snare') {
      g.fillStyle = '#fff';
      g.fillRect(x, top + rowH + 1, 1, rowH - 2);
    } else if (e.type === 'hat') {
      g.fillStyle = 'rgba(255,255,255,0.8)';
      g.fillRect(x - 1, top + rowH * 2 + rowH / 2 - 1, 2, 2);
    } else {
      // Tone row: 0 (dark) at the bottom of the row band
      const y = top + rowH * 4 - 1 - e.v * (rowH * 1.6);
      if (first) g.moveTo(x, y);
      else g.lineTo(x, y);
      first = false;
    }
  }
  g.stroke();
}

/** Paint: the walk drawn over the canvas as a light web, plus the current grain. */
function drawPaintOverlay(g: CanvasRenderingContext2D, W: number, H: number) {
  const [cx, cy] = renderer.cover();
  const toX = (u: number) => (0.5 + (u - 0.5) / cx) * W;
  const toY = (v: number) => (1 - (0.5 + (v - 0.5) / cy)) * H;
  const wk = painter.walker;
  drawMarks(g, W, H);
  if (W > 360 && hasPlayed) drawScore(g, W, H);
  if (!wk.started) return;
  drawTrail(g, wk, toX, toY, '#ffffff', 0.55);
  g.strokeStyle = theme.accent;
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(toX(wk.pu), toY(wk.pv));
  g.lineTo(toX(wk.u), toY(wk.v));
  g.stroke();
  const x = toX(wk.u);
  const y = toY(wk.v);
  g.fillStyle = theme.accent;
  g.fillRect(x - 3, y - 3, 6, 6);
  const label = `${painter.cell}px`;
  g.font = '600 10px "Inter Tight Variable", Helvetica, Arial, sans-serif';
  const tw = g.measureText(label).width + 10;
  const lx = Math.min(W - tw, x + 8);
  const ly = Math.max(0, Math.min(H - 16, y - 20));
  g.fillRect(lx, ly, tw, 16);
  g.fillStyle = '#fff';
  g.fillText(label, lx + 5, ly + 11.5);
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
  $('v-kick').classList.toggle('on', F.kickPulse > 0.25);
  $('v-snare').classList.toggle('on', F.snarePulse > 0.25);
  $('v-hat').classList.toggle('on', F.hatPulse > 0.25);
  $('v-energy').style.width = F.energy * 100 + '%';
  $('v-note').textContent = F.note;
  $('v-hz').textContent = F.pitchHz ? String(Math.round(F.pitchHz)) : '0';
  $('v-tone').style.left = activeWalker().toneFor(F, params) * 100 + '%';
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
  $('empty').classList.toggle('ready', hasSource() && audio.mode !== 'none');
  $('step-go').classList.toggle('done', hasPlayed);
  $('empty').classList.toggle('hidden', hasPlayed && hasSource());
  refreshCursor();
}

// ───────── Frame loop ─────────

let last = performance.now();
let toneAge = 0;
const mGrain = $('m-grain');
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
      if (source.kind === 'image' && source.still) tone.build(source.still, source.width, source.height, 640);
      toneAge = 1;
      // Paint starts from the new image
      if (params.engine === 'paint') resetCanvas();
    } else if (source.dynamic) {
      if (source.syncSize() && params.format === 'source') configureOutput();
      if (source.takeNewFrame()) renderer.setFrame(source.video, source.width, source.height, true);
    }
    toneAge += dt;
    if (source.dynamic && params.engine !== 'scan' && toneAge > 0.08 && source.video.readyState >= 2) {
      tone.build(source.video, source.width, source.height, 256);
      toneAge = 0;
    }
  }

  const pm = passMode();
  scanner.update({ dt, params, audio, passMode: pm });
  const thread = params.engine === 'thread';
  const paint = params.engine === 'paint';
  if (thread && hasSource()) {
    threader.setSweepRes(renderer.sweepRes);
    threader.fill(scanner.swept, audio.features, params, tone, renderer.srcW, renderer.srcH);
    renderer.uploadThread(threader.data, threader.dirtyLo, threader.dirtyHi);
    threader.clearDirty();
  }
  if (paint && hasSource()) {
    painter.update(audio.features, params, {
      dt,
      progress: scanner.head,
      passSeconds: pm ? audio.duration : params.loopSeconds,
      playing: audio.playing && !(pm && scanner.complete),
      outW: renderer.width,
      outH: renderer.height,
      cover: renderer.cover(),
      tone,
    });
    renderer.paint(painter.segs, painter.count, INK[params.ink]);
    const now = performance.now() / 1000;
    for (const m of painter.marks) liveMarks.push({ ...m, t: now });
  }
  recordScore(audio.features, audio.playing);
  const grain = paint ? `Grain ${painter.cell}px` : '';
  if (mGrain.textContent !== grain) mGrain.textContent = grain;

  // Spectrum: fast for the live edge, smoothed (to head speed) for the record
  blurBands(audio.features.bands, specLive);
  const k = 1 - Math.exp(-dt / scanner.recordTau);
  let sum = 0;
  for (let i = 0; i < SPEC_BANDS; i++) {
    specRecord[i] += (specLive[i] - specRecord[i]) * k;
    sum += specRecord[i];
  }
  specMean = sum / SPEC_BANDS;

  if (hasSource() && !paint) {
    renderer.uploadSlit(scanner.slit);
    renderer.uploadSpectrum(specRecord, specLive);
    renderer.step({
      engine: thread ? 1 : 0,
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
loadDefaults();

// First interaction unlocks audio
window.addEventListener('pointerdown', () => audio.resume(), { once: true });
window.addEventListener('keydown', () => audio.resume(), { once: true });

// Dev-only handle for test scripts
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__vs = { audio, painter, params, scanner, renderer };
