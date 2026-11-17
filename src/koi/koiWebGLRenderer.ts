import type { KoiFish, KoiPondConfig, PondPalette } from './koiTypes';
import type { PondWorld } from './pondWorld';
import { koiClamp } from './koiMath';

function parseCssHexToRgb01(hex: string, out: Float32Array, offset: number): void {
  const clean = hex.trim().replace('#', '');
  let r = 255;
  let g = 255;
  let b = 255;
  if (clean.length === 3) {
    r = parseInt(clean[0] + clean[0], 16);
    g = parseInt(clean[1] + clean[1], 16);
    b = parseInt(clean[2] + clean[2], 16);
  } else if (clean.length >= 6) {
    r = parseInt(clean.slice(0, 2), 16);
    g = parseInt(clean.slice(2, 4), 16);
    b = parseInt(clean.slice(4, 6), 16);
  }
  out[offset] = r / 255;
  out[offset + 1] = g / 255;
  out[offset + 2] = b / 255;
}

const FULLSCREEN_VERT = `#version 300 es
precision highp float;
void main() {
  vec2 pos = vec2(
    (gl_VertexID == 1) ? 3.0 : -1.0,
    (gl_VertexID == 2) ? 3.0 : -1.0
  );
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

const SUBRECT_BATCH_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_gridPos;
uniform vec2 u_gridSize; // dCols, dRows
void main() {
  vec2 ndc = (a_gridPos / u_gridSize) * 2.0 - 1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

const WATER_CELL_FRAG = `#version 300 es
precision highp float;
precision highp int;

uniform int u_cols;
uniform int u_rows;
uniform float u_cellW;
uniform float u_cellH;
uniform float u_time;
uniform int u_showWater;
uniform int u_hasTerrain;
uniform int u_rippleCount;
uniform vec4 u_ripples[16]; // x, y, radius, strength
uniform highp sampler2D u_wakeTex;

out vec4 fragColor;

float hash2D(int ix, int iy, int seed) {
  uint n = uint(ix) * 374761393u + uint(iy) * 668265263u + uint(seed) * 1442695041u;
  n = n ^ (n >> 13u);
  n = n * 1274126177u;
  n = n ^ (n >> 16u);
  return float(n) * (1.0 / 4294967296.0);
}

float valueNoise2D(float x, float y, int seed) {
  int ix = int(floor(x));
  int iy = int(floor(y));
  float fx = x - float(ix);
  float fy = y - float(iy);
  float ux = fx * fx * (3.0 - 2.0 * fx);
  float uy = fy * fy * (3.0 - 2.0 * fy);

  float n00 = hash2D(ix, iy, seed);
  float n10 = hash2D(ix + 1, iy, seed);
  float n01 = hash2D(ix, iy + 1, seed);
  float n11 = hash2D(ix + 1, iy + 1, seed);

  float nx0 = n00 + (n10 - n00) * ux;
  float nx1 = n01 + (n11 - n01) * ux;
  return nx0 + (nx1 - nx0) * uy;
}

float fbm2D(float x, float y, int seed) {
  float v1 = valueNoise2D(x, y, seed);
  float v2 = valueNoise2D(x * 2.13 + 17.3, y * 2.13 - 9.7, seed + 101);
  return (v1 * 0.68 + v2 * 0.32) * 2.0 - 1.0;
}

float koiSmoothstep(float edge0, float edge1, float x) {
  float t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

void main() {
  if (u_showWater == 0) {
    fragColor = vec4(0.0);
    return;
  }
  ivec2 cell = ivec2(gl_FragCoord.xy);
  int col = cell.x;
  int row = cell.y;
  float wx = (float(col) + 0.5) * u_cellW;
  float wy = (float(row) + 0.5) * u_cellH;

  float rippleIntensity = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= u_rippleCount) break;
    vec4 r = u_ripples[i];
    float dist = length(vec2(wx - r.x, wy - r.y));
    float ringDelta = abs(dist - r.z);
    if (ringDelta < 16.0) {
      float wave = cos((ringDelta / 16.0) * 1.57079632679) * r.w;
      if (wave > rippleIntensity) rippleIntensity = wave;
    }
  }

  if (rippleIntensity > 0.18) {
    float tone = 0.3 + rippleIntensity * 0.55;
    fragColor = vec4(tone, 1.0, 0.0, 1.0);
    return;
  }

  if (u_hasTerrain != 0) {
    float nx = float(col) / float(max(1, u_cols));
    float ny = float(row) / float(max(1, u_rows));
    float slowT = u_time * 0.04;
    float warp = fbm2D(nx * 3.6 + slowT, ny * 3.2 - slowT * 0.7, 31);
    float fineNoise = valueNoise2D(float(col) * 0.18, float(row) * 0.18, 97);

    float shoreCurve = 0.47 - 0.09 * sin(ny * 3.14159265359 * 1.35 - 0.2) + 0.08 * warp;
    float rightProgress = (nx - shoreCurve) / max(1e-5, 1.0 - shoreCurve);

    if (rightProgress > -0.14) {
      float d1 = length(vec2((nx - 0.67) / 0.16, (ny - 0.38) / 0.24));
      float mound1 = max(0.0, 1.0 - d1 * d1 * 0.68);

      float d2 = length(vec2((nx - 0.6) / 0.17, (ny - 0.66) / 0.22));
      float mound2 = max(0.0, 1.0 - d2 * d2 * 0.72);

      float d3 = length(vec2((nx - 0.84) / 0.18, (ny - 0.18) / 0.24));
      float mound3 = max(0.0, 1.0 - d3 * d3 * 0.75);

      float d4 = length(vec2((nx - 0.92) / 0.14, (ny - 0.72) / 0.26));
      float mound4 = max(0.0, 1.0 - d4 * d4 * 0.75);

      float baseShelf = koiSmoothstep(-0.12, 0.22, rightProgress) * 0.44;
      float ridgePeak = max(max(mound1, mound2 * 0.94), max(mound3 * 0.78, mound4 * 0.82));
      float elev = clamp(baseShelf + ridgePeak * 0.58 + warp * 0.14, 0.0, 1.15);

      float pocketHash = hash2D(col >> 1, row >> 1, 53);

      if (elev >= 0.04 && elev < 0.12) {
        if (pocketHash > 0.32) {
          fragColor = vec4(0.12, 1.0 / 5.0, 0.0, 1.0);
          return;
        }
        fragColor = vec4(0.0);
        return;
      }

      if (elev >= 0.12) {
        if (elev < 0.74 && pocketHash < 0.22 && fineNoise < 0.48) {
          fragColor = vec4(0.26, 3.0 / 5.0, 0.0, 1.0);
          return;
        }
        if (elev >= 0.86) {
          fragColor = vec4(0.50, 4.0 / 5.0, 0.0, 1.0);
          return;
        }
        if (elev >= 0.72) {
          fragColor = vec4(0.42, 4.0 / 5.0, 0.0, 1.0);
          return;
        }
        if (elev >= 0.54) {
          fragColor = vec4(0.34, 3.0 / 5.0, 0.0, 1.0);
          return;
        }
        if (elev >= 0.38) {
          fragColor = vec4(0.26, 3.0 / 5.0, 0.0, 1.0);
          return;
        }
        if (elev >= 0.24) {
          fragColor = vec4(0.20, 2.0 / 5.0, 0.0, 1.0);
          return;
        }
        fragColor = vec4(0.16, 2.0 / 5.0, 0.0, 1.0);
        return;
      }
    }
  }

  float wake = texelFetch(u_wakeTex, cell, 0).r;
  if (wake > 0.22) {
    fragColor = vec4(0.16 + wake * 0.22, 2.0 / 5.0, 0.0, 1.0);
    return;
  }

  fragColor = vec4(0.0);
}
`;

const WATER_LATTICE_FRAG = `#version 300 es
precision highp float;
precision highp int;

uniform int u_cols;
uniform int u_rows;
uniform float u_cellW;
uniform float u_cellH;
uniform float u_a;
uniform sampler2D u_waterCellTex;

out vec4 fragColor;

float hash2D(int ix, int iy, int seed) {
  uint n = uint(ix) * 374761393u + uint(iy) * 668265263u + uint(seed) * 1442695041u;
  n = n ^ (n >> 13u);
  n = n * 1274126177u;
  n = n ^ (n >> 16u);
  return float(n) * (1.0 / 4294967296.0);
}

