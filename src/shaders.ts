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
