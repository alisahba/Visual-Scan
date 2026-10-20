// The write-head and the slit. Decides where the head is on the canvas, where
// the slit reads from in the source, and records per-column slit state.

import type { AudioEngine } from './audio';
import type { Params } from './state';

export interface ScanInput {
  dt: number;
  params: Params;
  audio: AudioEngine;
  /** Pass mode only works with a track that has a known duration. */
  passMode: boolean;
}

const mirror = (x: number) => 1 - Math.abs(1 - (((x % 2) + 2) % 2));

export class Scanner {
  sweepRes = 1;
  slit = new Float32Array(4);
  head = 0;
  prevHead = 0;
  /**
   * The stretch of canvas swept this frame, going forward from `from` to `to`
   * (wrapping in loop mode). Usually prevHead -> head; reversed when you
   * scratch backwards.
   */
  from = 0;
  to = 0;
  private reverse = false;
  /** Columns actually swept this frame, in sweep order (for the map engine). */
  swept: number[] = [];
  /** Current slit position in the source (0..1), after all modulation. */
  sx = 0;
  scale = 1;
  offset = 0;
  grain = 0;
  complete = false;

  private lastSeek = 0;
  private lastPass = false;
  private live = 0; // integrated scan position for loop mode
  private jump = 0; // repeat offset, decays back to 0
  private phase = 0;
  private scratchTarget: number | null = null;
  private manualTarget = 0;
  private manualBlend = 0;
  manualActive = false;
  private last = { sx: 0, scale: 1, offset: 0, grain: 0 };
  /** Head speed in output pixels per second (smoothed). */
  pxPerSec = 0;
  /**
   * Smoothing time for what gets committed. Slow passes give each column more
   * time, so the committed signal is smoothed to avoid jagged columns.
   */
  recordTau = 0.05;

