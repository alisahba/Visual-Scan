// All tweakable parameters, their ranges, and presets.

export type Engine = 'map' | 'scan';
export type Axis = 'horizontal' | 'vertical' | 'radial';
export type Fill = 'pass' | 'loop';
export type Colour = 'source' | 'mono' | 'duo';
export type Format = 'source' | '16:9' | '1:1' | '4:5' | '9:16';
export type Size = 'hd' | '4k';

export interface Params {
  engine: Engine;
  // Map engine
  reach: number;
  momentum: number;
  curl: number;
  span: number;
  extend: number;
  glide: number;
  bend: number;
  contrast: number;
  tolerance: number;
  wander: number;
  invert: boolean;
  // Shared
  axis: Axis;
  fill: Fill;
  loopSeconds: number;
  travel: number;
  elastic: number;
  displace: number;
  slices: number;
  breathe: number;
  repeat: number;
  jitter: number;
  wet: number;
  timewarp: number;
  gain: number;
  format: Format;
  size: Size;
  colour: Colour;
  duo: number;
  head: boolean;
  grid: boolean;
}

export const DEFAULTS: Params = {
  engine: 'map',
  reach: 0.35,
  momentum: 0.75,
  curl: 0.4,
  span: 30,
  extend: 0.45,
  glide: 0.6,
  bend: 0.6,
  contrast: 0.25,
  tolerance: 0.25,
  wander: 0.1,
  invert: false,
  axis: 'horizontal',
  fill: 'pass',
  loopSeconds: 24,
  travel: 1,
  elastic: 0.6,
  displace: 0.4,
  slices: 0,
  breathe: 0.3,
  repeat: 0.25,
  jitter: 0.12,
  wet: 0.45,
  timewarp: 0,
  gain: 0,
  format: '16:9',
  size: 'hd',
  colour: 'source',
  duo: 0,
  head: true,
  grid: true,
};

export type NumKey = {
  [K in keyof Params]: Params[K] extends number ? K : never;
}[keyof Params];

export interface SliderDef {
  key: NumKey;
  group?: string;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
}

const pct = (v: number) => String(Math.round(v * 100));

export const MAP_SLIDERS: SliderDef[] = [
  { group: 'Walk', key: 'reach', label: 'Reach', hint: 'How far each step can jump through the image. Louder passages jump further.', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'momentum', label: 'Momentum', hint: 'How firmly the walk holds its heading.', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'curl', label: 'Curl', hint: 'The walk keeps turning, so the lines between picks sweep like string art. Pitch moves swerve it; hits flip it.', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'wander', label: 'Wander', hint: 'Chance in which matching pixel gets picked.', min: 0, max: 1, step: 0.01, fmt: pct },
  { group: 'Line', key: 'span', label: 'Span', hint: 'Each column joins where the sound is now to where it has been. Span is how far back that memory reaches, in steps.', min: 1, max: 120, step: 1, fmt: (v) => String(v) },
  { key: 'extend', label: 'Extend', hint: 'Each column is the line through two picks. 0 = only the stretch between them; higher = the same line reaching across the image.', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'bend', label: 'Bend', hint: 'Straight lines between picks, or curves through the pick in between.', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'glide', label: 'Glide', hint: 'How smoothly the newest end of the line follows the picks. 0 = raw and twitchy.', min: 0, max: 1, step: 0.01, fmt: pct },
  { group: 'Tone', key: 'contrast', label: 'Contrast', hint: 'Pushes notes towards the darkest and lightest pixels.', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'tolerance', label: 'Tolerance', hint: 'How loosely a pixel has to match the tone of the note.', min: 0, max: 1, step: 0.01, fmt: pct },
];

export const SCAN_SLIDERS: SliderDef[] = [
  { key: 'travel', label: 'Travel', hint: 'How much of the image the slit crosses per pass. Low = streaks.', min: 0.02, max: 3, step: 0.01, fmt: (v) => v.toFixed(2) + '×' },
  { key: 'elastic', label: 'Elastic', hint: 'Loud passages race through the image, quiet ones stall into streaks.', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'displace', label: 'Displace', hint: 'Each row is pushed by its frequency band. Bass at the bottom, highs at the top.', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'slices', label: 'Slices', hint: 'Cut the rows into bands that move as blocks. 0 = fluid.', min: 0, max: 48, step: 1, fmt: (v) => (v < 1 ? 'Off' : String(v)) },
  { key: 'breathe', label: 'Breathe', hint: 'Loudness stretches and shifts the slit, bending streaks into waves.', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'repeat', label: 'Repeat', hint: 'On hits, the slit jumps back and rescans.', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'jitter', label: 'Jitter', hint: 'Highs break the scan into glitch lines.', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'wet', label: 'Wet edge', hint: 'The strip behind the head keeps moving with the music before it sets.', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'timewarp', label: 'Time warp', hint: 'Video and camera only. Rows are pulled from past frames.', min: 0, max: 1, step: 0.01, fmt: pct },
];

