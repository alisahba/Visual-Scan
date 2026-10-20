import { VERT, ACCUM_FRAG, DISPLAY_FRAG } from './shaders';
import { THREAD_ROWS } from './thread';

type Target = { tex: WebGLTexture; fbo: WebGLFramebuffer };

export interface StepUniforms {
  engine: number;
  bend: number;
  axis: number;
  wrap: boolean;
  head: number;
  from: number;
  to: number;
  wet: number;
  displace: number;
  slices: number;
  specMean: number;
  timeWarp: number;
  flipX: boolean;
}

export interface DisplayUniforms {
  colour: number;
  duoA: [number, number, number];
  duoB: [number, number, number];
  bg: [number, number, number];
  gridCol: [number, number, number];
  grid: boolean;
}

export const SPEC_BANDS = 128;
const HIST_N = 64;
const HIST_MAX = 640;

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  width = 0;
  height = 0;
  sweepRes = 1;

  private vao: WebGLVertexArrayObject;
  private accumProg: WebGLProgram;
  private displayProg: WebGLProgram;
  private accumU: Record<string, WebGLUniformLocation | null> = {};
  private displayU: Record<string, WebGLUniformLocation | null> = {};
  private targets: Target[] = [];
  private live: Target | null = null;
  private liveValid = false;
  private cur = 0;
  private floatTargets: boolean;

  private srcTex: WebGLTexture;
  private srcFbo: WebGLFramebuffer;
  srcW = 1;
  srcH = 1;
  private srcIsStill = true;

  private histTex: WebGLTexture;
  private histFbo: WebGLFramebuffer;
  private histW = 2;
  private histH = 2;
  histHead = 0;
  histCount = 0;

  private slitTex: WebGLTexture;
  private threadTex: WebGLTexture;
  private specTex: WebGLTexture;
  private specBytes = new Uint8Array(SPEC_BANDS * 3);

  readonly maxTex: number;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');

    this.vao = gl.createVertexArray()!;
    this.accumProg = this.program(VERT, ACCUM_FRAG);
    this.displayProg = this.program(VERT, DISPLAY_FRAG);
    for (const n of [
      'uPrev', 'uSource', 'uHistory', 'uSlit', 'uSpec', 'uRes', 'uAxis', 'uWrap', 'uHead',
      'uFrom', 'uTo', 'uWet', 'uLive', 'uSweepRes', 'uCrossPx', 'uSrcCrossPx', 'uCrossCrop',
      'uDisplace', 'uSlices', 'uSpecMean', 'uTimeWarp', 'uHistCount', 'uHistHead', 'uHistN', 'uFlipX',
      'uThread', 'uEngine', 'uBend',
    ]) this.accumU[n] = gl.getUniformLocation(this.accumProg, n);
    for (const n of ['uAccum', 'uRes', 'uColour', 'uDuoA', 'uDuoB', 'uBg', 'uGridCol', 'uGrid'])
      this.displayU[n] = gl.getUniformLocation(this.displayProg, n);

    // Source texture (still image or the current video frame)
    this.srcTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.texParams(gl.TEXTURE_2D, gl.LINEAR, gl.LINEAR, gl.CLAMP_TO_EDGE);
    this.srcFbo = gl.createFramebuffer()!;

    // Frame history for time warp (video and camera only)
    this.histTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.histTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 2, 2, HIST_N);
    this.texParams(gl.TEXTURE_2D_ARRAY, gl.LINEAR, gl.LINEAR, gl.CLAMP_TO_EDGE);
    this.histFbo = gl.createFramebuffer()!;

    this.slitTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.slitTex);
    this.texParams(gl.TEXTURE_2D, gl.NEAREST, gl.NEAREST, gl.CLAMP_TO_EDGE);

    this.threadTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.threadTex);
    this.texParams(gl.TEXTURE_2D, gl.NEAREST, gl.NEAREST, gl.CLAMP_TO_EDGE);

    this.specTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.specTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, SPEC_BANDS, 3, 0, gl.RED, gl.UNSIGNED_BYTE, this.specBytes);
    this.texParams(gl.TEXTURE_2D, gl.LINEAR, gl.LINEAR, gl.CLAMP_TO_EDGE);
  }

  private texParams(target: number, min: number, mag: number, wrap: number) {
    const gl = this.gl;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, mag);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, wrap);
  }

  private program(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('Shader error: ' + gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link error: ' + gl.getProgramInfoLog(p));
    return p;
  }

  /** Set the output resolution. Recreates (and clears) the canvas. */
  resize(w: number, h: number, sweepRes: number) {
    const gl = this.gl;
    w = Math.min(w, this.maxTex);
    h = Math.min(h, this.maxTex);
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.canvas.width = w;
      this.canvas.height = h;
      for (const t of [...this.targets, ...(this.live ? [this.live] : [])]) {
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fbo);
      }
      this.targets = [this.makeTarget(w, h), this.makeTarget(w, h)];
      this.live = this.makeTarget(w, h);
      this.cur = 0;
      this.clear();
    }
    this.setSweepRes(sweepRes);
  }

  setSweepRes(n: number) {
    n = Math.min(Math.max(1, Math.round(n)), this.maxTex);
    if (n === this.sweepRes) return;
    this.sweepRes = n;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.slitTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, 1, 0, gl.RGBA, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, this.threadTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, THREAD_ROWS, 0, gl.RGBA, gl.FLOAT, new Float32Array(n * THREAD_ROWS * 4));
  }

  /** Upload columns lo..hi of the map engine's thread data. */
  uploadThread(data: Float32Array, lo: number, hi: number) {
    if (hi < lo) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.threadTex);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, this.sweepRes);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, lo);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, lo, 0, hi - lo + 1, THREAD_ROWS, gl.RGBA, gl.FLOAT, data);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  }

  private makeTarget(w: number, h: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.floatTargets) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.texParams(gl.TEXTURE_2D, gl.NEAREST, gl.NEAREST, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo };
  }

  clear() {
    const gl = this.gl;
    this.liveValid = false;
    for (const t of this.targets) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Upload a still image. Builds mipmaps so tall sources stay crisp. */
  setStill(src: TexImageSource, w: number, h: number) {
    const gl = this.gl;
    this.srcW = w;
    this.srcH = h;
    this.srcIsStill = true;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.texParams(gl.TEXTURE_2D, gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR, gl.CLAMP_TO_EDGE);
    this.histCount = 0;
  }

  /** Upload the latest video/camera frame and push it into the time-warp history. */
  setFrame(src: TexImageSource, w: number, h: number, pushHistory: boolean) {
    const gl = this.gl;
    const sizeChanged = w !== this.srcW || h !== this.srcH || this.srcIsStill;
    this.srcW = w;
    this.srcH = h;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    if (sizeChanged) {
      // Fresh texture object so the old mip chain doesn't linger
      gl.deleteTexture(this.srcTex);
      this.srcTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
      this.texParams(gl.TEXTURE_2D, gl.LINEAR, gl.LINEAR, gl.CLAMP_TO_EDGE);
      this.srcIsStill = false;
      this.allocHistory(w, h);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (pushHistory) this.pushHistory();
  }

  private allocHistory(w: number, h: number) {
    const gl = this.gl;
    const k = Math.min(1, HIST_MAX / Math.max(w, h));
    this.histW = Math.max(2, Math.round(w * k));
    this.histH = Math.max(2, Math.round(h * k));
    gl.deleteTexture(this.histTex);
    this.histTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.histTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, this.histW, this.histH, HIST_N);
    this.texParams(gl.TEXTURE_2D_ARRAY, gl.LINEAR, gl.LINEAR, gl.CLAMP_TO_EDGE);
    this.histHead = 0;
    this.histCount = 0;
  }

  private pushHistory() {
    const gl = this.gl;
    this.histHead = (this.histHead + 1) % HIST_N;
    this.histCount = Math.min(HIST_N, this.histCount + 1);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.srcFbo);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.srcTex, 0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.histFbo);
    gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.histTex, 0, this.histHead);
    gl.blitFramebuffer(0, 0, this.srcW, this.srcH, 0, 0, this.histW, this.histH, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  uploadSlit(data: Float32Array) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.slitTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.sweepRes, 1, gl.RGBA, gl.FLOAT, data, 0);
  }

  /**
   * Rows: 0 = smoothed spectrum for the record, 1 = the same from last frame
   * (so columns swept in one frame interpolate), 2 = fast spectrum for the live edge.
   */
  uploadSpectrum(record: Float32Array, live: Float32Array) {
    const gl = this.gl;
    const b = this.specBytes;
    b.copyWithin(SPEC_BANDS, 0, SPEC_BANDS);
    for (let i = 0; i < SPEC_BANDS; i++) {
      b[i] = Math.max(0, Math.min(255, record[i] * 255));
      b[SPEC_BANDS * 2 + i] = Math.max(0, Math.min(255, live[i] * 255));
    }
    gl.bindTexture(gl.TEXTURE_2D, this.specTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SPEC_BANDS, 3, gl.RED, gl.UNSIGNED_BYTE, b);
  }

  /** Write freshly swept columns into the canvas, then draw the live wet edge. */
  step(u: StepUniforms) {
    this.pass(u, false);
    this.liveValid = u.wet > 0 && u.engine === 0;
    if (this.liveValid) this.pass(u, true);
  }

  private pass(u: StepUniforms, live: boolean) {
    const gl = this.gl;
    const src = this.targets[this.cur];
    const dst = live ? this.live! : this.targets[1 - this.cur];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.accumProg);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.histTex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.slitTex);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.specTex);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.threadTex);

    const U = this.accumU;
    gl.uniform1i(U.uPrev, 0);
    gl.uniform1i(U.uSource, 1);
    gl.uniform1i(U.uHistory, 2);
    gl.uniform1i(U.uSlit, 3);
    gl.uniform1i(U.uSpec, 4);
    gl.uniform1i(U.uThread, 5);
    gl.uniform1i(U.uEngine, u.engine);
    gl.uniform1f(U.uBend, u.bend);

    const w = this.width;
    const h = this.height;
    const flipAxis = u.axis === 1;
    let crossPx = flipAxis ? w : h;
    let srcCross = flipAxis ? this.srcW : this.srcH;
    if (u.axis === 2) crossPx = 0.5 * Math.hypot(w, h);
    // Cover-crop across the scan so the image keeps its proportions at rest.
    const srcAspect = flipAxis ? this.srcH / this.srcW : this.srcW / this.srcH;
    const outAspect = flipAxis ? h / w : w / h;
    const crop = srcAspect < outAspect ? srcAspect / outAspect : 1;

    gl.uniform2f(U.uRes, w, h);
    gl.uniform1i(U.uAxis, u.axis);
    gl.uniform1i(U.uWrap, u.wrap ? 1 : 0);
    gl.uniform1f(U.uHead, u.head);
    gl.uniform1f(U.uFrom, u.from);
    gl.uniform1f(U.uTo, u.to);
    gl.uniform1f(U.uWet, u.wet);
    gl.uniform1i(U.uLive, live ? 1 : 0);
    gl.uniform1i(U.uSweepRes, this.sweepRes);
    gl.uniform1f(U.uCrossPx, crossPx);
    gl.uniform1f(U.uSrcCrossPx, srcCross);
    gl.uniform1f(U.uCrossCrop, crop);
    gl.uniform1f(U.uDisplace, u.displace);
    gl.uniform1f(U.uSlices, u.slices);
    gl.uniform1f(U.uSpecMean, u.specMean);
    gl.uniform1f(U.uTimeWarp, this.histCount > 1 ? u.timeWarp : 0);
    gl.uniform1i(U.uHistCount, this.histCount);
    gl.uniform1i(U.uHistHead, this.histHead);
    gl.uniform1i(U.uHistN, HIST_N);
    gl.uniform1i(U.uFlipX, u.flipX ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!live) this.cur = 1 - this.cur;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Grade the canvas and draw it to the visible WebGL canvas. Pass clean = true to skip the live edge (for stills). */
  display(u: DisplayUniforms, clean = false) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.displayProg);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    const tex = this.liveValid && !clean && this.live ? this.live.tex : this.targets[this.cur].tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const U = this.displayU;
    gl.uniform1i(U.uAccum, 0);
    gl.uniform2f(U.uRes, this.width, this.height);
    gl.uniform1i(U.uColour, u.colour);
    gl.uniform3fv(U.uDuoA, u.duoA);
    gl.uniform3fv(U.uDuoB, u.duoB);
    gl.uniform3fv(U.uBg, u.bg);
    gl.uniform3fv(U.uGridCol, u.gridCol);
    gl.uniform1i(U.uGrid, u.grid ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
