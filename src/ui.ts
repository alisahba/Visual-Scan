// Small DOM helpers: element lookup, segmented controls, sliders, toast.

import { DEFAULTS, type SliderDef } from './state';

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error('Missing #' + id);
  return el as T;
}

export interface Seg {
  set(v: string): void;
  disable(v: string, off: boolean): void;
}

/** Wire a .seg container whose buttons carry data-v values. */
export function seg(el: HTMLElement, value: string, onChange: (v: string) => void): Seg {
  const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('button[data-v]'));
  const set = (v: string) => {
    for (const b of buttons) b.classList.toggle('on', b.dataset.v === v);
  };
  for (const b of buttons) b.addEventListener('click', () => onChange(b.dataset.v!));
  set(value);
  return {
    set,
    disable(v, off) {
      const b = buttons.find((x) => x.dataset.v === v);
      if (b) b.disabled = off;
    },
  };
}

export interface Slider {
  el: HTMLElement;
  set(v: number): void;
  enable(on: boolean): void;
}

export function slider(def: SliderDef, value: number, onInput: (v: number) => void): Slider {
  const row = document.createElement('label');
  row.className = 'row';
  const lbl = document.createElement('span');
  lbl.className = 'lbl';
  lbl.textContent = def.label;
  lbl.title = def.hint + ' Double-click to reset.';
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(def.min);
  input.max = String(def.max);
  input.step = String(def.step);
  input.setAttribute('aria-label', def.label);
  input.title = def.hint;
  const out = document.createElement('output');
  row.append(lbl, input, out);

  const paint = (v: number) => {
    out.textContent = def.fmt(v);
    input.style.setProperty('--p', ((v - def.min) / (def.max - def.min)) * 100 + '%');
  };
  const set = (v: number) => {
    input.value = String(v);
    paint(v);
  };
  input.addEventListener('input', () => {
    const v = Number(input.value);
    paint(v);
    onInput(v);
  });
  // Double-click the label to reset to the default
  lbl.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const v = DEFAULTS[def.key];
    set(v);
    onInput(v);
  });
  set(value);
  return {
    el: row,
    set,
    enable(on) {
      row.classList.toggle('disabled', !on);
      input.disabled = !on;
    },
  };
}

let toastTimer = 0;
export function toast(msg: string, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), ms);
}

export function fmtTime(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Size a 2D canvas to its CSS box at device pixel ratio. Returns the context. */
export function fit2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
