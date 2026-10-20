// GLSL for the passes:
//  1. SCAN (commit): writes freshly swept columns into the canvas, once.
//  2. SCAN (live): draws the "wet edge" over the canvas without changing it.
//     The strip behind the head keeps reacting to the music, then fades into
//     the committed image.
//  3. DISPLAY: grades the result and draws it to screen.
// Everything works in "sweep space": s runs along the scan direction (0..1),
// c runs across it (0..1). Horizontal, vertical and radial axes are just
// different mappings into that space.

export const VERT = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const ACCUM_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uPrev;
uniform sampler2D uSource;
uniform sampler2DArray uHistory;
uniform highp sampler2D uSlit;   // per-column: r = slit pos, g = cross scale, b = cross offset, a = grain
uniform sampler2D uSpec;         // smoothed log spectrum, low -> high
uniform highp sampler2D uThread; // map engine: row 0 = (a, b), row 1 = (m, length px, written)
uniform int uEngine;             // 0 = scan, 1 = map
uniform float uBend;             // map engine: 0 = straight a->b, 1 = curve through m

uniform vec2 uRes;
uniform int uAxis;               // 0 horizontal, 1 vertical, 2 radial
uniform int uWrap;               // 1 = loop fill
uniform float uHead;              // write-head (live band hangs behind it)
uniform float uFrom;              // stretch swept this frame: uFrom -> uTo
uniform float uTo;
uniform float uWet;              // wet band width (sweep units)
uniform int uLive;               // 0 = commit fresh columns, 1 = live wet band
// uSpec rows: 0 = record (now), 1 = record (last frame), 2 = live
uniform int uSweepRes;
uniform float uCrossPx;          // output pixels across the scan
uniform float uSrcCrossPx;       // source pixels across the scan
uniform float uCrossCrop;        // cover-crop factor across the scan
uniform float uDisplace;
uniform float uSlices;
uniform float uSpecMean;
uniform float uTimeWarp;
uniform int uHistCount;
uniform int uHistHead;
uniform int uHistN;
uniform int uFlipX;

const float TAU = 6.28318530718;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float mirror(float x) { return 1.0 - abs(1.0 - mod(x, 2.0)); }


vec2 sweepCoords(vec2 uv) {
  if (uAxis == 0) return uv;
  if (uAxis == 1) return vec2(1.0 - uv.y, uv.x);
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float a = atan(p.x, p.y);                       // 0 at 12 o'clock, clockwise
  float rMax = 0.5 * length(vec2(aspect, 1.0));
  return vec2(fract(a / TAU), length(p) / rMax);
}

vec2 sourceUv(float ss, float cs) {
  vec2 uv = (uAxis == 1) ? vec2(cs, 1.0 - ss) : vec2(ss, cs);
  if (uFlipX == 1) uv.x = 1.0 - uv.x;
  return uv;
}

