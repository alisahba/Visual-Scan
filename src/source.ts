// What gets scanned: a still image, a video file or the webcam.

export type SourceKind = 'none' | 'image' | 'video' | 'camera';

const MAX_STILL = 4096;

export class SourceManager {
  kind: SourceKind = 'none';
  name = '';
  width = 0;
  height = 0;
  /** Still image, ready for upload (downscaled if huge). */
  still: HTMLCanvasElement | HTMLImageElement | ImageBitmap | null = null;
  readonly video: HTMLVideoElement;
  private camStream: MediaStream | null = null;
  private objectUrl = '';
  private lastVideoTime = -1;
  private frameReady = false;
  private readonly hasFrameCallback: boolean;
  /** Bumped whenever the source changes, so the renderer knows to re-upload. */
  version = 0;

  constructor() {
    const v = document.createElement('video');
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.crossOrigin = 'anonymous';
    this.video = v;
    this.hasFrameCallback = 'requestVideoFrameCallback' in v;
    if (this.hasFrameCallback) {
      const tick = () => {
        this.frameReady = true;
        v.requestVideoFrameCallback(tick);
      };
      v.requestVideoFrameCallback(tick);
    }
  }

  get dynamic(): boolean {
    return this.kind === 'video' || this.kind === 'camera';
  }

  get flipX(): boolean {
    return this.kind === 'camera';
  }

  private stopVideo() {
    this.video.pause();
    if (this.camStream) for (const t of this.camStream.getTracks()) t.stop();
    this.camStream = null;
    this.video.srcObject = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = '';
    this.video.removeAttribute('src');
  }

  async loadImage(file: File | Blob, name: string) {
    const bmp = await createImageBitmap(file);
    this.setStill(bmp, bmp.width, bmp.height, name);
  }

  setStill(img: HTMLCanvasElement | HTMLImageElement | ImageBitmap, w: number, h: number, name: string) {
    this.stopVideo();
    const k = Math.min(1, MAX_STILL / Math.max(w, h));
    if (k < 1) {
      const c = document.createElement('canvas');
      c.width = Math.round(w * k);
      c.height = Math.round(h * k);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      img = c;
      w = c.width;
      h = c.height;
    }
    this.still = img;
    this.width = w;
    this.height = h;
    this.kind = 'image';
    this.name = name;
    this.version++;
  }

  async loadVideo(file: File, name: string) {
    this.stopVideo();
    this.objectUrl = URL.createObjectURL(file);
    const v = this.video;
    v.src = this.objectUrl;
    await waitFor(v, 'loadeddata');
    await v.play().catch(() => undefined);
    this.width = v.videoWidth;
    this.height = v.videoHeight;
    this.still = null;
    this.kind = 'video';
    this.name = name;
    this.version++;
  }

  async useCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    this.stopVideo();
    this.camStream = stream;
    const v = this.video;
    v.srcObject = stream;
    await waitFor(v, 'loadeddata');
    await v.play().catch(() => undefined);
    this.width = v.videoWidth;
    this.height = v.videoHeight;
    this.still = null;
    this.kind = 'camera';
    this.name = stream.getVideoTracks()[0]?.label || 'Camera';
    this.version++;
  }

  /** True when a new video frame is available since the last call. */
  takeNewFrame(): boolean {
    if (!this.dynamic || this.video.readyState < 2) return false;
    if (this.hasFrameCallback) {
      const r = this.frameReady;
      this.frameReady = false;
      return r;
    }
    const t = this.video.currentTime;
    if (t !== this.lastVideoTime) {
      this.lastVideoTime = t;
      return true;
    }
    return false;
  }

  /** Keep dimensions in sync (cameras can renegotiate). */
  syncSize(): boolean {
    if (!this.dynamic) return false;
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (w && h && (w !== this.width || h !== this.height)) {
      this.width = w;
      this.height = h;
      return true;
    }
    return false;
  }
}

function waitFor(el: HTMLElement, ev: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = () => {
      el.removeEventListener('error', bad);
      resolve();
    };
    const bad = () => {
      el.removeEventListener(ev, ok);
      reject(new Error('Could not load media'));
    };
    el.addEventListener(ev, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });
}
