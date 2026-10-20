// All tweakable parameters, their ranges, and presets.

export type Axis = 'horizontal' | 'vertical' | 'radial';
export type Fill = 'pass' | 'loop';
export type Colour = 'source' | 'mono' | 'duo';
export type Format = 'source' | '16:9' | '1:1' | '4:5' | '9:16';
export type Size = 'hd' | '4k';

export interface Params {
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
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
}

const pct = (v: number) => String(Math.round(v * 100));

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

export const PRESETS: Preset[] = [
  { name: 'Strip', values: { axis: 'horizontal', travel: 0.14, elastic: 0.25, displace: 0.08, slices: 0, breathe: 0.18, repeat: 0.05, jitter: 0.35, wet: 0.25 } },
  { name: 'Liquid', values: { axis: 'horizontal', travel: 1, elastic: 0.6, displace: 0.7, slices: 0, breathe: 0.75, repeat: 0.1, jitter: 0, wet: 0.7 } },
  { name: 'Stutter', values: { axis: 'horizontal', travel: 1.2, elastic: 0.35, displace: 0.5, slices: 22, breathe: 0.1, repeat: 0.8, jitter: 0.2, wet: 0.15 } },
  { name: 'Orbit', values: { axis: 'radial', travel: 0.7, elastic: 0.5, displace: 0.45, slices: 0, breathe: 0.45, repeat: 0.3, jitter: 0.1, wet: 0.4 } },
];

const STORE_KEY = 'visual-scan:params:v1';

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