void main() {
  vec4 prev = texture(uPrev, vUv);
  vec2 sc = sweepCoords(vUv);
  float s = sc.x;
  float c = sc.y;

  float ref = (uLive == 1) ? uHead : uTo;
  float d;
  float delta;
  if (uWrap == 1) {
    d = fract(ref - s);
    delta = fract(uTo - uFrom);
  } else {
    d = ref - s;
    delta = max(uTo - uFrom, 0.0);
  }

  // Commit: fresh columns are written once. Live: the band behind the head is
  // re-sampled every frame and blended over the committed image.
  float w;
  if (d < 0.0) { outColor = prev; return; }
  if (uLive == 0) {
    if (d >= delta) { outColor = prev; return; }
    w = 1.0;
  } else {
    if (d >= uWet) { outColor = prev; return; }
    float k = 1.0 - d / uWet;
    w = k * sqrt(k);
  }

  int col = clamp(int(s * float(uSweepRes)), 0, uSweepRes - 1);

  // Map engine: the column is the image along the line between two picks
  // (a -> b), bent through the middle pick m. Top of the column = a.
  if (uEngine == 1) {
    vec4 ab = texelFetch(uThread, ivec2(col, 0), 0);
    vec4 mm = texelFetch(uThread, ivec2(col, 1), 0);
    if (mm.w < 0.5) { outColor = prev; return; }
    float t = clamp(1.0 - c, 0.0, 1.0);
    vec2 a = ab.xy;
    vec2 b = ab.zw;
    vec2 mid = 0.5 * (a + b);
    vec2 ctrl = mix(mid, 2.0 * mm.xy - mid, uBend);   // quadratic that passes through m
    vec2 tuv = mix(mix(a, ctrl, t), mix(ctrl, b, t), t);
    tuv = vec2(mirror(tuv.x), mirror(tuv.y));
    float tlod = max(0.0, log2(max(mm.z / uCrossPx, 1e-4)));
    vec3 tc = textureLod(uSource, tuv, tlod).rgb;
    outColor = mix(prev, vec4(tc, 1.0), w);
    return;
  }

  vec4 slit = texelFetch(uSlit, ivec2(col, 0), 0);

  // Slices quantise the cross axis into bands that move as blocks.
  float cb = c;
  if (uSlices >= 1.0) cb = (floor(c * uSlices) + 0.5) / uSlices;
  float spec;
  if (uLive == 1) {
    spec = texture(uSpec, vec2(cb, 2.5 / 3.0)).r;
  } else {
    // Columns swept in one frame blend from last frame's spectrum to this one's
    float t = delta > 0.0 ? clamp(d / delta, 0.0, 1.0) : 0.0;
    spec = mix(texture(uSpec, vec2(cb, 0.5 / 3.0)).r, texture(uSpec, vec2(cb, 1.5 / 3.0)).r, t);
  }

  // Spectrum pushes each row along the scan: loud bands lead, quiet ones lag.
  float dx = uDisplace * (spec - uSpecMean) * 0.45;

  // Sparse glitch rows from the highs.
  float row = floor(c * uCrossPx * 0.5);
  float h1 = hash(vec2(row, float(col)));
  float h2 = hash(vec2(float(col), row + 17.0));
  dx += slit.a * step(0.9, h1) * (h2 - 0.5) * 0.25;

  float crop = (uAxis == 2) ? 1.0 : uCrossCrop;
  float cs = mirror(0.5 + (c - 0.5) * slit.g * crop + slit.b);
  float ss = mirror(slit.r + dx);
  vec2 suv = sourceUv(ss, cs);

  // Choose mip level from the cross axis only, so hard jumps along the scan
  // don't blur the result.
  float lod = max(0.0, log2(max(uSrcCrossPx * slit.g * crop / uCrossPx, 1e-4)));

  vec3 colr;
  if (uTimeWarp > 0.001 && uHistCount > 1) {
    float delay = clamp(uTimeWarp * mix(c, spec, 0.55), 0.0, 1.0) * float(uHistCount - 1);
    float f = floor(delay);
    float fr = delay - f;
    int l0 = (uHistHead - int(f) + uHistN * 4) % uHistN;
    int l1 = (uHistHead - int(f) - 1 + uHistN * 4) % uHistN;
    vec3 a = texture(uHistory, vec3(suv, float(l0))).rgb;
    vec3 b = texture(uHistory, vec3(suv, float(l1))).rgb;
    colr = mix(a, b, fr);
  } else {
    colr = textureLod(uSource, suv, lod).rgb;
  }

  outColor = mix(prev, vec4(colr, 1.0), w);
}`;

export const DISPLAY_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uAccum;
uniform vec2 uRes;
uniform int uColour;     // 0 source, 1 mono, 2 duo
uniform vec3 uDuoA;
uniform vec3 uDuoB;
uniform vec3 uBg;
uniform vec3 uGridCol;
uniform int uGrid;

void main() {
  vec4 a = texture(uAccum, vUv);
  vec3 col = a.a > 0.0 ? a.rgb / a.a : vec3(0.0);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  if (uColour == 1) col = vec3(smoothstep(0.03, 0.97, l));
  else if (uColour == 2) col = mix(uDuoA, uDuoB, smoothstep(0.02, 0.98, l));

  vec3 bg = uBg;
  if (uGrid == 1) {
    vec2 px = vUv * uRes;
    vec2 cell = uRes / vec2(12.0, 8.0);
    vec2 g = abs(fract(px / cell + 0.5) - 0.5) * cell;
    float line = 1.0 - step(0.75, min(g.x, g.y));
    bg = mix(bg, uGridCol, line);
  }
  outColor = vec4(mix(bg, col, a.a), 1.0);
}`;

