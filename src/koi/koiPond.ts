/**
 * Pond environment, colour themes, water-cell sampling, fish wake trails,
 * and expanding concentric click ripples. Dark theme: deep black water with
 * faint topographic terrain; light theme: black-and-white dot matrix (diamond dots on white).
 */

import { fbm2D, hash2D, koiClamp, koiSmoothstep, valueNoise2D } from './koiMath';
import type { PondPalette, PondRipple, PondThemeName } from './koiTypes';

export const POND_PALETTES: Record<PondThemeName, PondPalette> = {
  'black-pond': {
    name: 'black-pond',
    label: 'Sumi Black Pond',
    background: '#050608',
    backgroundSecondary: '#090c10',
    waterBase: '#0c1116',
    waterShimmer: '#131922',
    waterRipple: '#415b6b',
    waterWake: '#253641',
    shadowColor: '#020304',
    isLight: false,
    terrain: true,
    causticMotes: true
  },
  'light-pond': {
    name: 'light-pond',
    label: 'Dot Matrix Light',
    background: '#ffffff',
    backgroundSecondary: '#ffffff',
    waterBase: '#ffffff',
    waterShimmer: '#ececec',
    waterRipple: '#111111',
    waterWake: '#8a8a8a',
    shadowColor: '#bdbdbd',
    isLight: true,
    terrain: true,
    causticMotes: false
  }
};

const MAX_RIPPLES = 16;

const TRENCH_FLOOR_GLYPHS = ['T', 'I', 'L', 'T', 'J', 'I', 'T', 'L'];
const DEEP_SHELF_GLYPHS = ['V', 'T', 'Y', 'W', 'V', 'T', 'Y', 'V'];
const OUTER_CANOPY_GLYPHS = ['M', 'N', 'W', 'N', 'M', 'W', 'N', 'U'];
const MID_SLOPE_GLYPHS = ['U', 'N', 'M', 'O', 'U', 'N', 'W', 'O'];
const INNER_RING_GLYPHS = ['O', 'U', 'I', 'O', 'E', 'I', 'U', 'O'];
const CREST_CORE_GLYPHS = ['A', 'E', 'I', 'A', 'E', 'O', 'I', 'A'];

/** Per-tier terrain glyph colours + translucent cell background fills. */
interface TerrainTierColors {
  color: string;
  cellBg: string;
}

type TerrainTier =
  | 'ghost'
  | 'pocket'
  | 'crest'
  | 'ring4'
  | 'ring3'
  | 'slope'
  | 'deepShelf'
  | 'trench';

const TERRAIN_LIGHT: Record<TerrainTier, TerrainTierColors> = {
  ghost: { color: 'rgb(150, 150, 150)', cellBg: 'rgba(0, 0, 0, 0)' },
  pocket: { color: 'rgb(60, 60, 60)', cellBg: 'rgba(0, 0, 0, 0)' },
  crest: { color: 'rgb(0, 0, 0)', cellBg: 'rgba(0, 0, 0, 0)' },
  ring4: { color: 'rgb(0, 0, 0)', cellBg: 'rgba(0, 0, 0, 0)' },
  ring3: { color: 'rgb(20, 20, 20)', cellBg: 'rgba(0, 0, 0, 0)' },
  slope: { color: 'rgb(60, 60, 60)', cellBg: 'rgba(0, 0, 0, 0)' },
  deepShelf: { color: 'rgb(110, 110, 110)', cellBg: 'rgba(0, 0, 0, 0)' },
  trench: { color: 'rgb(150, 150, 150)', cellBg: 'rgba(0, 0, 0, 0)' }
};

/**
 * Dot-matrix (light theme) look of each terrain tier: `tone` is how large the diamond dot is
 * (0..1) and `ink` how dark it is in fifths (5 = pure black, lower = grey).
 */
const TERRAIN_DOTS: Record<TerrainTier, { tone: number; ink: number }> = {
  ghost: { tone: 0.12, ink: 1 },
  pocket: { tone: 0.26, ink: 3 },
  crest: { tone: 0.5, ink: 4 },
  ring4: { tone: 0.42, ink: 4 },
  ring3: { tone: 0.34, ink: 3 },
  slope: { tone: 0.26, ink: 3 },
  deepShelf: { tone: 0.2, ink: 2 },
  trench: { tone: 0.16, ink: 2 }
};

