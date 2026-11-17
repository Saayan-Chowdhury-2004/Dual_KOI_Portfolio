/**
 * Mathematical utilities, deterministic PRNG, 2D value noise, and
 * divergence-free ambient water current fields for the ASCII koi pond.
 */

export const KOI_TAU = Math.PI * 2;

export function koiClamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function koiLerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function koiSmoothstep(edge0: number, edge1: number, x: number): number {
  const t = koiClamp((x - edge0) / (edge1 - edge0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

export function koiWrapAngle(a: number): number {
  let r = (a + Math.PI) % KOI_TAU;
  if (r < 0) r += KOI_TAU;
  return r - Math.PI;
}

export function koiAngleDiff(from: number, to: number): number {
  return koiWrapAngle(to - from);
}

/**
 * Deterministic 32-bit PRNG (Mulberry32) for reproducible koi markings and proportions.
 */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fast integer coordinate hash returning [0, 1].
 */
export function hash2D(ix: number, iy: number, seed = 0): number {
  let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041);
  n = (n ^ (n >>> 13)) | 0;
  n = Math.imul(n, 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/**
 * Smooth 2D value noise returning [0, 1].
 */
export function valueNoise2D(x: number, y: number, seed = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const n00 = hash2D(ix, iy, seed);
  const n10 = hash2D(ix + 1, iy, seed);
  const n01 = hash2D(ix, iy + 1, seed);
  const n11 = hash2D(ix + 1, iy + 1, seed);

  const nx0 = n00 + (n10 - n00) * ux;
  const nx1 = n01 + (n11 - n01) * ux;
  return nx0 + (nx1 - nx0) * uy;
}

/**
 * Two-octave fractional Brownian motion returning [-1, 1].
 */
export function fbm2D(x: number, y: number, seed = 0): number {
  const v1 = valueNoise2D(x, y, seed);
  const v2 = valueNoise2D(x * 2.13 + 17.3, y * 2.13 - 9.7, seed + 101);
  return (v1 * 0.68 + v2 * 0.32) * 2 - 1;
}

/**
 * Divergence-free 2D curl flow field for subtle ambient pond currents.
 */
export function samplePondCurrent(x: number, y: number, time: number): { vx: number; vy: number } {
  const scale = 0.0032;
  const sx = x * scale;
  const sy = y * scale;
  const t = time * 0.18;

  const vx =
    Math.sin(sy * 1.7 + t) * 0.55 +
    Math.cos((sx + sy) * 1.15 - t * 0.7) * 0.45;
  const vy =
    -Math.cos(sx * 1.7 - t * 0.85) * 0.55 +
    Math.sin((sx - sy) * 1.15 + t * 0.65) * 0.45;

  return { vx, vy };
}

/**
 * Interpolates two `#rrggbb` hex colours by t in [0, 1] (used for theme transitions).
 */
export function lerpHexColor(a: string, b: string, t: number): string {
  const ah = a.replace('#', '');
  const bh = b.replace('#', '');
  const av = parseInt(ah.length === 3 ? ah.replace(/./g, (c) => c + c) : ah, 16);
  const bv = parseInt(bh.length === 3 ? bh.replace(/./g, (c) => c + c) : bh, 16);
  const ar = (av >> 16) & 255;
  const ag = (av >> 8) & 255;
  const ab = av & 255;
  const br = (bv >> 16) & 255;
  const bg = (bv >> 8) & 255;
  const bb = bv & 255;
  const r = Math.round(ar + (br - ar) * koiClamp(t, 0, 1));
  const g = Math.round(ag + (bg - ag) * koiClamp(t, 0, 1));
  const bl = Math.round(ab + (bb - ab) * koiClamp(t, 0, 1));
  return `rgb(${r},${g},${bl})`;
}

/**
 * Quantized RGB color helper with 3D dorsal shading, highlight modulation,
 * and theme-aware contrast so both snow-white Shiroji and ink-black Sumi
 * remain clearly legible on dark and light ponds alike.
 */
export function formatShadedRgb(
  rgb: [number, number, number],
  shade: number,
  highlightBoost = 0,
  lightTheme = false,
  isSumi = false,
  isShiro = false
): string {
  let r = koiClamp(rgb[0], 0, 255);
  let g = koiClamp(rgb[1], 0, 255);
  let b = koiClamp(rgb[2], 0, 255);

  if (!lightTheme && isSumi) {
    // On the black pond, give Sumi lacquer-black a cool slate-obsidian sheen so the silhouette
    // stands out clearly against the deep water while reading as unmistakable black next to Shiroji/Hi
    r = 68;
    g = 82;
    b = 98;
  } else if (lightTheme && isShiro) {
    // On the pale celadon light pond, give snow-white Shiroji a warm pearl tone with deeper lateral shading
    // so white koi pop cleanly against the light background
    const edgeShade = 0.68 + shade * 0.32;
    r = Math.round(248 * edgeShade);
    g = Math.round(244 * edgeShade);
    b = Math.round(234 * edgeShade);
    const qr = koiClamp(Math.round(r / 4) * 4, 0, 255);
    const qg = koiClamp(Math.round(g / 4) * 4, 0, 255);
    const qb = koiClamp(Math.round(b / 4) * 4, 0, 255);
    return `rgb(${qr},${qg},${qb})`;
  }

  const light = koiClamp(0.64 + shade * 0.42, 0.5, 1.12);
  const spec = koiClamp(highlightBoost, 0, 0.45) * 54;

  const qr = koiClamp(Math.round((r * light + spec) / 4) * 4, 0, 255);
  const qg = koiClamp(Math.round((g * light + spec) / 4) * 4, 0, 255);
  const qb = koiClamp(Math.round((b * light + spec) / 4) * 4, 0, 255);
  return `rgb(${qr},${qg},${qb})`;
}