void main() {
  ivec2 dc = ivec2(gl_FragCoord.xy);
  int c = dc.x;
  int r = dc.y;
  float px = u_a * 2.0;
  float py = u_a;
  float shift = float(r & 1) * u_a;

  int row = min(u_rows - 1, int(floor((float(r) * py) / u_cellH)));
  int col = min(u_cols - 1, int(floor((float(c) * px + shift) / u_cellW)));

  vec4 cell = texelFetch(u_waterCellTex, ivec2(col, row), 0);
  if (cell.g <= 0.01) {
    fragColor = vec4(0.0);
    return;
  }
  float wt = clamp(cell.r * (0.86 + 0.28 * hash2D(c, r, 17)), 0.0, 1.0);
  if (wt < 0.04) {
    fragColor = vec4(0.0);
    return;
  }
  fragColor = vec4(wt, cell.g, 1.0 / 5.0, 1.0);
}
`;

const MINNOW_LATTICE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_minnow; // c, r, tone
uniform vec2 u_gridSize; // dCols, dRows
out float v_tone;
void main() {
  v_tone = clamp(a_minnow.z, 0.0, 1.0);
  vec2 ndc = ((a_minnow.xy + 0.5) / u_gridSize) * 2.0 - 1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

const MINNOW_LATTICE_FRAG = `#version 300 es
precision highp float;
in float v_tone;
out vec4 fragColor;
void main() {
  fragColor = vec4(v_tone, 1.0, 2.0 / 5.0, 1.0);
}
`;

const KOI_EVAL_FRAG = `#version 300 es
precision highp float;
precision highp int;

uniform float u_a;
uniform int u_koiCount;
uniform int u_detailQuality; // 0 = low, 1 = medium, 2 = high
uniform int u_showScales;
uniform vec4 u_koiBBoxes[4];
uniform highp sampler2D u_koiDataTex;
uniform sampler2D u_baseLatticeTex;

out vec4 fragColor;

float hash2DU(int ix, int iy, uint seed) {
  uint n = uint(ix) * 374761393u + uint(iy) * 668265263u + seed * 1442695041u;
  n = n ^ (n >> 13u);
  n = n * 1274126177u;
  n = n ^ (n >> 16u);
  return float(n) * (1.0 / 4294967296.0);
}

float valueNoise2DU(float x, float y, uint seed) {
  int ix = int(floor(x));
  int iy = int(floor(y));
  float fx = x - float(ix);
  float fy = y - float(iy);
  float ux = fx * fx * (3.0 - 2.0 * fx);
  float uy = fy * fy * (3.0 - 2.0 * fy);

  float n00 = hash2DU(ix, iy, seed);
  float n10 = hash2DU(ix + 1, iy, seed);
  float n01 = hash2DU(ix, iy + 1, seed);
  float n11 = hash2DU(ix + 1, iy + 1, seed);

  float nx0 = n00 + (n10 - n00) * ux;
  float nx1 = n01 + (n11 - n01) * ux;
  return nx0 + (nx1 - nx0) * uy;
}

float fbm2DU(float x, float y, uint seed) {
  float v1 = valueNoise2DU(x, y, seed);
  float v2 = valueNoise2DU(x * 2.13 + 17.3, y * 2.13 - 9.7, seed + 101u);
  return (v1 * 0.68 + v2 * 0.32) * 2.0 - 1.0;
}

