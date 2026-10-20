// PNG stills and video recording (canvas + audio).

type Downloads = { save(req: { filename: string; data: Blob }): Promise<unknown> };

/** When hosted on claude.ai, files go through the viewer's save prompt. */
let hostSave: Promise<Downloads | null> | null = null;
function getHostSave(): Promise<Downloads | null> {
  if (!hostSave) {
    const c = (window as unknown as { claude?: { use?: (n: string) => Promise<Downloads | null> } }).claude;
    hostSave = c?.use ? c.use('downloads').catch(() => null) : Promise.resolve(null);
  }
  return hostSave;
}
// Ask early so the first save isn't delayed
getHostSave();

export type SaveOutcome = 'saved' | 'declined' | 'failed';

export async function download(blob: Blob, filename: string): Promise<SaveOutcome> {
  const downloads = await getHostSave();
  if (downloads) {
    try {
      await downloads.save({ filename, data: blob });
      return 'saved';
    } catch (e) {
      const code = (e as { code?: string })?.code;
      return code === 'declined' ? 'declined' : 'failed';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'saved';
}

export function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const TYPES = [
  'video/mp4;codecs=avc1.640033,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mime = '';
  startedAt = 0;

  get active(): boolean {
    return this.rec?.state === 'recording';
  }

  static supported(): boolean {
    return typeof MediaRecorder !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
  }

  start(canvas: HTMLCanvasElement, audio: MediaStream) {
    const video = canvas.captureStream(60);
    const stream = new MediaStream([...video.getVideoTracks(), ...audio.getAudioTracks()]);
    this.mime = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const px = canvas.width * canvas.height;
    this.rec = new MediaRecorder(stream, {
      mimeType: this.mime || undefined,
      videoBitsPerSecond: px > 3e6 ? 45e6 : 18e6,
      audioBitsPerSecond: 256e3,
    });
    this.chunks = [];
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.rec.start(250);
    this.startedAt = performance.now();
  }

  stop(): Promise<{ blob: Blob; ext: string }> {
    return new Promise((resolve) => {
      const rec = this.rec;
      if (!rec) return resolve({ blob: new Blob(), ext: 'webm' });
      rec.onstop = () => {
        const type = rec.mimeType || this.mime || 'video/webm';
        const blob = new Blob(this.chunks, { type });
        for (const t of rec.stream.getTracks()) if (t.kind === 'video') t.stop();
        this.rec = null;
        resolve({ blob, ext: type.includes('mp4') ? 'mp4' : 'webm' });
      };
      rec.stop();
    });
  }
}
