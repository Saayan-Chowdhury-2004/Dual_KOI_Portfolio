/**
 * Procedural Japanese Gosanke koi varieties (Kohaku, Taisho Sanke, Showa Sanshoku),
 * spine-locked organic dorsal markings, and adaptive scale surface evaluation.
 */

import { fbm2D, formatShadedRgb, koiClamp, mulberry32 } from './koiMath';
import type { DetailQuality, KoiFish, KoiVariety, OrganicPatch } from './koiTypes';

export interface KoiVarietyMeta {
  variety: KoiVariety;
  label: string;
  japanese: string;
  description: string;
}

export const KOI_VARIETIES: Record<KoiVariety, KoiVarietyMeta> = {
  kohaku: {
    variety: 'kohaku',
    label: 'Kohaku',
    japanese: '紅白',
    description: 'Snow-white Shiroji base with vivid vermilion Hi dorsal patches'
  },
  sanke: {
    variety: 'sanke',
    label: 'Taisho Sanke',
    japanese: '大正三色',
    description: 'White body with crimson Hi saddles and crisp lacquer-black Sumi accents'
  },
  showa: {
    variety: 'showa',
    label: 'Showa Sanshoku',
    japanese: '昭和三色',
    description: 'Deep ink-black Sumi base wrapped with bold scarlet Hi and snow-white Shiroji'
  }
};

export const VARIETY_ORDER: KoiVariety[] = ['kohaku', 'sanke', 'showa'];

const KOI_NAMES: Record<KoiVariety, string[]> = {
  kohaku: ['Akane', 'Beni', 'Sakura', 'Hinata'],
  sanke: ['Taisho', 'Kasumi', 'Kaede', 'Miyabi'],
  showa: ['Kurogane', 'Inazuma', 'Arashi', 'Raiden']
};

export function pickKoiName(variety: KoiVariety, index: number): string {
  const list = KOI_NAMES[variety] ?? KOI_NAMES.kohaku;
  return list[index % list.length];
}

/**
 * Generates deterministic, anatomically authentic dorsal markings in fish-local (s, u) coordinates:
 * - s in [0, 1] runs from snout tip (0) to tail peduncle (0.85) and caudal fin (1.0)
 * - u in [-1, 1] runs laterally from left body contour (-1) across dorsal spine (0) to right contour (+1)
 */
