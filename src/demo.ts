// Built-in demo material so the app works on first open:
// a procedurally drawn image and a short synthesised track (no samples, no licences).

export function demoImage(): HTMLCanvasElement {
  const W = 1600;
  const H = 1000;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;

  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#ecebe7');
  bg.addColorStop(1, '#b9b8b2');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);

  // Big type behind everything: slit-scanned letters turn into hard graphic bands
  g.fillStyle = '#111';
  g.font = '800 430px "Inter Tight Variable", "Helvetica Neue", Helvetica, Arial, sans-serif';
  g.textBaseline = 'alphabetic';
  g.fillText('SCAN', 40, 720);

  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const colours = ['#ff5a1f', '#ffc21a', '#ff4f9a', '#8f6bff', '#3ccf6a', '#1f5bff', '#f4f4f0', '#ff2a3d'];

  const balls: { x: number; y: number; r: number; col: string }[] = [];
  for (let i = 0; i < 30; i++) {
    balls.push({
      x: rnd() * W,
      y: 90 + rnd() * (H - 180),
      r: 40 + Math.pow(rnd(), 1.6) * 190,
      col: colours[Math.floor(rnd() * colours.length)],
    });
  }
  balls.sort((a, b) => a.r - b.r);
  for (const b of balls) sphere(g, b.x, b.y, b.r, b.col);

  // A thin rule and a caption, Swiss-poster style
  g.fillStyle = '#111';
  g.fillRect(40, 900, W - 80, 3);
  g.font = '600 28px "Inter Tight Variable", "Helvetica Neue", Helvetica, Arial, sans-serif';
  g.fillText('Visual Scan — Demo Image 01', 40, 950);
  return c;
}

