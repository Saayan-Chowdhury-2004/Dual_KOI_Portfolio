/**
 * Procedural Japanese Gosanke koi varieties (Kohaku, Taisho Sanke, Showa Sanshoku),
 * spine-locked organic dorsal markings, and adaptive scale surface evaluation.
 */

import { mulberry32 } from './koiMath';
import type { KoiFish, KoiVariety, OrganicPatch } from './koiTypes';

interface KoiVarietyMeta {
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
  _variety: KoiVariety,
  seed: number
): {
  patches: OrganicPatch[];
  colors: KoiFish['colors'];
} {
  const rand = mulberry32(seed);
  const patches: OrganicPatch[] = [];

  const shiroRgb: [number, number, number] = [
    244 + Math.round(rand() * 4),
    237 + Math.round(rand() * 4),
    224 + Math.round(rand() * 5),
  ];
  const hiRgb: [number, number, number] = [
    242 + Math.round(rand() * 6),
    56 + Math.round(rand() * 10),
    8 + Math.round(rand() * 6),
  ];
  const sumiRgb: [number, number, number] = [14, 14, 16];

  const baseRgb: [number, number, number] = [...shiroRgb];
  const finRgb: [number, number, number] = [246, 236, 220];
  const mirror = seed === 101 ? 1 : (rand() < 0.5 ? 1 : -1);
  const jitS = () => (seed === 101 ? 0 : (rand() - 0.5) * 0.014);
  const jitU = () => (seed === 101 ? 0 : (rand() - 0.5) * 0.04);

  // 1. Broad, lush 4-lobed scalloped cranial Hi shield (~74% of crown width, rounded dome top & bilobed base)
  patches.push({
    sCenter: 0.160 + jitS() * 0.3,
    uCenter: jitU() * 0.08,
    sRadius: 0.094 + (seed === 101 ? 0.002 : rand() * 0.004),
    uRadius: 0.64 + (seed === 101 ? 0.01 : rand() * 0.03),
    warpFreq: 4.0,
    warpAmp: 0.11,
    phase: rand() * 100,
    layer: 'hi',
  });

  // 2. Strongly asymmetric diagonal upper-shoulder Sumi slash (upper-right -> lower-left, NOT a symmetrical cap!)
  patches.push({
    sCenter: 0.332 + jitS(),
    uCenter: mirror * 0.36 + jitU(),
    sRadius: 0.042 + rand() * 0.004,
    uRadius: 0.44 + rand() * 0.04,
    warpFreq: 5.0 + rand() * 0.8,
    warpAmp: 0.18,
    phase: rand() * 100 + 11,
    layer: 'sumi',
  });
  patches.push({
    sCenter: 0.364 + jitS(),
    uCenter: -mirror * 0.06 + jitU(),
    sRadius: 0.036 + rand() * 0.004,
    uRadius: 0.36 + rand() * 0.04,
    warpFreq: 5.4 + rand() * 0.8,
    warpAmp: 0.18,
    phase: rand() * 100 + 17,
    layer: 'sumi',
  });
  patches.push({
    sCenter: 0.396 + jitS(),
    uCenter: -mirror * 0.40 + jitU(),
    sRadius: 0.036 + rand() * 0.004,
    uRadius: 0.36 + rand() * 0.04,
    warpFreq: 5.6 + rand() * 0.8,
    warpAmp: 0.18,
    phase: rand() * 100 + 23,
    layer: 'sumi',
  });

  // 3. Large prominent right-flank vermilion Hi saddle + offset smaller left-mid Hi accent
  patches.push({
    sCenter: 0.440 + jitS(),
    uCenter: mirror * 0.38 + jitU(),
    sRadius: 0.072 + rand() * 0.006,
    uRadius: 0.48 + rand() * 0.04,
    warpFreq: 4.8 + rand() * 0.8,
    warpAmp: 0.16,
    phase: rand() * 100 + 37,
    layer: 'hi',
  });
  patches.push({
    sCenter: 0.482 + jitS(),
    uCenter: -mirror * 0.32 + jitU(),
    sRadius: 0.042 + rand() * 0.005,
    uRadius: 0.34 + rand() * 0.04,
    warpFreq: 5.8 + rand() * 0.8,
    warpAmp: 0.16,
    phase: rand() * 100 + 51,
    layer: 'hi',
  });

  // 4. Bold diagonal lower-left Sumi mass sweeping cleanly across spine
  patches.push({
    sCenter: 0.556 + jitS(),
    uCenter: -mirror * 0.24 + jitU(),
    sRadius: 0.064 + rand() * 0.006,
    uRadius: 0.50 + rand() * 0.04,
    warpFreq: 5.2 + rand() * 0.8,
    warpAmp: 0.20,
    phase: rand() * 100 + 67,
    layer: 'sumi',
  });

  // 5. Prominent lower-right vermilion Hi saddle
  patches.push({
    sCenter: 0.646 + jitS(),
    uCenter: mirror * 0.24 + jitU(),
    sRadius: 0.064 + rand() * 0.006,
    uRadius: 0.50 + rand() * 0.04,
    warpFreq: 5.0 + rand() * 0.8,
    warpAmp: 0.16,
    phase: rand() * 100 + 91,
    layer: 'hi',
  });

  // 6. Compact lower-right Sumi accent below the Hi saddle
  patches.push({
    sCenter: 0.712 + jitS() * 0.5,
    uCenter: mirror * 0.28 + jitU(),
    sRadius: 0.036 + rand() * 0.005,
    uRadius: 0.36 + rand() * 0.04,
    warpFreq: 5.8 + rand() * 0.8,
    warpAmp: 0.16,
    phase: rand() * 100 + 107,
    layer: 'sumi',
  });

  // 7. Tail-base vermilion Hi accent near peduncle
  patches.push({
    sCenter: 0.780 + jitS() * 0.5,
    uCenter: -mirror * 0.10 + jitU(),
    sRadius: 0.046 + rand() * 0.005,
    uRadius: 0.48 + rand() * 0.04,
    warpFreq: 5.6 + rand() * 0.8,
    warpAmp: 0.15,
    phase: rand() * 100 + 123,
    layer: 'hi',
  });

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
      hasMotoguro: false,
    },
  };
}
