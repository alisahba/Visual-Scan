// Paint engine: the canvas starts as the image and the sound paints over it
// in place. Each step connects the last picked pixel to the new one with a
// stroke snapped to a pixel grid. The grid starts coarse (big pixels) and
// refines over the pass; painting is budgeted by area so the image is used up
// steadily across the whole track, not wiped in the first seconds.

import type { Features } from './audio';
import type { Params } from './state';
import type { ToneMap } from './tonemap';
import { Walker } from './walker';

/** Floats per stroke: P.xy, Q.xy (canvas px), P.uv, Q.uv (source), half width, cell. */
export const SEG_FLOATS = 10;
const MAX_SEGS = 4096;
const GRID = 56;

/** A hit drawn this frame, for the overlay's markers and score. */
export interface HitMark {
  type: 'kick' | 'snare' | 'hat';
  x: number; // canvas px (y up)
  y: number;
  size: number;
}

export interface PaintContext {
  dt: number;
  /** 0..1 through the current pass (track, or one loop). */
  progress: number;
  passSeconds: number;
  playing: boolean;
  outW: number;
  outH: number;
  /** Portion of the source (in uv) visible on the canvas, per axis. */
  cover: [number, number];
  tone: ToneMap;
}

export class Painter {
  readonly walker = new Walker();
  readonly segs = new Float32Array(MAX_SEGS * SEG_FLOATS);
  count = 0;
  readonly marks: HitMark[] = [];
  /** Current grain in canvas pixels (power of two). */
  cell = 64;
  private budget = 0;
  private gw = GRID;
  private gh = GRID;
  private cov = new Float32Array(GRID * GRID);
  private ctx: PaintContext | null = null;

  /** Fresh canvas: forget what has been painted. */
  reset() {
    this.cov.fill(0);
    this.budget = 0;
  }

  private setGrid(w: number, h: number) {
    const gw = GRID;
    const gh = Math.max(4, Math.round((GRID * h) / w));
    if (gw !== this.gw || gh !== this.gh) {
      this.gw = gw;
      this.gh = gh;
      this.cov = new Float32Array(gw * gh);
    }
  }

  private toCanvas(u: number, v: number, c: PaintContext): [number, number] {
    return [(0.5 + (u - 0.5) / c.cover[0]) * c.outW, (0.5 + (v - 0.5) / c.cover[1]) * c.outH];
  }

  /** Coverage at a tone-map pixel: 0 untouched .. 1 well painted. */
  private coverAt = (x: number, y: number): number => {
    const c = this.ctx;
    if (!c) return 0;
    const T = c.tone;
    const [cx, cy] = this.toCanvas(x / T.w, 1 - y / T.h, c);
    const gx = Math.floor((cx / c.outW) * this.gw);
    const gy = Math.floor((cy / c.outH) * this.gh);
    if (gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh) return 1;
    return 1 - Math.exp(-this.cov[gy * this.gw + gx]);
  };

