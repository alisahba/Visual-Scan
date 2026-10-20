// The image as a lookup table: every pixel ranked by brightness.
// A tone (0 = darkest pixel in the image, 1 = brightest) points to a narrow
// band of pixels with that rank. Ranking (not raw brightness) means every
// tone lands on real pixels, even in a mostly dark or mostly light image.

export class ToneMap {
  w = 0;
  h = 0;
  ready = false;
  /** Pixel indices sorted dark -> light. */
  order = new Uint32Array(0);
  lum = new Uint8Array(0);
  private canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private hist = new Uint32Array(256);
  /** Tone rank of each brightness level (0 = darkest pixel, 1 = brightest). */
  readonly rank = new Float32Array(256);

  constructor() {
    this.g = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  /** Analyse a source at reduced size. Counting sort keeps this to ~1 ms. */
  build(src: CanvasImageSource, sw: number, sh: number, maxSide: number) {
    const k = Math.min(1, maxSide / Math.max(sw, sh));
    const w = Math.max(2, Math.round(sw * k));
    const h = Math.max(2, Math.round(sh * k));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.g.drawImage(src, 0, 0, w, h);
    const px = this.g.getImageData(0, 0, w, h).data;
    const n = w * h;
    if (this.lum.length !== n) {
      this.lum = new Uint8Array(n);
      this.order = new Uint32Array(n);
    }
    const hist = this.hist;
    hist.fill(0);
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const l = (px[o] * 0.2126 + px[o + 1] * 0.7152 + px[o + 2] * 0.0722) | 0;
      this.lum[i] = l;
      hist[l]++;
    }
    let acc = 0;
    for (let l = 0; l < 256; l++) {
      const c = hist[l];
      this.rank[l] = (acc + c / 2) / n;
      hist[l] = acc;
      acc += c;
    }
    for (let i = 0; i < n; i++) this.order[hist[this.lum[i]]++] = i;
    this.w = w;
    this.h = h;
    this.ready = true;
  }

  /**
   * Pick the next pixel for a tone (0 = darkest rank, 1 = brightest).
   * First look locally, around the point `reach` ahead along the heading, for
   * a pixel of that tone: steady notes trace smooth paths along same-tone
   * contours. If the tone isn't nearby, jump to wherever it exists.
   * Coordinates are tone-map pixels (y down). Returns [x, y, jumped].
   */
  pick(
    tone: number,
    tolerance: number,
    px: number,
    py: number,
    hx: number,
    hy: number,
    reach: number,
    momentum: number,
    wander: number,
    explore = 0,
    cover?: (x: number, y: number) => number,
  ): [number, number, boolean] {
    const R = Math.max(1, reach);
    const qx = px + hx * R;
    const qy = py + hy * R;
    const rad = Math.max(2.5, R * 0.9);
    let best = -1;
    let bestScore = Infinity;
    let bestErr = 1;
    for (let k = 0; k < 140; k++) {
      const ang = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * rad;
      const x = Math.floor(qx + Math.cos(ang) * rr);
      const y = Math.floor(qy + Math.sin(ang) * rr);
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
      const idx = y * this.w + x;
      const err = Math.abs(this.rank[this.lum[idx]] - tone);
      const dx = x + 0.5 - px;
      const dy = y + 0.5 - py;
      const dist = Math.hypot(dx, dy);
      const align = dist > 1e-6 ? (dx * hx + dy * hy) / dist : 0;
      let score = err / tolerance + 0.5 * (Math.abs(dist - R) / R) + momentum * (1 - align) + wander * 1.5 * Math.random();
      if (cover && explore > 0) score += explore * 2 * cover(x, y);
      if (score < bestScore) {
        bestScore = score;
        best = idx;
        bestErr = err;
      }
    }
    if (best >= 0 && bestErr <= tolerance) {
      return [(best % this.w) + 0.5, Math.floor(best / this.w) + 0.5, false];
    }

    // Jump: sample the tone band across the whole image, prefer the nearest
    // (and, when exploring, the least painted)
    const diag = Math.hypot(this.w, this.h);
    const n = this.order.length;
    const centre = Math.round(Math.max(0, Math.min(1, tone)) * (n - 1));
    const half = Math.max(8, Math.round(n * tolerance));
    const lo = Math.max(0, centre - half);
    const hi = Math.min(n, centre + half + 1);
    const count = hi - lo;
    const K = Math.min(count, 400);
    const stride = count / K;
    const off = Math.random() * stride;
    best = -1;
    bestScore = Infinity;
    for (let k = 0; k < K; k++) {
      const idx = this.order[lo + Math.min(count - 1, Math.floor(off + k * stride))];
      const x = (idx % this.w) + 0.5;
      const y = Math.floor(idx / this.w) + 0.5;
      let score = Math.hypot(x - px, y - py) * (1 + wander * 3 * Math.random());
      if (cover && explore > 0) score += explore * diag * 1.5 * cover(x, y);
      if (score < bestScore) {
        bestScore = score;
        best = idx;
      }
    }
    if (best < 0) return [px, py, false];
    return [(best % this.w) + 0.5, Math.floor(best / this.w) + 0.5, true];
  }
}
