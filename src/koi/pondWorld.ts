/**
 * PondWorld: the artificial-life world that drives the portfolio hero.
 * Owns the PondEnvironment (wake trails + click ripples), floating koi food pellets,
 * the koi fish steering themselves with goal-driven behaviors + fluid cursor curiosity
 * and food foraging, and the small schooling medaka minnows.
 */

import {
  attractKoiToFood,
  createKoiFish,
  pondFishSplash,
  rescalePondFish,
  seedPondFish,
  stepPondFish,
  rescaleKoi,
  updateKoiSimulation,
  type PondPointerState
} from './koiSimulation';
import { SPINE_NODE_COUNT } from './koiGeometry';
import { koiAngleDiff, koiClamp, KOI_TAU } from './koiMath';
import { PondEnvironment } from './koiPond';
import type { KoiFish, KoiPondConfig, KoiSpec, PondFish, PondFoodPellet } from './koiTypes';
import { VARIETY_ORDER } from './koiVarieties';

export const DEFAULT_KOI_CONFIG: KoiPondConfig = {
  fishCount: 4,
  minSize: 3.28,
  maxSize: 4.41,
  animationSpeed: 10.0,
  cellWidth: 10,
  cellHeight: 17,
  detailQuality: 'high',
  pondTheme: 'light-pond',
  interactionSensitivity: 1.0,
  showScales: true,
  showWaterTexture: true,
  respectReducedMotion: true
};

const MAX_KOI_SNAPSHOT = 4;
const MAX_MINNOW_SNAPSHOT = 512;
const MAX_FOOD_PELLETS = 24;

export class PondWorld {
  width = 0;
  height = 0;
  time = 0;
  koi: KoiFish[] = [];
  fish: PondFish[] = [];
  food: PondFoodPellet[] = [];
  private nextFoodId = 1;

  readonly pond = new PondEnvironment();
  readonly pointer: PondPointerState = {
    x: -9999,
    y: -9999,
    vx: 0,
    vy: 0,
    active: false,
    curiousKoiId: 0
  };

  /** Small fish are stepped in discrete quanta to match the glyph cadence. */
  private fishStepAccum = 0;

  // Preallocated fixed-step interpolation snapshots (zero allocations per frame)
  private readonly prevKoiSpineX = new Float32Array(MAX_KOI_SNAPSHOT * SPINE_NODE_COUNT);
  private readonly prevKoiSpineY = new Float32Array(MAX_KOI_SNAPSHOT * SPINE_NODE_COUNT);
  private readonly currKoiSpineX = new Float32Array(MAX_KOI_SNAPSHOT * SPINE_NODE_COUNT);
  private readonly currKoiSpineY = new Float32Array(MAX_KOI_SNAPSHOT * SPINE_NODE_COUNT);
  private readonly currKoiSpineTx = new Float32Array(MAX_KOI_SNAPSHOT * SPINE_NODE_COUNT);
  private readonly currKoiSpineTy = new Float32Array(MAX_KOI_SNAPSHOT * SPINE_NODE_COUNT);
  // Per koi: [x, y, phase, finPhase, curvature, bboxMinX, bboxMinY, bboxMaxX, bboxMaxY]
  private readonly prevKoiScalars = new Float32Array(MAX_KOI_SNAPSHOT * 9);
  private readonly currKoiScalars = new Float32Array(MAX_KOI_SNAPSHOT * 9);
  private readonly prevMinnowXY = new Float32Array(MAX_MINNOW_SNAPSHOT * 2);
  private readonly currMinnowXY = new Float32Array(MAX_MINNOW_SNAPSHOT * 2);
  private prevTime = 0;
  private currTime = 0;
  private hasSnapshot = false;
  private isInterpolated = false;

  constructor(public config: KoiPondConfig) {}

  resize(width: number, height: number) {
    const first = this.width === 0;
    const hadSize = first === false && this.width > 0 && this.height > 0;
    const oldW = this.width;
    const oldH = this.height;
    this.width = width;
    this.height = height;

    if (this.koi.length === 0 || first) {
      this.seed();
      return;
    }

    if (hadSize) {
      rescalePondFish(this.fish, oldW, oldH, width, height);
      rescaleKoi(this.koi, oldW, oldH, width, height);
      for (const f of this.fish) {
        f.x = koiClamp(f.x, -60, width + 60);
        f.y = koiClamp(f.y, -60, height + 60);
      }
      const sx = width / oldW;
      const sy = height / oldH;
      for (const p of this.food) {
        p.x = koiClamp(p.x * sx, 16, width - 16);
        p.y = koiClamp(p.y * sy, 16, height - 16);
      }
      this.hasSnapshot = false;
    }
  }

