/**
 * Goal-driven koi steering with fluid single-fish cursor curiosity and multi-fish food foraging.
 */

import { SPINE_NODE_COUNT, updateFishSpineGeometry } from './koiGeometry';
import { koiAngleDiff, koiClamp, koiLerp, mulberry32, KOI_TAU } from './koiMath';
import type { PondEnvironment } from './koiPond';
import type {
  KoiBehavior,
  KoiBrain,
  KoiFish,
  KoiPondConfig,
  KoiSpec,
  KoiVariety,
  SpineNode,
  PondFish,
  PondFoodPellet
} from './koiTypes';
import { generateVarietyPatchesAndColors, KOI_VARIETIES, pickKoiName, VARIETY_ORDER } from './koiVarieties';

export interface PondPointerState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  active: boolean;
  /** ID of the single random koi currently curious about the hovering cursor (0 if none) */
  curiousKoiId?: number;
}

/* -------------------------------------------------------------------------
 * Tuning. Everything that makes the motion calm lives here.
 * ---------------------------------------------------------------------- */

const TRAIL_STEP = 4;
const CRUISE_BODY_LENGTHS_PER_SEC = 0.34;
const MIN_TURN_RADIUS_BL = 0.48;
const MAX_TURN_RATE = 1.02;
const MAX_BENDS = 2;
const BEND_MIN = 0.14;
const NET_BLOCK = 1.55;
const FORWARD_CONE = 1.15;
const WAYPOINT_LOST = 1.4;
const SLOT_BEHIND = 1.2;
const TURN_GAIN = 1.75;
const TURN_ACCEL = 1.32;
const SPEED_TAU = 1.3;
const ACCEL_BL = 0.10;
const MIN_SPEED_FACTOR = 0.24;
const MAX_STEP = 1 / 30;

/**
 * Expanded virtual boundary beyond `[0, w] x [0, h]` (in world px) so koi can swim
 * right up to and slightly past the visible edge while curving smoothly back inward,
 * never crashing into or bouncing off an invisible inner wall.
 */
const OUTER_BOUND_PAD = 110;
const HARD_SAFETY_PAD = 240;

const LOOKAHEAD = [0, 0.8, 1.6, 2.4, 3.2] as const;
const BODY_SAMPLES = 6;
const BODY_IDX: number[] = Array.from({ length: BODY_SAMPLES }, (_, k) =>
  Math.round((k / (BODY_SAMPLES - 1)) * (SPINE_NODE_COUNT - 1))
);
const SAFE_WIDTH_FACTOR = 2.0;
const CAUTION_FACTOR = 1.5;
const HARD_FACTOR = 0.58;

const KOI_STARTS: ReadonlyArray<readonly [number, number, number]> = [
  [0.34, 0.28, 0.18],
  [0.66, 0.72, Math.PI + 0.18],
  [0.78, 0.34, -2.4],
  [0.24, 0.74, 0.55]
];

const KOI_HOMES: ReadonlyArray<readonly [number, number]> = [
  [0.30, 0.30],
  [0.70, 0.70],
  [0.72, 0.30],
  [0.28, 0.70]
];

const BEHAVIOR_KINDS: ReadonlyArray<KoiBehavior> = ['cruise', 'loiter', 'drift', 'trail'];

function wrapAngle(a: number): number {
  return a - KOI_TAU * Math.floor((a + Math.PI) / KOI_TAU);
}

function turnRadius(f: KoiFish): number {
  return f.bodyLength * MIN_TURN_RADIUS_BL;
}