function sphere(g: CanvasRenderingContext2D, x: number, y: number, r: number, col: string) {
  // Soft contact shadow
  g.save();
  g.globalAlpha = 0.18;
  g.fillStyle = '#000';
  g.beginPath();
  g.ellipse(x + r * 0.15, y + r * 0.95, r * 0.8, r * 0.18, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();

  const grad = g.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.05, x, y, r);
  grad.addColorStop(0, mix(col, '#ffffff', 0.65));
  grad.addColorStop(0.3, col);
  grad.addColorStop(1, mix(col, '#000000', 0.55));
  g.fillStyle = grad;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();

  // Specular highlight
  const hl = g.createRadialGradient(x - r * 0.38, y - r * 0.45, 0, x - r * 0.38, y - r * 0.45, r * 0.38);
  hl.addColorStop(0, 'rgba(255,255,255,0.85)');
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = hl;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

/** Render a ~60s track: intro, drop, break, second drop. Returns a WAV blob. */
export async function demoTrack(): Promise<Blob> {
  const sr = 44100;
  const bpm = 118;
  const beat = 60 / bpm;
  const bar = beat * 4;
  const bars = 28;
  const dur = bars * bar + 2.5;
  const ctx = new OfflineAudioContext(2, Math.ceil(sr * dur), sr);

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  comp.attack.value = 0.005;
  comp.release.value = 0.15;
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(comp).connect(ctx.destination);

  const noise = ctx.createBuffer(1, sr, sr);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  const env = (p: AudioParam, t: number, peak: number, a: number, d: number) => {
    p.setValueAtTime(0.0001, t);
    p.exponentialRampToValueAtTime(peak, t + a);
    p.exponentialRampToValueAtTime(0.0001, t + a + d);
  };

  const kick = (t: number, v = 1) => {
    const o = ctx.createOscillator();
    const gn = ctx.createGain();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    env(gn.gain, t, v, 0.002, 0.42);
    o.connect(gn).connect(master);
    o.start(t);
    o.stop(t + 0.5);
  };

  // Shared filter buses keep the graph small
  const bus = (type: BiquadFilterType, f: number, q: number, pan: number) => {
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = f;
    flt.Q.value = q;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    flt.connect(p).connect(master);
    return flt;
  };
  const snareBus = bus('bandpass', 1900, 0.7, 0);
  const hatBus = bus('highpass', 7800, 0.5, -0.2);
  const openHatBus = bus('highpass', 7800, 0.5, 0.25);

  const noiseHit = (t: number, out: AudioNode, v: number, d: number) => {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    const gn = ctx.createGain();
    env(gn.gain, t, v, 0.001, d);
    s.connect(gn).connect(out);
    s.start(t, Math.random() * 0.5);
    s.stop(t + d + 0.05);
  };

  const snare = (t: number, v = 0.6) => {
    noiseHit(t, snareBus, v, 0.2);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(210, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    const gn = ctx.createGain();
    env(gn.gain, t, v * 0.6, 0.001, 0.1);
    o.connect(gn).connect(master);
    o.start(t);
    o.stop(t + 0.15);
  };

  const hat = (t: number, v = 0.18, open = false) => noiseHit(t, open ? openHatBus : hatBus, v, open ? 0.22 : 0.035);

  const bass = (t: number, f: number, len: number, v = 0.35) => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.Q.value = 6;
    flt.frequency.setValueAtTime(1400, t);
    flt.frequency.exponentialRampToValueAtTime(180, t + len);
    const gn = ctx.createGain();
    env(gn.gain, t, v, 0.004, len);
    o.connect(flt).connect(gn).connect(master);
    o.start(t);
    o.stop(t + len + 0.05);
  };

  const pad = (t: number, freqs: number[], len: number, v = 0.06) => {
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(500, t);
    flt.frequency.linearRampToValueAtTime(1500, t + len * 0.6);
    flt.frequency.linearRampToValueAtTime(700, t + len);
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.linearRampToValueAtTime(v, t + 0.5);
    gn.gain.setValueAtTime(v, t + len - 0.2);
    gn.gain.linearRampToValueAtTime(0.0001, t + len + 0.6);
    flt.connect(gn).connect(master);
    for (const f of freqs) {
      for (const det of [-8, 8]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det;
        o.connect(flt);
        o.start(t);
        o.stop(t + len + 0.7);
      }
    }
  };

  const pluck = (t: number, f: number, v = 0.1) => {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(4200, t);
    flt.frequency.exponentialRampToValueAtTime(350, t + 0.22);
    const gn = ctx.createGain();
    env(gn.gain, t, v, 0.002, 0.26);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.sin(t * 3) * 0.6;
    o.connect(flt).connect(gn).connect(p).connect(master);
    o.start(t);
    o.stop(t + 0.32);
  };

  const chords = [
    { root: 55, notes: [220, 261.63, 329.63] },
    { root: 43.65, notes: [174.61, 220, 261.63] },
    { root: 65.41, notes: [261.63, 329.63, 392] },
    { root: 49, notes: [196, 246.94, 293.66] },
  ];

  // Notes are scheduled one bar ahead while rendering (via suspend), so only a
  // handful of nodes are alive at any time. Scheduling everything up front is
  // several times slower.
  const scheduleBar = (b: number) => {
    if (b >= bars) {
      if (b === bars) {
        kick(bars * bar + 0.05, 1);
        pad(bars * bar + 0.05, chords[0].notes, 1.2, 0.06);
      }
      return;
    }
    const t0 = b * bar + 0.05;
    const ch = chords[b % 4];
    const drop1 = b >= 8 && b < 16;
    const brk = b >= 16 && b < 20;
    const drop2 = b >= 20;
    const intro = b < 8;

    pad(t0, ch.notes, bar, brk ? 0.08 : 0.05);

    for (let s = 0; s < 16; s++) {
      const t = t0 + s * (beat / 4);
      const onBeat = s % 4 === 0;
      if ((drop1 || drop2) && onBeat) kick(t, 1);
      if ((drop1 || drop2) && (s === 4 || s === 12)) snare(t, 0.55);
      if ((drop1 || drop2 || (intro && b >= 4)) && s % 2 === 0) hat(t, onBeat ? 0.1 : 0.17);
      if (drop2 && s % 4 === 2) hat(t, 0.12, true);
      if ((drop1 || drop2) && s % 2 === 0 && s % 8 !== 6) bass(t, ch.root * (s % 8 === 4 ? 2 : 1), beat / 2.2);
      const arp = ch.notes[(s * 5 + b) % 3] * (s % 8 < 4 ? 2 : 1);
      if ((intro && b >= 4 && s % 4 === 0) || (brk && s % 2 === 0) || (drop2 && s % 2 === 1)) pluck(t, arp, brk ? 0.12 : 0.08);
    }
    // Riser into the second drop
    if (b === 19) {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      s.loop = true;
      const flt = ctx.createBiquadFilter();
      flt.type = 'bandpass';
      flt.frequency.setValueAtTime(400, t0);
      flt.frequency.exponentialRampToValueAtTime(9000, t0 + bar);
      const gn = ctx.createGain();
      gn.gain.setValueAtTime(0.0001, t0);
      gn.gain.exponentialRampToValueAtTime(0.35, t0 + bar);
      gn.gain.linearRampToValueAtTime(0.0001, t0 + bar + 0.05);
      s.connect(flt).connect(gn).connect(master);
      s.start(t0);
      s.stop(t0 + bar + 0.1);
    }
  };

  scheduleBar(0);
  scheduleBar(1);
  for (let b = 2; b <= bars; b++) {
    ctx.suspend((b - 1) * bar).then(() => {
      scheduleBar(b);
      ctx.resume();
    });
  }
  const buf = await ctx.startRendering();
  return toWav(buf);
}

function toWav(b: AudioBuffer): Blob {
  const ch = b.numberOfChannels;
  const n = b.length;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  out.setUint32(4, 36 + n * ch * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, ch, true);
  out.setUint32(24, b.sampleRate, true);
  out.setUint32(28, b.sampleRate * ch * 2, true);
  out.setUint16(32, ch * 2, true);
  out.setUint16(34, 16, true);
  w(36, 'data');
  out.setUint32(40, n * ch * 2, true);
  const data: Float32Array[] = [];
  for (let c = 0; c < ch; c++) data.push(b.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}