  /**
   * Smoothly adjusts the active simulation bounds `(newW, newH)` when the pond concentrates into
   * the left-side hand-painted rectangle beside the 4 columns. Shifts each Koi's head, trail, and
   * spine rigidly without hard-clamping at the edges so fish never bounce during transitions.
   */
  setSimulationBounds(newW: number, newH: number) {
    const targetW = Math.max(240, newW);
    const targetH = Math.max(240, newH);
    if (this.width <= 0 || this.height <= 0 || this.koi.length === 0) {
      this.resize(targetW, targetH);
      return;
    }
    if (Math.abs(targetW - this.width) < 0.5 && Math.abs(targetH - this.height) < 0.5) {
      return;
    }

    const sx = targetW / this.width;
    const sy = targetH / this.height;
    this.width = targetW;
    this.height = targetH;

    for (let i = 0; i < this.koi.length; i++) {
      const f = this.koi[i];
      const nextX = koiClamp(f.x * sx, -120, targetW + 120);
      const nextY = koiClamp(f.y * sy, -120, targetH + 120);
      const dx = nextX - f.x;
      const dy = nextY - f.y;

      f.x = nextX;
      f.y = nextY;
      f.brain.targetX = koiClamp(f.brain.targetX * sx, 16, targetW - 16);
      f.brain.targetY = koiClamp(f.brain.targetY * sy, 16, targetH - 16);
      if (f.brain.hasPerceivedTarget) {
        f.brain.perceivedX = koiClamp(f.brain.perceivedX * sx, 16, targetW - 16);
        f.brain.perceivedY = koiClamp(f.brain.perceivedY * sy, 16, targetH - 16);
      }

      for (let k = 0; k < f.trailX.length; k++) {
        f.trailX[k] += dx;
        f.trailY[k] += dy;
      }
      for (let k = 0; k < f.restSpineX.length; k++) {
        f.restSpineX[k] += dx;
        f.restSpineY[k] += dy;
      }
      for (let k = 0; k < f.spine.length; k++) {
        f.spine[k].x += dx;
        f.spine[k].y += dy;
      }
      f.bbox.minX += dx;
      f.bbox.maxX += dx;
      f.bbox.minY += dy;
      f.bbox.maxY += dy;
    }

    for (let i = 0; i < this.fish.length; i++) {
      const mf = this.fish[i];
      mf.x = koiClamp(mf.x * sx, -60, targetW + 60);
      mf.y = koiClamp(mf.y * sy, -60, targetH + 60);
    }

    for (let i = 0; i < this.pond.ripples.length; i++) {
      const r = this.pond.ripples[i];
      r.x *= sx;
      r.y *= sy;
    }

    for (let i = 0; i < this.food.length; i++) {
      const p = this.food[i];
      p.x = koiClamp(p.x * sx, 16, targetW - 16);
      p.y = koiClamp(p.y * sy, 16, targetH - 16);
    }

    this.hasSnapshot = false;
  }

  seed() {
    const w = Math.max(320, this.width);
    const h = Math.max(240, this.height);

    const specs: KoiSpec[] | undefined = this.config.fishSpecs?.slice(
      0,
      koiClamp(this.config.fishCount, 1, 4)
    );
    const count = koiClamp(
      specs ? specs.length : this.config.fishCount,
      1,
      4
    );

    this.koi = [];
    for (let i = 0; i < count; i++) {
      const spec: KoiSpec =
        specs?.[i] ?? {
          variety: VARIETY_ORDER[i % VARIETY_ORDER.length],
          size:
            this.config.minSize +
            (count > 1 ? i / (count - 1) : 0.5) *
              (this.config.maxSize - this.config.minSize)
        };
      this.koi.push(createKoiFish(i + 1, spec, w, h, this.config));
    }

    this.fish = seedPondFish(w, h);
    this.food = [];
    this.fishStepAccum = 0;
    this.hasSnapshot = false;
  }

  /**
   * Click / tap on the pond: food dropping is disabled so clicking does not drop pellets.
   */
  splash(_x: number, _y: number) {
    // Intentionally passive: clicking no longer drops koi food pellets.
  }