float koiSmoothstep(float edge0, float edge1, float x) {
  float t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

float koiBodyHalfWidth(float s, float maxHalfWidth) {
  if (s < 0.0 || s > 0.845) return 0.0;
  if (s < 0.25) {
    float t = s / 0.25;
    float base = pow(t, 0.52) * (0.94 + 0.06 * sin(t * 3.14159265359));
    return maxHalfWidth * clamp(base, 0.0, 1.0);
  }
  if (s < 0.38) {
    float t = (s - 0.25) / 0.13;
    return maxHalfWidth * (1.0 - 0.03 * t * t);
  }
  float t = clamp((s - 0.38) / 0.465, 0.0, 1.0);
  float peduncleRatio = 0.175;
  float curve = (1.0 - t) * (1.0 - 0.36 * t * t) + peduncleRatio * (t * t * (3.0 - 2.0 * t));
  return maxHalfWidth * clamp(curve * 0.97, peduncleRatio * 0.9, 1.0);
}

float shadedCssLuminance(vec3 rgb, float shade, float highlightBoost, float sumiWeight) {
  vec3 c = clamp(rgb, 0.0, 255.0);
  c = mix(c, vec3(68.0, 82.0, 98.0), clamp(sumiWeight, 0.0, 1.0));
  float light = clamp(0.64 + shade * 0.42, 0.5, 1.12);
  float spec = clamp(highlightBoost, 0.0, 0.45) * 54.0;
  vec3 q = clamp(c * light + spec, 0.0, 255.0);
  return (0.2126 * q.r + 0.7152 * q.g + 0.0722 * q.b) / 255.0;
}

float ptSegDistSq(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  vec2 ap = p - a;
  float t = clamp(dot(ap, ab) / max(1e-6, dot(ab, ab)), 0.0, 1.0);
  vec2 d = p - (a + ab * t);
  return dot(d, d);
}

vec3 evalSingleKoi(int k, float wx, float wy) {
  vec4 p0 = texelFetch(u_koiDataTex, ivec2(20, k), 0);
  float bodyLength = p0.x;
  float maxHalfWidth = p0.y;
  float finSpanFactor = p0.z;
  float tailLengthFactor = p0.w;

  vec2 pt = vec2(wx, wy);
  vec4 n0 = texelFetch(u_koiDataTex, ivec2(0, k), 0);
  vec4 n6 = texelFetch(u_koiDataTex, ivec2(6, k), 0);
  vec4 n13 = texelFetch(u_koiDataTex, ivec2(13, k), 0);
  vec4 n19 = texelFetch(u_koiDataTex, ivec2(19, k), 0);
  vec2 tailEnd = n19.xy - n19.zw * (bodyLength * 0.25 * tailLengthFactor);

  float d0 = ptSegDistSq(pt, n0.xy, n6.xy);
  float d1 = ptSegDistSq(pt, n6.xy, n13.xy);
  float d2 = ptSegDistSq(pt, n13.xy, n19.xy);
  float d3 = ptSegDistSq(pt, n19.xy, tailEnd);

  float r0 = maxHalfWidth * (0.96 + 1.35 * finSpanFactor) + 10.0;
  float r1 = maxHalfWidth * (1.04 + 0.60 * finSpanFactor) + 10.0;
  float r2 = maxHalfWidth * 1.00 + 10.0;
  float r3 = maxHalfWidth * 1.20 * finSpanFactor + 10.0;

  bool near0 = d0 <= r0 * r0;
  bool near1 = d1 <= r1 * r1;
  bool near2 = (d2 <= r2 * r2) || (d3 <= r3 * r3);
  if (!near0 && !near1 && !near2) {
    return vec3(0.0);
  }

  vec4 p1 = texelFetch(u_koiDataTex, ivec2(21, k), 0);
  vec4 p2 = texelFetch(u_koiDataTex, ivec2(22, k), 0);
  float phase = p1.x;
  float finPhase = p1.y;
  float curvature = p1.z;
  float speedRatio = p1.w;
  int varietyAndMoto = int(p2.y + 0.5);
  int varietyId = varietyAndMoto & 3;
  bool hasMotoguro = (varietyAndMoto & 4) != 0;
  uint fishSeed = uint(p2.z + 0.5) | (uint(p2.w + 0.5) << 16u);

  int startSeg = near0 ? 0 : (near1 ? 5 : 12);
  int endSeg = near2 ? 19 : (near1 ? 14 : 7);

  float bestDistSq = 1e20;
  int bestSeg = startSeg;
  float bestT = 0.0;
  vec4 prevNode = (startSeg == 0) ? n0 : texelFetch(u_koiDataTex, ivec2(startSeg, k), 0);
  vec4 nodeA = prevNode;
  vec4 nodeB = prevNode;

  for (int i = startSeg; i < endSeg; i++) {
    vec4 nextNode = texelFetch(u_koiDataTex, ivec2(i + 1, k), 0);
    vec2 ab = nextNode.xy - prevNode.xy;
    vec2 ap = pt - prevNode.xy;
    float abLenSq = max(1e-6, dot(ab, ab));
    float t = clamp(dot(ap, ab) / abLenSq, 0.0, 1.0);
    vec2 closest = prevNode.xy + ab * t;
    vec2 diff = pt - closest;
    float dSq = dot(diff, diff);
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestSeg = i;
      bestT = t;
      nodeA = prevNode;
      nodeB = nextNode;
    }
    prevNode = nextNode;
  }

  vec2 cPos = mix(nodeA.xy, nodeB.xy, bestT);
  vec2 tVec = normalize(mix(nodeA.zw, nodeB.zw, bestT));
  vec2 nVec = vec2(-tVec.y, tVec.x);

  vec2 rVec = pt - cPos;
  float d = dot(rVec, nVec);
  float s = ((float(bestSeg) + bestT) / 19.0) * 0.83;

  if (bestSeg == 0 && bestT <= 0.0) {
    vec2 hDiff = pt - n0.xy;
    float forwardProj = dot(hDiff, n0.zw);
    if (forwardProj > 0.0) {
      s = -forwardProj / bodyLength;
      d = dot(hDiff, vec2(-n0.w, n0.z));
      tVec = n0.zw;
    }
  } else if (bestSeg == 18 && bestT >= 1.0) {
    vec2 tDiff = pt - n19.xy;
    float backProj = -dot(tDiff, n19.zw);
    if (backProj > 0.0) {
      s = 0.83 + backProj / bodyLength;
      d = dot(tDiff, vec2(-n19.w, n19.z));
      tVec = n19.zw;
    }
  }

  float absD = abs(d);
  if (absD > maxHalfWidth * 2.22 * finSpanFactor) {
    return vec3(0.0);
  }

  float hw = koiBodyHalfWidth(s, maxHalfWidth);

  int part = 0; // 0=none, 1=pelvic, 2=body/head, 3=dorsal, 4=pectoral, 5=caudal
  float cov = 0.0;
  float hitS = 0.0;
  float hitU = 0.0;
  float hitShade = 0.0;
  float finSpanU = 0.0;
  float finChordV = 0.0;

  if (s >= 0.0 && s <= 0.835 && hw > 0.5 && absD <= hw) {
    float u = clamp(d / hw, -1.0, 1.0);
    float absU = abs(u);
    float nz = sqrt(max(0.04, 1.0 - u * u * 0.88));
    float snoutBias = (s < 0.18) ? (0.18 - s) * 2.2 : 0.0;
    float worldNx = nVec.x * u * 0.72 - tVec.x * snoutBias;
    float worldNy = nVec.y * u * 0.72 - tVec.y * snoutBias;
    float diffuse = clamp(worldNx * -0.32 + worldNy * -0.38 + nz * 0.86, 0.18, 1.0);
    float edgeSoftness = koiSmoothstep(1.0, 0.84, absU);

    if (s >= 0.35 && s <= 0.67) {
      float dorsalProgress = (s - 0.35) / 0.32;
      float swayU = sin(phase - s * 2.2) * 0.08 * (0.4 + dorsalProgress * 0.6) - clamp(curvature * 0.14, -0.15, 0.15);
      float ridgeDist = abs(u - swayU * 0.65);
      float ridgeHalfWidth = 0.11 + 0.04 * sin(dorsalProgress * 3.14159265359);
      if (ridgeDist <= ridgeHalfWidth) {
        part = 3;
        cov = 0.96;
        hitS = s;
        hitU = u;
        hitShade = clamp(diffuse + 0.14, 0.4, 1.0);
        finSpanU = 1.0 - ridgeDist / ridgeHalfWidth;
        finChordV = dorsalProgress;
      }
    }
    if (part == 0) {
      part = 2;
      cov = clamp(0.45 + 0.55 * edgeSoftness, 0.35, 1.0);
      hitS = s;
      hitU = u;
      hitShade = diffuse;
    }
  }

  if (part == 0 && s >= 0.14 && s <= 0.43) {
    vec4 attachNode = texelFetch(u_koiDataTex, ivec2(5, k), 0);
    vec2 attachN = vec2(-attachNode.w, attachNode.z);
    float side = (d >= 0.0) ? 1.0 : -1.0;
    float attachHw = koiBodyHalfWidth((5.0 / 19.0) * 0.83, maxHalfWidth) * 0.88;
    vec2 root = attachNode.xy + attachN * (side * attachHw);

    float flutter = sin(finPhase + side * 0.9) * 0.075;
    float turnOffset = clamp(curvature * side * -0.1, -0.12, 0.12);
    float baseAngle = atan(attachN.y * side, attachN.x * side) + side * (0.48 + flutter + turnOffset);

    float fCos = cos(baseAngle);
    float fSin = sin(baseAngle);
    float cCos = -fSin * side;
    float cSin = fCos * side;

    vec2 dxy = pt - root;
    float spanDist = dxy.x * fCos + dxy.y * fSin;
    float chordDist = dxy.x * cCos + dxy.y * cSin;
    float maxSpan = maxHalfWidth * 1.28 * finSpanFactor;

    if (spanDist >= -maxSpan * 0.06 && spanDist <= maxSpan) {
      float sU = clamp(spanDist / maxSpan, 0.0, 1.0);
      float envelope = sin(pow(sU, 0.68) * 3.14159265359);
      float halfChord = bodyLength * 0.064 * finSpanFactor * (0.32 + 0.68 * envelope);
      float chordCenter = sU * bodyLength * 0.025;
      float localChord = chordDist - chordCenter;
      if (abs(localChord) <= halfChord) {
        float cV = (localChord / max(1e-5, halfChord) + 1.0) * 0.5;
        float tipFade = koiSmoothstep(1.0, 0.72, sU);
        float rimFade = koiSmoothstep(1.0, 0.78, abs(localChord) / max(1e-5, halfChord));
        part = 4;
        cov = clamp(0.32 + 0.62 * tipFade * rimFade, 0.28, 0.92);
        hitS = 0.24;
        hitU = side * (1.0 + sU);
        hitShade = clamp(0.62 + 0.28 * (1.0 - sU) + 0.1 * (1.0 - cV), 0.45, 0.98);
        finSpanU = sU;
        finChordV = cV;
      }
    }
  }

  if (part == 0 && s >= 0.45 && s <= 0.6 && absD > hw * 0.92) {
    float pelvicMaxSpan = maxHalfWidth * 0.54 * finSpanFactor;
    float spanDist = absD - hw * 0.9;
    if (spanDist >= 0.0 && spanDist <= pelvicMaxSpan) {
      float sU = spanDist / pelvicMaxSpan;
      float sCenter = 0.515 + sU * 0.03;
      float halfS = 0.038 * sin(pow(sU, 0.65) * 3.14159265359 + 0.25);
      if (abs(s - sCenter) <= halfS) {
        part = 1;
        cov = clamp(0.3 + 0.52 * (1.0 - sU), 0.25, 0.82);
        hitS = s;
        hitU = ((d >= 0.0) ? 1.0 : -1.0) * (1.0 + sU * 0.6);
        hitShade = 0.68 * (1.0 - sU * 0.3);
        finSpanU = sU;
        finChordV = (s - (sCenter - halfS)) / max(1e-5, 2.0 * halfS);
      }
    }
  }

  if (part == 0 && s >= 0.79 && s <= 1.16) {
    vec2 tDir = -n19.zw;
    vec2 nDir = vec2(-tDir.y, tDir.x);
    vec2 dxy = pt - n19.xy;
    float tailX = dot(dxy, tDir);
    float tailLen = bodyLength * 0.25 * tailLengthFactor;

    if (tailX >= -bodyLength * 0.025 && tailX <= tailLen) {
      float uLen = clamp(tailX / tailLen, 0.0, 1.0);
      float speedFactor = clamp(speedRatio, 0.35, 1.25);
      float sweepLag =
        sin(phase - 2.1 - uLen * 1.65) * maxHalfWidth * 0.46 * (0.45 + 0.55 * speedFactor) * pow(uLen, 1.25) +
        clamp(curvature, -1.0, 1.0) * maxHalfWidth * 0.32 * pow(uLen, 1.4);

      float tailY = dot(dxy, nDir) - sweepLag;
      float absTailY = abs(tailY);
      float outerSpan = maxHalfWidth * (0.18 + 0.78 * sin(pow(uLen, 0.65) * 3.14159265359 * 0.84)) * finSpanFactor;

      float innerFork = 0.0;
      if (uLen > 0.34) {
        float forkT = (uLen - 0.34) / 0.66;
        innerFork = outerSpan * 0.56 * pow(forkT, 1.32);
      }

      float lobeMidY = (innerFork + outerSpan) * 0.5;
      float lobeHalfW = max(1.0, (outerSpan - innerFork) * 0.5);
      float lobeLocalY = (absTailY - lobeMidY) / lobeHalfW;
      float maxTipULen = (uLen > 0.58) ? (1.0 - 0.22 * lobeLocalY * lobeLocalY) : 1.0;

      if (absTailY <= outerSpan && absTailY >= innerFork && uLen <= maxTipULen) {
        float lobeFill = 1.0 - min(1.0, abs(lobeLocalY));
        float veilFade = clamp(1.0 - uLen * 0.34, 0.36, 0.94);
        part = 5;
        cov = veilFade * koiSmoothstep(0.0, 0.24, lobeFill);
        hitS = 0.83 + uLen * 0.17;
        hitU = clamp(tailY / max(1e-5, outerSpan), -1.0, 1.0);
        hitShade = clamp(0.68 + lobeFill * 0.24 - uLen * 0.16, 0.44, 0.96);
        finSpanU = uLen;
        finChordV = clamp((absTailY - innerFork) / max(1e-5, outerSpan - innerFork), 0.0, 1.0);
      }
    }
  }

  if (part == 0 || cov <= 0.04) {
    return vec3(0.0);
  }

  float edgeRaw = clamp((cov - 0.06) / 0.8, 0.0, 1.0);
  float edge = edgeRaw * edgeRaw * (3.0 - 2.0 * edgeRaw);

  vec4 cBase = texelFetch(u_koiDataTex, ivec2(24, k), 0);
  vec4 cHi = texelFetch(u_koiDataTex, ivec2(25, k), 0);
  vec4 cSumi = texelFetch(u_koiDataTex, ivec2(26, k), 0);
  vec4 cShiro = texelFetch(u_koiDataTex, ivec2(27, k), 0);

  if (part == 1 || part == 4 || part == 5) {
    float rayCount = (part == 5) ? 9.0 : 11.0;
    float rayWave = sin(finChordV * rayCount * 3.14159265359);
    float lum = cBase.w;
    if (part == 4 && hasMotoguro) {
      lum = mix(lum, cHi.w, koiSmoothstep(0.44, 0.30, finSpanU));
    } else if (varietyId == 1 && finSpanU < 0.72) {
      lum = mix(lum, cHi.w, koiSmoothstep(0.11, 0.05, abs(finChordV - 0.48)));
    } else if (part == 5 && (varietyId == 0 || varietyId == 2) && abs(hitU) < 0.46) {
      lum = mix(lum, cSumi.w, koiSmoothstep(0.38, 0.24, finSpanU));
    }
    float dens = 1.0 - lum;
    float tone = (0.14 + 0.5 * dens) * (0.45 + 0.55 * edge);
    float outerFade = min(koiSmoothstep(0.92, 0.72, finSpanU), koiSmoothstep(0.28, 0.48, cov));
    tone *= mix(0.6, 1.0, outerFade);
    tone *= mix(0.64, 1.44, koiSmoothstep(-0.12, 0.36, rayWave));
    tone = clamp(tone, 0.0, 0.85);
    if (tone <= 0.04) return vec3(0.0);
    return vec3(tone, 5.0, 3.0);
  }

  vec3 surfRgb = cBase.rgb;
  float sumiWeight = (varietyId == 2) ? 1.0 : 0.0;
  int patchCount = int(cShiro.w + 0.5);

  // Smoothly feathered organic patches so dark Sumi/Hi diamonds never pop or flicker across lattice cells
  if (patchCount > 0 && hitS >= 0.02 && hitS <= 0.85) {
    float warp = fbm2DU(hitS * 9.5, hitU * 3.8, fishSeed);
    for (int pIdx = 0; pIdx < 8; pIdx++) {
      if (pIdx >= patchCount) break;
      vec4 geom = texelFetch(u_koiDataTex, ivec2(28 + pIdx, k), 0);
      vec4 meta = texelFetch(u_koiDataTex, ivec2(36 + pIdx, k), 0);
      float ds = (hitS - geom.x) / geom.z;
      float du = (hitU - geom.y) / geom.w;
      float distSq = ds * ds + du * du;
      if (distSq > 2.4) continue;
      float dist = sqrt(distSq) + warp * meta.x;
      float pBlend = koiSmoothstep(1.08, 0.82, dist);
      if (pBlend > 0.001) {
        int lyr = int(meta.y + 0.5);
        vec3 targetRgb = (lyr == 0) ? cShiro.rgb : ((lyr == 1) ? cHi.rgb : cSumi.rgb);
        float targetSumi = (lyr == 2) ? 1.0 : 0.0;
        surfRgb = mix(surfRgb, targetRgb, pBlend);
        sumiWeight = mix(sumiWeight, targetSumi, pBlend);
      }
    }
  }

  float dorsalRidge = max(0.0, 1.0 - abs(hitU) * 1.45);
  float highlightBoost = pow(dorsalRidge, 3.2) * 0.2;

  float cssLum = shadedCssLuminance(surfRgb, hitShade, highlightBoost, sumiWeight);
  float dens = clamp(1.0 - cssLum, 0.0, 1.0);
  float tone = 0.22 + 0.78 * pow(dens, 0.9);
  tone *= edge;
  // Smooth rim boost only on pale shiro areas so dark Sumi/Hi dots never jump at cov = 0.70
  float paleRim = koiSmoothstep(0.18, 0.36, cov) * koiSmoothstep(0.76, 0.52, cov) * (1.0 - dens * 0.85) * 0.11;
  tone += paleRim;
  tone = clamp(tone, 0.0, 1.0);
  if (tone <= 0.04) return vec3(0.0);

  float pri = (part == 3) ? 5.0 : 4.0;
  return vec3(tone, 5.0, pri);
}

