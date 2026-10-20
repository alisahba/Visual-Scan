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

  /** Plan this frame's strokes. Read `segs`/`count` afterwards. */
  update(F: Features, p: Params, c: PaintContext) {
    this.count = 0;
    this.ctx = c;
    this.setGrid(c.outW, c.outH);
    const scale = Math.max(c.outW, c.outH) / 1920;

    // Grain: coarse -> fine over the pass, in power-of-two levels.
    // Bass hits push it back up for a moment (big pixels on the kick).
    const lc = p.coarse + Math.log2(scale);
    const lf = Math.min(lc, p.fine + Math.log2(scale));
    const ease = Math.pow(Math.max(0, Math.min(1, c.progress)), 0.85);
    let lg = lc + (lf - lc) * ease;
    lg += p.pulse * 6 * Math.max(0, F.low - F.lowSlow);
    lg = Math.min(lg, lc);
    const cell = Math.max(1, 2 ** Math.round(lg));
    this.cell = cell;

    // Slowly forget coverage so the walk can come back to places
    const fade = Math.exp(-c.dt / Math.max(2, c.passSeconds * 0.35));
    for (let i = 0; i < this.cov.length; i++) this.cov[i] *= fade;

    if (!c.playing || !c.tone.ready) return;

    // Area budget: cover the canvas about (density) times per pass, faster when loud
    const rate = (c.outW * c.outH * (0.3 + p.density * 2.2)) / Math.max(4, c.passSeconds);
    this.budget += rate * c.dt * (0.2 + 1.6 * F.level);
    this.budget = Math.min(this.budget, rate * 0.5);

    const T = c.tone;
    const toTone = (c.cover[0] * T.w) / c.outW; // canvas px -> tone-map px
    const W = this.walker;
    let turn = F.onset;
    let first = true;
    let steps = 0;
    while (this.budget > 0 && steps < 600 && this.count < MAX_SEGS - 16) {
      steps++;
      const half = cell * (0.72 + p.weight * 4 * F.level);
      const ok = W.step(F, p, T, turn, { minReach: cell * 2 * toTone, explore: p.explore, cover: this.coverAt });
      if (!ok) break;
      turn = false;
      this.budget -= Math.max(cell * cell, this.addSeg(W.pu, W.pv, W.u, W.v, half, cell, c));

      // Hits throw out a fan of thin strokes from the new pick
      if (first && F.onset && p.burst > 0) {
        const n = Math.round(1 + p.burst * (2 + 5 * F.onsetStrength));
        const qu = W.u;
        const qv = W.v;
        for (let k = 0; k < n; k++) {
          const ang = Math.random() * Math.PI * 2;
          W.step(F, p, T, false, { minReach: cell * (3 + 10 * p.burst) * toTone, heading: [Math.cos(ang), Math.sin(ang)] });
          this.addSeg(qu, qv, W.u, W.v, Math.max(1, cell * 0.72), Math.max(1, cell / 2), c);
          W.restore(qu, qv);
        }
      }
      first = false;
    }
  }
}
