// The walk: the sound moving through the image by tone.
// pitch -> target tone -> pick a pixel of that tone near the last pick,
// steered by momentum and curl. Shared by the Paint and Thread engines.

import type { Features } from './audio';
import type { Params } from './state';
import type { ToneMap } from './tonemap';

const TRAIL = 240;

export interface StepOptions {
  /** Minimum step length in tone-map pixels (Paint scales this with the grain). */
  minReach?: number;
  /** 0..1: how strongly to avoid areas already painted. */
  explore?: number;
  /** Coverage lookup in tone-map pixels, 0 = untouched, 1 = well covered. */
  cover?: (x: number, y: number) => number;
  /** Force a jump to a fresh location of the tone (used by hit bursts). */
  heading?: [number, number];
}

export class Walker {
  /** Latest and previous pick in source uv (y up). */
  u = 0.5;
  v = 0.5;
  pu = 0.5;
  pv = 0.5;
  started = false;
  hx = 1;
  hy = 0;
  lastJumped = false;
  private lastPitch = 0.5;
  private curlSign = 1;
  private steerUv: [number, number] | null = null;

  /** Recent picks for drawing the walk (uv). */
  readonly trail = new Float32Array(TRAIL * 2);
  trailHead = -1;
  trailCount = 0;

  steer(uv: [number, number] | null) {
    this.steerUv = uv;
  }

  /** Map the current pitch to a target tone rank (0 = darkest pixel, 1 = brightest). */
  toneFor(F: Features, p: Params): number {
    let t = p.invert ? F.pitch : 1 - F.pitch;
    t = 0.5 + (t - 0.5) * (1 + 3 * p.contrast);
    return Math.max(0, Math.min(1, t));
  }

  private push(u: number, v: number) {
    this.pu = this.u;
    this.pv = this.v;
    this.u = u;
    this.v = v;
    this.trailHead = (this.trailHead + 1) % TRAIL;
    this.trail[this.trailHead * 2] = u;
    this.trail[this.trailHead * 2 + 1] = v;
    this.trailCount = Math.min(TRAIL, this.trailCount + 1);
  }

  /** Take one step. Returns false if the tone map isn't ready. */
  step(F: Features, p: Params, T: ToneMap, turn: boolean, opts: StepOptions = {}): boolean {
    if (!T.ready) return false;
    if (!this.started) {
      this.started = true;
      this.push(Math.random(), Math.random());
      this.pu = this.u;
      this.pv = this.v;
    }
    const [su, sv] = this.steerUv ?? [this.u, this.v];
    const px = su * T.w;
    const py = (1 - sv) * T.h;

    // Curl: the walk keeps turning, so lines between picks become rotating
    // chords. Rising pitch swerves one way, falling the other. Hits flip the
    // curl and kick the heading.
    const dp = F.pitch - this.lastPitch;
    this.lastPitch = F.pitch;
    let a = this.curlSign * p.curl * 0.35 + dp * 3 * p.curl;
    if (turn) {
      this.curlSign = -this.curlSign;
      a += (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 1.2);
    }
    let hx = this.hx;
    let hy = this.hy;
    if (a !== 0) {
      const c = Math.cos(a);
      const s = Math.sin(a);
      [hx, hy] = [hx * c - hy * s, hx * s + hy * c];
    }
    if (opts.heading) [hx, hy] = opts.heading;

    const tone = this.toneFor(F, p);
    const diag = Math.hypot(T.w, T.h);
    // Cubic so the low end (small, coherent steps) gets most of the slider
    let reach = diag * (0.002 + 0.4 * p.reach ** 3) * (0.3 + 1.4 * F.level);
    if (opts.minReach) reach = Math.max(reach, opts.minReach);
    const tolerance = 0.01 + 0.2 * p.tolerance * p.tolerance;
    const [x, y, jumped] = T.pick(tone, tolerance, px, py, hx, hy, reach, p.momentum, p.wander, opts.explore ?? 0, opts.cover);
    this.lastJumped = jumped;

    if (!opts.heading) {
      // Heading follows the move, smoothed by momentum
      const dx = x - px;
      const dy = y - py;
      const d = Math.hypot(dx, dy);
      if (d > 1e-6 && !jumped) {
        const m = 0.35 + 0.6 * p.momentum;
        let nx = hx * m + (dx / d) * (1 - m);
        let ny = hy * m + (dy / d) * (1 - m);
        const nl = Math.hypot(nx, ny) || 1;
        nx /= nl;
        ny /= nl;
        hx = nx;
        hy = ny;
      }
      this.hx = hx;
      this.hy = hy;
    }
    this.push(x / T.w, 1 - y / T.h);
    return true;
  }

  /** Jump the walker's position back without recording a stroke (for bursts). */
  restore(u: number, v: number) {
    this.u = u;
    this.v = v;
  }
}