void main() {
  ivec2 dc = ivec2(gl_FragCoord.xy);
  vec4 base = texelFetch(u_baseLatticeTex, dc, 0);
  float bestTone = base.r;
  float bestInk = floor(base.g * 5.0 + 0.5);
  float bestPri = floor(base.b * 5.0 + 0.5);

  float px = u_a * 2.0;
  float py = u_a;
  float wx = float(dc.x) * px + float(dc.y & 1) * u_a;
  float wy = float(dc.y) * py;

  for (int k = 0; k < 4; k++) {
    if (k >= u_koiCount) break;
    vec4 bb = u_koiBBoxes[k];
    if (wx < bb.x || wx > bb.z || wy < bb.y || wy > bb.w) continue;
    vec3 hit = evalSingleKoi(k, wx, wy);
    if (hit.z > 0.0) {
      if (hit.z > bestPri || (hit.z == bestPri && hit.x > bestTone)) {
        bestTone = hit.x;
        bestInk = hit.y;
        bestPri = hit.z;
      }
    }
  }

  fragColor = vec4(bestTone, bestInk / 5.0, bestPri / 5.0, 1.0);
}
`;

const KOI_OUTLINE_FRAG = `#version 300 es
precision highp float;
precision highp int;

uniform int u_dCols;
uniform int u_dRows;
uniform sampler2D u_rawLatticeTex;

out vec4 fragColor;

void main() {
  ivec2 dc = ivec2(gl_FragCoord.xy);
  vec4 center = texelFetch(u_rawLatticeTex, dc, 0);
  int pri = int(floor(center.b * 5.0 + 0.5));
  if (pri != 1 || center.r <= 0.0) {
    fragColor = center;
    return;
  }

  int c = dc.x;
  int r = dc.y;
  bool odd = (r & 1) == 1;
  int lo = odd ? c : (c - 1);
  int hi = odd ? (c + 1) : c;

  for (int k = 0; k < 6; k++) {
    int nr = r;
    int nc = c;
    if (k == 0) nc = c - 1;
    else if (k == 1) nc = c + 1;
    else if (k < 4) {
      nr = r - 1;
      nc = (k == 2) ? lo : hi;
    } else {
      nr = r + 1;
      nc = (k == 4) ? lo : hi;
    }
    if (nr < 0 || nr >= u_dRows || nc < 0 || nc >= u_dCols) continue;
    vec4 nb = texelFetch(u_rawLatticeTex, ivec2(nc, nr), 0);
    int nPri = int(floor(nb.b * 5.0 + 0.5));
    if (nPri >= 3 && nb.r > 0.30) {
      fragColor = vec4(0.0, 0.0, 1.0 / 5.0, 1.0);
      return;
    }
  }

  fragColor = center;
}
`;

/**
 * Pass 6: Full-screen analytical diamond SDF shader.
 * Draws a single full-screen triangle every frame so no partial tile or box boundaries can ever appear.
 */
const SCREEN_SDF_VERT = `#version 300 es
precision highp float;

uniform vec2 u_viewSize;
uniform float u_inv2a;

out vec2 v_worldPos;
out vec2 v_uvRot;