  setSweepRes(n: number) {
    if (n === this.sweepRes) return;
    this.sweepRes = n;
    this.slit = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      this.slit[i * 4] = this.sx;
      this.slit[i * 4 + 1] = 1;
    }
  }

  reset() {
    this.head = 0;
    this.prevHead = 0;
    this.live = 0;
    this.jump = 0;
    this.complete = false;
  }

  /** Steer the slit by hand (value is a source position 0..1). */
  steer(v: number | null) {
    if (v === null) {
      this.manualActive = false;
      return;
    }
    this.manualActive = true;
    this.manualTarget = Math.max(0, Math.min(1, v));
  }

  /** Drag the write-head by hand in loop mode (null to let go). */
  scratch(v: number | null) {
    this.scratchTarget = v === null ? null : Math.max(0, Math.min(0.99999, v));
  }

  update({ dt, params: p, audio, passMode }: ScanInput) {
    const F = audio.features;
    const playing = audio.playing;

    // 1. Head position
    let head = this.head;
    if (passMode) {
      const dur = audio.duration;
      head = dur > 0 ? Math.min(1, audio.currentTime / dur) : 0;
      if (audio.el.ended) head = 1;
    } else if (playing) {
      head = (head + dt / p.loopSeconds) % 1;
    }
    // Seeks start a new stroke instead of smearing across the gap. Forward
    // jumps without a seek (a stalled frame) are filled in.
    const moved = head - this.head;
    const seeked = audio.seekCount !== this.lastSeek || passMode !== this.lastPass;
    this.lastSeek = audio.seekCount;
    this.lastPass = passMode;
    if (passMode && (seeked || moved < -1e-4)) this.prevHead = head;
    else this.prevHead = this.head;
    this.head = head;
    this.from = this.prevHead;
    this.to = this.head;
    this.reverse = false;

    // Scratching: the head follows the pointer and paints in either direction
    if (!passMode && this.scratchTarget !== null) {
      let diff = this.scratchTarget - this.prevHead;
      if (p.axis === 'radial') {
        if (diff > 0.5) diff -= 1;
        if (diff < -0.5) diff += 1;
      }
      const target = (((this.prevHead + diff) % 1) + 1) % 1;
      this.head = target;
      if (diff >= 0) {
        this.from = this.prevHead;
        this.to = target;
      } else {
        this.from = target;
        this.to = this.prevHead;
        this.reverse = true;
      }
      head = target;
    }
    this.complete = passMode && head >= 0.9999;
    let step = this.to - this.from;
    if (step < 0) step += 1;
    const pps = (step * this.sweepRes) / Math.max(dt, 1e-3);
    if (playing) this.pxPerSec += (pps - this.pxPerSec) * (1 - Math.exp(-dt / 0.5));
    this.recordTau = Math.max(0.03, Math.min(0.45, 5 / Math.max(1, this.pxPerSec)));

    // 2. Slit position along the scan
    let base: number;
    if (passMode) {
      base = audio.scanAt(audio.currentTime, p.elastic);
    } else {
      if (playing) {
        const ratio = (F.level + 0.04) / (F.levelSlow + 0.04);
        const rate = Math.pow(ratio + 0.03, p.elastic * 2.5);
        this.live += (dt / p.loopSeconds) * rate;
      }
      base = this.live;
    }

    // Repeat: hits throw the slit back so it rescans what it just passed
    if (playing && F.onset && p.repeat > 0 && Math.random() < 0.35 + p.repeat * 0.65) {
      this.jump -= (0.01 + 0.09 * p.repeat) * (0.4 + F.onsetStrength) / Math.max(0.25, p.travel);
    }
    this.jump *= Math.exp(-dt / (0.6 + 1.6 * p.repeat));

    const start = Math.max(0, 0.5 - p.travel / 2);
    let sx = mirror(start + p.travel * (base + this.jump));

    // Hand steering eases in and out
    const tau = this.manualActive ? 0.04 : 0.5;
    this.manualBlend += ((this.manualActive ? 1 : 0) - this.manualBlend) * (1 - Math.exp(-dt / tau));
    sx = sx + (this.manualTarget - sx) * this.manualBlend;
    this.sx = sx;

    // 3. Cross-axis shape: waves that flow faster when the music is busy
    if (playing) this.phase += dt * (0.5 + 5 * F.mid);
    // Breathe moves slowly on purpose: streaks should bend into waves, not jag.
    const b = p.breathe;
    const k = 1 - Math.exp(-dt / Math.max(0.18, this.recordTau));
    const swell = F.level - F.levelSlow;
    const offset = b * (0.12 * Math.sin(this.phase) * (0.4 + F.level) + 0.18 * (F.low - F.lowSlow));
    const scale = Math.max(0.3, Math.min(1.8, 1 - b * 0.55 * swell));
    this.offset += (offset - this.offset) * k;
    this.scale += (scale - this.scale) * k;
    this.grain = p.jitter * F.high * 1.4;

    // 4. Record slit state for every column the head swept this frame
    this.fillColumns(p.jitter * F.high, playing);
    this.last = { sx: this.sx, scale: this.scale, offset: this.offset, grain: this.grain };
  }

  private fillColumns(jitterAmt: number, playing: boolean) {
    const n = this.sweepRes;
    const i0 = Math.min(n - 1, Math.floor(this.from * n));
    const i1 = Math.min(n - 1, Math.floor(this.to * n));
    const cols: number[] = [];
    if (i1 >= i0) for (let i = i0; i <= i1; i++) cols.push(i);
    else {
      for (let i = i0; i < n; i++) cols.push(i);
      for (let i = 0; i <= i1; i++) cols.push(i);
    }
    // Newly entered columns only: each one gets exactly one map step
    const sw: number[] = [];
    if (this.to !== this.from) {
      const a = Math.min(n - 1, Math.floor(this.from * n));
      const b = Math.min(n - 1, Math.floor(this.to * n));
      if (b > a) for (let i = a + 1; i <= b; i++) sw.push(i);
      else if (b < a) {
        for (let i = a + 1; i < n; i++) sw.push(i);
        for (let i = 0; i <= b; i++) sw.push(i);
      }
    }
    if (this.reverse) sw.reverse();
    this.swept = sw;
    // When idle, keep the column under the head live so slider tweaks show
    if (!playing && cols.length === 0) cols.push(i1);
    const L = this.last;
    const count = cols.length;
    for (let k = 0; k < count; k++) {
      let t = count === 1 ? 1 : (k + 1) / count;
      if (this.reverse) t = 1 - t + 1 / count;
      let sx = L.sx + (this.sx - L.sx) * t;
      if (playing && jitterAmt > 0.05 && Math.random() < jitterAmt * 0.35) {
        sx = mirror(sx + (Math.random() - 0.5) * 0.3 * jitterAmt);
      }
      const o = cols[k] * 4;
      this.slit[o] = sx;
      this.slit[o + 1] = L.scale + (this.scale - L.scale) * t;
      this.slit[o + 2] = L.offset + (this.offset - L.offset) * t;
      this.slit[o + 3] = L.grain + (this.grain - L.grain) * t;
    }
  }
}
