/**
 * Procedural Wet-on-Wet Sumi-e Ink Wash Baking Engine
 * ---------------------------------------------------
 * Generates one-time cached offscreen canvases for authentic wet-on-wet Japanese ink wash
 * (*Sumi-e* & *Tarashikomi*) on textured cream washi paper (and inverted silver-grey night washi):
 *   1. Textured cream washi & reusable paper-tooth Float32Array field (kozo fibers, mottling, faint crackle).
 *   2. 4–5 tonal-tier wet-on-wet background lotus pad mosaic (merged wet-in-wet clouds, dry-on-dry
 *      multiply lens overlaps, tarashikomi capillary tide lines, open swimming corridors).
 *   3. Mottled dark foreground pads (per-pixel ink granulation, reserved-paper hairline veins that
 *      break up near the rim, pale central hub, lifted-out flecks, zero cast shadows).
 *   4. Reserved-paper water lilies (unpainted cream petals with quick, tapered, broken jet-ink
 *      strokes, soft base wash, dark dab center with stamen flicks).
 *   5. Crisp dark-ink maple flicks (5–7 lobes) and loose 5-petal reserved-paper white flower clusters.
 *   6. Perimeter-sampled alpha-keyed floating glyphs for top-right Sumi-e UI controls.
 */

// Fast deterministic permutation table for 2D value noise / FBM
const PERM = new Uint8Array(512);
{
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let seed = 133791;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function hash2(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise2D(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const x0 = xi & 255;
  const y0 = yi & 255;
  const x1 = (x0 + 1) & 255;
  const y1 = (y0 + 1) & 255;

  const aa = PERM[PERM[x0] + y0] / 255;
  const ba = PERM[PERM[x1] + y0] / 255;
  const ab = PERM[PERM[x0] + y1] / 255;
  const bb = PERM[PERM[x1] + y1] / 255;

  const nx0 = aa + (ba - aa) * u;
  const nx1 = ab + (bb - ab) * u;
  return nx0 + (nx1 - nx0) * v;
}

function fbm2D(x: number, y: number, octaves = 3): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise2D(x * freq, y * freq) * amp;
    norm += amp;
    freq *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}

export interface SumiePaperBundle {
  canvas: HTMLCanvasElement;
  tooth: Float32Array;
  toothW: number;
  toothH: number;
}

/**
 * 1. Bakes warm cream textured washi (day) or dark sumi washi (night) with a reusable
 *    per-pixel paper-tooth field so all ink washes granulate into paper valleys.
 */
export function bakeSumieParchment(
  width: number,
  height: number,
  isLight: boolean
): SumiePaperBundle {
  const w = Math.max(64, Math.round(width));
  const h = Math.max(64, Math.round(height));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");

  // Bake tooth field at up to 960px on longest side for fast, crisp granulation
  const maxBake = 960;
  const scale = Math.min(1, maxBake / Math.max(w, h));
  const bw = Math.max(64, Math.round(w * scale));
  const bh = Math.max(64, Math.round(h * scale));
  const tooth = new Float32Array(bw * bh);

  const bakeCanvas = document.createElement("canvas");
  bakeCanvas.width = bw;
  bakeCanvas.height = bh;
  const bCtx = bakeCanvas.getContext("2d");

  if (bCtx) {
    const img = bCtx.createImageData(bw, bh);
    const data = img.data;
    const invW = 1 / Math.max(1, bw);
    const invH = 1 / Math.max(1, bh);

    for (let y = 0; y < bh; y++) {
      const ny = y * invH;
      const dy = ny - 0.5;
      for (let x = 0; x < bw; x++) {
        const nx = x * invW;
        const dx = nx - 0.5;
        const idx = y * bw + x;

        // Radial warmth falloff from warm cream center (#e2d8c5) to aged edge (#d2c6b0)
        const rad = Math.min(1, Math.hypot(dx * 1.15, dy * 1.15) * 1.38);
        const vig = rad * rad;

        // Multi-scale paper mottling + fine kozo tooth
        const mottle = fbm2D(x * 0.0085 + 3.1, y * 0.0085 + 7.4, 3);
        const mediumGrain = valueNoise2D(x * 0.055 + 11.2, y * 0.055 + 4.8);
        const fineGrain = hash2(x, y, 17);
        // Directional kozo paper weave hint
        const fiberH = valueNoise2D(x * 0.035, y * 0.34);
        const fiberV = valueNoise2D(x * 0.34, y * 0.035);
        const toothVal = clamp01(
          0.34 * mediumGrain + 0.32 * fineGrain + 0.18 * mottle + 0.08 * fiberH + 0.08 * fiberV
        );
        tooth[idx] = toothVal;

        const p = idx * 4;
        if (isLight) {
          // Warm cream washi: #e2d8c5 center -> #d2c6b0 edges
          let r = 228 - vig * 18 + (mottle - 0.5) * 15 + (toothVal - 0.5) * 14;
          let g = 219 - vig * 20 + (mottle - 0.5) * 14 + (toothVal - 0.5) * 13;
          let b = 200 - vig * 23 + (mottle - 0.5) * 13 + (toothVal - 0.5) * 12;

          // Subtle natural pulp speckles
          if (fineGrain > 0.986) {
            r -= 16;
            g -= 17;
            b -= 19;
          } else if (fineGrain < 0.012) {
            r += 8;
            g += 7;
            b += 5;
          }
          data[p] = Math.max(0, Math.min(255, r));
          data[p + 1] = Math.max(0, Math.min(255, g));
          data[p + 2] = Math.max(0, Math.min(255, b));
          data[p + 3] = 255;
        } else {
          // Dark sumi washi for night mode: #191816 center -> #0d0c0b edges
          let r = 26 - vig * 11 + (mottle - 0.5) * 6 + (toothVal - 0.5) * 7;
          let g = 25 - vig * 10 + (mottle - 0.5) * 6 + (toothVal - 0.5) * 7;
          let b = 23 - vig * 9 + (mottle - 0.5) * 5 + (toothVal - 0.5) * 6;
          data[p] = Math.max(0, Math.min(255, r));
          data[p + 1] = Math.max(0, Math.min(255, g));
          data[p + 2] = Math.max(0, Math.min(255, b));
          data[p + 3] = 255;
        }
      }
    }
    bCtx.putImageData(img, 0, 0);
  }

  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bakeCanvas, 0, 0, w, h);

    // Crisp full-resolution kozo paper fibres
    ctx.save();
    const fiberCount = Math.min(680, Math.round((w * h) / 1800));
    for (let i = 0; i < fiberCount; i++) {
      const fx = hash2(i, 1, 311) * w;
      const fy = hash2(i, 2, 311) * h;
      const flen = 7 + hash2(i, 3, 311) * 20;
      const fang = hash2(i, 4, 311) * Math.PI * 2;
      const fcurv = (hash2(i, 5, 311) - 0.5) * 6;
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.quadraticCurveTo(
        fx + Math.cos(fang) * flen * 0.5 - Math.sin(fang) * fcurv,
        fy + Math.sin(fang) * flen * 0.5 + Math.cos(fang) * fcurv,
        fx + Math.cos(fang) * flen,
        fy + Math.sin(fang) * flen
      );
      ctx.lineWidth = 0.45 + hash2(i, 6, 311) * 0.45;
      ctx.strokeStyle = isLight
        ? i % 3 === 0
          ? "rgba(250, 245, 234, 0.30)"
          : "rgba(116, 102, 82, 0.065)"
        : i % 3 === 0
          ? "rgba(182, 174, 158, 0.055)"
          : "rgba(0, 0, 0, 0.22)";
      ctx.stroke();
    }

    // Faint aged paper crackle lines in a few quiet corners/edges
    const crackleCount = 14;
    for (let c = 0; c < crackleCount; c++) {
      let cx = hash2(c, 11, 701) * w;
      let cy = hash2(c, 13, 701) * h;
      let ang = hash2(c, 17, 701) * Math.PI * 2;
      const segs = 5 + Math.floor(hash2(c, 19, 701) * 6);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      for (let s = 0; s < segs; s++) {
        ang += (hash2(c * 13 + s, 23, 701) - 0.5) * 0.9;
        const step = 10 + hash2(c * 17 + s, 29, 701) * 18;
        cx += Math.cos(ang) * step;
        cy += Math.sin(ang) * step;
        ctx.lineTo(cx, cy);
      }
      ctx.lineWidth = 0.55;
      ctx.strokeStyle = isLight
        ? "rgba(110, 96, 76, 0.075)"
        : "rgba(176, 168, 154, 0.045)";
      ctx.stroke();
    }
    ctx.restore();
  }

  return { canvas, tooth, toothW: bw, toothH: bh };
}