void main() {
  vec2 clip = vec2(
    (gl_VertexID == 1) ? 3.0 : -1.0,
    (gl_VertexID == 2) ? -3.0 : 1.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  vec2 uv = vec2(clip.x * 0.5 + 0.5, 0.5 - clip.y * 0.5);
  vec2 worldPos = uv * u_viewSize;
  v_worldPos = worldPos;
  v_uvRot = vec2(worldPos.x + worldPos.y, worldPos.x - worldPos.y) * u_inv2a + 0.5;
}
`;

const SCREEN_SDF_FRAG = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_latticeTex;
uniform ivec2 u_latticeSize;
uniform float u_a;
uniform float u_aaL1;
uniform float u_fade;
uniform float u_veilAlpha;
uniform vec3 u_bgTop;
uniform vec3 u_bgBottom;
uniform float u_viewHeight;
uniform int u_isSimpleBg;

in vec2 v_worldPos;
in vec2 v_uvRot;
out vec4 fragColor;

void main() {
  vec3 bg = (u_isSimpleBg != 0)
    ? vec3(1.0)
    : mix(u_bgTop, u_bgBottom, clamp(v_worldPos.y / max(1.0, u_viewHeight), 0.0, 1.0));

  ivec2 ij = ivec2(floor(v_uvRot));
  int r = ij.x - ij.y;
  int c = (ij.x + ij.y - (r & 1)) >> 1;

  if (c < 0 || r < 0 || c >= u_latticeSize.x || r >= u_latticeSize.y) {
    vec3 outBg = mix(bg, vec3(1.0), u_veilAlpha);
    fragColor = vec4(outBg, 1.0);
    return;
  }

  vec4 dotData = texelFetch(u_latticeTex, ivec2(c, r), 0);
  if (dotData.g <= 0.01 || dotData.r <= 0.01) {
    vec3 outBg = mix(bg, vec3(1.0), u_veilAlpha);
    fragColor = vec4(outBg, 1.0);
    return;
  }

  vec2 center = vec2(float(ij.x + ij.y), float(r)) * u_a;
  float manhattan = abs(v_worldPos.x - center.x) + abs(v_worldPos.y - center.y);
  float h = u_a * (0.16 + 0.82 * clamp(dotData.r, 0.0, 1.0));
  float diff = manhattan - h;

  if (diff >= u_aaL1) {
    vec3 outBg = mix(bg, vec3(1.0), u_veilAlpha);
    fragColor = vec4(outBg, 1.0);
    return;
  }

  float cov = (1.0 - smoothstep(-u_aaL1, u_aaL1, diff)) * u_fade;
  float gray = 1.0 - dotData.g;
  vec3 color = mix(bg, vec3(gray), cov);
  color = mix(color, vec3(1.0), u_veilAlpha);
  fragColor = vec4(color, 1.0);
}
`;

export class WebGLDotMatrixRenderer {
  private glCanvas: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private contextLost = false;
  private failedInit = false;
  private mountedParent: HTMLElement | null = null;

  private waterCellProg: WebGLProgram | null = null;
  private waterLatticeProg: WebGLProgram | null = null;
  private minnowLatticeProg: WebGLProgram | null = null;
  private koiEvalProg: WebGLProgram | null = null;
  private koiOutlineProg: WebGLProgram | null = null;
  private screenSdfProg: WebGLProgram | null = null;

  private emptyVao: WebGLVertexArrayObject | null = null;
  private minnowVao: WebGLVertexArrayObject | null = null;
  private minnowVbo: WebGLBuffer | null = null;
  private subRectVao: WebGLVertexArrayObject | null = null;
  private subRectVbo: WebGLBuffer | null = null;

  private wakeTex: WebGLTexture | null = null;
  private koiDataTex: WebGLTexture | null = null;
  private waterCellTex: WebGLTexture | null = null;
  private waterCellFbo: WebGLFramebuffer | null = null;
  private waterLatticeTex: WebGLTexture | null = null;
  private waterLatticeFbo: WebGLFramebuffer | null = null;
  private baseLatticeTex: WebGLTexture | null = null;
  private baseLatticeFbo: WebGLFramebuffer | null = null;
  private rawLatticeTex: WebGLTexture | null = null;
  private rawLatticeFbo: WebGLFramebuffer | null = null;
  private liveLatticeTex: WebGLTexture | null = null;
  private liveLatticeFbo: WebGLFramebuffer | null = null;

  private texCols = 0;
  private texRows = 0;
  private texDCols = 0;
  private texDRows = 0;

  private waterKey = '';
  private waterTime = -Infinity;
  private lastMinnowKey = NaN;

  private readonly koiDataBuf = new Float32Array(768);
  private readonly koiBBoxUniformBuf = new Float32Array(16);
  private readonly minnowDataBuf = new Float32Array(1536);
  private readonly rippleDataBuf = new Float32Array(64);
  private readonly subRectVertBuf = new Float32Array(4 * 6 * 2);
  private readonly bgTopRgb = new Float32Array(3);
  private readonly bgBottomRgb = new Float32Array(3);
  private readonly prevTopRgb = new Float32Array(3);
  private readonly prevBottomRgb = new Float32Array(3);

  private readonly koiSubRects = Array.from({ length: 4 }, () => ({
    minC: 0,
    minR: 0,
    maxC: 0,
    maxR: 0
  }));

  private readonly uniformCache = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();

  public get isAvailable(): boolean {
    return !this.failedInit && !this.contextLost;
  }

  public setVisible(visible: boolean): void {
    if (!this.glCanvas) return;
    const next = visible ? 'block' : 'none';
    if (this.glCanvas.style.display !== next) {
      this.glCanvas.style.display = next;
    }
  }

  public destroy(): void {
    if (this.glCanvas) {
      this.glCanvas.removeEventListener('webglcontextlost', this.onContextLost);
      this.glCanvas.removeEventListener('webglcontextrestored', this.onContextRestored);
      this.glCanvas.remove();
      this.glCanvas = null;
    }
    this.gl = null;
    this.uniformCache.clear();
  }

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
    this.setVisible(false);
  };

  private onContextRestored = (): void => {
    this.contextLost = false;
    this.waterKey = '';
    this.waterTime = -Infinity;
    this.lastMinnowKey = NaN;
    this.texCols = 0;
    this.texRows = 0;
    this.texDCols = 0;
    this.texDRows = 0;
    if (this.gl) {
      this.initGLResources(this.gl);
    }
  };

  private ensureContext(hostCanvas: HTMLCanvasElement): WebGL2RenderingContext | null {
    if (this.failedInit || this.contextLost) return null;
    if (typeof document === 'undefined') return null;

    if (!this.glCanvas) {
      const c = document.createElement('canvas');
      c.className = 'bp-webgl-pond-canvas';
      c.setAttribute('aria-hidden', 'true');
      Object.assign(c.style, {
        position: 'fixed',
        inset: '0',
        width: '100%',
        height: '100%',
        display: 'none',
        pointerEvents: 'none',
        zIndex: '0',
        touchAction: 'none'
      });
      c.addEventListener('webglcontextlost', this.onContextLost, false);
      c.addEventListener('webglcontextrestored', this.onContextRestored, false);
      this.glCanvas = c;
    }

    const parent = hostCanvas.parentElement ?? document.body;
    if (this.mountedParent !== parent && this.glCanvas) {
      if (hostCanvas.nextSibling) {
        parent.insertBefore(this.glCanvas, hostCanvas.nextSibling);
      } else {
        parent.appendChild(this.glCanvas);
      }
      this.mountedParent = parent;
    }

    if (!this.gl && this.glCanvas) {
      const gl = this.glCanvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance'
      });
      if (!gl) {
        this.failedInit = true;
        return null;
      }
      this.gl = gl;
      if (!this.initGLResources(gl)) {
        this.failedInit = true;
        this.gl = null;
        return null;
      }
    }

    return this.gl;
  }

  private compileProgram(
    gl: WebGL2RenderingContext,
    vsSource: string,
    fsSource: string
  ): WebGLProgram | null {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return null;

    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);
    gl.shaderSource(fs, fsSource);
    gl.compileShader(fs);

    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);

    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
  }

  private getUniform(
    gl: WebGL2RenderingContext,
    prog: WebGLProgram,
    name: string
  ): WebGLUniformLocation | null {
    let map = this.uniformCache.get(prog);
    if (!map) {
      map = new Map<string, WebGLUniformLocation | null>();
      this.uniformCache.set(prog, map);
    }
    if (map.has(name)) {
      return map.get(name) ?? null;
    }
    const loc = gl.getUniformLocation(prog, name);
    map.set(name, loc);
    return loc;
  }

  private createTex2D(
    gl: WebGL2RenderingContext,
    internalFormat: number,
    w: number,
    h: number
  ): WebGLTexture | null {
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, Math.max(1, w), Math.max(1, h));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private initGLResources(gl: WebGL2RenderingContext): boolean {
    this.uniformCache.clear();
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    this.waterCellProg = this.compileProgram(gl, FULLSCREEN_VERT, WATER_CELL_FRAG);
    this.waterLatticeProg = this.compileProgram(gl, FULLSCREEN_VERT, WATER_LATTICE_FRAG);
    this.minnowLatticeProg = this.compileProgram(gl, MINNOW_LATTICE_VERT, MINNOW_LATTICE_FRAG);
    this.koiEvalProg = this.compileProgram(gl, SUBRECT_BATCH_VERT, KOI_EVAL_FRAG);
    this.koiOutlineProg = this.compileProgram(gl, SUBRECT_BATCH_VERT, KOI_OUTLINE_FRAG);
    this.screenSdfProg = this.compileProgram(gl, SCREEN_SDF_VERT, SCREEN_SDF_FRAG);

    if (
      !this.waterCellProg ||
      !this.waterLatticeProg ||
      !this.minnowLatticeProg ||
      !this.koiEvalProg ||
      !this.koiOutlineProg ||
      !this.screenSdfProg
    ) {
      return false;
    }

    this.emptyVao = gl.createVertexArray();
    this.minnowVao = gl.createVertexArray();
    this.minnowVbo = gl.createBuffer();
    this.subRectVao = gl.createVertexArray();
    this.subRectVbo = gl.createBuffer();
    if (
      !this.emptyVao ||
      !this.minnowVao ||
      !this.minnowVbo ||
      !this.subRectVao ||
      !this.subRectVbo
    ) {
      return false;
    }

    gl.bindVertexArray(this.minnowVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.minnowVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.minnowDataBuf.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.vertexAttribDivisor(0, 0);

    gl.bindVertexArray(this.subRectVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.subRectVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.subRectVertBuf.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);

    gl.bindVertexArray(null);

    this.koiDataTex = this.createTex2D(gl, gl.RGBA32F, 48, 4);
    return !!this.koiDataTex;
  }

  private ensureTextures(
    gl: WebGL2RenderingContext,
    cols: number,
    rows: number,
    dCols: number,
    dRows: number
  ): boolean {
    if (cols !== this.texCols || rows !== this.texRows) {
      if (this.wakeTex) gl.deleteTexture(this.wakeTex);
      if (this.waterCellTex) gl.deleteTexture(this.waterCellTex);
      if (this.waterCellFbo) gl.deleteFramebuffer(this.waterCellFbo);

      this.wakeTex = this.createTex2D(gl, gl.R32F, cols, rows);
      this.waterCellTex = this.createTex2D(gl, gl.RGBA8, cols, rows);
      this.waterCellFbo = gl.createFramebuffer();
      if (!this.wakeTex || !this.waterCellTex || !this.waterCellFbo) return false;

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.waterCellFbo);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.waterCellTex,
        0
      );

      this.texCols = cols;
      this.texRows = rows;
      this.waterKey = '';
    }

    if (dCols !== this.texDCols || dRows !== this.texDRows) {
      if (this.waterLatticeTex) gl.deleteTexture(this.waterLatticeTex);
      if (this.waterLatticeFbo) gl.deleteFramebuffer(this.waterLatticeFbo);
      if (this.baseLatticeTex) gl.deleteTexture(this.baseLatticeTex);
      if (this.baseLatticeFbo) gl.deleteFramebuffer(this.baseLatticeFbo);
      if (this.rawLatticeTex) gl.deleteTexture(this.rawLatticeTex);
      if (this.rawLatticeFbo) gl.deleteFramebuffer(this.rawLatticeFbo);
      if (this.liveLatticeTex) gl.deleteTexture(this.liveLatticeTex);
      if (this.liveLatticeFbo) gl.deleteFramebuffer(this.liveLatticeFbo);

      this.waterLatticeTex = this.createTex2D(gl, gl.RGBA8, dCols, dRows);
      this.waterLatticeFbo = gl.createFramebuffer();
      this.baseLatticeTex = this.createTex2D(gl, gl.RGBA8, dCols, dRows);
      this.baseLatticeFbo = gl.createFramebuffer();
      this.rawLatticeTex = this.createTex2D(gl, gl.RGBA8, dCols, dRows);
      this.rawLatticeFbo = gl.createFramebuffer();
      this.liveLatticeTex = this.createTex2D(gl, gl.RGBA8, dCols, dRows);
      this.liveLatticeFbo = gl.createFramebuffer();

      if (
        !this.waterLatticeTex ||
        !this.waterLatticeFbo ||
        !this.baseLatticeTex ||
        !this.baseLatticeFbo ||
        !this.rawLatticeTex ||
        !this.rawLatticeFbo ||
        !this.liveLatticeTex ||
        !this.liveLatticeFbo
      ) {
        return false;
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.waterLatticeFbo);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.waterLatticeTex,
        0
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.baseLatticeFbo);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.baseLatticeTex,
        0
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.rawLatticeFbo);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.rawLatticeTex,
        0
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.liveLatticeFbo);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.liveLatticeTex,
        0
      );

      this.texDCols = dCols;
      this.texDRows = dRows;
      this.waterKey = '';
      this.lastMinnowKey = NaN;
    }

    return true;
  }

  /**
   * Packs Koi parameters into u_koiDataTex and computes 1 generous unclipped bounding box per fish
   * so no sub-rect clipping seam or white box corner can ever occur.
   */
  private packKoiData(
    koiList: KoiFish[],
    dCols: number,
    dRows: number,
    px: number,
    py: number
  ): number {
    const buf = this.koiDataBuf;
    const count = Math.min(4, koiList.length);
    let subRectCount = 0;

    for (let k = 0; k < count; k++) {
      const fish = koiList[k];
      const rowBase = k * 48 * 4;

      let minX = fish.bbox.minX;
      let minY = fish.bbox.minY;
      let maxX = fish.bbox.maxX;
      let maxY = fish.bbox.maxY;
      const pecReach = fish.maxHalfWidth * (0.95 + 1.38 * fish.finSpanFactor) + 8;

      for (let i = 0; i < 20; i++) {
        const node = fish.spine[i];
        const idx = rowBase + i * 4;
        buf[idx] = node.x;
        buf[idx + 1] = node.y;
        buf[idx + 2] = node.tx;
        buf[idx + 3] = node.ty;

        if (node.x - pecReach < minX) minX = node.x - pecReach;
        if (node.y - pecReach < minY) minY = node.y - pecReach;
        if (node.x + pecReach > maxX) maxX = node.x + pecReach;
        if (node.y + pecReach > maxY) maxY = node.y + pecReach;
      }

      const tailNode = fish.spine[19];
      const tailLen = fish.bodyLength * 0.28 * fish.tailLengthFactor;
      const tailReach = fish.maxHalfWidth * 1.55 * fish.finSpanFactor + 8;
      const tailEndX = tailNode.x - tailNode.tx * tailLen;
      const tailEndY = tailNode.y - tailNode.ty * tailLen;

      minX = Math.min(minX, tailEndX - tailReach);
      minY = Math.min(minY, tailEndY - tailReach);
      maxX = Math.max(maxX, tailEndX + tailReach);
      maxY = Math.max(maxY, tailEndY + tailReach);

      const rect = this.koiSubRects[subRectCount++];
      rect.minC = koiClamp(Math.floor(minX / px) - 4, 0, dCols - 1);
      rect.maxC = koiClamp(Math.ceil(maxX / px) + 4, 0, dCols - 1);
      rect.minR = koiClamp(Math.floor(minY / py) - 4, 0, dRows - 1);
      rect.maxR = koiClamp(Math.ceil(maxY / py) + 4, 0, dRows - 1);

      const p0 = rowBase + 80;
      buf[p0] = fish.bodyLength;
      buf[p0 + 1] = fish.maxHalfWidth;
      buf[p0 + 2] = fish.finSpanFactor;
      buf[p0 + 3] = fish.tailLengthFactor;

      const p1 = rowBase + 84;
      buf[p1] = fish.phase;
      buf[p1 + 1] = fish.finPhase;
      buf[p1 + 2] = fish.curvature;
      buf[p1 + 3] = fish.speed / (fish.baseCruiseSpeed || 120);

      const varId = fish.variety === 'kohaku' ? 0 : fish.variety === 'sanke' ? 1 : 2;
      const varFlags = varId | (fish.colors.hasMotoguro ? 4 : 0);
      const uSeed = fish.seed >>> 0;
      const p2 = rowBase + 88;
      buf[p2] = fish.size;
      buf[p2 + 1] = varFlags;
      buf[p2 + 2] = uSeed & 0xffff;
      buf[p2 + 3] = (uSeed >>> 16) & 0xffff;

      const p3 = rowBase + 92;
      buf[p3] = minX;
      buf[p3 + 1] = minY;
      buf[p3 + 2] = maxX;
      buf[p3 + 3] = maxY;

      const bbIdx = k * 4;
      this.koiBBoxUniformBuf[bbIdx] = minX;
      this.koiBBoxUniformBuf[bbIdx + 1] = minY;
      this.koiBBoxUniformBuf[bbIdx + 2] = maxX;
      this.koiBBoxUniformBuf[bbIdx + 3] = maxY;

      const finRgb = fish.colors.finRgb;
      const sumiRgb = fish.colors.sumiRgb;
      const hiRgb = fish.colors.hiRgb;
      const shiroRgb = fish.colors.shiroRgb;
      const baseRgb = fish.colors.baseRgb;

      const finLum = (0.2126 * finRgb[0] + 0.7152 * finRgb[1] + 0.0722 * finRgb[2]) / 255;
      const sumiLum = (0.2126 * sumiRgb[0] + 0.7152 * sumiRgb[1] + 0.0722 * sumiRgb[2]) / 255;
      const hiLum = (0.2126 * hiRgb[0] + 0.7152 * hiRgb[1] + 0.0722 * hiRgb[2]) / 255;

      const c0 = rowBase + 96;
      buf[c0] = baseRgb[0];
      buf[c0 + 1] = baseRgb[1];
      buf[c0 + 2] = baseRgb[2];
      buf[c0 + 3] = finLum;

      const c1 = rowBase + 100;
      buf[c1] = hiRgb[0];
      buf[c1 + 1] = hiRgb[1];
      buf[c1 + 2] = hiRgb[2];
      buf[c1 + 3] = sumiLum;

      const c2 = rowBase + 104;
      buf[c2] = sumiRgb[0];
      buf[c2 + 1] = sumiRgb[1];
      buf[c2 + 2] = sumiRgb[2];
      buf[c2 + 3] = hiLum;

      const patchCount = Math.min(8, fish.patches.length);
      const c3 = rowBase + 108;
      buf[c3] = shiroRgb[0];
      buf[c3 + 1] = shiroRgb[1];
      buf[c3 + 2] = shiroRgb[2];
      buf[c3 + 3] = patchCount;

      for (let p = 0; p < patchCount; p++) {
        const patch = fish.patches[p];
        const gIdx = rowBase + (28 + p) * 4;
        buf[gIdx] = patch.sCenter;
        buf[gIdx + 1] = patch.uCenter;
        buf[gIdx + 2] = patch.sRadius;
        buf[gIdx + 3] = patch.uRadius;

        const mIdx = rowBase + (36 + p) * 4;
        buf[mIdx] = patch.warpAmp;
        buf[mIdx + 1] = patch.layer === 'shiro' ? 0 : patch.layer === 'hi' ? 1 : 2;
        buf[mIdx + 2] = 0;
        buf[mIdx + 3] = 0;
      }
    }

    let vOff = 0;
    const vBuf = this.subRectVertBuf;
    for (let i = 0; i < subRectCount; i++) {
      const r = this.koiSubRects[i];
      const x0 = r.minC;
      const y0 = r.minR;
      const x1 = r.maxC + 1;
      const y1 = r.maxR + 1;
      vBuf[vOff++] = x0;
      vBuf[vOff++] = y0;
      vBuf[vOff++] = x1;
      vBuf[vOff++] = y0;
      vBuf[vOff++] = x1;
      vBuf[vOff++] = y1;
      vBuf[vOff++] = x0;
      vBuf[vOff++] = y0;
      vBuf[vOff++] = x1;
      vBuf[vOff++] = y1;
      vBuf[vOff++] = x0;
      vBuf[vOff++] = y1;
    }

    return subRectCount;
  }

  public render(
    hostCanvas: HTMLCanvasElement,
    width: number,
    height: number,
    scale: number,
    world: PondWorld,
    time: number,
    config: KoiPondConfig,
    palette: PondPalette,
    previousPalette: PondPalette | null,
    transitioning: boolean,
    t: number
  ): boolean {
    const gl = this.ensureContext(hostCanvas);
    if (!gl || !this.glCanvas) return false;

    const physW = Math.max(1, Math.round(width * scale));
    const physH = Math.max(1, Math.round(height * scale));
    if (this.glCanvas.width !== physW || this.glCanvas.height !== physH) {
      this.glCanvas.width = physW;
      this.glCanvas.height = physH;
    }
    this.setVisible(true);

    const cellW = Math.max(5, config.cellWidth);
    const cellH = Math.max(8, config.cellHeight);
    const a = Math.max(3, cellW * 0.5);
    const px = a * 2;
    const py = a;
    const dCols = Math.ceil(width / px) + 1;
    const dRows = Math.ceil(height / py) + 1;
    const cols = Math.max(1, Math.ceil(width / cellW));
    const rows = Math.max(1, Math.ceil(height / cellH));

    if (!this.ensureTextures(gl, cols, rows, dCols, dRows)) {
      return false;
    }

    const wKey = `${a}|${dCols}|${dRows}|${cols}|${rows}|${config.showWaterTexture}|${palette.terrain}`;
    const waterDirty = wKey !== this.waterKey || time < this.waterTime || time - this.waterTime >= 0.1;
    if (waterDirty) {
      this.bakeWaterOnGPU(gl, world, time, config, palette, cellW, cellH, cols, rows, dCols, dRows, a);
      this.waterKey = wKey;
      this.waterTime = time;
    }

    const fishList = world.fish;
    let minnowKey = fishList.length;
    for (let i = 0; i < fishList.length; i += 7) {
      const m = fishList[i];
      minnowKey = (minnowKey * 31 + ((m.x * 4) | 0) + ((m.y * 4) | 0)) | 0;
    }
    const baseDirty = waterDirty || minnowKey !== this.lastMinnowKey;
    if (baseDirty) {
      this.lastMinnowKey = minnowKey;
      let validMinnows = 0;
      for (let i = 0; i < fishList.length && validMinnows < 512; i++) {
        const m = fishList[i];
        m.col = Math.floor(m.x / cellW);
        m.row = Math.floor(m.y / cellH);
        const r = Math.round(m.y / py);
        if (r < 0 || r >= dRows) continue;
        const c = Math.round((m.x - (r & 1) * a) / px);
        if (c < 0 || c >= dCols) continue;
        const off = validMinnows * 3;
        this.minnowDataBuf[off] = c;
        this.minnowDataBuf[off + 1] = r;
        this.minnowDataBuf[off + 2] = 0.42 + 0.12 * m.depth + 0.3 * m.alarm;
        validMinnows++;
      }

      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.waterLatticeFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.baseLatticeFbo);
      gl.blitFramebuffer(0, 0, dCols, dRows, 0, 0, dCols, dRows, gl.COLOR_BUFFER_BIT, gl.NEAREST);

      if (validMinnows > 0 && this.minnowVbo && this.minnowLatticeProg && this.minnowVao) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.minnowVbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.minnowDataBuf.subarray(0, validMinnows * 3));
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.baseLatticeFbo);
        gl.viewport(0, 0, dCols, dRows);
        gl.disable(gl.BLEND);
        gl.useProgram(this.minnowLatticeProg);
        gl.uniform2f(this.getUniform(gl, this.minnowLatticeProg, 'u_gridSize'), dCols, dRows);
        gl.bindVertexArray(this.minnowVao);
        gl.drawArrays(gl.POINTS, 0, validMinnows);
      }
    }

    const subRectCount = this.packKoiData(world.koi, dCols, dRows, px, py);
    if (this.koiDataTex) {
      gl.bindTexture(gl.TEXTURE_2D, this.koiDataTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 48, 4, gl.RGBA, gl.FLOAT, this.koiDataBuf);
    }

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.baseLatticeFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.rawLatticeFbo);
    gl.blitFramebuffer(0, 0, dCols, dRows, 0, 0, dCols, dRows, gl.COLOR_BUFFER_BIT, gl.NEAREST);

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.baseLatticeFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.liveLatticeFbo);
    gl.blitFramebuffer(0, 0, dCols, dRows, 0, 0, dCols, dRows, gl.COLOR_BUFFER_BIT, gl.NEAREST);

    if (
      subRectCount > 0 &&
      this.koiEvalProg &&
      this.koiOutlineProg &&
      this.subRectVao &&
      this.subRectVbo
    ) {
      gl.bindVertexArray(this.subRectVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.subRectVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.subRectVertBuf.subarray(0, subRectCount * 12));

      gl.disable(gl.BLEND);
      gl.viewport(0, 0, dCols, dRows);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.rawLatticeFbo);
      gl.useProgram(this.koiEvalProg);
      gl.uniform2f(this.getUniform(gl, this.koiEvalProg, 'u_gridSize'), dCols, dRows);
      gl.uniform1f(this.getUniform(gl, this.koiEvalProg, 'u_a'), a);
      gl.uniform1i(this.getUniform(gl, this.koiEvalProg, 'u_koiCount'), Math.min(4, world.koi.length));
      const detailInt = config.detailQuality === 'high' ? 2 : config.detailQuality === 'medium' ? 1 : 0;
      gl.uniform1i(this.getUniform(gl, this.koiEvalProg, 'u_detailQuality'), detailInt);
      gl.uniform1i(this.getUniform(gl, this.koiEvalProg, 'u_showScales'), config.showScales ? 1 : 0);
      gl.uniform4fv(this.getUniform(gl, this.koiEvalProg, 'u_koiBBoxes[0]'), this.koiBBoxUniformBuf);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.koiDataTex);
      gl.uniform1i(this.getUniform(gl, this.koiEvalProg, 'u_koiDataTex'), 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.baseLatticeTex);
      gl.uniform1i(this.getUniform(gl, this.koiEvalProg, 'u_baseLatticeTex'), 1);

      gl.drawArrays(gl.TRIANGLES, 0, subRectCount * 6);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.liveLatticeFbo);
      gl.useProgram(this.koiOutlineProg);
      gl.uniform2f(this.getUniform(gl, this.koiOutlineProg, 'u_gridSize'), dCols, dRows);
      gl.uniform1i(this.getUniform(gl, this.koiOutlineProg, 'u_dCols'), dCols);
      gl.uniform1i(this.getUniform(gl, this.koiOutlineProg, 'u_dRows'), dRows);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.rawLatticeTex);
      gl.uniform1i(this.getUniform(gl, this.koiOutlineProg, 'u_rawLatticeTex'), 0);

      gl.drawArrays(gl.TRIANGLES, 0, subRectCount * 6);
    }

    if (!this.screenSdfProg || !this.emptyVao) return false;

    // Pass 6: Full-screen analytical Diamond SDF pass
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, physW, physH);
    gl.bindVertexArray(this.emptyVao);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);

    const isSimpleBg = !transitioning && !config.customBackground;
    if (!isSimpleBg) {
      if (config.customBackground) {
        parseCssHexToRgb01(config.customBackground, this.bgTopRgb, 0);
        this.bgBottomRgb.set(this.bgTopRgb);
      } else {
        parseCssHexToRgb01(palette.background, this.bgTopRgb, 0);
        parseCssHexToRgb01(palette.backgroundSecondary, this.bgBottomRgb, 0);
        if (previousPalette && transitioning) {
          parseCssHexToRgb01(previousPalette.background, this.prevTopRgb, 0);
          parseCssHexToRgb01(previousPalette.backgroundSecondary, this.prevBottomRgb, 0);
          for (let i = 0; i < 3; i++) {
            this.bgTopRgb[i] = this.prevTopRgb[i] + (this.bgTopRgb[i] - this.prevTopRgb[i]) * t;
            this.bgBottomRgb[i] =
              this.prevBottomRgb[i] + (this.bgBottomRgb[i] - this.prevBottomRgb[i]) * t;
          }
        }
      }
    }

    const fade = transitioning ? 0.35 + 0.65 * t : 1.0;
    const veilAlpha = transitioning ? Math.sin(t * Math.PI) * 0.22 : 0.0;

    gl.useProgram(this.screenSdfProg);
    gl.uniform2f(this.getUniform(gl, this.screenSdfProg, 'u_viewSize'), width, height);
    gl.uniform2i(this.getUniform(gl, this.screenSdfProg, 'u_latticeSize'), dCols, dRows);
    gl.uniform1f(this.getUniform(gl, this.screenSdfProg, 'u_a'), a);
    gl.uniform1f(this.getUniform(gl, this.screenSdfProg, 'u_inv2a'), 0.5 / a);
    gl.uniform1f(this.getUniform(gl, this.screenSdfProg, 'u_aaL1'), 0.9 / Math.max(0.75, scale));
    gl.uniform1f(this.getUniform(gl, this.screenSdfProg, 'u_fade'), fade);
    gl.uniform1f(this.getUniform(gl, this.screenSdfProg, 'u_veilAlpha'), veilAlpha);
    gl.uniform1i(this.getUniform(gl, this.screenSdfProg, 'u_isSimpleBg'), isSimpleBg ? 1 : 0);

    if (!isSimpleBg) {
      gl.uniform3fv(this.getUniform(gl, this.screenSdfProg, 'u_bgTop'), this.bgTopRgb);
      gl.uniform3fv(this.getUniform(gl, this.screenSdfProg, 'u_bgBottom'), this.bgBottomRgb);
      gl.uniform1f(this.getUniform(gl, this.screenSdfProg, 'u_viewHeight'), height);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.liveLatticeTex);
    gl.uniform1i(this.getUniform(gl, this.screenSdfProg, 'u_latticeTex'), 0);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  private bakeWaterOnGPU(
    gl: WebGL2RenderingContext,
    world: PondWorld,
    time: number,
    config: KoiPondConfig,
    palette: PondPalette,
    cellW: number,
    cellH: number,
    cols: number,
    rows: number,
    dCols: number,
    dRows: number,
    a: number
  ): void {
    if (!this.waterCellProg || !this.waterLatticeProg || !this.emptyVao) return;

    if (this.wakeTex && world.pond.wakeField.length >= cols * rows) {
      gl.bindTexture(gl.TEXTURE_2D, this.wakeTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        cols,
        rows,
        gl.RED,
        gl.FLOAT,
        world.pond.wakeField,
        0
      );
    }

    let rCount = 0;
    const ripples = world.pond.ripples;
    for (let i = 0; i < ripples.length && rCount < 16; i++) {
      const r = ripples[i];
      if (!r.active) continue;
      const off = rCount * 4;
      this.rippleDataBuf[off] = r.x;
      this.rippleDataBuf[off + 1] = r.y;
      this.rippleDataBuf[off + 2] = r.radius;
      this.rippleDataBuf[off + 3] = r.strength;
      rCount++;
    }

    gl.bindVertexArray(this.emptyVao);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.waterCellFbo);
    gl.viewport(0, 0, cols, rows);
    gl.useProgram(this.waterCellProg);
    gl.uniform1i(this.getUniform(gl, this.waterCellProg, 'u_cols'), cols);
    gl.uniform1i(this.getUniform(gl, this.waterCellProg, 'u_rows'), rows);
    gl.uniform1f(this.getUniform(gl, this.waterCellProg, 'u_cellW'), cellW);
    gl.uniform1f(this.getUniform(gl, this.waterCellProg, 'u_cellH'), cellH);
    gl.uniform1f(this.getUniform(gl, this.waterCellProg, 'u_time'), time);
    gl.uniform1i(this.getUniform(gl, this.waterCellProg, 'u_showWater'), config.showWaterTexture ? 1 : 0);
    gl.uniform1i(this.getUniform(gl, this.waterCellProg, 'u_hasTerrain'), palette.terrain ? 1 : 0);
    gl.uniform1i(this.getUniform(gl, this.waterCellProg, 'u_rippleCount'), rCount);
    if (rCount > 0) {
      gl.uniform4fv(this.getUniform(gl, this.waterCellProg, 'u_ripples[0]'), this.rippleDataBuf);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.wakeTex);
    gl.uniform1i(this.getUniform(gl, this.waterCellProg, 'u_wakeTex'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.waterLatticeFbo);
    gl.viewport(0, 0, dCols, dRows);
    gl.useProgram(this.waterLatticeProg);
    gl.uniform1i(this.getUniform(gl, this.waterLatticeProg, 'u_cols'), cols);
    gl.uniform1i(this.getUniform(gl, this.waterLatticeProg, 'u_rows'), rows);
    gl.uniform1f(this.getUniform(gl, this.waterLatticeProg, 'u_cellW'), cellW);
    gl.uniform1f(this.getUniform(gl, this.waterLatticeProg, 'u_cellH'), cellH);
    gl.uniform1f(this.getUniform(gl, this.waterLatticeProg, 'u_a'), a);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.waterCellTex);
    gl.uniform1i(this.getUniform(gl, this.waterLatticeProg, 'u_waterCellTex'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
