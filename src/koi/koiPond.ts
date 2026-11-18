/**
 * Pond environment, colour themes, wake trails, and expanding concentric click ripples.
 */

import { koiClamp } from "./koiMath";
import type { PondPalette, PondRipple, PondThemeName } from "./koiTypes";

export const POND_PALETTES: Record<PondThemeName, PondPalette> = {
  "black-pond": {
    name: "black-pond",
    label: "Sumi Black Pond",
    background: "#050608",
    backgroundSecondary: "#090c10",
    waterBase: "#0c1116",
    waterShimmer: "#131922",
    waterRipple: "#415b6b",
    waterWake: "#253641",
    shadowColor: "#020304",
    isLight: false,
    terrain: true,
    causticMotes: true,
  },
  "light-pond": {
    name: "light-pond",
    label: "Washi Light Pond",
    background: "#ffffff",
    backgroundSecondary: "#ffffff",
    waterBase: "#ffffff",
    waterShimmer: "#ececec",
    waterRipple: "#111111",
    waterWake: "#8a8a8a",
    shadowColor: "#bdbdbd",
    isLight: true,
    terrain: true,
    causticMotes: false,
  },
};

const MAX_RIPPLES = 16;

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
        active: false,
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
}
