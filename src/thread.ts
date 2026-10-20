// Map engine: the sound walks through the image by tone, and each canvas
// column is the image's pixels along the line joining where the walk is now
// to where it has been.
//
// pitch -> tone (high = dark by default) -> pick a pixel of that tone near the
// last one -> column = pixels on the line through the walk's followers.

import type { Features } from './audio';
import type { Params } from './state';
import { ToneMap } from './tonemap';

/** Texture rows per column: row 0 = (ax, ay, bx, by), row 1 = (mx, my, length px, unused). */
export const THREAD_ROWS = 2;
const HISTORY = 4;
const TRAIL = 240;

export class Threader {
  readonly tone = new ToneMap();
  sweepRes = 0;
  data = new Float32Array(0);
  dirtyLo = Infinity;
  dirtyHi = -1;

  /** Latest picks in source uv (y up), newest at `head`. */
  private picks = new Float32Array(HISTORY * 2);
  private head = -1;
  private count = 0;
  private hx = 1;
  private hy = 0;
  /** The line the newest column samples (a, m, b in uv), for the preview. */
  readonly drawn = new Float32Array(6);
  hasDrawn = false;
  private lastPitch = 0.5;
  private curlSign = 1;
  private steerUv: [number, number] | null = null;

  /** Recent picks for drawing the walk on the preview (uv). */
  readonly trail = new Float32Array(TRAIL * 2);
  trailHead = -1;
  trailCount = 0;

  setSweepRes(n: number) {
    if (n === this.sweepRes) return;
    this.sweepRes = n;
    this.data = new Float32Array(n * THREAD_ROWS * 4);
    this.dirtyLo = 0;
    this.dirtyHi = n - 1;
  }

  steer(uv: [number, number] | null) {
    this.steerUv = uv;
  }

  get pos(): [number, number] {
    if (this.head < 0) return [0.5, 0.5];
    return [this.picks[this.head * 2], this.picks[this.head * 2 + 1]];
  }

  /**
   * The line each column samples joins three followers of the walk:
   * b tracks the newest pick (smoothed by Glide), a is a slow average of
   * where the walk has been (memory = Span), m sits in between (for Bend).
   */
  private fa = [0.5, 0.5];
  private fm = [0.5, 0.5];
  private fb = [0.5, 0.5];
  private followersReady = false;

  /** Map the current pitch to a target tone rank. */
  toneFor(F: Features, p: Params): number {
    let t = p.invert ? F.pitch : 1 - F.pitch;
    t = 0.5 + (t - 0.5) * (1 + 3 * p.contrast);
    return Math.max(0, Math.min(1, t));
  }

  private push(u: number, v: number) {
    this.head = (this.head + 1) % HISTORY;
    this.picks[this.head * 2] = u;
    this.picks[this.head * 2 + 1] = v;
    this.count = Math.min(HISTORY, this.count + 1);
    this.trailHead = (this.trailHead + 1) % TRAIL;
    this.trail[this.trailHead * 2] = u;
    this.trail[this.trailHead * 2 + 1] = v;
    this.trailCount = Math.min(TRAIL, this.trailCount + 1);
  }

  private step(F: Features, p: Params, turn: boolean) {
    const T = this.tone;
    if (!T.ready) return;
    if (this.head < 0) this.push(Math.random(), Math.random());
    const [pu, pv] = this.steerUv ?? this.pos;
    const px = pu * T.w;
    const py = (1 - pv) * T.h;

    // Curl: the walk keeps turning, so lines between picks become rotating
    // chords. Rising pitch swerves one way, falling the other. Hits flip the
    // direction of the curl and kick the heading.
    const dp = F.pitch - this.lastPitch;
    this.lastPitch = F.pitch;
    let a = this.curlSign * p.curl * 0.35 + dp * 3 * p.curl;
    if (turn) {
      this.curlSign = -this.curlSign;
      a += (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 1.2);
    }
    if (a !== 0) {
      const c = Math.cos(a);
      const s = Math.sin(a);
      [this.hx, this.hy] = [this.hx * c - this.hy * s, this.hx * s + this.hy * c];
    }

    const tone = this.toneFor(F, p);
    const diag = Math.hypot(T.w, T.h);
    // Cubic so the low end (small, coherent steps) gets most of the slider
    const reach = diag * (0.002 + 0.4 * p.reach ** 3) * (0.3 + 1.4 * F.level);
    const tolerance = 0.01 + 0.2 * p.tolerance * p.tolerance;
    const [x, y, jumped] = T.pick(tone, tolerance, px, py, this.hx, this.hy, reach, p.momentum, p.wander);

    // Heading follows the move, smoothed by momentum
    const dx = x - px;
    const dy = y - py;
    const d = Math.hypot(dx, dy);
    if (d > 1e-6 && !jumped) {
      const m = 0.35 + 0.6 * p.momentum;
      let nx = this.hx * m + (dx / d) * (1 - m);
      let ny = this.hy * m + (dy / d) * (1 - m);
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl;
      ny /= nl;
      this.hx = nx;
      this.hy = ny;
    }
    this.push(x / T.w, 1 - y / T.h);
  }

  /** Write thread data for every column the head swept this frame. One pick per column. */
  fill(cols: number[], F: Features, p: Params, srcW: number, srcH: number) {
    if (!cols.length || !this.sweepRes) return;
    let turn = F.onset && p.momentum > 0;
    const R = this.sweepRes;
    const D = this.data;
    const span = Math.max(1, p.span);
    const ka = 1 / span;
    const km = Math.min(1, 2.5 / span);
    const kb = Math.max(0.01, (1 - p.glide) ** 2);
    for (const col of cols) {
      this.step(F, p, turn);
      turn = false;
      if (this.count < 1) continue;
      const [pu, pv] = this.pos;
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
          dx = this.hx;
          dy = -this.hy;
          seg = 1e-3;
        }
        const full = Math.hypot(srcW, srcH);
        const target = seg + (full - seg) * p.extend;
        const k = target / Math.max(seg, 1e-3);
        const ux = dx / Math.hypot(dx, dy) * (target / 2);
        const uy = dy / Math.hypot(dx, dy) * (target / 2);
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