  private markCoverage(ax: number, ay: number, bx: number, by: number, half: number, c: PaintContext) {
    const cw = c.outW / this.gw;
    const ch = c.outH / this.gh;
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(len / (Math.min(cw, ch) * 0.5)));
    const rx = Math.min(6, Math.floor(half / cw));
    const ry = Math.min(6, Math.floor(half / ch));
    const amt = Math.min(1, ((2 * half) * (len / n)) / (cw * ch * (2 * rx + 1) * (2 * ry + 1)));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const gx = Math.floor(((ax + (bx - ax) * t) / c.outW) * this.gw);
      const gy = Math.floor(((ay + (by - ay) * t) / c.outH) * this.gh);
      for (let y = gy - ry; y <= gy + ry; y++) {
        if (y < 0 || y >= this.gh) continue;
        for (let x = gx - rx; x <= gx + rx; x++) {
          if (x < 0 || x >= this.gw) continue;
          this.cov[y * this.gw + x] += amt;
        }
      }
    }
  }

  private addSeg(pu: number, pv: number, qu: number, qv: number, half: number, cell: number, c: PaintContext): number {
    if (this.count >= MAX_SEGS) return 0;
    const [ax, ay] = this.toCanvas(pu, pv, c);
    const [bx, by] = this.toCanvas(qu, qv, c);
    const o = this.count * SEG_FLOATS;
    const S = this.segs;
    S[o] = ax;
    S[o + 1] = ay;
    S[o + 2] = bx;
    S[o + 3] = by;
    S[o + 4] = pu;
    S[o + 5] = pv;
    S[o + 6] = qu;
    S[o + 7] = qv;
    S[o + 8] = half;
    S[o + 9] = cell;
    this.count++;
    this.markCoverage(ax, ay, bx, by, half, c);
    const len = Math.hypot(bx - ax, by - ay);
    return (len + 2 * half) * 2 * half;
  }

  /** A square block (kick stamp or hat spark) centred on a pick. */
  private addBlock(u: number, v: number, size: number, cell: number, c: PaintContext): number {
    if (this.count >= MAX_SEGS) return 0;
    const [x, y] = this.toCanvas(u, v, c);
    const o = this.count * SEG_FLOATS;
    const S = this.segs;
    S[o] = x;
    S[o + 1] = y;
    S[o + 2] = x;
    S[o + 3] = y;
    S[o + 4] = u;
    S[o + 5] = v;
    S[o + 6] = u;
    S[o + 7] = v;
    S[o + 8] = -size / 2;
    S[o + 9] = cell;
    this.count++;
    this.markCoverage(x, y, x, y, size / 2, c);
    return size * size;
  }

  private mark(type: HitMark['type'], u: number, v: number, size: number, c: PaintContext) {
    const [x, y] = this.toCanvas(u, v, c);
    this.marks.push({ type, x, y, size });
  }

  /** Plan this frame's strokes. Read `segs`/`count` and `marks` afterwards. */
  update(F: Features, p: Params, c: PaintContext) {
    this.count = 0;
    this.marks.length = 0;
    this.ctx = c;
    this.setGrid(c.outW, c.outH);
    const scale = Math.max(c.outW, c.outH) / 1920;
    const short = Math.min(c.outW, c.outH);

    // Grain: coarse -> fine over the pass, in power-of-two levels
    const lc = p.coarse + Math.log2(scale);
    const lf = Math.min(lc, p.fine + Math.log2(scale));
    const ease = Math.pow(Math.max(0, Math.min(1, c.progress)), 0.85);
    const cell = Math.max(1, 2 ** Math.round(lc + (lf - lc) * ease));
    this.cell = cell;

    // Slowly forget coverage so the walk can come back to places
    const fade = Math.exp(-c.dt / Math.max(2, c.passSeconds * 0.35));
    for (let i = 0; i < this.cov.length; i++) this.cov[i] *= fade;

    if (!c.playing || !c.tone.ready) return;

    const T = c.tone;
    const toTone = (c.cover[0] * T.w) / c.outW; // canvas px -> tone-map px
    const W = this.walker;
    const walk = { explore: p.explore, cover: this.coverAt };

    // Hits first, each with its own mark, so they read in time with the music.
    // Their area comes out of the budget: the line pauses briefly after a big hit.
    if (F.kick && p.kick > 0) {
      // Kick: a bold leap across the image and a solid block where it lands
      const s = F.kick;
      if (W.step(F, p, T, true, { ...walk, minReach: short * (0.08 + 0.2 * p.kick) * toTone })) {
        this.budget -= this.addSeg(W.pu, W.pv, W.u, W.v, Math.max(2 * scale, cell * (0.9 + 1.6 * p.kick * s)), cell, c);
        // Kicks keep a readable size even once the grain is fine
        const floor = short * (0.015 + 0.05 * p.kick * (0.5 + s));
        const size = Math.min(short * 0.28, Math.max(floor, cell * (1.5 + 3.5 * p.kick * s)));
        this.budget -= this.addBlock(W.u, W.v, size, cell, c);
        this.mark('kick', W.u, W.v, size, c);
      }
    }
    if (F.snare && p.snare > 0 && W.started) {
      // Snare: a fan of thin lines out of the current pixel
      const n = Math.round(2 + 6 * p.snare * F.snare);
      const qu = W.u;
      const qv = W.v;
      for (let k = 0; k < n; k++) {
        const ang = (k / n) * Math.PI * 2 + Math.random() * 0.6;
        W.step(F, p, T, false, { minReach: cell * (4 + 14 * p.snare) * toTone, heading: [Math.cos(ang), Math.sin(ang)] });
        this.budget -= this.addSeg(qu, qv, W.u, W.v, Math.max(1, cell * 0.72), Math.max(1, cell / 2), c);
        W.restore(qu, qv);
      }
      this.mark('snare', qu, qv, cell * (4 + 14 * p.snare), c);
    }
    if (F.hat && p.hat > 0 && W.started) {
      // Hat: sparks of single pixels of the same tone, scattered nearby
      const n = Math.round(2 + 8 * p.hat * F.hat);
      const qu = W.u;
      const qv = W.v;
      const dot = Math.max(4 * scale, cell * 0.5);
      for (let k = 0; k < n; k++) {
        const ang = Math.random() * Math.PI * 2;
        W.step(F, p, T, false, { minReach: Math.max(dot * 3, cell * 3) * toTone, heading: [Math.cos(ang), Math.sin(ang)] });
        this.budget -= this.addBlock(W.u, W.v, dot, Math.max(1, dot), c);
        W.restore(qu, qv);
      }
      this.mark('hat', qu, qv, dot * 6, c);
    }

    // The line: steps at a rate set by energy, so it rests in breakdowns and
    // races in drops. Covers the canvas about (density) times per pass.
    const rate = (c.outW * c.outH * (0.2 + p.density * 1.6)) / Math.max(4, c.passSeconds);
    const drive = Math.max(0, F.energy - 0.2) / 0.3; // ~1 at average loudness
    this.budget += rate * c.dt * drive * drive;
    this.budget = Math.max(-rate * 2, Math.min(this.budget, rate * 0.5));
    let steps = 0;
    while (this.budget > 0 && steps < 600 && this.count < MAX_SEGS - 16) {
      steps++;
      const half = cell * (0.72 + p.weight * 2.5 * Math.max(0, F.energy - 0.3));
      if (!W.step(F, p, T, false, { ...walk, minReach: cell * 2 * toTone })) break;
      this.budget -= Math.max(cell * cell, this.addSeg(W.pu, W.pv, W.u, W.v, half, cell, c));
    }
  }
}