  private capturePrevSnapshot() {
    this.prevTime = this.time;
    const kCount = Math.min(MAX_KOI_SNAPSHOT, this.koi.length);
    for (let k = 0; k < kCount; k++) {
      const f = this.koi[k];
      const sOff = k * SPINE_NODE_COUNT;
      for (let i = 0; i < SPINE_NODE_COUNT; i++) {
        this.prevKoiSpineX[sOff + i] = f.spine[i].x;
        this.prevKoiSpineY[sOff + i] = f.spine[i].y;
      }
      const bOff = k * 9;
      this.prevKoiScalars[bOff] = f.x;
      this.prevKoiScalars[bOff + 1] = f.y;
      this.prevKoiScalars[bOff + 2] = f.phase;
      this.prevKoiScalars[bOff + 3] = f.finPhase;
      this.prevKoiScalars[bOff + 4] = f.curvature;
      this.prevKoiScalars[bOff + 5] = f.bbox.minX;
      this.prevKoiScalars[bOff + 6] = f.bbox.minY;
      this.prevKoiScalars[bOff + 7] = f.bbox.maxX;
      this.prevKoiScalars[bOff + 8] = f.bbox.maxY;
    }

    const mCount = Math.min(MAX_MINNOW_SNAPSHOT, this.fish.length);
    for (let i = 0; i < mCount; i++) {
      this.prevMinnowXY[i * 2] = this.fish[i].x;
      this.prevMinnowXY[i * 2 + 1] = this.fish[i].y;
    }
    this.hasSnapshot = true;
  }

  /**
   * Temporarily interpolates the world pose between the previous and current fixed simulation
   * steps by `alpha` in [0, 1] for smooth rendering at arbitrary display refresh rates.
   */
  applyInterpolation(alpha: number) {
    if (!this.hasSnapshot || alpha >= 0.999 || alpha < 0) {
      this.isInterpolated = false;
      return;
    }
    const a = koiClamp(alpha, 0, 1);
    this.currTime = this.time;
    this.time = this.prevTime + (this.currTime - this.prevTime) * a;

    const kCount = Math.min(MAX_KOI_SNAPSHOT, this.koi.length);
    for (let k = 0; k < kCount; k++) {
      const f = this.koi[k];
      const sOff = k * SPINE_NODE_COUNT;
      for (let i = 0; i < SPINE_NODE_COUNT; i++) {
        const node = f.spine[i];
        this.currKoiSpineX[sOff + i] = node.x;
        this.currKoiSpineY[sOff + i] = node.y;
        this.currKoiSpineTx[sOff + i] = node.tx;
        this.currKoiSpineTy[sOff + i] = node.ty;

        const px = this.prevKoiSpineX[sOff + i];
        const py = this.prevKoiSpineY[sOff + i];
        node.x = px + (node.x - px) * a;
        node.y = py + (node.y - py) * a;
      }

      const segLen = (f.bodyLength * 0.83) / (SPINE_NODE_COUNT - 1);
      let headTx = f.spine[0].x - f.spine[4].x;
      let headTy = f.spine[0].y - f.spine[4].y;
      const headLen = Math.hypot(headTx, headTy) || 1;
      headTx /= headLen;
      headTy /= headLen;
      for (let i = 1; i <= 4; i++) {
        f.spine[i].x = f.spine[0].x - headTx * (i * segLen);
        f.spine[i].y = f.spine[0].y - headTy * (i * segLen);
      }

      for (let i = 0; i < SPINE_NODE_COUNT; i++) {
        const node = f.spine[i];
        if (i <= 3) {
          node.tx = headTx;
          node.ty = headTy;
          node.nx = -headTy;
          node.ny = headTx;
          continue;
        }
        let tx: number;
        let ty: number;
        if (i === SPINE_NODE_COUNT - 1) {
          const prev = f.spine[SPINE_NODE_COUNT - 2];
          tx = prev.x - node.x;
          ty = prev.y - node.y;
        } else {
          const prev = f.spine[i - 1];
          const next = f.spine[i + 1];
          tx = prev.x - next.x;
          ty = prev.y - next.y;
        }
        const len = Math.hypot(tx, ty) || 1;
        node.tx = tx / len;
        node.ty = ty / len;
        node.nx = -node.ty;
        node.ny = node.tx;
      }

      const bOff = k * 9;
      this.currKoiScalars[bOff] = f.x;
      this.currKoiScalars[bOff + 1] = f.y;
      this.currKoiScalars[bOff + 2] = f.phase;
      this.currKoiScalars[bOff + 3] = f.finPhase;
      this.currKoiScalars[bOff + 4] = f.curvature;
      this.currKoiScalars[bOff + 5] = f.bbox.minX;
      this.currKoiScalars[bOff + 6] = f.bbox.minY;
      this.currKoiScalars[bOff + 7] = f.bbox.maxX;
      this.currKoiScalars[bOff + 8] = f.bbox.maxY;

      f.x = this.prevKoiScalars[bOff] + (f.x - this.prevKoiScalars[bOff]) * a;
      f.y = this.prevKoiScalars[bOff + 1] + (f.y - this.prevKoiScalars[bOff + 1]) * a;
      f.phase = (this.prevKoiScalars[bOff + 2] + koiAngleDiff(this.prevKoiScalars[bOff + 2], f.phase) * a + KOI_TAU) % KOI_TAU;
      f.finPhase = (this.prevKoiScalars[bOff + 3] + koiAngleDiff(this.prevKoiScalars[bOff + 3], f.finPhase) * a + KOI_TAU) % KOI_TAU;
      f.curvature = this.prevKoiScalars[bOff + 4] + (f.curvature - this.prevKoiScalars[bOff + 4]) * a;
      f.bbox.minX = Math.min(this.prevKoiScalars[bOff + 5], f.bbox.minX);
      f.bbox.minY = Math.min(this.prevKoiScalars[bOff + 6], f.bbox.minY);
      f.bbox.maxX = Math.max(this.prevKoiScalars[bOff + 7], f.bbox.maxX);
      f.bbox.maxY = Math.max(this.prevKoiScalars[bOff + 8], f.bbox.maxY);
    }

    const mCount = Math.min(MAX_MINNOW_SNAPSHOT, this.fish.length);
    for (let i = 0; i < mCount; i++) {
      const mf = this.fish[i];
      const ox = i * 2;
      this.currMinnowXY[ox] = mf.x;
      this.currMinnowXY[ox + 1] = mf.y;
      mf.x = this.prevMinnowXY[ox] + (mf.x - this.prevMinnowXY[ox]) * a;
      mf.y = this.prevMinnowXY[ox + 1] + (mf.y - this.prevMinnowXY[ox + 1]) * a;
    }

    this.isInterpolated = true;
  }