// ───────── Paint engine ─────────
// Strokes are instanced quads. Every fragment snaps to the centre of its grain
// cell and tests that point against the stroke, so a whole cell is in or out
// and takes one colour: crisp big pixels that refine as the grain shrinks.

export const STROKE_VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec4 aPQ;   // P.xy, Q.xy in canvas px
layout(location = 1) in vec4 aUV;   // P.uv, Q.uv in the source
layout(location = 2) in vec2 aWC;   // half width px (negative = square block of that half size), cell px
uniform vec2 uRes;
out vec2 vPos;
flat out vec4 vPQ;
flat out vec4 vUV;
flat out vec2 vWC;
void main() {
  int c = gl_VertexID % 6;
  vec2 k = vec2((c == 1 || c == 2 || c == 4) ? 1.0 : 0.0, (c == 2 || c == 4 || c == 5) ? 1.0 : 0.0);
  vec2 P = aPQ.xy;
  vec2 Q = aPQ.zw;
  vec2 d = Q - P;
  float L = length(d);
  vec2 dir = L > 1e-4 ? d / L : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float pad = abs(aWC.x) + aWC.y * 1.5;
  vec2 pos = mix(P - dir * pad, Q + dir * pad, k.x) + nrm * pad * (k.y * 2.0 - 1.0);
  vPos = pos;
  vPQ = aPQ;
  vUV = aUV;
  vWC = aWC;
  gl_Position = vec4(pos / uRes * 2.0 - 1.0, 0.0, 1.0);
}`;

export const STROKE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vPos;
flat in vec4 vPQ;
flat in vec4 vUV;
flat in vec2 vWC;
out vec4 outColor;
uniform sampler2D uSource;
uniform sampler2D uCanvas;
uniform vec2 uRes;
uniform vec2 uCover;      // source uv span visible on the canvas
uniform float uSrcPerPx;  // source pixels per canvas pixel
uniform int uInk;         // 0 colour, 1 clone, 2 smear

float mirror(float x) { return 1.0 - abs(1.0 - mod(x, 2.0)); }

void main() {
  float cell = vWC.y;
  vec2 cc = (floor(vPos / cell) + 0.5) * cell;
  vec2 P = vPQ.xy;
  vec2 Q = vPQ.zw;
  vec2 pq = Q - P;
  float L2 = dot(pq, pq);
  float t = L2 > 1e-6 ? clamp(dot(cc - P, pq) / L2, 0.0, 1.0) : 0.0;
  if (vWC.x < 0.0) {
    // Square block (kick stamps, hat sparks)
    vec2 o = abs(cc - P);
    if (max(o.x, o.y) > max(-vWC.x, cell * 0.5)) discard;
  } else {
    float d = length(cc - (P + pq * t));
    if (d > max(vWC.x, cell * 0.72)) discard;
  }

  // Sample at the grain's scale: big cells take the average colour of their area
  float lod = log2(max(cell * uSrcPerPx, 1.0));
  vec3 col;
  if (uInk == 0) {
    // Colour: a gradient between the two picked pixels
    col = mix(textureLod(uSource, vUV.xy, lod).rgb, textureLod(uSource, vUV.zw, lod).rgb, t);
  } else if (uInk == 1) {
    // Clone: the stroke carries the image from one step back along the walk
    vec2 suv = 0.5 + (cc / uRes - 0.5) * uCover - (vUV.zw - vUV.xy);
    col = textureLod(uSource, vec2(mirror(suv.x), mirror(suv.y)), lod).rgb;
  } else {
    // Smear: drags the canvas's own colours from P to Q
    col = mix(texture(uCanvas, P / uRes).rgb, texture(uCanvas, Q / uRes).rgb, t);
  }
  outColor = vec4(col, 1.0);
}`;

/** Fill the canvas with the source image (cover-fitted). */
export const FILL_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSource;
uniform vec2 uCover;
uniform float uLod;
void main() {
  vec2 suv = 0.5 + (vUv - 0.5) * uCover;
  outColor = vec4(textureLod(uSource, suv, uLod).rgb, 1.0);
}`;