function pointSegDist(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  const t = len2 > 1e-6 ? koiClamp(((px - ax) * abx + (py - ay) * aby) / len2, 0, 1) : 0;
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

/* -------------------------------------------------------------------------
 * Head trail -> spine
 * ---------------------------------------------------------------------- */

function resetTrail(f: KoiFish): void {
  const cap = f.trailX.length;
  const bx = -Math.cos(f.angle) * TRAIL_STEP;
  const by = -Math.sin(f.angle) * TRAIL_STEP;
  f.trailHead = 0;
  for (let i = 0; i < cap; i++) {
    const idx = (f.trailHead - i + cap) % cap;
    f.trailX[idx] = f.x + bx * (i + 1);
    f.trailY[idx] = f.y + by * (i + 1);
  }
  f.trailCount = cap;
}

function pushTrail(f: KoiFish): void {
  const cap = f.trailX.length;
  const lx = f.trailX[f.trailHead];
  const ly = f.trailY[f.trailHead];
  if (Math.hypot(f.x - lx, f.y - ly) >= TRAIL_STEP) {
    f.trailHead = (f.trailHead + 1) % cap;
    f.trailX[f.trailHead] = f.x;
    f.trailY[f.trailHead] = f.y;
    if (f.trailCount < cap) f.trailCount++;
  }
}

function sampleSpineFromTrail(f: KoiFish): void {
  const cap = f.trailX.length;
  const segLen = (f.bodyLength * 0.83) / (SPINE_NODE_COUNT - 1);

  let ax = f.x;
  let ay = f.y;
  let arc = 0;
  let ti = f.trailHead;
  let used = 0;
  let bx = f.trailX[ti];
  let by = f.trailY[ti];
  let segEnd = Math.hypot(bx - ax, by - ay);

  for (let k = 0; k < SPINE_NODE_COUNT; k++) {
    const target = k * segLen;
    while (target > segEnd && used < f.trailCount - 1) {
      ax = bx;
      ay = by;
      arc = segEnd;
      ti = (ti - 1 + cap) % cap;
      used++;
      bx = f.trailX[ti];
      by = f.trailY[ti];
      segEnd = arc + Math.hypot(bx - ax, by - ay);
    }
    const span = segEnd - arc;
    const t = span > 1e-6 ? koiClamp((target - arc) / span, 0, 1) : 1;
    f.restSpineX[k] = ax + (bx - ax) * t;
    f.restSpineY[k] = ay + (by - ay) * t;
  }
}

/* -------------------------------------------------------------------------
 * Creation
 * ---------------------------------------------------------------------- */

export function createKoiFish(
  id: number,
  spec: KoiSpec,
  width: number,
  height: number,
  config: KoiPondConfig
): KoiFish {
  const seed = (spec.seed ?? (id * 2654435761 + 1013904223)) >>> 0;
  const rand = mulberry32(seed);

  const rawVar = spec.variety;
  const variety: KoiVariety =
    rawVar && rawVar in KOI_VARIETIES
      ? rawVar
      : VARIETY_ORDER[(id - 1) % VARIETY_ORDER.length];
  const meta = KOI_VARIETIES[variety] ?? KOI_VARIETIES.kohaku;

  const size = koiClamp(
    spec.size ?? koiLerp(config.minSize, config.maxSize, (id - 1) / 3),
    2.0,
    5.0
  );

  const viewportScale = koiClamp(Math.min(width, height) / 920, 0.68, 1.12);
  const girthFactor = 0.94 + rand() * 0.1;
  const finSpanFactor = 0.95 + rand() * 0.12;
  const tailLengthFactor = 0.96 + rand() * 0.12;

  const bodyLength = Math.round(115 * size * viewportScale);
  const maxHalfWidth = bodyLength * 0.154 * girthFactor;

  const start = KOI_STARTS[(id - 1) % KOI_STARTS.length];
  const home = KOI_HOMES[(id - 1) % KOI_HOMES.length];
  const angle = wrapAngle(start[2] + (rand() - 0.5) * 0.2);
  const x = koiClamp(start[0] * width, 16, width - 16);
  const y = koiClamp(start[1] * height, 16, height - 16);

  const baseCruiseSpeed =
    bodyLength * CRUISE_BODY_LENGTHS_PER_SEC * (0.92 + rand() * 0.16);

  const { patches, colors } = generateVarietyPatchesAndColors(variety, seed);

  const spine: SpineNode[] = [];
  const restSpineX = new Float32Array(SPINE_NODE_COUNT);
  const restSpineY = new Float32Array(SPINE_NODE_COUNT);

  for (let i = 0; i < SPINE_NODE_COUNT; i++) {
    spine.push({
      x: 0,
      y: 0,
      tx: 1,
      ty: 0,
      nx: 0,
      ny: 1,
      s: (i / (SPINE_NODE_COUNT - 1)) * 0.83,
      halfWidth: 0
    });
  }

  const brain: KoiBrain = {
    behavior: 'cruise',
    targetX: koiClamp(x + Math.cos(angle) * width * 0.3, 16, width - 16),
    targetY: koiClamp(y + Math.sin(angle) * height * 0.3, 16, height - 16),
    targetAge: 0,
    speedFactor: 0.7,
    orbitX: x,
    orbitY: y,
    orbitRadius: bodyLength * MIN_TURN_RADIUS_BL * 1.3,
    orbitDir: 1,
    followId: 0,
    followSide: 1,
    wanderPhase: rand() * KOI_TAU,
    avoidBias: 0,
    blockedTime: 0,
    weights: {
      cruise: 1.0 * (0.8 + rand() * 0.5),
      loiter: 0.8 * (0.5 + rand() * 1.0),
      drift: 0.6 * (0.5 + rand() * 1.0),
      trail: 0.5 * (0.4 + rand() * 1.2)
    },
    homeX: home[0],
    homeY: home[1],
    rng: mulberry32((seed ^ 0x85ebca6b) >>> 0),
    attentionWeight: 0,
    perceptionDelay: 0,
    perceivedX: x,
    perceivedY: y,
    hasPerceivedTarget: false,
    approachSign: rand() < 0.5 ? 1 : -1,
    foodTargetId: 0
  };

  const trailCap = Math.ceil((bodyLength * 1.35) / TRAIL_STEP) + 16;

  const fish: KoiFish = {
    id,
    name: pickKoiName(variety, id - 1),
    variety,
    varietyLabel: meta.label,
    varietyJapanese: meta.japanese,
    seed,
    size,
    bodyLength,
    maxHalfWidth,
    girthFactor,
    finSpanFactor,
    tailLengthFactor,
    x,
    y,
    angle,
    turnRate: 0,
    curvature: 0,
    speed: baseCruiseSpeed * 0.7,
    baseCruiseSpeed,
    yieldMultiplier: 1.0,
    swimMode: 'cruise',
    modeTimer: 2.0 + rand() * 3.0,
    brain,
    trailX: new Float32Array(trailCap),
    trailY: new Float32Array(trailCap),
    trailHead: 0,
    trailCount: 0,
    phase: rand() * KOI_TAU,
    finPhase: rand() * KOI_TAU,
    startleBoost: 0,
    spine,
    restSpineX,
    restSpineY,
    patches,
    colors,
    bbox: { minX: 0, minY: 0, maxX: width, maxY: height }
  };

  resetTrail(fish);
  sampleSpineFromTrail(fish);
  updateFishSpineGeometry(fish);
  return fish;
}

export function rescaleKoi(
  koi: KoiFish[],
  oldW: number,
  oldH: number,
  newW: number,
  newH: number
): void {
  if (oldW <= 0 || oldH <= 0) return;
  const sx = newW / oldW;
  const sy = newH / oldH;
  for (const f of koi) {
    f.x = koiClamp(f.x * sx, -OUTER_BOUND_PAD, newW + OUTER_BOUND_PAD);
    f.y = koiClamp(f.y * sy, -OUTER_BOUND_PAD, newH + OUTER_BOUND_PAD);
    f.modeTimer = 0;
    f.brain.targetAge = 0;
    f.brain.blockedTime = 0;
    if (f.brain.hasPerceivedTarget) {
      f.brain.perceivedX = koiClamp(f.brain.perceivedX * sx, 16, newW - 16);
      f.brain.perceivedY = koiClamp(f.brain.perceivedY * sy, 16, newH - 16);
    }
    resetTrail(f);
    sampleSpineFromTrail(f);
    updateFishSpineGeometry(f);
  }
}

function pickNaturalApproachSign(f: KoiFish, tx: number, ty: number): 1 | -1 {
  const bearing = koiAngleDiff(f.angle, Math.atan2(ty - f.y, tx - f.x));
  if (Math.abs(bearing) > 0.14) {
    return bearing >= 0 ? 1 : -1;
  }
  if (Math.abs(f.turnRate) > 0.04) {
    return f.turnRate >= 0 ? 1 : -1;
  }
  return f.brain.rng() < 0.5 ? 1 : -1;
}

export function attractKoiToFood(
  fishes: KoiFish[],
  spawnedPellets: PondFoodPellet[],
  dropX: number,
  dropY: number
): void {
  if (fishes.length === 0 || spawnedPellets.length === 0) return;

  const order = fishes
    .map((f, idx) => ({ f, idx, d: Math.hypot(dropX - f.x, dropY - f.y) }))
    .sort((a, b) => a.d - b.d);

  for (let rank = 0; rank < order.length; rank++) {
    const { f, d } = order[rank];
    const b = f.brain;
    const assignedPellet = spawnedPellets[rank % spawnedPellets.length];
    b.foodTargetId = assignedPellet.id;

    const distDelay = koiClamp(d / 1400, 0.04, 0.22);
    b.perceptionDelay = 0.05 + rank * 0.06 + distDelay * (0.7 + b.rng() * 0.5);

    const naturalSign = pickNaturalApproachSign(f, assignedPellet.x, assignedPellet.y);
    b.approachSign = rank % 2 === 0 ? naturalSign : (naturalSign === 1 ? -1 : 1);

    if (!b.hasPerceivedTarget) {
      b.perceivedX = assignedPellet.x;
      b.perceivedY = assignedPellet.y;
      b.hasPerceivedTarget = true;
    }
  }
}

export function reactFishToClick(
  fishes: KoiFish[],
  clickX: number,
  clickY: number,
  _sensitivity: number
): void {
  for (let i = 0; i < fishes.length; i++) {
    const f = fishes[i];
    f.brain.perceivedX = clickX;
    f.brain.perceivedY = clickY;
    f.brain.hasPerceivedTarget = true;
  }
}

/* -------------------------------------------------------------------------
 * Behaviors: choosing goals
 * ---------------------------------------------------------------------- */

function pickWaypoint(f: KoiFish, fishes: KoiFish[], w: number, h: number): void {
  const b = f.brain;
  const rng = b.rng;
  const rMin = turnRadius(f);
  // Allow waypoints across a much wider expanse of the pond so koi use the full space naturally
  const mx = Math.max(12, w * 0.03);
  const my = Math.max(12, h * 0.03);
  const cosA = Math.cos(f.angle);
  const sinA = Math.sin(f.angle);
  const diag = Math.hypot(w, h);
  const space = f.bodyLength;
  const mid = SPINE_NODE_COUNT >> 1;

  let best = -Infinity;
  let bestX = NaN;
  let bestY = NaN;

  for (let c = 0; c < 14; c++) {
    const ang = f.angle + (rng() * 2 - 1) * FORWARD_CONE;
    const dist = rMin * 2.2 + rng() * diag * 0.48;
    const tx = koiClamp(f.x + Math.cos(ang) * dist, mx, w - mx);
    const ty = koiClamp(f.y + Math.sin(ang) * dist, my, h - my);
    const dx = tx - f.x;
    const dy = ty - f.y;
    if (Math.hypot(dx, dy) < rMin * 1.8) continue;

    const lx = dx * cosA + dy * sinA;
    const ly = -dx * sinA + dy * cosA;
    const circleY = ly >= 0 ? rMin : -rMin;
    if (Math.hypot(lx, ly - circleY) < rMin * 1.02) continue;

    let clear = space * 3;
    for (const o of fishes) {
      if (o === f) continue;
      clear = Math.min(
        clear,
        pointSegDist(o.x, o.y, f.x, f.y, tx, ty),
        pointSegDist(o.restSpineX[mid], o.restSpineY[mid], f.x, f.y, tx, ty),
        Math.hypot(tx - o.x, ty - o.y)
      );
    }
    const homeD = Math.hypot(tx - b.homeX * w, ty - b.homeY * h) / diag;
    const score =
      (Math.min(clear, space * 2.2) / (space * 2.2)) * 1.3 +
      (1 - homeD * 1.4) * 0.35 +
      rng() * 0.4;
    if (score > best) {
      best = score;
      bestX = tx;
      bestY = ty;
    }
  }

  if (!Number.isFinite(bestX)) {
    bestX = koiClamp(f.x + cosA * rMin * 2.5, mx, w - mx);
    bestY = koiClamp(f.y + sinA * rMin * 2.5, my, h - my);
  }

  b.targetX = bestX;
  b.targetY = bestY;
  b.targetAge = 0;
  b.speedFactor = 0.6 + rng() * 0.4;
}

function startCruise(f: KoiFish, fishes: KoiFish[], w: number, h: number): void {
  f.brain.behavior = 'cruise';
  f.modeTimer = 9 + f.brain.rng() * 7;
  pickWaypoint(f, fishes, w, h);
}

function startDrift(f: KoiFish): void {
  const b = f.brain;
  b.behavior = 'drift';
  b.speedFactor = 0.3 + b.rng() * 0.12;
  b.wanderPhase = b.rng() * KOI_TAU;
  f.modeTimer = 4 + b.rng() * 4;
}

function startLoiter(f: KoiFish, fishes: KoiFish[], w: number, h: number): boolean {
  const b = f.brain;
  const rng = b.rng;
  const rMin = turnRadius(f);
  const edge = 80;
  const maxRho = (Math.min(w, h) - edge * 2) / 2;
  const rho = Math.min(rMin * (1.15 + rng() * 0.55), maxRho);
  if (rho < rMin * 1.1) return false;

  const cosA = Math.cos(f.angle);
  const sinA = Math.sin(f.angle);
  const space = f.maxHalfWidth * 2 * SAFE_WIDTH_FACTOR;
  const first: 1 | -1 = rng() < 0.5 ? 1 : -1;

  for (let s = 0; s < 2; s++) {
    const dir: 1 | -1 = s === 0 ? first : first === 1 ? -1 : 1;
    const cx = f.x - sinA * dir * rho;
    const cy = f.y + cosA * dir * rho;
    if (cx - rho < edge || cx + rho > w - edge || cy - rho < edge || cy + rho > h - edge) {
      continue;
    }
    let ok = true;
    for (const o of fishes) {
      if (o === f) continue;
      if (Math.abs(Math.hypot(o.x - cx, o.y - cy) - rho) < space) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    b.behavior = 'loiter';
    b.orbitX = cx;
    b.orbitY = cy;
    b.orbitRadius = rho;
    b.orbitDir = dir;
    b.speedFactor = 0.45 + rng() * 0.15;
    f.modeTimer = 9 + rng() * 6;
    return true;
  }
  return false;
}

function startTrail(f: KoiFish, fishes: KoiFish[]): boolean {
  const b = f.brain;
  const candidates: KoiFish[] = [];
  for (const o of fishes) {
    if (o === f) continue;
    if (o.brain.behavior === 'trail' && o.brain.followId === f.id) continue;
    candidates.push(o);
  }
  if (candidates.length === 0) return false;

  const leader = candidates[Math.floor(b.rng() * candidates.length) % candidates.length];
  b.behavior = 'trail';
  b.followId = leader.id;
  b.followSide = b.rng() < 0.5 ? 1 : -1;
  b.speedFactor = 0.7;
  b.targetAge = 0;
  f.modeTimer = 8 + b.rng() * 6;
  return true;
}

function chooseBehavior(f: KoiFish, fishes: KoiFish[], w: number, h: number): void {
  const b = f.brain;
  const n = BEHAVIOR_KINDS.length;
  const ws: number[] = [];
  let total = 0;
  for (let k = 0; k < n; k++) {
    const kind = BEHAVIOR_KINDS[k];
    let wt = b.weights[kind];
    if (kind === b.behavior) wt *= kind === 'cruise' ? 0.9 : 0.2;
    ws.push(wt);
    total += wt;
  }

  let roll = b.rng() * total;
  for (let k = 0; k < n; k++) {
    roll -= ws[k];
    if (roll > 0) continue;
    switch (BEHAVIOR_KINDS[k]) {
      case 'loiter':
        if (startLoiter(f, fishes, w, h)) return;
        break;
      case 'drift':
        startDrift(f);
        return;
      case 'trail':
        if (startTrail(f, fishes)) return;
        break;
      default:
        break;
    }
    break;
  }
  startCruise(f, fishes, w, h);
}

/* -------------------------------------------------------------------------
 * Steering
 * ---------------------------------------------------------------------- */

interface SteerOut {
  heading: number;
  feedTurn: number;
  speed: number;
  wallGain: number;
}

const steerOut: SteerOut = { heading: 0, feedTurn: 0, speed: 1, wallGain: 1 };

function steerBehavior(f: KoiFish, fishes: KoiFish[], w: number, h: number, dt: number): void {
  const b = f.brain;
  const rMin = turnRadius(f);
  steerOut.feedTurn = 0;
  steerOut.wallGain = 1;
  steerOut.speed = b.speedFactor;

  switch (b.behavior) {
    case 'cruise': {
      let dist = Math.hypot(b.targetX - f.x, b.targetY - f.y);
      const bearing = Math.abs(
        koiAngleDiff(f.angle, Math.atan2(b.targetY - f.y, b.targetX - f.x))
      );
      if (dist < rMin * 0.9 || b.targetAge > 22 || bearing > WAYPOINT_LOST) {
        pickWaypoint(f, fishes, w, h);
        dist = Math.hypot(b.targetX - f.x, b.targetY - f.y);
      }
      steerOut.heading = Math.atan2(b.targetY - f.y, b.targetX - f.x);
      steerOut.speed = b.speedFactor;
      const ease = rMin * 2.5;
      if (dist < ease) steerOut.speed *= 0.82 + 0.18 * (dist / ease);
      break;
    }

    case 'loiter': {
      const dx = f.x - b.orbitX;
      const dy = f.y - b.orbitY;
      const r = Math.hypot(dx, dy) || 1;
      const a = Math.atan2(dy, dx);
      const delta = koiClamp(((r - b.orbitRadius) / b.orbitRadius) * 1.2, -0.9, 0.9);
      steerOut.heading = a + b.orbitDir * (Math.PI / 2 + delta);
      steerOut.feedTurn = (b.orbitDir * f.speed) / b.orbitRadius;
      steerOut.wallGain = 0.45;
      break;
    }

    case 'drift': {
      b.wanderPhase += dt * 0.55;
      steerOut.heading = f.angle + 0.18 * Math.sin(b.wanderPhase);
      break;
    }

    case 'trail': {
      let lead: KoiFish | undefined;
      for (const o of fishes) {
        if (o.id === b.followId) {
          lead = o;
          break;
        }
      }
      if (!lead) {
        startCruise(f, fishes, w, h);
        steerOut.heading = Math.atan2(b.targetY - f.y, b.targetX - f.x);
        steerOut.speed = b.speedFactor;
        break;
      }
      const lx = Math.cos(lead.angle);
      const ly = Math.sin(lead.angle);
      const back = lead.bodyLength * 1.2;
      const side = b.followSide * lead.bodyLength * 0.3;
      const tx = lead.x - lx * back - ly * side;
      const ty = lead.y - ly * back + lx * side;
      const dTar = Math.hypot(tx - f.x, ty - f.y);
      const ref = f.bodyLength;

      let heading = Math.atan2(ty - f.y, tx - f.x);
      if (Math.abs(koiAngleDiff(f.angle, heading)) > SLOT_BEHIND) {
        heading = f.angle;
        if (b.targetAge > 3) f.modeTimer = Math.min(f.modeTimer, 0.01);
      } else {
        b.targetAge = 0;
      }
      if (dTar < ref * 0.6) {
        const k = 1 - dTar / (ref * 0.6);
        heading += koiAngleDiff(heading, lead.angle) * k;
      }
      steerOut.heading = heading;

      const want = lead.speed * (1 + koiClamp((dTar - ref * 0.8) / (ref * 4), -0.3, 0.4));
      steerOut.speed = koiClamp(want / f.baseCruiseSpeed, 0.3, 1.0);

      if (dTar > Math.hypot(w, h) * 0.7) f.modeTimer = Math.min(f.modeTimer, 0.01);
      break;
    }
  }
}

function applyCuriosityAndFoodSteering(
  f: KoiFish,
  pointer: PondPointerState,
  food: PondFoodPellet[],
  w: number,
  h: number,
  dt: number
): void {
  const b = f.brain;
  const rMin = turnRadius(f);

  let targetPellet: PondFoodPellet | null = null;
  if (food.length > 0) {
    for (let i = 0; i < food.length; i++) {
      const p = food[i];
      if (p.active && p.id === b.foodTargetId) {
        targetPellet = p;
        break;
      }
    }
    if (!targetPellet) {
      let bestDist = Infinity;
      for (let i = 0; i < food.length; i++) {
        const p = food[i];
        if (!p.active) continue;
        const d = Math.hypot(p.x - f.x, p.y - f.y);
        if (d < bestDist) {
          bestDist = d;
          targetPellet = p;
        }
      }
      if (targetPellet) {
        b.foodTargetId = targetPellet.id;
        b.approachSign = pickNaturalApproachSign(f, targetPellet.x, targetPellet.y);
      }
    }
  } else {
    b.foodTargetId = 0;
  }

  const isHoverChosen = pointer.active && pointer.curiousKoiId === f.id;
  const hasStimulus = targetPellet !== null || isHoverChosen;

  if (!hasStimulus) {
    b.attentionWeight *= Math.exp(-dt / 0.48);
    if (b.attentionWeight < 0.005) {
      b.attentionWeight = 0;
      b.hasPerceivedTarget = false;
    }
    return;
  }

  const rawTx = targetPellet ? targetPellet.x : pointer.x;
  const rawTy = targetPellet ? targetPellet.y : pointer.y;
  const clampedTx = koiClamp(rawTx, 8, w - 8);
  const clampedTy = koiClamp(rawTy, 8, h - 8);

  if (!b.hasPerceivedTarget) {
    b.perceivedX = clampedTx;
    b.perceivedY = clampedTy;
    b.hasPerceivedTarget = true;
    b.approachSign = pickNaturalApproachSign(f, clampedTx, clampedTy);
  } else {
    const filterAlpha = 1 - Math.exp(-dt / 0.24);
    b.perceivedX += (clampedTx - b.perceivedX) * filterAlpha;
    b.perceivedY += (clampedTy - b.perceivedY) * filterAlpha;
  }

  if (b.perceptionDelay > 0) {
    b.perceptionDelay = Math.max(0, b.perceptionDelay - dt);
  } else {
    b.attentionWeight += (1 - b.attentionWeight) * (1 - Math.exp(-dt / 0.52));
  }

  const wAtt = b.attentionWeight * b.attentionWeight * (3 - 2 * b.attentionWeight);
  if (wAtt <= 0.005) return;

  b.wanderPhase = (b.wanderPhase + dt * 1.55) % KOI_TAU;

  const dx = b.perceivedX - f.x;
  const dy = b.perceivedY - f.y;
  const dist = Math.hypot(dx, dy) || 1;
  const directHeading = Math.atan2(dy, dx);

  let attHeading = directHeading;
  let attFeedTurn = 0;
  let attSpeed = 0.85;

  if (targetPellet) {
    const spiralFactor = koiClamp((dist - 22) / (f.bodyLength * 0.65), 0, 1);
    const spiralOffsetRad = b.approachSign * 0.36 * spiralFactor;
    const weaveAmp = 0.28 * koiClamp((dist - 26) / (f.bodyLength * 0.95), 0.08, 1.0);
    const sWeave = Math.sin(b.wanderPhase + f.id * 1.85) * weaveAmp;

    const rawBearing = koiAngleDiff(f.angle, directHeading);
    if (Math.abs(rawBearing) > 1.22) {
      attHeading = wrapAngle(f.angle + b.approachSign * 1.15);
      attFeedTurn = (b.approachSign * f.speed) / (rMin * 1.08);
      attSpeed = 0.78;
    } else {
      attHeading = wrapAngle(directHeading + spiralOffsetRad + sWeave);
      const approachEase = koiClamp(dist / (f.bodyLength * 0.85), 0, 1);
      attSpeed = 0.62 + 0.34 * approachEase;
    }
  } else {
    const orbitR = Math.max(48, f.bodyLength * 0.38);
    const weaveAmp = 0.32 * koiClamp((dist - orbitR * 0.7) / (f.bodyLength * 1.15), 0.14, 1.0);
    const sWeave = Math.sin(b.wanderPhase + f.id * 1.7) * weaveAmp;

    if (dist > orbitR * 1.35) {
      const rawBearing = koiAngleDiff(f.angle, directHeading);
      if (Math.abs(rawBearing) > 1.22) {
        attHeading = wrapAngle(f.angle + b.approachSign * 1.12);
        attFeedTurn = (b.approachSign * f.speed) / (rMin * 1.12);
        attSpeed = 0.76;
      } else {
        const tangentAngle = b.approachSign * Math.asin(koiClamp(orbitR / dist, 0.15, 0.82));
        attHeading = wrapAngle(directHeading + tangentAngle + sWeave);
        const approachEase = koiClamp((dist - orbitR) / (f.bodyLength * 1.2), 0, 1);
        attSpeed = 0.64 + 0.26 * approachEase;
      }
    } else {
      const radialAngle = Math.atan2(f.y - b.perceivedY, f.x - b.perceivedX);
      const delta = koiClamp(((dist - orbitR) / orbitR) * 1.15, -0.85, 0.85);
      attHeading = wrapAngle(radialAngle + b.approachSign * (Math.PI / 2 + delta) + sWeave * 0.35);
      attFeedTurn = (b.approachSign * f.speed) / Math.max(orbitR, rMin);
      attSpeed = 0.56;
    }
  }

  steerOut.heading = wrapAngle(steerOut.heading + koiAngleDiff(steerOut.heading, attHeading) * wAtt);
  steerOut.feedTurn = koiLerp(steerOut.feedTurn, attFeedTurn, wAtt);
  steerOut.speed = koiLerp(steerOut.speed, attSpeed, wAtt);
  steerOut.wallGain = koiLerp(steerOut.wallGain, 0.55, wAtt);
}

function shiftFish(f: KoiFish, dx: number, dy: number): void {
  f.x += dx;
  f.y += dy;
  for (let i = 0; i < f.trailX.length; i++) {
    f.trailX[i] += dx;
    f.trailY[i] += dy;
  }
}

interface BendInfo {
  runs: number;
  firstSign: number;
  net: number;
}

const bendInfo: BendInfo = { runs: 0, firstSign: 0, net: 0 };

function analyzeBends(f: KoiFish): void {
  let prev = 0;
  let total = 0;
  let ext = 0;
  let dir = 0;
  let runs = 0;
  let firstSign = 0;

  for (let k = 0; k < SPINE_NODE_COUNT - 1; k++) {
    const hd = Math.atan2(
      f.restSpineY[k] - f.restSpineY[k + 1],
      f.restSpineX[k] - f.restSpineX[k + 1]
    );
    if (k > 0) {
      total += koiAngleDiff(hd, prev);
      if (dir === 0) {
        if (Math.abs(total) >= BEND_MIN) {
          dir = total > 0 ? 1 : -1;
          firstSign = dir;
          runs = 1;
          ext = total;
        }
      } else if (dir > 0) {
        if (total > ext) ext = total;
        else if (ext - total >= BEND_MIN) {
          dir = -1;
          runs++;
          ext = total;
        }
      } else {
        if (total < ext) ext = total;
        else if (total - ext >= BEND_MIN) {
          dir = 1;
          runs++;
          ext = total;
        }
      }
    }
    prev = hd;
  }

  bendInfo.runs = runs;
  bendInfo.firstSign = firstSign;
  bendInfo.net = total;
}

let wallEmergency = false;

/**
 * Gently curves desired heading back inward using the expanded virtual boundary
 * `[-OUTER_BOUND_PAD, w + OUTER_BOUND_PAD] x [-OUTER_BOUND_PAD, h + OUTER_BOUND_PAD]`,
 * so koi never crash or bounce against the visible screen or box edges.
 */
function applyWalls(f: KoiFish, heading: number, w: number, h: number, gain: number): number {
  const rMin = turnRadius(f);
  const hx = Math.cos(f.angle);
  const hy = Math.sin(f.angle);
  let vx = Math.cos(heading);
  let vy = Math.sin(heading);
  wallEmergency = false;

  for (let k = 0; k < 4; k++) {
    // Distance to the expanded outer boundary `[-OUTER_BOUND_PAD, w + OUTER_BOUND_PAD]`
    const d =
      k === 0
        ? f.x + OUTER_BOUND_PAD
        : k === 1
          ? w + OUTER_BOUND_PAD - f.x
          : k === 2
            ? f.y + OUTER_BOUND_PAD
            : h + OUTER_BOUND_PAD - f.y;
    const nx = k === 0 ? 1 : k === 1 ? -1 : 0;
    const ny = k === 2 ? 1 : k === 3 ? -1 : 0;
    const closing = Math.max(0, -(hx * nx + hy * ny));
    const need = rMin * (1 - Math.sqrt(Math.max(0, 1 - closing * closing)));
    const range = need * 1.5 + 85;
    if (closing > 0.15 && d < need * 1.05 + 45) wallEmergency = true;
    const s = koiClamp(1 - (d - 24) / range, 0, 1) * gain;
    if (s <= 0) continue;
    // Smooth quadratic ramp so entering the boundary zone never causes a sudden bounce
    const sSmooth = s * s * (3 - 2 * s);
    vx += nx * sSmooth * 1.75;
    vy += ny * sSmooth * 1.75;
    if (closing > 0) {
      const c = hx * ny - hy * nx >= 0 ? 1 : -1;
      vx += -hy * c * sSmooth * closing * 1.55;
      vy += hx * c * sSmooth * closing * 1.55;
    }
  }

  return Math.atan2(vy, vx);
}

/* -------------------------------------------------------------------------
 * Avoidance
 * ---------------------------------------------------------------------- */

interface Avoidance {
  bias: Float32Array;
  slow: Float32Array;
  pushX: Float32Array;
  pushY: Float32Array;
  offX: Float32Array;
  offY: Float32Array;
}

function createAvoidance(n: number): Avoidance {
  const t = LOOKAHEAD.length;
  return {
    bias: new Float32Array(n),
    slow: new Float32Array(n),
    pushX: new Float32Array(n),
    pushY: new Float32Array(n),
    offX: new Float32Array(n * t),
    offY: new Float32Array(n * t)
  };
}

let avoidanceCache: Avoidance | null = null;
let avoidanceCount = -1;

function getAvoidance(n: number): Avoidance {
  if (!avoidanceCache || avoidanceCount !== n) {
    avoidanceCache = createAvoidance(n);
    avoidanceCount = n;
  }
  return avoidanceCache;
}

function computeAvoidance(fishes: KoiFish[], av: Avoidance): void {
  const n = fishes.length;
  const T = LOOKAHEAD.length;
  av.bias.fill(0);
  av.slow.fill(1);
  av.pushX.fill(0);
  av.pushY.fill(0);

  for (let i = 0; i < n; i++) {
    const f = fishes[i];
    const wRate = f.turnRate;
    const v = f.speed;
    for (let ti = 0; ti < T; ti++) {
      const t = LOOKAHEAD[ti];
      let ox: number;
      let oy: number;
      if (Math.abs(wRate) < 1e-3) {
        ox = Math.cos(f.angle) * v * t;
        oy = Math.sin(f.angle) * v * t;
      } else {
        ox = (v / wRate) * (Math.sin(f.angle + wRate * t) - Math.sin(f.angle));
        oy = -(v / wRate) * (Math.cos(f.angle + wRate * t) - Math.cos(f.angle));
      }
      av.offX[i * T + ti] = ox;
      av.offY[i * T + ti] = oy;
    }
  }

  for (let i = 0; i < n; i++) {
    const A = fishes[i];
    for (let j = i + 1; j < n; j++) {
      const B = fishes[j];
      const safe = (A.maxHalfWidth + B.maxHalfWidth) * SAFE_WIDTH_FACTOR;
      const caution = safe * CAUTION_FACTOR;
      const hard = safe * HARD_FACTOR;

      let dMin = Infinity;
      let bi = 0;
      let bj = 0;
      let rx = 0;
      let ry = 0;
      let d0 = Infinity;
      let d0x = 0;
      let d0y = 0;

      for (let ti = 0; ti < T; ti++) {
        const oax = av.offX[i * T + ti];
        const oay = av.offY[i * T + ti];
        const obx = av.offX[j * T + ti];
        const oby = av.offY[j * T + ti];
        for (let a = 0; a < BODY_SAMPLES; a++) {
          const ia = BODY_IDX[a];
          const ax = A.restSpineX[ia] + oax;
          const ay = A.restSpineY[ia] + oay;
          for (let c = 0; c < BODY_SAMPLES; c++) {
            const ic = BODY_IDX[c];
            const bx = B.restSpineX[ic] + obx;
            const by = B.restSpineY[ic] + oby;
            const d = Math.hypot(bx - ax, by - ay);
            if (d < dMin) {
              dMin = d;
              bi = a;
              bj = c;
              rx = bx - ax;
              ry = by - ay;
            }
            if (ti === 0 && d < d0) {
              d0 = d;
              d0x = ax - bx;
              d0y = ay - by;
            }
          }
        }
      }

      let aYields = false;
      let decided = false;

      if (dMin < caution) {
        const prox = koiClamp((dMin - hard) / (caution - hard), 0, 1);
        aYields = Math.abs(bi - bj) >= 2 ? bi < bj : A.id > B.id;
        decided = true;

        const yi = aYields ? i : j;
        const Y = aYields ? A : B;
        const sx = aYields ? rx : -rx;
        const sy = aYields ? ry : -ry;
        const lat = Math.cos(Y.angle) * sy - Math.sin(Y.angle) * sx;
        const mag = Math.hypot(sx, sy) || 1;
        const side = Math.abs(lat) > mag * 0.2 ? (lat > 0 ? -1 : 1) : Y.id % 2 === 0 ? 1 : -1;

        av.bias[yi] += side * 1.25 * (1 - prox);
        av.slow[yi] = Math.min(av.slow[yi], 0.3 + 0.7 * prox * prox);
      }

      if (d0 < hard && d0 > 1e-3) {
        const mag = ((hard - d0) / hard) * 14;
        const nx = d0x / d0;
        const ny = d0y / d0;
        const wa = decided ? (aYields ? 0.7 : 0.3) : 0.5;
        av.pushX[i] += nx * mag * wa;
        av.pushY[i] += ny * mag * wa;
        av.pushX[j] -= nx * mag * (1 - wa);
        av.pushY[j] -= ny * mag * (1 - wa);
      }
    }
  }
}

/* -------------------------------------------------------------------------
 * Main update
 * ---------------------------------------------------------------------- */

function stepKoi(
  fishes: KoiFish[],
  pointer: PondPointerState,
  food: PondFoodPellet[],
  pond: PondEnvironment,
  av: Avoidance,
  w: number,
  h: number,
  dt: number
): void {
  computeAvoidance(fishes, av);

  for (let i = 0; i < fishes.length; i++) {
    const f = fishes[i];
    const b = f.brain;

    if (f.startleBoost > 0) {
      f.startleBoost = Math.max(0, f.startleBoost - dt * 0.7);
    }

    if (av.slow[i] < 0.55) b.blockedTime += dt;
    else b.blockedTime = Math.max(0, b.blockedTime - dt * 0.5);

    f.modeTimer -= dt;
    b.targetAge += dt;
    if (b.blockedTime > 4.5) {
      b.blockedTime = 0;
      startCruise(f, fishes, w, h);
    } else if (f.modeTimer <= 0) {
      chooseBehavior(f, fishes, w, h);
    }

    steerBehavior(f, fishes, w, h, dt);
    applyCuriosityAndFoodSteering(f, pointer, food, w, h, dt);

    let desired = applyWalls(f, steerOut.heading, w, h, steerOut.wallGain);
    b.avoidBias +=
      (koiClamp(av.bias[i], -1.4, 1.4) - b.avoidBias) * (1 - Math.exp(-dt / 0.6));
    desired += b.avoidBias;

    const maxTurn = Math.min(f.speed / turnRadius(f), MAX_TURN_RATE);
    analyzeBends(f);
    let lo = -maxTurn;
    let hi = maxTurn;
    if (!wallEmergency) {
      if (bendInfo.runs >= MAX_BENDS && b.attentionWeight < 0.35) {
        if (bendInfo.firstSign > 0) lo = 0;
        else hi = 0;
      }
      const room = koiClamp((NET_BLOCK - Math.abs(bendInfo.net)) / 0.3, 0, 1);
      if (bendInfo.net > 0) hi *= room;
      else if (bendInfo.net < 0) lo *= room;
    }
    const diff = koiAngleDiff(f.angle, desired);
    const wantTurn = koiClamp(diff * TURN_GAIN + steerOut.feedTurn, lo, hi);
    const turnAccel = TURN_ACCEL * (1 + b.attentionWeight * 0.25);
    f.turnRate = koiClamp(
      f.turnRate + koiClamp(wantTurn - f.turnRate, -turnAccel * dt, turnAccel * dt),
      -maxTurn,
      maxTurn
    );
    f.angle = wrapAngle(f.angle + f.turnRate * dt);

    const slow = av.slow[i];
    const factor =
      koiClamp(steerOut.speed * slow, MIN_SPEED_FACTOR, 1.05) * (1 + f.startleBoost * 0.35);
    const targetSpeed = f.baseCruiseSpeed * factor;
    const accel = f.bodyLength * ACCEL_BL * (1 + b.attentionWeight * 0.25);
    f.speed += koiClamp(
      (targetSpeed - f.speed) * (1 - Math.exp(-dt / SPEED_TAU)),
      -accel * 1.3 * dt,
      accel * dt
    );

    f.x += Math.cos(f.angle) * f.speed * dt;
    f.y += Math.sin(f.angle) * f.speed * dt;
    pushTrail(f);

    // Safety clamp is placed far outside the visible viewport (`-HARD_SAFETY_PAD` .. `w + HARD_SAFETY_PAD`)
    // so fish never hit a hard stop or bounce against the screen or box edges!
    let shiftX = av.pushX[i] * dt;
    let shiftY = av.pushY[i] * dt;
    shiftX += koiClamp(f.x + shiftX, -HARD_SAFETY_PAD, w + HARD_SAFETY_PAD) - (f.x + shiftX);
    shiftY += koiClamp(f.y + shiftY, -HARD_SAFETY_PAD, h + HARD_SAFETY_PAD) - (f.y + shiftY);
    if (shiftX !== 0 || shiftY !== 0) shiftFish(f, shiftX, shiftY);

    sampleSpineFromTrail(f);

    if (food.length > 0) {
      const snoutX = f.x + Math.cos(f.angle) * (f.maxHalfWidth * 0.36);
      const snoutY = f.y + Math.sin(f.angle) * (f.maxHalfWidth * 0.36);
      const eatRadius = Math.max(20, f.maxHalfWidth * 0.92);
      for (let pIdx = 0; pIdx < food.length; pIdx++) {
        const pellet = food[pIdx];
        if (!pellet.active) continue;
        if (Math.hypot(pellet.x - snoutX, pellet.y - snoutY) <= eatRadius + pellet.radius) {
          pellet.active = false;
          pond.spawnRipple(pellet.x, pellet.y, 58, 0.52, 48);
          break;
        }
      }
    }

    const curvTarget = koiClamp((f.turnRate / Math.max(f.speed, 20)) * 95, -0.65, 0.65);
    f.curvature = koiLerp(f.curvature, curvTarget, koiClamp(dt * 6, 0, 1));

    f.yieldMultiplier = koiLerp(f.yieldMultiplier, slow, koiClamp(dt * 4, 0, 1));
    const ratio = f.speed / (f.baseCruiseSpeed || 120);
    f.swimMode = f.yieldMultiplier < 0.75 || ratio < 0.55 ? 'glide' : 'cruise';
  }
}

export function updateKoiSimulation(
  fishes: KoiFish[],
  pond: PondEnvironment,
  pointer: PondPointerState,
  food: PondFoodPellet[],
  width: number,
  height: number,
  time: number,
  dt: number,
  config: KoiPondConfig
): void {
  const rawSpeedCfg = config.animationSpeed >= 5 ? config.animationSpeed / 10 : config.animationSpeed;
  const speedMult = koiClamp(rawSpeedCfg, 0.2, 2.5);
  const effDt = dt * speedMult;
  if (effDt <= 0 || fishes.length === 0) return;

  if (pointer.active) {
    const hasValidCurious =
      pointer.curiousKoiId !== undefined &&
      pointer.curiousKoiId > 0 &&
      fishes.some((f) => f.id === pointer.curiousKoiId);
    if (!hasValidCurious) {
      const picked = fishes[Math.floor(Math.random() * fishes.length)];
      pointer.curiousKoiId = picked.id;
      picked.brain.perceptionDelay = 0.14 + picked.brain.rng() * 0.22;
      picked.brain.approachSign = pickNaturalApproachSign(picked, pointer.x, pointer.y);
      picked.brain.perceivedX = pointer.x;
      picked.brain.perceivedY = pointer.y;
      picked.brain.hasPerceivedTarget = true;
    }
  } else {
    pointer.curiousKoiId = 0;
  }

  if (food.length > 0) {
    const cur = samplePond(time);
    const drag = Math.exp(-effDt * 2.4);
    for (let i = food.length - 1; i >= 0; i--) {
      const p = food[i];
      p.age += effDt;
      if (!p.active || p.age >= p.maxAge) {
        food.splice(i, 1);
        continue;
      }
      p.vx *= drag;
      p.vy *= drag;
      p.x = koiClamp(p.x + (p.vx + cur.vx * 3.5) * effDt, 16, width - 16);
      p.y = koiClamp(p.y + (p.vy + cur.vy * 3.5) * effDt, 16, height - 16);
    }
  }

  const steps = Math.max(1, Math.ceil(effDt / MAX_STEP));
  const h = effDt / steps;
  const av = getAvoidance(fishes.length);
  for (let s = 0; s < steps; s++) {
    stepKoi(fishes, pointer, food, pond, av, width, height, h);
  }

  for (let i = food.length - 1; i >= 0; i--) {
    if (!food[i].active) {
      food.splice(i, 1);
    }
  }

  for (let i = 0; i < fishes.length; i++) {
    const f = fishes[i];
    const speedRatio = koiClamp(f.speed / (f.baseCruiseSpeed || 120), 0.25, 1.35);
    const waveFreq = 2.5 + speedRatio * 2.1;
    f.phase = (f.phase + waveFreq * effDt) % KOI_TAU;
    f.finPhase = (f.finPhase + (1.4 + speedRatio * 1.0) * effDt) % KOI_TAU;

    updateFishSpineGeometry(f);

    const tailNode = f.spine[SPINE_NODE_COUNT - 1];
    if (Math.random() < koiClamp(effDt * 12 * speedRatio, 0, 0.75)) {
      pond.depositWake(
        tailNode.x,
        tailNode.y,
        config.cellWidth,
        config.cellHeight,
        0.14 * speedRatio,
        1
      );
    }
  }
}

/* -------------------------------------------------------------------------
 * Small schooling pond fish (medaka minnows)
 * ---------------------------------------------------------------------- */

const SCHOOL_CRUISE = 34;
const SCHOOL_MAX = 62;
const SCHOOL_MIN = 16;
const SEPARATION_K = 380;
const ALIGN_K = 1.7;
const COHESION_K = 1.05;
const FLEE_K = 900;
const MILL_K = 26;
const POINTER_FLEE_R = 108;
const KOI_FLEE_R_FACTOR = 0.7;
const BLIND_COS = -0.35;
const CELL = 26;

export function seedPondFish(width: number, height: number): PondFish[] {
  const total = koiClamp(Math.round((width * height) / 3400), 120, 420);
  const fish: PondFish[] = [];
  while (fish.length < total) {
    const school = Math.min(14 + Math.floor(Math.random() * 20), total - fish.length);
    const millDir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    const cx = koiClamp((Math.random() * 0.88 + 0.06) * width, 30, width - 30);
    const cy = koiClamp((Math.random() * 0.84 + 0.08) * height, 30, height - 30);
    const spread = Math.sqrt(school) * CELL * 1.2;
    const dir = (Math.random() < 0.5 ? 0 : Math.PI) + (Math.random() - 0.5) * 0.9;
    for (let k = 0; k < school; k++) {
      fish.push({
        x: koiClamp(cx + (Math.random() - 0.5) * 2 * spread, 12, width - 12),
        y: koiClamp(cy + (Math.random() - 0.5) * 1.2 * spread, 12, height - 12),
        vx: Math.cos(dir) * SCHOOL_CRUISE,
        vy: Math.sin(dir) * SCHOOL_CRUISE,
        phase: Math.random() * KOI_TAU,
        alarm: 0,
        turn: 0,
        depth: 0.55 + Math.random() * 0.45,
        millDir,
        col: 0,
        row: 0
      });
    }
  }
  return fish;
}

export function stepPondFish(
  fish: PondFish[],
  koi: KoiFish[],
  pointer: PondPointerState,
  width: number,
  height: number,
  time: number,
  dt: number
): void {
  const n = fish.length;
  if (n === 0) return;

  const R = CELL * 3.4;
  const R2 = R * R;
  const sep2 = (CELL * 0.92) ** 2;

  for (let i = 0; i < n; i++) {
    const f = fish[i];
    const speed = Math.hypot(f.vx, f.vy) || 1;
    const hx = f.vx / speed;
    const hy = f.vy / speed;

    let sx = 0;
    let sy = 0;
    let avx = 0;
    let avy = 0;
    let cx = 0;
    let cy = 0;
    let neighbours = 0;
    let neighbourAlarm = 0;

    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const o = fish[j];
      const dx = o.x - f.x;
      const dy = o.y - f.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= R2 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);

      if ((dx * hx + dy * hy) / d > BLIND_COS) {
        if (d2 < sep2) {
          const k = (1 - d / Math.sqrt(sep2)) / d;
          sx -= dx * k;
          sy -= dy * k;
        }
        avx += o.vx;
        avy += o.vy;
        cx += dx;
        cy += dy;
        neighbours++;
        if (o.alarm > neighbourAlarm) neighbourAlarm = o.alarm;
      }
    }

    let ax = sx * SEPARATION_K;
    let ay = sy * SEPARATION_K;

    if (neighbours > 0) {
      ax += (avx / neighbours - f.vx) * ALIGN_K + (cx / neighbours) * COHESION_K;
      ay += (avy / neighbours - f.vy) * ALIGN_K + (cy / neighbours) * COHESION_K;
      const cl = Math.hypot(cx, cy) || 1;
      ax += (-cy / cl) * f.millDir * MILL_K * (1 - f.alarm);
      ay += (cx / cl) * f.millDir * MILL_K * (1 - f.alarm);
    }

    for (const k of koi) {
      const fearR = k.bodyLength * KOI_FLEE_R_FACTOR;
      const dx = f.x - k.x;
      const dy = f.y - k.y;
      const d = Math.hypot(dx, dy);
      if (d >= fearR || d < 1e-3) continue;
      const w = 1 - d / fearR;
      ax += (dx / d) * FLEE_K * w * w * 0.5;
      ay += (dy / d) * FLEE_K * w * w * 0.5;
      if (w * w * 0.42 > f.alarm) f.alarm = w * w * 0.42;
    }

    if (pointer.active) {
      const dx = f.x - pointer.x;
      const dy = f.y - pointer.y;
      const d = Math.hypot(dx, dy);
      if (d < POINTER_FLEE_R && d > 1e-3) {
        const w = (1 - d / POINTER_FLEE_R) ** 2;
        ax += (dx / d) * FLEE_K * w * 0.55;
        ay += (dy / d) * FLEE_K * w * 0.55;
        const pFear = Math.sqrt(w) * 0.5;
        if (pFear > f.alarm) f.alarm = pFear;
      }
    }

    const calmDecay = Math.exp(-dt * 0.7);
    const relayed = neighbourAlarm * 0.86;
    let alarm = Math.max(f.alarm * calmDecay, 0);
    if (relayed > alarm) alarm += (relayed - alarm) * Math.min(1, dt * 6);
    f.alarm = koiClamp(alarm, 0, 1);

    // Soft outer boundary placed outside `[0, width] x [0, height]` so minnows never bounce on the edge
    const m = -24;
    if (f.x < m) ax += (m - f.x) * 5;
    else if (f.x > width - m) ax -= (f.x - (width - m)) * 5;
    if (f.y < m) ay += (m - f.y) * 5;
    else if (f.y > height - m) ay -= (f.y - (height - m)) * 5;

    const cur = samplePond(time);
    ax += cur.vx * 26;
    ay += cur.vy * 26;

    ay -= f.vy * 0.9 * (1 - 0.6 * f.alarm);

    const preferred = SCHOOL_CRUISE * (1 + 1.25 * f.alarm);
    ax += (preferred - speed) * hx * 1.6;
    ay += (preferred - speed) * hy * 1.6;

    const before = Math.atan2(f.vy, f.vx);
    f.vx += ax * dt;
    f.vy += ay * dt;
    const s = Math.hypot(f.vx, f.vy);
    const maxSpeed = SCHOOL_MAX * (1 + 1.6 * f.alarm);
    if (s > maxSpeed) {
      f.vx *= maxSpeed / s;
      f.vy *= maxSpeed / s;
    } else if (s < SCHOOL_MIN && s > 1e-3) {
      f.vx *= SCHOOL_MIN / s;
      f.vy *= SCHOOL_MIN / s;
    }
    f.turn += (koiAngleDiff(before, Math.atan2(f.vy, f.vx)) / dt - f.turn) * Math.min(1, dt * 8);
    f.phase += dt * (6 + s * 0.14);
    f.x = koiClamp(f.x + f.vx * dt, -80, width + 80);
    f.y = koiClamp(f.y + f.vy * dt, -80, height + 80);
  }
}

function samplePond(time: number): { vx: number; vy: number } {
  const t = time * 0.15;
  return {
    vx: Math.sin(t) * 0.5 + Math.cos(t * 0.6) * 0.28,
    vy: -Math.cos(t * 0.8) * 0.5 + Math.sin(t * 0.5) * 0.28
  };
}

export function pondFishSplash(fish: PondFish[], x: number, y: number): void {
  const r = 110;
  for (const f of fish) {
    const dx = f.x - x;
    const dy = f.y - y;
    const d = Math.hypot(dx, dy);
    if (d > r || d < 1e-3) continue;
    const k = (1 - d / r) * 140;
    f.vx += (dx / d) * k;
    f.vy += (dy / d) * k;
    f.alarm = 0.65;
  }
}

export function rescalePondFish(
  fish: PondFish[],
  oldW: number,
  oldH: number,
  newW: number,
  newH: number
): void {
  if (oldW <= 0 || oldH <= 0) return;
  const sx = newW / oldW;
  const sy = newH / oldH;
  for (const f of fish) {
    f.x *= sx;
    f.y *= sy;
  }
}