interface WashPadSeed {
  x: number;
  y: number;
  r: number;
  aspect: number;
  rot: number;
  tone: number; // 0..1 ink strength
  rimStrength: number; // tarashikomi tide-line darkness
  dissolveAng: number; // angle on which pad partially dissolves into wash
  dissolveAmt: number; // 0..0.85
  seed: number;
  tier: number;
}

/**
 * Computes breathing-corridor openness [0..1] matching the reference painting:
 * - Upper-center-right open cream paper lane around main swimming koi
 * - Lower-center-left lighter airy lane
 * - Dense wet-on-wet lotus leaf clouds framing top-left, bottom-left, top-right, bottom-right
 */
function corridorOpenness(nx: number, ny: number): number {
  // Primary upper-center-right open corridor (around x=0.62, y=0.36)
  const d1 = Math.hypot((nx - 0.61) * 1.35, (ny - 0.34) * 1.85);
  const open1 = Math.exp(-d1 * d1 * 3.8);
  // Secondary lower-center-left airy lane (around x=0.38, y=0.72)
  const d2 = Math.hypot((nx - 0.38) * 1.55, (ny - 0.72) * 1.75);
  const open2 = Math.exp(-d2 * d2 * 4.4) * 0.72;
  // Top-right corner breathing room for floating kanji/seal icons
  const d3 = Math.hypot((nx - 0.94) * 2.8, (ny - 0.14) * 2.4);
  const open3 = Math.exp(-d3 * d3 * 4.2) * 0.85;
  return clamp01(Math.max(open1, open2, open3));
}

/**
 * 2. Bakes the 4–5 tonal-tier wet-on-wet background lotus pad mosaic into an offscreen canvas.
 *    Uses domain-warped distance fields + shared wet-in-wet density clouds + dry-on-dry multiply
 *    lens overlaps + capillary tarashikomi rims settling into the paper-tooth field.
 */