export function generateVarietyPatchesAndColors(
  variety: KoiVariety,
  seed: number
): {
  patches: OrganicPatch[];
  colors: KoiFish['colors'];
} {
  const rand = mulberry32(seed);
  const patches: OrganicPatch[] = [];

  const shiroRgb: [number, number, number] = [
    246 + Math.round(rand() * 7),
    244 + Math.round(rand() * 7),
    236 + Math.round(rand() * 8)
  ];

  const hiWarmth = rand();
  const hiRgb: [number, number, number] = [
    238 + Math.round(rand() * 16),
    Math.round(54 + hiWarmth * 36),
    Math.round(28 + hiWarmth * 14)
  ];

  const sumiRgb: [number, number, number] = [28, 34, 42];

  let baseRgb: [number, number, number] = [...shiroRgb];
  const finRgb: [number, number, number] = [238, 236, 228];
  let hasMotoguro = false;

  if (variety === 'kohaku') {
    const numSteps = 3 + (rand() > 0.55 ? 1 : 0);
    const spanStart = 0.06 + rand() * 0.04;
    const spanEnd = 0.76;
    const stepLen = (spanEnd - spanStart) / numSteps;

    for (let i = 0; i < numSteps; i++) {
      const sCenter = spanStart + stepLen * (i + 0.45) + (rand() - 0.5) * 0.04;
      const uCenter = (rand() - 0.5) * 0.42;
      const sRadius = stepLen * (0.44 + rand() * 0.16);
      const uRadius = 0.65 + rand() * 0.35;
      patches.push({
        sCenter,
        uCenter,
        sRadius,
        uRadius,
        warpFreq: 5.5 + rand() * 3.0,
        warpAmp: 0.22 + rand() * 0.1,
        phase: rand() * 100,
        layer: 'hi'
      });
    }
  } else if (variety === 'sanke') {
    const numHi = 2 + (rand() > 0.4 ? 1 : 0);
    for (let i = 0; i < numHi; i++) {
      const sCenter = 0.1 + i * 0.27 + (rand() - 0.5) * 0.05;
      const uCenter = (rand() - 0.5) * 0.45;
      patches.push({
        sCenter,
        uCenter,
        sRadius: 0.12 + rand() * 0.045,
        uRadius: 0.62 + rand() * 0.32,
        warpFreq: 6.0 + rand() * 2.5,
        warpAmp: 0.24,
        phase: rand() * 100,
        layer: 'hi'
      });
    }

    const numSumi = 4 + Math.floor(rand() * 2);
    for (let i = 0; i < numSumi; i++) {
      const sCenter = 0.22 + i * 0.14 + (rand() - 0.5) * 0.04;
      const side = (i % 2 === 0 ? 1 : -1) * (0.18 + rand() * 0.35);
      patches.push({
        sCenter,
        uCenter: side,
        sRadius: 0.052 + rand() * 0.025,
        uRadius: 0.36 + rand() * 0.18,
        warpFreq: 8.0 + rand() * 3.0,
        warpAmp: 0.2,
        phase: rand() * 100 + 50,
        layer: 'sumi'
      });
    }
  } else if (variety === 'showa') {
    baseRgb = [...sumiRgb];
    hasMotoguro = true;

    const shiroPositions = [0.22 + (rand() - 0.5) * 0.04, 0.52 + (rand() - 0.5) * 0.05, 0.75];
    for (const sc of shiroPositions) {
      patches.push({
        sCenter: sc,
        uCenter: (rand() - 0.5) * 0.38,
        sRadius: 0.095 + rand() * 0.035,
        uRadius: 0.76 + rand() * 0.28,
        warpFreq: 6.2 + rand() * 2.0,
        warpAmp: 0.24,
        phase: rand() * 100,
        layer: 'shiro'
      });
    }

    const hiPositions = [0.09 + rand() * 0.03, 0.37 + (rand() - 0.5) * 0.04, 0.64 + (rand() - 0.5) * 0.04];
    for (const sc of hiPositions) {
      patches.push({
        sCenter: sc,
        uCenter: (rand() - 0.5) * 0.36,
        sRadius: 0.105 + rand() * 0.03,
        uRadius: 0.68 + rand() * 0.28,
        warpFreq: 5.8 + rand() * 2.5,
        warpAmp: 0.22,
        phase: rand() * 100 + 33,
        layer: 'hi'
      });
    }
  }

  return {
    patches,
    colors: {
      baseHex: `rgb(${baseRgb[0]},${baseRgb[1]},${baseRgb[2]})`,
      baseRgb,
      hiHex: `rgb(${hiRgb[0]},${hiRgb[1]},${hiRgb[2]})`,
      hiRgb,
      sumiHex: `rgb(${sumiRgb[0]},${sumiRgb[1]},${sumiRgb[2]})`,
      sumiRgb,
      shiroHex: `rgb(${shiroRgb[0]},${shiroRgb[1]},${shiroRgb[2]})`,
      shiroRgb,
      finHex: `rgb(${finRgb[0]},${finRgb[1]},${finRgb[2]})`,
      finRgb,
      hasMotoguro
    }
  };
}

export interface KoiSurfaceEvaluation {
  rgb: [number, number, number];
  cssColor: string;
  /** Density bias in [-0.25, +0.28] so markings are also legible in the ASCII density ramp */
  densityBias: number;
  /** True if this cell lands on a subtle scale crescent rim */
  isScaleRim: boolean;
  /** Scale crescent character if applicable */
  scaleGlyph: string;
}