export const LOOP_SLIDER: SliderDef = {
  key: 'loopSeconds', label: 'Pass length', hint: 'Seconds per pass in loop mode.', min: 4, max: 120, step: 1, fmt: (v) => v + 's',
};

export const GAIN_SLIDER: SliderDef = {
  key: 'gain', label: 'Gain', hint: 'Input sensitivity.', min: -18, max: 18, step: 1, fmt: (v) => (v > 0 ? '+' : '') + v + ' dB',
};

// Duotone pairs: [shadow, light]
export const DUOS: [string, string][] = [
  ['#141414', '#ff7aa8'],
  ['#0b0b0b', '#c8ff2e'],
  ['#1530d8', '#f1f1ec'],
  ['#ff4a1c', '#f6f2ea'],
];

export interface Preset {
  name: string;
  values: Partial<Params>;
}

export const MAP_PRESETS: Preset[] = [
  { name: 'Thread', values: { reach: 0.35, momentum: 0.75, curl: 0.4, span: 30, extend: 0.45, bend: 0.6, glide: 0.6, contrast: 0.25, tolerance: 0.25, wander: 0.1 } },
  { name: 'Weave', values: { reach: 0.25, momentum: 0.85, curl: 0.2, span: 60, extend: 0.8, bend: 0.8, glide: 0.6, contrast: 0.2, tolerance: 0.4, wander: 0.05 } },
  { name: 'Pixel', values: { reach: 0.9, momentum: 0.05, curl: 0, span: 1, extend: 0, bend: 0, glide: 0, contrast: 0.7, tolerance: 0.1, wander: 0.6 } },
  { name: 'Orbit', values: { reach: 0.4, momentum: 0.9, curl: 0.8, span: 24, extend: 0.65, bend: 0.3, glide: 0.6, contrast: 0.2, tolerance: 0.5, wander: 0 } },
];

export const SCAN_PRESETS: Preset[] = [
  { name: 'Strip', values: { axis: 'horizontal', travel: 0.14, elastic: 0.25, displace: 0.08, slices: 0, breathe: 0.18, repeat: 0.05, jitter: 0.35, wet: 0.25 } },
  { name: 'Liquid', values: { axis: 'horizontal', travel: 1, elastic: 0.6, displace: 0.7, slices: 0, breathe: 0.75, repeat: 0.1, jitter: 0, wet: 0.7 } },
  { name: 'Stutter', values: { axis: 'horizontal', travel: 1.2, elastic: 0.35, displace: 0.5, slices: 22, breathe: 0.1, repeat: 0.8, jitter: 0.2, wet: 0.15 } },
  { name: 'Orbit', values: { axis: 'radial', travel: 0.7, elastic: 0.5, displace: 0.45, slices: 0, breathe: 0.45, repeat: 0.3, jitter: 0.1, wet: 0.4 } },
];

const STORE_KEY = 'visual-scan:params:v5';

export function loadParams(): Params {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULTS };
}

let saveTimer = 0;
export function saveParams(p: Params) {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(p));
    } catch {
      /* storage unavailable */
    }
  }, 300);
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function outputSize(p: Params, srcW: number, srcH: number): [number, number] {
  const long = p.size === '4k' ? 3840 : 1920;
  let aspect: number;
  switch (p.format) {
    case '16:9': aspect = 16 / 9; break;
    case '1:1': aspect = 1; break;
    case '4:5': aspect = 4 / 5; break;
    case '9:16': aspect = 9 / 16; break;
    default: aspect = srcW > 0 && srcH > 0 ? srcW / srcH : 16 / 9;
  }
  const w = aspect >= 1 ? long : Math.round(long * aspect);
  const h = aspect >= 1 ? Math.round(long / aspect) : long;
  // Even dimensions keep video encoders happy
  return [w & ~1, h & ~1];
}