export function bakeSumieWashMosaic(
  width: number,
  height: number,
  isLight: boolean,
  tooth: Float32Array,
  toothW: number,
  toothH: number
): HTMLCanvasElement {
  const w = Math.max(64, Math.round(width));
  const h = Math.max(64, Math.round(height));
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const outCtx = out.getContext("2d");
  if (!outCtx) return out;

  // Bake at tooth resolution (up to 960px wide) for silky wet-on-wet granulation
  const bw = toothW;
  const bh = toothH;
  const minDim = Math.min(bw, bh);

  // Two buffers:
  // 1) wetCloud: accumulated wet-in-wet merged wash density (no seams between touching pools)
  // 2) dryAccum: dry-on-dry multiplicative transmittance (1 = clean paper, 0 = deep black ink)
  const wetCloud = new Float32Array(bw * bh);
  const dryTrans = new Float32Array(bw * bh);
  dryTrans.fill(1.0);

  // Helper to stamp a single domain-warped wet-on-wet pad pool into either wetCloud or dryTrans
  const stampPool = (pad: WashPadSeed, mode: "wet" | "dry") => {
    const padSpan = pad.r * 1.48;
    const x0 = Math.max(0, Math.floor(pad.x - padSpan));
    const x1 = Math.min(bw - 1, Math.ceil(pad.x + padSpan));
    const y0 = Math.max(0, Math.floor(pad.y - padSpan));
    const y1 = Math.min(bh - 1, Math.ceil(pad.y + padSpan));
    const cosR = Math.cos(pad.rot);
    const sinR = Math.sin(pad.rot);
    const invR = 1 / Math.max(4, pad.r);
    const invAsp = 1 / pad.aspect;
    const cosD = Math.cos(pad.dissolveAng);
    const sinD = Math.sin(pad.dissolveAng);
    const sOffX = (pad.seed * 17.3) % 100;
    const sOffY = (pad.seed * 31.7) % 100;
    const freq = 0.042 * (48 / Math.max(18, pad.r));

    for (let y = y0; y <= y1; y++) {
      const dy = y - pad.y;
      const row = y * bw;
      for (let x = x0; x <= x1; x++) {
        const dx = x - pad.x;
        // Rotate into pad-local ellipse frame
        const lx = (dx * cosR + dy * sinR) * invR;
        const ly = (-dx * sinR + dy * cosR) * invR * invAsp;
        const rawDist = Math.hypot(lx, ly);
        if (rawDist > 1.46) continue;

        // Domain-warped organic outline with ragged fingers & water blooms
        const n1 = valueNoise2D(x * freq + sOffX, y * freq + sOffY);
        const n2 = valueNoise2D(x * freq * 2.6 + sOffY, y * freq * 2.6 + sOffX);
        const n3 = valueNoise2D(x * freq * 5.8 + sOffX * 1.7, y * freq * 5.8 + sOffY * 1.3);
        const edgeWarp = (n1 - 0.5) * 0.36 + (n2 - 0.5) * 0.24 + (n3 - 0.5) * 0.12;
        const d = rawDist + edgeWarp;
        if (d > 1.14) continue;

        // Soft feathered edge (zero hard stroke)
        const feather = mode === "wet" ? 0.32 : 0.17;
        let mask = 1.0 - smoothstep(1.0 - feather, 1.0 + feather * 0.60, d);
        if (mask <= 0.004) continue;

        // Directional dissolution: one side of the pad dissolves softly into the wash
        if (pad.dissolveAmt > 0.02) {
          const proj = (lx * cosD + ly * sinD);
          const fadeSide = smoothstep(-0.35, 0.95, proj);
          mask *= 1.0 - fadeSide * pad.dissolveAmt;
          if (mask <= 0.004) continue;
        }

        // Soft, ragged Tarashikomi capillary tide line + strong paper-valley granulation
        const rimBand = Math.exp(-Math.pow((d - 0.87) / 0.18, 2)) * (0.65 + 0.70 * n2);
        const interiorMottle = 0.66 + 0.48 * n1 + 0.24 * (n2 - 0.5) + 0.16 * (n3 - 0.5);
        const paperVal = tooth[row + x];
        // Pigment settles into paper valleys (authentic granulation speckle)
        const granulation = 0.60 + 0.82 * (1.0 - paperVal);

        const density =
          pad.tone *
          mask *
          (interiorMottle * 0.86 + rimBand * (pad.rimStrength * 0.62)) *
          granulation;

        if (mode === "wet") {
          // Wet-in-wet smooth union: pools merge seamlessly without hard seams
          const cur = wetCloud[row + x];
          wetCloud[row + x] = cur + density * (1.0 - cur * 0.68);
        } else {
          // Dry-on-dry multiply overlap: overlapping pools create darker lens shapes
          const inkAbsorb = clamp01(density);
          dryTrans[row + x] *= 1.0 - inkAbsorb;
        }
      }
    }
  };

  // --- TIER 1: Large wet-in-wet merged cloudy grey zones around edges & corners ---
  const wetSeeds: WashPadSeed[] = [];
  const tier1Count = 58;
  for (let i = 0; i < tier1Count; i++) {
    const nx = hash2(i, 1, 201);
    const ny = hash2(i, 2, 201);
    const open = corridorOpenness(nx, ny);
    // Keep upper-center-right swimming corridor lighter
    if (open > 0.62 && hash2(i, 9, 201) < 0.78) continue;
    const r = minDim * (0.075 + hash2(i, 3, 201) * 0.115);
    wetSeeds.push({
      x: nx * bw,
      y: ny * bh,
      r,
      aspect: 0.76 + hash2(i, 4, 201) * 0.44,
      rot: hash2(i, 5, 201) * Math.PI,
      tone: (0.14 + hash2(i, 6, 201) * 0.14) * (1.0 - open * 0.58),
      rimStrength: 0.26 + hash2(i, 7, 201) * 0.22,
      dissolveAng: hash2(i, 8, 201) * Math.PI * 2,
      dissolveAmt: 0.35 + hash2(i, 10, 201) * 0.45,
      seed: i + 11,
      tier: 1,
    });
  }
  for (let i = 0; i < wetSeeds.length; i++) {
    stampPool(wetSeeds[i], "wet");
  }

  // Convert accumulated wetCloud into initial dryTrans base
  for (let i = 0; i < bw * bh; i++) {
    const wVal = clamp01(wetCloud[i] * 0.78);
    // Subtle outer tide-line bloom where the merged wet cloud meets bare paper
    dryTrans[i] = 1.0 - wVal;
  }

  // --- TIER 2: Pale-mid submerged overlapping pad pools (partly dissolved, varied sizes) ---
  const tier2Count = 135;
  for (let i = 0; i < tier2Count; i++) {
    const nx = hash2(i, 1, 307);
    const ny = hash2(i, 2, 307);
    const open = corridorOpenness(nx, ny);
    if (open > 0.56 && hash2(i, 11, 307) < 0.82) continue;
    const r = minDim * (0.032 + Math.pow(hash2(i, 3, 307), 1.35) * 0.088);
    stampPool(
      {
        x: nx * bw,
        y: ny * bh,
        r,
        aspect: 0.78 + hash2(i, 4, 307) * 0.36,
        rot: hash2(i, 5, 307) * Math.PI,
        tone: (0.12 + hash2(i, 6, 307) * 0.14) * (1.0 - open * 0.62),
        rimStrength: 0.38 + hash2(i, 7, 307) * 0.26,
        dissolveAng: hash2(i, 8, 307) * Math.PI * 2,
        dissolveAmt: 0.25 + hash2(i, 9, 307) * 0.52,
        seed: i + 137,
        tier: 2,
      },
      "dry"
    );
  }

  // --- TIER 3: Mid-grey dry-on-dry pads with crisp lens overlaps & ragged tarashikomi rims ---
  const tier3Count = 105;
  for (let i = 0; i < tier3Count; i++) {
    const nx = hash2(i, 1, 419);
    const ny = hash2(i, 2, 419);
    const open = corridorOpenness(nx, ny);
    if (open > 0.44 && hash2(i, 11, 419) < 0.88) continue;
    const r = minDim * (0.024 + Math.pow(hash2(i, 3, 419), 1.4) * 0.068);
    stampPool(
      {
        x: nx * bw,
        y: ny * bh,
        r,
        aspect: 0.82 + hash2(i, 4, 419) * 0.30,
        rot: hash2(i, 5, 419) * Math.PI,
        tone: (0.16 + hash2(i, 6, 419) * 0.18) * (1.0 - open * 0.55),
        rimStrength: 0.48 + hash2(i, 7, 419) * 0.30,
        dissolveAng: hash2(i, 8, 419) * Math.PI * 2,
        dissolveAmt: hash2(i, 9, 419) < 0.55 ? 0.28 + hash2(i, 10, 419) * 0.42 : 0.08,
        seed: i + 313,
        tier: 3,
      },
      "dry"
    );
  }

  // --- TIER 4: Richer dark-grey mottled accent pads framing the corners & foliage zones ---
  const anchorClusters: Array<[number, number, number, number]> = [
    // [nx, ny, radiusFrac, tone]
    [0.09, 0.08, 0.115, 0.44],
    [0.02, 0.20, 0.088, 0.40],
    [0.18, 0.16, 0.068, 0.32],
    [0.08, 0.56, 0.072, 0.34],
    [0.14, 0.78, 0.082, 0.36],
    [0.84, 0.18, 0.092, 0.34],
    [0.78, 0.09, 0.076, 0.30],
    [0.88, 0.38, 0.068, 0.32],
    [0.92, 0.90, 0.095, 0.38],
    [0.78, 0.84, 0.078, 0.34],
    [0.32, 0.08, 0.062, 0.30],
    [0.26, 0.64, 0.064, 0.28],
    [0.46, 0.86, 0.068, 0.30],
    [0.68, 0.64, 0.072, 0.32],
    [0.95, 0.64, 0.066, 0.34],
    [0.05, 0.88, 0.074, 0.34],
  ];
  for (let i = 0; i < anchorClusters.length; i++) {
    const [nx, ny, rFrac, tone] = anchorClusters[i];
    stampPool(
      {
        x: nx * bw,
        y: ny * bh,
        r: minDim * rFrac,
        aspect: 0.86 + hash2(i, 4, 557) * 0.24,
        rot: hash2(i, 5, 557) * Math.PI,
        tone,
        rimStrength: 0.56 + hash2(i, 7, 557) * 0.28,
        dissolveAng: hash2(i, 8, 557) * Math.PI * 2,
        dissolveAmt: 0.18 + hash2(i, 9, 557) * 0.26,
        seed: i + 701,
        tier: 4,
      },
      "dry"
    );
  }

  // Render transmittance field into an RGBA ImageData canvas
  const bakeCanvas = document.createElement("canvas");
  bakeCanvas.width = bw;
  bakeCanvas.height = bh;
  const bCtx = bakeCanvas.getContext("2d");
  if (bCtx) {
    const img = bCtx.createImageData(bw, bh);
    const data = img.data;
    for (let i = 0; i < bw * bh; i++) {
      // inkAmt in [0..1]
      const inkAmt = clamp01(1.0 - dryTrans[i]);
      if (inkAmt <= 0.004) continue;
      // Non-linear pigment response so pale washes stay airy and overlaps read rich
      const alpha = clamp01(Math.pow(inkAmt, 0.92) * (isLight ? 0.86 : 0.72));
      const p = i * 4;
      if (isLight) {
        // Warm sumi charcoal ink settling into cream paper
        const shade = Math.round(36 - inkAmt * 18);
        data[p] = shade + 3;
        data[p + 1] = shade + 1;
        data[p + 2] = shade - 2;
        data[p + 3] = Math.round(alpha * 255);
      } else {
        // Night mode: clean silver-grey ink washes (#6e695f .. #cfc7b6) with zero color
        const t = clamp01(inkAmt * 1.15);
        data[p] = Math.round(110 + t * 97);
        data[p + 1] = Math.round(105 + t * 94);
        data[p + 2] = Math.round(95 + t * 87);
        data[p + 3] = Math.round(alpha * 142);
      }
    }
    bCtx.putImageData(img, 0, 0);
  }

  outCtx.imageSmoothingEnabled = true;
  outCtx.drawImage(bakeCanvas, 0, 0, w, h);

  // Subtle spattered ink micro-dots (tobi-sumi) integrated into the static wash
  outCtx.save();
  for (let i = 0; i < 36; i++) {
    const bx = hash2(i, 3, 823) * w;
    const by = hash2(i, 7, 823) * h;
    const br = 0.7 + hash2(i, 11, 823) * 1.8;
    const ba = 0.08 + hash2(i, 13, 823) * 0.14;
    outCtx.fillStyle = isLight
      ? `rgba(26, 24, 21, ${ba.toFixed(3)})`
      : `rgba(196, 189, 174, ${(ba * 0.75).toFixed(3)})`;
    outCtx.beginPath();
    outCtx.arc(bx, by, br, 0, Math.PI * 2);
    outCtx.fill();
  }
  outCtx.restore();

  return out;
}