/**
 * Evaluates the fish's ornamental pattern and scale lattice at fish-local coordinates (s, u).
 */
export function evaluateKoiSurface(
  fish: KoiFish,
  s: number,
  u: number,
  shade: number,
  detailQuality: DetailQuality,
  showScales: boolean,
  lightTheme: boolean
): KoiSurfaceEvaluation {
  let rgb: [number, number, number] = fish.colors.baseRgb;
  let densityBias = fish.variety === 'showa' ? 0.2 : 0.0;
  let activeLayer: 'shiro' | 'hi' | 'sumi' =
    fish.variety === 'showa' ? 'sumi' : 'shiro';

  // Evaluate spine-attached organic patches in layer order
  if (fish.patches.length > 0 && s >= 0.02 && s <= 0.85) {
    const warp = fbm2D(s * 9.5, u * 3.8, fish.seed);

    for (let i = 0; i < fish.patches.length; i++) {
      const p = fish.patches[i];
      const ds = (s - p.sCenter) / p.sRadius;
      const du = (u - p.uCenter) / p.uRadius;
      const distSq = ds * ds + du * du;
      if (distSq > 2.1) continue;

      const dist = Math.sqrt(distSq) + warp * p.warpAmp;
      if (dist <= 1.0) {
        if (p.layer === 'shiro') {
          rgb = fish.colors.shiroRgb;
          densityBias = -0.08;
          activeLayer = 'shiro';
        } else if (p.layer === 'hi') {
          rgb = fish.colors.hiRgb;
          densityBias = 0.16;
          activeLayer = 'hi';
        } else if (p.layer === 'sumi') {
          rgb = fish.colors.sumiRgb;
          densityBias = 0.28;
          activeLayer = 'sumi';
        }
      }
    }
  }

  // Adaptive overlapping scale lattice on torso (s in [0.18, 0.80])
  let isScaleRim = false;
  let scaleGlyph = '';
  let highlightBoost = 0;

  const dorsalRidge = Math.max(0, 1 - Math.abs(u) * 1.45);
  const ridgeSpecular = Math.pow(dorsalRidge, 3.2);
  highlightBoost += ridgeSpecular * 0.2;

  if (
    showScales &&
    detailQuality !== 'low' &&
    s >= 0.18 &&
    s <= 0.8 &&
    Math.abs(u) <= 0.84
  ) {
    const scaleFactor = koiClamp(fish.size / 2.6, 0.75, 1.35);
    const rowsAlong = Math.round(18 * scaleFactor);
    const colsAcross = Math.round(7 * scaleFactor);

    const su = s * rowsAlong;
    const rowIdx = Math.floor(su);
    const fracS = su - rowIdx;

    const stagger = (rowIdx & 1) * 0.5;
    const vu = (u * 0.5 + 0.5) * colsAcross + stagger;
    const colIdx = Math.floor(vu);
    const fracU = vu - colIdx - 0.5;

    const arcS = 0.68 - fracU * fracU * 1.15;
    const rimDist = Math.abs(fracS - arcS);

    const cellHash = ((rowIdx * 37 + colIdx * 101 + fish.seed) & 15) / 15;
    const threshold = detailQuality === 'high' ? 0.36 : 0.22;

    if (rimDist < 0.12 && Math.abs(fracU) < 0.42 && cellHash < threshold) {
      isScaleRim = true;
      highlightBoost += 0.1;
      scaleGlyph = u > 0.25 ? ')' : u < -0.25 ? '(' : 'c';
    }
  }

  const cssColor = formatShadedRgb(
    rgb,
    shade,
    highlightBoost,
    lightTheme,
    activeLayer === 'sumi',
    activeLayer === 'shiro'
  );

  return {
    rgb,
    cssColor,
    densityBias,
    isScaleRim,
    scaleGlyph
  };
}