const TERRAIN_DARK: Record<TerrainTier, TerrainTierColors> = {
  ghost: { color: 'rgb(13, 37, 13)', cellBg: 'rgba(13, 37, 13, 0.04)' },
  pocket: { color: 'rgb(26, 74, 26)', cellBg: 'rgba(26, 74, 26, 0.20)' },
  crest: { color: 'rgb(187, 220, 18)', cellBg: 'rgba(187, 220, 18, 0.28)' },
  ring4: { color: 'rgb(142, 202, 60)', cellBg: 'rgba(142, 202, 60, 0.22)' },
  ring3: { color: 'rgb(73, 154, 19)', cellBg: 'rgba(73, 154, 19, 0.18)' },
  slope: { color: 'rgb(39, 111, 39)', cellBg: 'rgba(39, 111, 39, 0.14)' },
  deepShelf: { color: 'rgb(26, 74, 26)', cellBg: 'rgba(26, 74, 26, 0.10)' },
  trench: { color: 'rgb(13, 37, 13)', cellBg: 'rgba(13, 37, 13, 0.06)' }
};

export interface WaterCellSample {
  glyph: string;
  color: string;
  alpha: number;
  /** Optional translucent cell background block fill (rgba string) */
  cellBg?: string;
  /** Light (dot-matrix) theme: dot size 0..1 */
  tone?: number;
  /** Light (dot-matrix) theme: dot darkness in fifths, 1 = light grey .. 5 = black */
  ink?: number;
}

export class PondEnvironment {
  public cols = 0;
  public rows = 0;
  /** Per-cell wake/disturbance intensity buffer [0..1], preserved across no-op resizes */
  public wakeField = new Float32Array(0);
  /** Fixed-size pool of expanding concentric water ripples */
  public readonly ripples: PondRipple[] = [];

  constructor() {
    for (let i = 0; i < MAX_RIPPLES; i++) {
      this.ripples.push({
        x: 0,
        y: 0,
        radius: 0,
        maxRadius: 220,
        strength: 0,
        speed: 85,
        active: false
      });
    }
  }

  public ensureGridSize(cols: number, rows: number): boolean {
    if (cols === this.cols && rows === this.rows && this.wakeField.length === cols * rows) {
      return false;
    }
    this.cols = cols;
    this.rows = rows;
    this.wakeField = new Float32Array(cols * rows);
    return true;
  }

  public spawnRipple(x: number, y: number, maxRadius = 210, strength = 1.0, speed = 82): void {
    let slot = this.ripples.find((r) => !r.active);
    if (!slot) {
      slot = this.ripples.reduce((prev, curr) => (curr.strength < prev.strength ? curr : prev));
    }
    slot.x = x;
    slot.y = y;
    slot.radius = 4;
    slot.maxRadius = maxRadius;
    slot.strength = strength;
    slot.speed = speed;
    slot.active = true;
  }

  public depositWake(
    worldX: number,
    worldY: number,
    cellWidth: number,
    cellHeight: number,
    amount: number,
    radiusCells = 2
  ): void {
    if (this.cols === 0 || this.rows === 0) return;
    const cx = Math.floor(worldX / cellWidth);
    const cy = Math.floor(worldY / cellHeight);

    for (let dy = -radiusCells; dy <= radiusCells; dy++) {
      const ry = cy + dy;
      if (ry < 0 || ry >= this.rows) continue;
      for (let dx = -radiusCells; dx <= radiusCells; dx++) {
        const rx = cx + dx;
        if (rx < 0 || rx >= this.cols) continue;
        const dist = Math.hypot(dx, dy);
        if (dist <= radiusCells + 0.25) {
          const idx = ry * this.cols + rx;
          const falloff = 1 - dist / (radiusCells + 0.5);
          this.wakeField[idx] = koiClamp(this.wakeField[idx] + amount * falloff, 0, 1.0);
        }
      }
    }
  }

  public update(dt: number): void {
    const decay = Math.exp(-dt * 1.65);
    const wake = this.wakeField;
    for (let i = 0; i < wake.length; i++) {
      if (wake[i] > 0.004) {
        wake[i] *= decay;
      } else {
        wake[i] = 0;
      }
    }

    for (let i = 0; i < this.ripples.length; i++) {
      const r = this.ripples[i];
      if (!r.active) continue;
      r.radius += r.speed * dt;
      const progress = r.radius / r.maxRadius;
      r.strength = koiClamp(1 - progress * progress, 0, 1);
      if (r.radius >= r.maxRadius || r.strength <= 0.01) {
        r.active = false;
      }
    }
  }

