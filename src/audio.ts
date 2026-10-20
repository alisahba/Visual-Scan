// Audio in, features out. Handles a track (file) or a live input (mic / line-in),
// analyses it every frame, and pre-analyses tracks so a full pass of the canvas
// can be mapped to the track's energy.

export const NB = 128; // log-spaced analysis bands, low -> high

export interface Features {
  bands: Float32Array; // 0..1 per band, smoothed
  low: number;
  mid: number;
  high: number;
  level: number; // 0..1 loudness
  levelSlow: number;
  lowSlow: number;
  onset: boolean; // a hit landed this frame
  onsetStrength: number;
  pulse: number; // decaying flash after a hit
}

export type AudioMode = 'none' | 'file' | 'mic';

const F_MIN = 30;
const F_MAX = 16000;
const FLUX_HISTORY = 48;

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly analyser: AnalyserNode;
  readonly recordDest: MediaStreamAudioDestinationNode;
  readonly el: HTMLAudioElement;
  private elSource: MediaElementAudioSourceNode;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private objectUrl = '';

  mode: AudioMode = 'none';
  trackName = '';
  inputName = '';
  /** RMS envelope of the decoded track, used for the timeline and elastic scan. */
  envelope: Float32Array | null = null;
  envRate = 1;
  overview: Float32Array | null = null;
  private lut: Float32Array | null = null;
  private lutElastic = -1;

  gainDb = 0;
  /** Bumped on every user seek, so the scanner can start a new stroke. */
  seekCount = 0;
  /** Pauses scanning while a live input stays connected. */
  hold = false;
  inputStartedAt = 0;

  readonly features: Features = {
    bands: new Float32Array(NB),
    low: 0,
    mid: 0,
    high: 0,
    level: 0,
    levelSlow: 0.3,
    lowSlow: 0.3,
    onset: false,
    onsetStrength: 0,
    pulse: 0,
  };

  private freq: Float32Array<ArrayBuffer>;
  private time: Float32Array<ArrayBuffer>;
  private raw = new Float32Array(NB);
  private prevRaw = new Float32Array(NB);
  private bandLo = new Int32Array(NB);
  private bandHi = new Int32Array(NB);
  private bandCentre = new Float32Array(NB);
  private bandTilt = new Float32Array(NB);
  private ref = -60;
  private levelRef = -30;
  private flux = new Float32Array(FLUX_HISTORY);
  private fluxIdx = 0;
  private lastOnset = 0;
  private clock = 0;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.analyser.minDecibels = -140;
    this.analyser.maxDecibels = 0;
    this.recordDest = this.ctx.createMediaStreamDestination();

    // Keep the analyser pulled even when only a mic feeds it.
    const silent = this.ctx.createGain();
    silent.gain.value = 0;
    this.analyser.connect(silent).connect(this.ctx.destination);

    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.crossOrigin = 'anonymous';
    this.elSource = this.ctx.createMediaElementSource(this.el);
    this.elSource.connect(this.analyser);
    this.elSource.connect(this.ctx.destination);
    this.elSource.connect(this.recordDest);

    this.freq = new Float32Array(this.analyser.frequencyBinCount);
    this.time = new Float32Array(this.analyser.fftSize);
    this.setupBands();
  }

  private setupBands() {
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    const nBins = this.analyser.frequencyBinCount;
    const ratio = F_MAX / F_MIN;
    for (let b = 0; b < NB; b++) {
      const f0 = F_MIN * Math.pow(ratio, b / NB);
      const f1 = F_MIN * Math.pow(ratio, (b + 1) / NB);
      const fc = Math.sqrt(f0 * f1);
      this.bandCentre[b] = fc / binHz;
      this.bandLo[b] = Math.min(nBins - 1, Math.floor(f0 / binHz));
      this.bandHi[b] = Math.min(nBins, Math.max(this.bandLo[b] + 1, Math.ceil(f1 / binHz)));
      // Music falls off with frequency; tilt it so highs get a say.
      this.bandTilt[b] = 3.5 * Math.log2(fc / 1000);
    }
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  get playing(): boolean {
    if (this.mode === 'mic') return !this.hold;
    if (this.mode === 'file') return !this.el.paused && !this.el.ended;
    return false;
  }

  get duration(): number {
    return this.mode === 'file' && isFinite(this.el.duration) ? this.el.duration : 0;
  }

  get currentTime(): number {
    return this.mode === 'file' ? this.el.currentTime : 0;
  }

  /** Load a track. Decodes it once for the timeline and energy-mapped scanning. */
  async loadFile(file: File | Blob, name: string) {
    await this.resume();
    const buf = await file.arrayBuffer();
    const decoded = await this.ctx.decodeAudioData(buf.slice(0));
    this.stopMic();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    this.el.src = this.objectUrl;
    this.el.load();
    this.trackName = name;
    this.mode = 'file';
    this.analyseBuffer(decoded);
  }

  private analyseBuffer(b: AudioBuffer) {
    const hop = 1024;
    const n = Math.floor(b.length / hop);
    const env = new Float32Array(n);
    const chans: Float32Array[] = [];
    for (let c = 0; c < b.numberOfChannels; c++) chans.push(b.getChannelData(c));
    for (let i = 0; i < n; i++) {
      let sum = 0;
      const o = i * hop;
      for (let j = 0; j < hop; j++) {
        let s = 0;
        for (const ch of chans) s += ch[o + j];
        s /= chans.length;
        sum += s * s;
      }
      env[i] = Math.sqrt(sum / hop);
    }
    // Light smoothing so the scan moves with phrases, not individual samples
    const sm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let a = 0;
      let k = 0;
      for (let j = -3; j <= 3; j++) {
        const v = env[i + j];
        if (v !== undefined) {
          a += v;
          k++;
        }
      }
      sm[i] = a / k;
    }
    this.envelope = sm;
    this.envRate = b.sampleRate / hop;
    this.lut = null;
    this.lutElastic = -1;

    const bars = 480;
    const ov = new Float32Array(bars);
    let max = 1e-6;
    for (let i = 0; i < bars; i++) {
      const a = Math.floor((i / bars) * n);
      const z = Math.max(a + 1, Math.floor(((i + 1) / bars) * n));
      let m = 0;
      for (let j = a; j < z; j++) m = Math.max(m, env[j]);
      ov[i] = m;
      max = Math.max(max, m);
    }
    for (let i = 0; i < bars; i++) ov[i] /= max;
    this.overview = ov;
  }

  /**
   * Where the slit should be (0..1) at time t for a single pass of the track.
   * With elastic = 0 it moves at a constant rate. Higher values make it race
   * through loud passages and stall in quiet ones.
   */
  scanAt(t: number, elastic: number): number {
    const env = this.envelope;
    if (!env || env.length < 2) return this.duration ? t / this.duration : 0;
    if (!this.lut || Math.abs(this.lutElastic - elastic) > 1e-3) {
      let mean = 0;
      for (let i = 0; i < env.length; i++) mean += env[i];
      mean = mean / env.length || 1e-6;
      const p = elastic * 2.5;
      const lut = new Float32Array(env.length + 1);
      for (let i = 0; i < env.length; i++) lut[i + 1] = lut[i] + Math.pow(env[i] / mean + 0.03, p);
      const total = lut[env.length] || 1;
      for (let i = 0; i <= env.length; i++) lut[i] /= total;
      this.lut = lut;
      this.lutElastic = elastic;
    }
    const x = Math.max(0, Math.min(env.length, t * this.envRate));
    const i = Math.floor(x);
    const f = x - i;
    const a = this.lut[i];
    const b = this.lut[Math.min(env.length, i + 1)];
    return a + (b - a) * f;
  }

  async listInputs(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput');
  }

  /** Switch to a live input (mic or line-in). */
  async useMic(deviceId?: string) {
    await this.resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.stopMic();
    this.el.pause();
    this.micStream = stream;
    this.micSource = this.ctx.createMediaStreamSource(stream);
    this.micSource.connect(this.analyser);
    this.micSource.connect(this.recordDest);
    this.inputName = stream.getAudioTracks()[0]?.label || 'Input';
    this.mode = 'mic';
    this.hold = false;
    this.inputStartedAt = performance.now();
  }

  stopMic() {
    if (this.micSource) this.micSource.disconnect();
    if (this.micStream) for (const t of this.micStream.getTracks()) t.stop();
    this.micSource = null;
    this.micStream = null;
    if (this.mode === 'mic') this.mode = this.trackName ? 'file' : 'none';
  }

  /** Back to the loaded track after using the mic. */
  useTrack() {
    this.stopMic();
    this.mode = this.trackName ? 'file' : 'none';
  }

  async toggle() {
    if (this.mode === 'mic') {
      this.hold = !this.hold;
      return;
    }
    if (this.mode !== 'file') return;
    await this.resume();
    if (this.el.paused || this.el.ended) {
      if (this.el.ended) this.el.currentTime = 0;
      await this.el.play();
    } else {
      this.el.pause();
    }
  }

  seek(t: number) {
    if (this.mode !== 'file' || !this.duration) return;
    this.el.currentTime = Math.max(0, Math.min(this.duration - 0.01, t));
    this.seekCount++;
  }

  /** Analyse the current audio frame. Call once per animation frame. */
  update(dt: number) {
    const F = this.features;
    this.clock += dt;
    const active = this.mode === 'mic' || (this.mode === 'file' && !this.el.paused);
    const nBins = this.freq.length;

    if (active) {
      this.analyser.getFloatFrequencyData(this.freq);
      this.analyser.getFloatTimeDomainData(this.time);
    } else {
      this.freq.fill(-200);
      this.time.fill(0);
    }

    // Bands in dB, with tilt and auto-gain so any source fills the range.
    let peak = -200;
    for (let b = 0; b < NB; b++) {
      const lo = this.bandLo[b];
      const hi = this.bandHi[b];
      let mag: number;
      if (hi - lo <= 1) {
        // Narrow low bands: interpolate between neighbouring bins
        const x = Math.min(nBins - 1.001, this.bandCentre[b]);
        const i = Math.floor(x);
        const f = x - i;
        const m0 = dbToMag(this.freq[i]);
        const m1 = dbToMag(this.freq[i + 1]);
        mag = m0 + (m1 - m0) * f;
      } else {
        let s = 0;
        for (let i = lo; i < hi; i++) s += dbToMag(this.freq[i]);
        mag = s / (hi - lo);
      }
      const db = 20 * Math.log10(mag + 1e-12) + this.bandTilt[b] + this.gainDb;
      this.raw[b] = db;
      if (db > peak) peak = db;
    }
    // Peak follower: instant attack, slow release, with a floor so silence stays dark
    this.ref = Math.max(peak, this.ref - 6 * dt, -58);
    const range = 48;
    const atk = 1 - Math.exp(-dt / 0.012);
    const rel = 1 - Math.exp(-dt / 0.14);
    let flux = 0;
    for (let b = 0; b < NB; b++) {
      const v = clamp01((this.raw[b] - (this.ref - range)) / range);
      flux += Math.max(0, v - this.prevRaw[b]);
      this.prevRaw[b] = v;
      const cur = F.bands[b];
      F.bands[b] = cur + (v - cur) * (v > cur ? atk : rel);
    }
    flux /= NB;

    // ~30-160 Hz, 160 Hz-2.5 kHz, 2.5-16 kHz
    F.low = avgRange(F.bands, 0, 34);
    F.mid = avgRange(F.bands, 34, 90);
    F.high = avgRange(F.bands, 90, NB);

    // Loudness
    let sum = 0;
    for (let i = 0; i < this.time.length; i++) sum += this.time[i] * this.time[i];
    const rmsDb = 10 * Math.log10(sum / this.time.length + 1e-12) + this.gainDb;
    this.levelRef = Math.max(rmsDb, this.levelRef - 3 * dt, -42);
    const lv = clamp01((rmsDb - (this.levelRef - 30)) / 30);
    F.level += (lv - F.level) * (lv > F.level ? atk : rel);
    F.levelSlow += (F.level - F.levelSlow) * (1 - Math.exp(-dt / 4));
    F.lowSlow += (F.low - F.lowSlow) * (1 - Math.exp(-dt / 2));

    // Hits: spectral flux against an adaptive threshold
    let mean = 0;
    for (let i = 0; i < FLUX_HISTORY; i++) mean += this.flux[i];
    mean /= FLUX_HISTORY;
    let varc = 0;
    for (let i = 0; i < FLUX_HISTORY; i++) varc += (this.flux[i] - mean) ** 2;
    const std = Math.sqrt(varc / FLUX_HISTORY);
    this.flux[this.fluxIdx] = flux;
    this.fluxIdx = (this.fluxIdx + 1) % FLUX_HISTORY;
    const threshold = mean + 1.6 * std + 0.004;
    F.onset = false;
    if (active && flux > threshold && flux > 0.012 && this.clock - this.lastOnset > 0.09) {
      F.onset = true;
      F.onsetStrength = clamp01((flux - mean) / (5 * std + 0.03));
      this.lastOnset = this.clock;
      F.pulse = Math.max(F.pulse, 0.35 + 0.65 * F.onsetStrength);
    }
    F.pulse *= Math.exp(-dt / 0.16);
  }
}

function dbToMag(db: number): number {
  return isFinite(db) ? Math.pow(10, db / 20) : 0;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function avgRange(a: Float32Array, lo: number, hi: number): number {
  let s = 0;
  for (let i = lo; i < hi; i++) s += a[i];
  return s / (hi - lo);
}
