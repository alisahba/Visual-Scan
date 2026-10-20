// Thread engine: each canvas column is the image's pixels along the line
// joining where the walk is now to where it has been.

import type { Features } from './audio';
import type { Params } from './state';
import type { ToneMap } from './tonemap';
import { Walker } from './walker';

/** Texture rows per column: row 0 = (ax, ay, bx, by), row 1 = (mx, my, length px, written). */
export const THREAD_ROWS = 2;

export class Threader {
  readonly walker = new Walker();
  sweepRes = 0;
  data = new Float32Array(0);
  dirtyLo = Infinity;
  dirtyHi = -1;
  /** The line the newest column samples (a, m, b in uv), for the preview. */
  readonly drawn = new Float32Array(6);
  hasDrawn = false;

  // Followers of the walk: b tracks the newest pick (Glide), a is a slow
  // average of where it has been (Span), m sits in between (Bend).
  private fa = [0.5, 0.5];
  private fm = [0.5, 0.5];
  private fb = [0.5, 0.5];
  private followersReady = false;

  setSweepRes(n: number) {
    if (n === this.sweepRes) return;
    this.sweepRes = n;
    this.data = new Float32Array(n * THREAD_ROWS * 4);
    this.dirtyLo = 0;
    this.dirtyHi = n - 1;
  }

  /** Write thread data for every column the head swept this frame. One pick per column. */
  fill(cols: number[], F: Features, p: Params, tone: ToneMap, srcW: number, srcH: number) {
    if (!cols.length || !this.sweepRes) return;
    let turn = F.onset && p.momentum > 0;
    const R = this.sweepRes;
    const D = this.data;
    const span = Math.max(1, p.span);
    const ka = 1 / span;
    const km = Math.min(1, 2.5 / span);
    const kb = Math.max(0.01, (1 - p.glide) ** 2);
    const W = this.walker;
    for (const col of cols) {
      if (!W.step(F, p, tone, turn)) continue;
      turn = false;
      const pu = W.u;
      const pv = W.v;
      if (!this.followersReady) {
        this.fa = [pu, pv];
        this.fm = [pu, pv];
        this.fb = [pu, pv];
        this.followersReady = true;
      }
      this.fb[0] += (pu - this.fb[0]) * kb;
      this.fb[1] += (pv - this.fb[1]) * kb;
      this.fm[0] += (this.fb[0] - this.fm[0]) * km;
      this.fm[1] += (this.fb[1] - this.fm[1]) * km;
      this.fa[0] += (this.fb[0] - this.fa[0]) * ka;
      this.fa[1] += (this.fb[1] - this.fa[1]) * ka;
      let ax = this.fa[0], ay = this.fa[1], mx = this.fm[0], my = this.fm[1], bx = this.fb[0], by = this.fb[1];
      // Extend: keep the line's direction and centre, reach further across the image
      if (p.extend > 0) {
        const cx = (ax + bx) / 2;
        const cy = (ay + by) / 2;
        let dx = (bx - ax) * srcW;
        let dy = (by - ay) * srcH;
        let seg = Math.hypot(dx, dy);
        if (seg < 1e-3) {
          dx = W.hx;
          dy = -W.hy;
          seg = 1e-3;
        }
        const full = Math.hypot(srcW, srcH);
        const target = seg + (full - seg) * p.extend;
        const k = target / Math.max(seg, 1e-3);
        const dl = Math.hypot(dx, dy);
        const ux = (dx / dl) * (target / 2);
        const uy = (dy / dl) * (target / 2);
        ax = cx - ux / srcW;
        ay = cy - uy / srcH;
        bx = cx + ux / srcW;
        by = cy + uy / srcH;
        mx = cx + (mx - cx) * Math.min(k, 8);
        my = cy + (my - cy) * Math.min(k, 8);
      }
      const len = Math.hypot((mx - ax) * srcW, (my - ay) * srcH) + Math.hypot((bx - mx) * srcW, (by - my) * srcH);
      this.drawn.set([ax, ay, mx, my, bx, by]);
      this.hasDrawn = true;
      let o = col * 4;
      D[o] = ax;
      D[o + 1] = ay;
      D[o + 2] = bx;
      D[o + 3] = by;
      o = (R + col) * 4;
      D[o] = mx;
      D[o + 1] = my;
      D[o + 2] = Math.max(len, 1);
      D[o + 3] = 1;
      if (col < this.dirtyLo) this.dirtyLo = col;
      if (col > this.dirtyHi) this.dirtyHi = col;
    }
  }

  clearDirty() {
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
  }
}