/**
 * 3. Bakes a single mottled dark-ink foreground lotus pad sprite (zero cast shadow, zero vector outline).
 *    Features per-pixel mottled ink interior (lighter thinned patches, darker pooled scalloped rims),
 *    reserved-paper hairline radial veins that thin and break up near the rim, a small pale central hub,
 *    and a few lifted-out pale flecks.
 */
export function bakeSumieForegroundPadSprite(
  radius: number,
  seed: number,
  isLight: boolean,
  isCompanion = false
): HTMLCanvasElement {
  const r = Math.max(10, radius);
  const margin = Math.ceil(r * 0.24 + 8);
  const dim = Math.max(40, Math.ceil((r + margin) * 2));
  const cx = dim * 0.5;
  const cy = dim * 0.5;

  const sprite = document.createElement("canvas");
  sprite.width = dim;
  sprite.height = dim;
  const ctx = sprite.getContext("2d");
  if (!ctx) return sprite;

  const img = ctx.createImageData(dim, dim);
  const data = img.data;
  const cleftHalf = isCompanion ? 0.24 : 0.16;
  const sOffX = (seed * 23.1) % 100;
  const sOffY = (seed * 41.7) % 100;
  const nFreq = 0.065 * (56 / Math.max(20, r));
  const navelX = cx - r * 0.05;
  const navelY = cy;

  // Precompute scalloped lobe harmonics
  const lobeCount = isCompanion ? 9 : 13;

  for (let y = 0; y < dim; y++) {
    const dy = y - cy;
    const row = y * dim;
    for (let x = 0; x < dim; x++) {
      const dx = x - cx;
      const dist = Math.hypot(dx, dy);
      if (dist > r * 1.18) continue;

      const ang = Math.atan2(dy, dx); // [-PI, PI], notch at 0
      const absAng = Math.abs(ang);

      // Organic wavy scalloped edge + small ink-bleed irregularity
      const lobe =
        1.0 +
        0.044 * Math.sin(ang * lobeCount + seed * 1.7) +
        0.026 * Math.cos(ang * (lobeCount * 1.6) - seed * 1.1);
      const n1 = valueNoise2D(x * nFreq + sOffX, y * nFreq + sOffY);
      const n2 = valueNoise2D(x * nFreq * 2.6 + sOffY, y * nFreq * 2.6 + sOffX);
      const fine = hash2(x, y, seed + 19);

      const warp = (n1 - 0.5) * 0.11 + (n2 - 0.5) * 0.06;
      const effR = r * (lobe + warp);
      const normD = dist / Math.max(4, effR);
      if (normD > 1.08) continue;

      // V-cleft cutout near angle 0 (softened slightly at vertex)
      let cleftMask = 1.0;
      if (absAng < cleftHalf * 1.35 && dist > r * 0.08) {
        cleftMask = smoothstep(cleftHalf * 0.52, cleftHalf * 1.25, absAng);
      }

      // Firmer rim than background washes (painted on drier paper), yet still softly feathered
      const edgeMask = (1.0 - smoothstep(0.93, 1.05, normD)) * cleftMask;
      if (edgeMask <= 0.01) continue;

      // Mottled dark-ink interior: thinned lighter patches + darker pooled tarashikomi rim
      const rimPool = Math.exp(-Math.pow((normD - 0.91) / 0.10, 2)) * 0.34;
      const mottle = 0.56 + 0.42 * n1 + 0.22 * (n2 - 0.5);
      const grain = 0.86 + 0.28 * (1.0 - fine);
      const baseStrength = isCompanion ? 0.72 : 0.84;
      const inkDensity = clamp01(baseStrength * (mottle * 0.78 + rimPool) * grain);
      const alpha = clamp01(edgeMask * (0.76 + 0.24 * inkDensity));

      const p = (row + x) * 4;
      if (isLight) {
        // Deep warm charcoal/jet sumi with thinned mid-dark grey pockets
        const v = Math.round(78 - inkDensity * 60);
        data[p] = v + 2;
        data[p + 1] = v;
        data[p + 2] = Math.max(0, v - 3);
        data[p + 3] = Math.round(alpha * 255);
      } else {
        // Night mode: silver-grey dry-brush foreground pads (#7c766b .. #cfc7b6)
        const v = Math.round(92 + inkDensity * 92);
        data[p] = v + 3;
        data[p + 1] = v;
        data[p + 2] = Math.max(0, v - 8);
        data[p + 3] = Math.round(alpha * 238);
      }
    }
  }
  ctx.putImageData(img, 0, 0);

  // Reserved-paper radial veins: fine pale lines scratched/reserved out of the dark wash,
  // thinner near the center and breaking up as they reach the rim
  ctx.save();
  ctx.lineCap = "round";
  const veinCount = isCompanion ? 10 : 19;
  const veinCol = isLight ? "rgba(228, 220, 202, 0.74)" : "rgba(22, 20, 18, 0.68)";
  const veinFaint = isLight ? "rgba(228, 220, 202, 0.38)" : "rgba(22, 20, 18, 0.34)";

  for (let v = 0; v < veinCount; v++) {
    const u = (v + 0.5) / veinCount;
    const jitter = (hash2(seed * 13 + v, 3, 941) - 0.5) * 0.07;
    const va = cleftHalf + 0.08 + u * (Math.PI * 2 - (cleftHalf + 0.08) * 2) + jitter;
    const bend = (hash2(seed * 17 + v, 7, 947) - 0.5) * 0.14;
    const reach = r * (0.76 + hash2(seed * 23 + v, 11, 953) * 0.16);

    // Inner continuous hairline segment (thin near center, slightly clearer mid-blade)
    const rMid = reach * 0.62;
    const mx = navelX + Math.cos(va + bend * 0.55) * rMid;
    const my = navelY + Math.sin(va + bend * 0.55) * rMid;
    ctx.strokeStyle = veinCol;
    ctx.lineWidth = Math.max(0.55, r * 0.0115);
    ctx.beginPath();
    ctx.moveTo(navelX + Math.cos(va) * (r * 0.05), navelY + Math.sin(va) * (r * 0.05));
    ctx.quadraticCurveTo(
      navelX + Math.cos(va + bend * 0.25) * (rMid * 0.5),
      navelY + Math.sin(va + bend * 0.25) * (rMid * 0.5),
      mx,
      my
    );
    ctx.stroke();

    // Outer broken/tapering vein segment near rim
    const rEnd = reach;
    const ex = navelX + Math.cos(va + bend * 0.15) * rEnd;
    const ey = navelY + Math.sin(va + bend * 0.15) * rEnd;
    ctx.strokeStyle = veinFaint;
    ctx.lineWidth = Math.max(0.4, r * 0.0075);
    ctx.beginPath();
    ctx.moveTo(
      mx + Math.cos(va) * (r * 0.03),
      my + Math.sin(va) * (r * 0.03)
    );
    ctx.lineTo(ex, ey);
    ctx.stroke();

    // Occasional delicate forked veinlet on large pads
    if (!isCompanion && v % 2 === 0) {
      const side = v % 4 === 0 ? 1 : -1;
      const fa = va + side * 0.22;
      const fl = r * 0.22;
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx + Math.cos(fa) * fl, my + Math.sin(fa) * fl);
      ctx.stroke();
    }
  }

  // Small pale reserved-paper central navel hub
  const hubR = Math.max(1.8, r * 0.052);
  const hubGrad = ctx.createRadialGradient(navelX, navelY, hubR * 0.1, navelX, navelY, hubR);
  if (isLight) {
    hubGrad.addColorStop(0.0, "rgba(232, 224, 206, 0.90)");
    hubGrad.addColorStop(0.65, "rgba(220, 211, 192, 0.45)");
    hubGrad.addColorStop(1.0, "rgba(220, 211, 192, 0)");
  } else {
    hubGrad.addColorStop(0.0, "rgba(24, 22, 20, 0.86)");
    hubGrad.addColorStop(1.0, "rgba(24, 22, 20, 0)");
  }
  ctx.fillStyle = hubGrad;
  ctx.beginPath();
  ctx.arc(navelX, navelY, hubR, 0, Math.PI * 2);
  ctx.fill();

  // A few small lifted-out / spattered pale paper flecks on the dark pad surface
  const fleckCount = isCompanion ? 2 : 5;
  for (let f = 0; f < fleckCount; f++) {
    const fa = cleftHalf + 0.35 + hash2(seed, f * 7 + 1, 881) * (Math.PI * 2 - cleftHalf * 2 - 0.7);
    const fd = r * (0.28 + hash2(seed, f * 11 + 2, 887) * 0.52);
    const fx = cx + Math.cos(fa) * fd;
    const fy = cy + Math.sin(fa) * fd;
    const fr = 0.8 + hash2(seed, f * 13 + 3, 907) * (isCompanion ? 1.0 : 1.7);
    ctx.fillStyle = isLight ? "rgba(232, 224, 208, 0.78)" : "rgba(26, 24, 22, 0.72)";
    ctx.beginPath();
    ctx.ellipse(fx, fy, fr * 1.2, fr * 0.85, fa, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
  return sprite;
}

/**
 * 4A. Paints a Sumi-e reserved-paper water lily:
 *     Unpainted cream paper petals, soft grey ink wash at petal bases, defined by quick,
 *     tapered, BROKEN jet-ink strokes (pressed harder at base, lifted/open at tips — not closed),
 *     and a dark dab center with fine stamen flicks. Zero cast shadow, zero red/gold color.
 */
export function paintSumieWaterLily(
  ctx: CanvasRenderingContext2D,
  fx: number,
  fy: number,
  radius: number,
  rotBase: number,
  isLight: boolean
): void {
  ctx.save();
  ctx.translate(fx, fy);

  const paperFill = isLight ? [234, 226, 210] : [206, 199, 185];
  const baseWash = isLight ? [138, 132, 120] : [118, 113, 104];
  const inkRgb = isLight ? [20, 18, 16] : [22, 20, 18];

  const drawPetalRing = (
    count: number,
    angOffset: number,
    pLen: number,
    pWidth: number,
    ringIdx: number
  ) => {
    for (let p = 0; p < count; p++) {
      const jitter = (hash2(ringIdx * 17 + p, 3, 401) - 0.5) * 0.08;
      const a = rotBase + angOffset + (p / count) * Math.PI * 2 + jitter;
      const len = pLen * (0.92 + hash2(ringIdx * 19 + p, 5, 401) * 0.15);
      const w = pWidth * (0.92 + hash2(ringIdx * 23 + p, 7, 401) * 0.14);

      ctx.save();
      ctx.rotate(a);

      // Reserved-paper petal silhouette (warm cream paper + soft grey ink wash at petal base)
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(len * 0.28, -w * 0.88, len * 0.72, -w * 0.62, len, 0);
      ctx.bezierCurveTo(len * 0.72, w * 0.62, len * 0.28, w * 0.88, 0, 0);
      ctx.closePath();

      const pg = ctx.createLinearGradient(0, 0, len, 0);
      pg.addColorStop(0.0, `rgba(${baseWash[0]}, ${baseWash[1]}, ${baseWash[2]}, 0.96)`);
      pg.addColorStop(0.32, `rgba(${paperFill[0]}, ${paperFill[1]}, ${paperFill[2]}, 0.98)`);
      pg.addColorStop(1.0, `rgba(${paperFill[0]}, ${paperFill[1]}, ${paperFill[2]}, 0.96)`);
      ctx.fillStyle = pg;
      ctx.fill();

      // Quick, tapered, BROKEN jet-ink strokes: pressed harder at base, lifted toward tip
      // Deliberately leave one side lighter/open so petals never read as closed vector shapes
      const heavySide = (p + ringIdx) % 2 === 0 ? -1 : 1;
      ctx.lineCap = "round";

      // Primary brush flick along one flank (stops short of tip or lifts cleanly)
      ctx.beginPath();
      ctx.moveTo(len * 0.06, heavySide * w * 0.12);
      ctx.bezierCurveTo(
        len * 0.30,
        heavySide * w * 0.84,
        len * 0.68,
        heavySide * w * 0.58,
        len * 0.96,
        heavySide * w * 0.04
      );
      ctx.lineWidth = Math.max(0.85, radius * 0.036);
      ctx.strokeStyle = `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, 0.84)`;
      ctx.stroke();

      // Secondary lighter broken flick on the opposite flank (only lower 60%–75%)
      const oppReach = 0.54 + hash2(p, ringIdx, 409) * 0.26;
      ctx.beginPath();
      ctx.moveTo(len * 0.10, -heavySide * w * 0.14);
      ctx.quadraticCurveTo(
        len * (oppReach * 0.55),
        -heavySide * w * 0.76,
        len * oppReach,
        -heavySide * w * (0.42 * (1 - oppReach * 0.45))
      );
      ctx.lineWidth = Math.max(0.55, radius * 0.022);
      ctx.strokeStyle = `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, 0.54)`;
      ctx.stroke();

      // Faint ink vein flick from base
      ctx.beginPath();
      ctx.moveTo(len * 0.08, 0);
      ctx.lineTo(len * 0.52, (hash2(p, ringIdx, 421) - 0.5) * w * 0.14);
      ctx.lineWidth = Math.max(0.45, radius * 0.015);
      ctx.strokeStyle = `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, 0.30)`;
      ctx.stroke();

      ctx.restore();
    }
  };

  drawPetalRing(9, 0.0, radius * 1.0, radius * 0.33, 0);
  drawPetalRing(8, Math.PI / 9, radius * 0.80, radius * 0.29, 1);
  drawPetalRing(7, Math.PI / 7, radius * 0.56, radius * 0.24, 2);

  // Dark ink dab center with fine stamen flicks around it
  const coreR = radius * 0.24;
  const centerGrad = ctx.createRadialGradient(0, 0, 0.5, 0, 0, coreR * 1.15);
  centerGrad.addColorStop(0.0, `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, 0.94)`);
  centerGrad.addColorStop(0.55, `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, 0.62)`);
  centerGrad.addColorStop(1.0, `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, 0)`);
  ctx.fillStyle = centerGrad;
  ctx.beginPath();
  ctx.arc(0, 0, coreR * 1.15, 0, Math.PI * 2);
  ctx.fill();

  const stamenCount = 15;
  ctx.lineCap = "round";
  for (let s = 0; s < stamenCount; s++) {
    const sa = rotBase * 0.4 + (s / stamenCount) * Math.PI * 2 + (hash2(s, 3, 433) - 0.5) * 0.14;
    const sLen = coreR * (0.95 + hash2(s, 7, 433) * 0.55);
    const sx = Math.cos(sa) * sLen;
    const sy = Math.sin(sa) * sLen;
    ctx.beginPath();
    ctx.moveTo(Math.cos(sa) * coreR * 0.32, Math.sin(sa) * coreR * 0.32);
    ctx.lineTo(sx, sy);
    ctx.lineWidth = Math.max(0.6, radius * 0.02);
    ctx.strokeStyle = `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, 0.76)`;
    ctx.stroke();

    ctx.fillStyle = `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, 0.88)`;
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(0.75, radius * 0.028), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * 4B. Bakes a crisp 5–7 lobed dark-ink Sumi-e maple leaf sprite (zero cast shadow, single-flick lobes,
 *     subtle pale midribs).
 */
export function bakeSumieMapleSprite(
  size: number,
  isLight: boolean,
  variant: number
): HTMLCanvasElement {
  const s = Math.max(14, size);
  const dim = Math.ceil(s * 2.6);
  const cx = dim * 0.5;
  const cy = dim * 0.5;
  const canvas = document.createElement("canvas");
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const isFive = variant % 2 === 1;
  const lobes = isFive
    ? [
        { ang: 0.0, len: 1.0, w: 0.24 },
        { ang: -0.68, len: 0.84, w: 0.21 },
        { ang: 0.68, len: 0.84, w: 0.21 },
        { ang: -1.38, len: 0.56, w: 0.16 },
        { ang: 1.38, len: 0.56, w: 0.16 },
      ]
    : [
        { ang: 0.0, len: 1.0, w: 0.22 },
        { ang: -0.56, len: 0.86, w: 0.20 },
        { ang: 0.56, len: 0.86, w: 0.20 },
        { ang: -1.14, len: 0.66, w: 0.16 },
        { ang: 1.14, len: 0.66, w: 0.16 },
        { ang: -1.70, len: 0.42, w: 0.12 },
        { ang: 1.70, len: 0.42, w: 0.12 },
      ];

  ctx.save();
  ctx.translate(cx, cy);

  // Confident pointed brush flicks per lobe (dark ink day / silver-grey ink night)
  for (let i = 0; i < lobes.length; i++) {
    const lb = lobes[i];
    const lLen = s * lb.len * (0.94 + hash2(variant, i, 613) * 0.12);
    const lW = s * lb.w;
    ctx.save();
    ctx.rotate(lb.ang);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(lLen * 0.24, -lW * 0.72, lLen * 0.56, -lW * 1.02, lLen, 0);
    ctx.bezierCurveTo(lLen * 0.56, lW * 1.02, lLen * 0.24, lW * 0.72, 0, 0);
    ctx.closePath();

    const g = ctx.createLinearGradient(0, 0, lLen, 0);
    if (isLight) {
      g.addColorStop(0.0, "rgba(22, 20, 18, 0.94)");
      g.addColorStop(0.62, "rgba(38, 35, 31, 0.90)");
      g.addColorStop(1.0, "rgba(18, 16, 15, 0.96)");
    } else {
      g.addColorStop(0.0, "rgba(196, 188, 174, 0.92)");
      g.addColorStop(0.62, "rgba(156, 150, 138, 0.88)");
      g.addColorStop(1.0, "rgba(208, 200, 186, 0.94)");
    }
    ctx.fillStyle = g;
    ctx.fill();

    // Subtle pale midrib flick
    ctx.beginPath();
    ctx.moveTo(lLen * 0.06, 0);
    ctx.lineTo(lLen * 0.76, 0);
    ctx.lineWidth = Math.max(0.5, s * 0.024);
    ctx.lineCap = "round";
    ctx.strokeStyle = isLight ? "rgba(226, 218, 202, 0.42)" : "rgba(24, 22, 20, 0.46)";
    ctx.stroke();
    ctx.restore();
  }

  // Delicate wiry petiole flick
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(-s * 0.22, s * 0.08, -s * 0.44, -s * 0.04);
  ctx.lineWidth = Math.max(0.75, s * 0.036);
  ctx.lineCap = "round";
  ctx.strokeStyle = isLight ? "rgba(24, 22, 20, 0.82)" : "rgba(196, 188, 174, 0.80)";
  ctx.stroke();

  ctx.restore();
  return canvas;
}

/**
 * 4C-1. Bakes ONLY the soft mid-grey ink wash backing patch underneath a Sumi-e flower cluster.
 */
export function bakeSumieWashBackingSprite(
  radius: number,
  isLight: boolean,
  seed: number
): HTMLCanvasElement {
  const r = Math.max(24, radius);
  const dim = Math.ceil(r * 2.6);
  const cx = dim * 0.5;
  const cy = dim * 0.5;
  const canvas = document.createElement("canvas");
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  for (let wIdx = 0; wIdx < 4; wIdx++) {
    const wa = hash2(seed, wIdx * 3 + 1, 719) * Math.PI * 2;
    const wd = r * (0.12 + hash2(seed, wIdx * 5 + 2, 719) * 0.34);
    const wx = cx + Math.cos(wa) * wd;
    const wy = cy + Math.sin(wa) * wd;
    const wr = r * (0.48 + hash2(seed, wIdx * 7 + 3, 719) * 0.38);
    const wg = ctx.createRadialGradient(wx, wy, wr * 0.1, wx, wy, wr);
    if (isLight) {
      wg.addColorStop(0.0, "rgba(56, 52, 46, 0.34)");
      wg.addColorStop(0.68, "rgba(64, 59, 52, 0.18)");
      wg.addColorStop(1.0, "rgba(64, 59, 52, 0)");
    } else {
      wg.addColorStop(0.0, "rgba(142, 136, 124, 0.28)");
      wg.addColorStop(0.68, "rgba(120, 114, 104, 0.14)");
      wg.addColorStop(1.0, "rgba(120, 114, 104, 0)");
    }
    ctx.fillStyle = wg;
    ctx.beginPath();
    ctx.arc(wx, wy, wr, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

/**
 * 4C-2. Bakes a single bigger 5-petal reserved-paper flower sprite with a crisp dark center dot
 *       so each flower can be displaced individually on pond clicks.
 */
export function bakeSumieSingleFlowerSprite(
  radius: number,
  isLight: boolean
): HTMLCanvasElement {
  const fRad = Math.max(5, radius);
  const dim = Math.ceil(fRad * 2.8);
  const cx = dim * 0.5;
  const cy = dim * 0.5;
  const canvas = document.createElement("canvas");
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const petalCol = isLight ? "rgba(234, 226, 210, 0.96)" : "rgba(212, 205, 192, 0.92)";
  const rimCol = isLight ? "rgba(58, 53, 46, 0.30)" : "rgba(24, 22, 20, 0.38)";
  const dotCol = isLight ? "rgba(22, 20, 18, 0.94)" : "rgba(20, 18, 16, 0.94)";

  ctx.save();
  ctx.translate(cx, cy);
  for (let p = 0; p < 5; p++) {
    const pa = (p / 5) * Math.PI * 2;
    ctx.save();
    ctx.rotate(pa);
    ctx.beginPath();
    ctx.ellipse(fRad * 0.56, 0, fRad * 0.52, fRad * 0.37, 0, 0, Math.PI * 2);
    ctx.fillStyle = petalCol;
    ctx.fill();
    ctx.lineWidth = Math.max(0.55, fRad * 0.065);
    ctx.strokeStyle = rimCol;
    ctx.stroke();
    ctx.restore();
  }

  // Dark center dot + subtle tiny stamen specks
  ctx.fillStyle = dotCol;
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(1.5, fRad * 0.24), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  return canvas;
}