  /**
   * Evaluates the background ASCII water cell at (col, row):
   * - Expanding concentric click ripples (`~`, `:`, `·`)
   * - Fish wake disturbance (`~`, `-`, `·`)
   * - Light theme: gentle topographic canopy terrain glyphs (celadon palette)
   * - Dark theme: the same terrain, drenched in deep green-teal on the black water
   */
  public sampleWaterCell(
    col: number,
    row: number,
    cellWidth: number,
    cellHeight: number,
    time: number,
    palette: PondPalette
  ): WaterCellSample | null {
    const wx = (col + 0.5) * cellWidth;
    const wy = (row + 0.5) * cellHeight;
    const idx = row * this.cols + col;
    const wake = this.wakeField[idx] || 0;

    // 1. Check active concentric click ripples
    let rippleIntensity = 0;
    for (let i = 0; i < this.ripples.length; i++) {
      const r = this.ripples[i];
      if (!r.active) continue;
      const dist = Math.hypot(wx - r.x, wy - r.y);
      const ringDelta = Math.abs(dist - r.radius);
      const bandWidth = 16;
      if (ringDelta < bandWidth) {
        const wave = Math.cos((ringDelta / bandWidth) * Math.PI * 0.5) * r.strength;
        if (wave > rippleIntensity) rippleIntensity = wave;
      }
    }

    if (rippleIntensity > 0.18) {
      const glyph = rippleIntensity > 0.62 ? '-' : '・';
      return {
        glyph,
        color: rippleIntensity > 0.45 ? palette.waterRipple : palette.waterWake,
        alpha: 0.85,
        tone: 0.3 + rippleIntensity * 0.55,
        ink: 5
      };
    }

    if (palette.terrain) {
      // 2. Topographic ASCII terrain (dark + light themes)
      const tiers = palette.isLight ? TERRAIN_LIGHT : TERRAIN_DARK;
      const nx = col / (this.cols || 1);
      const ny = row / (this.rows || 1);

      // Slow gentle breathing of the underwater contours
      const slowT = time * 0.04;
      const warp = fbm2D(nx * 3.6 + slowT, ny * 3.2 - slowT * 0.7, 31);
      const fineNoise = valueNoise2D(col * 0.18, row * 0.18, 97);

      const shoreCurve =
        0.47 -
        0.09 * Math.sin(ny * Math.PI * 1.35 - 0.2) +
        0.08 * warp;

      const rightProgress = (nx - shoreCurve) / (1 - shoreCurve || 1);

      if (rightProgress > -0.14) {
        const d1 = Math.hypot((nx - 0.67) / 0.16, (ny - 0.38) / 0.24);
        const mound1 = Math.max(0, 1 - d1 * d1 * 0.68);

        const d2 = Math.hypot((nx - 0.6) / 0.17, (ny - 0.66) / 0.22);
        const mound2 = Math.max(0, 1 - d2 * d2 * 0.72);

        const d3 = Math.hypot((nx - 0.84) / 0.18, (ny - 0.18) / 0.24);
        const mound3 = Math.max(0, 1 - d3 * d3 * 0.75);

        const d4 = Math.hypot((nx - 0.92) / 0.14, (ny - 0.72) / 0.26);
        const mound4 = Math.max(0, 1 - d4 * d4 * 0.75);

        const baseShelf = koiSmoothstep(-0.12, 0.22, rightProgress) * 0.44;
        const ridgePeak = Math.max(mound1, mound2 * 0.94, mound3 * 0.78, mound4 * 0.82);
        const elev = koiClamp(baseShelf + ridgePeak * 0.58 + warp * 0.14, 0, 1.15);

        const cellIdxHash = (col * 13 + row * 29) & 7;
        const pocketHash = hash2D(Math.floor(col * 0.5), Math.floor(row * 0.5), 53);

        // A. Faint transition ghost blocks along the shoreline (rightProgress in [-0.14, 0.08])
        if (elev >= 0.04 && elev < 0.12) {
          if (pocketHash > 0.32) {
            return {
              glyph: TRENCH_FLOOR_GLYPHS[cellIdxHash],
              color: tiers.ghost.color,
              alpha: koiClamp((elev - 0.03) * 4.0, 0.16, 0.38),
              cellBg: tiers.ghost.cellBg,
              tone: TERRAIN_DOTS.ghost.tone,
              ink: TERRAIN_DOTS.ghost.ink
            };
          }
          return null;
        }

        // B. Main Topographic Field (elev >= 0.12)
        if (elev >= 0.12) {
          const isRecessedPocket =
            elev < 0.74 && pocketHash < 0.22 && fineNoise < 0.48;

          if (isRecessedPocket) {
            return {
              glyph: DEEP_SHELF_GLYPHS[cellIdxHash],
              color: tiers.pocket.color,
              alpha: 0.58,
              cellBg: tiers.pocket.cellBg,
              tone: TERRAIN_DOTS.pocket.tone,
              ink: TERRAIN_DOTS.pocket.ink
            };
          }

          if (elev >= 0.86) {
            // Layer 5 — Peak / Crest Core (`A`, `E`, `I`, `O`)
            return {
              glyph: CREST_CORE_GLYPHS[cellIdxHash],
              color: tiers.crest.color,
              alpha: 0.96,
              cellBg: tiers.crest.cellBg,
              tone: TERRAIN_DOTS.crest.tone,
              ink: TERRAIN_DOTS.crest.ink
            };
          }

          if (elev >= 0.72) {
            // Layer 4 — Inner Ridge Ring (`O`, `U`, `I`, `E`)
            return {
              glyph: INNER_RING_GLYPHS[cellIdxHash],
              color: tiers.ring4.color,
              alpha: 0.92,
              cellBg: tiers.ring4.cellBg,
              tone: TERRAIN_DOTS.ring4.tone,
              ink: TERRAIN_DOTS.ring4.ink
            };
          }

          if (elev >= 0.54) {
            // Layer 3 — Mid Contour Ring (`U`, `N`, `M`, `O`)
            return {
              glyph: MID_SLOPE_GLYPHS[cellIdxHash],
              color: tiers.ring3.color,
              alpha: 0.86,
              cellBg: tiers.ring3.cellBg,
              tone: TERRAIN_DOTS.ring3.tone,
              ink: TERRAIN_DOTS.ring3.ink
            };
          }

          if (elev >= 0.38) {
            // Layer 2 — Outer Canopy Slope (`M`, `N`, `W`)
            return {
              glyph: OUTER_CANOPY_GLYPHS[cellIdxHash],
              color: tiers.slope.color,
              alpha: 0.76,
              cellBg: tiers.slope.cellBg,
              tone: TERRAIN_DOTS.slope.tone,
              ink: TERRAIN_DOTS.slope.ink
            };
          }

          if (elev >= 0.24) {
            // Layer 1 — Deep Shelf / Lower Abyss (`V`, `T`, `Y`, `W`)
            return {
              glyph: DEEP_SHELF_GLYPHS[cellIdxHash],
              color: tiers.deepShelf.color,
              alpha: 0.64,
              cellBg: tiers.deepShelf.cellBg,
              tone: TERRAIN_DOTS.deepShelf.tone,
              ink: TERRAIN_DOTS.deepShelf.ink
            };
          }

          // Layer 0 — Abyssal Floor / Trench (`T`, `I`, `L`, `J`)
          return {
            glyph: TRENCH_FLOOR_GLYPHS[cellIdxHash],
            color: tiers.trench.color,
            alpha: 0.48,
            cellBg: tiers.trench.cellBg,
            tone: TERRAIN_DOTS.trench.tone,
            ink: TERRAIN_DOTS.trench.ink
          };
        }
      }
    }

    // 3. Fish wake disturbance
    if (wake > 0.22) {
      const glyph = wake > 0.58 ? '-' : '・';
      return {
        glyph,
        color: palette.waterWake,
        alpha: 0.65,
        tone: 0.16 + wake * 0.22,
        ink: 2
      };
    }

    // 4. Sparse drifting caustic motes on the open black water (dark theme)
    if (palette.causticMotes) {
      const moteNoise = valueNoise2D(col * 0.11 + time * 0.05, row * 0.13 - time * 0.03, 211);
      const spark = hash2D(
        Math.floor(col * 0.23),
        Math.floor(row * 0.31),
        Math.floor(time * 0.7) * 7919 + 131
      );
      if (spark > 0.976 && moteNoise > 0.42) {
        return {
          glyph: '・',
          color: palette.waterRipple,
          alpha: 0.16 + (spark - 0.976) * 8 * Math.min(1, moteNoise)
        };
      }
    }

    return null;
  }
}