  /** Restores the exact simulation state after rendering an interpolated frame. */
  restoreSimulationState() {
    if (!this.isInterpolated) return;
    this.time = this.currTime;

    const kCount = Math.min(MAX_KOI_SNAPSHOT, this.koi.length);
    for (let k = 0; k < kCount; k++) {
      const f = this.koi[k];
      const sOff = k * SPINE_NODE_COUNT;
      for (let i = 0; i < SPINE_NODE_COUNT; i++) {
        const node = f.spine[i];
        node.x = this.currKoiSpineX[sOff + i];
        node.y = this.currKoiSpineY[sOff + i];
        node.tx = this.currKoiSpineTx[sOff + i];
        node.ty = this.currKoiSpineTy[sOff + i];
        node.nx = -node.ty;
        node.ny = node.tx;
      }
      const bOff = k * 9;
      f.x = this.currKoiScalars[bOff];
      f.y = this.currKoiScalars[bOff + 1];
      f.phase = this.currKoiScalars[bOff + 2];
      f.finPhase = this.currKoiScalars[bOff + 3];
      f.curvature = this.currKoiScalars[bOff + 4];
      f.bbox.minX = this.currKoiScalars[bOff + 5];
      f.bbox.minY = this.currKoiScalars[bOff + 6];
      f.bbox.maxX = this.currKoiScalars[bOff + 7];
      f.bbox.maxY = this.currKoiScalars[bOff + 8];
    }

    const mCount = Math.min(MAX_MINNOW_SNAPSHOT, this.fish.length);
    for (let i = 0; i < mCount; i++) {
      const mf = this.fish[i];
      const ox = i * 2;
      mf.x = this.currMinnowXY[ox];
      mf.y = this.currMinnowXY[ox + 1];
    }

    this.isInterpolated = false;
  }

  step(dt: number) {
    this.capturePrevSnapshot();
    this.time += dt;

    updateKoiSimulation(
      this.koi,
      this.pond,
      this.pointer,
      this.food,
      this.width,
      this.height,
      this.time,
      dt,
      this.config
    );

    this.fishStepAccum += dt;
    const Q = 1 / 12;
    if (this.fishStepAccum >= Q) {
      const d = Math.min(this.fishStepAccum, Q * 2);
      this.fishStepAccum = 0;
      stepPondFish(
        this.fish,
        this.koi,
        this.pointer,
        this.width,
        this.height,
        this.time,
        d
      );
    }

    this.pond.update(dt);
  }
}
