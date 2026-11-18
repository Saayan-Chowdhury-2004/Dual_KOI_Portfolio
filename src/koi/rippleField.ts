/**
 * Shared Cube-Grid Shockwave Ripple Field (`src/koi/rippleField.ts`).
 *
 * Pure, stateless mathematical evaluation for the open/close shockwave reveal
 * shared by both the 4 DOM portfolio columns (`src/koi/portfolioColumns.ts`)
 * and the canvas-rendered left portrait frame (`src/koi/koiRenderer.ts`).
 *
 * Because both layers evaluate the exact same function of `(tileX, tileY, flipProgress, origin, config)`,
 * the 4 columns and the left framed image run the exact same ripple from their virtual centres,
 * and the Mokkotsu + Sumi-e engines remain 100% locked in step via `flipProgress`.
 */

// ============================================================================
// TUNABLE SHOCKWAVE CONSTANTS (Grouped at top per specification)
// ============================================================================

/** Target square tile size in CSS pixels (snapped to an integer multiple of pond grid cell size in 16..24px). */
export const RIPPLE_TARGET_TILE_PX = 20;

/** Minimum allowed square tile size in CSS pixels. */
export const RIPPLE_MIN_TILE_PX = 16;

/** Maximum allowed base square tile size in CSS pixels before quality-governor scaling. */
export const RIPPLE_MAX_TILE_PX = 24;

/** Total open animation duration in seconds (~2.0s total). */
export const FLIP_OPEN_DURATION = 2.0;

/** Total close animation duration in seconds (inward ring collapses to the virtual centres over ~2.0s). */
export const FLIP_CLOSE_DURATION = 2.0;

/** Time in seconds at which the expanding ring crest reaches the farthest corner on open. */
export const RING_CORNER_REACH_SECONDS = 1.45;

/** Normalized flipProgress (0..1) reference ratio for corner reach. */
export const RING_CORNER_REACH_PROGRESS = RING_CORNER_REACH_SECONDS / FLIP_OPEN_DURATION;

/** Fallback opacity fade duration in seconds when `prefers-reduced-motion: reduce` is active. */
export const REDUCED_MOTION_FADE_DURATION = 0.25;

/** Duration in seconds for each column's inner text (`.bp-col-inner`) to fade & rise 6px after the ring crosses its center. */
export const COLUMN_TEXT_FADE_SECONDS = 0.25;

/** Upward translate distance in CSS pixels for `.bp-col-inner` text reveal. */
export const COLUMN_TEXT_TRANSLATE_Y_PX = 6;

/** Width of the raised outer rim at the shockwave crest, measured in tiles (3–4 tiles wide). */
export const RIM_WIDTH_TILES = 3.5;

/** Width of the depressed circular crater immediately behind the raised rim, measured in tiles. */
export const CRATER_WIDTH_TILES = 4.2;

/** Width of the scattered per-tile noisy tail behind the crater before settling flat, measured in tiles. */
export const TAIL_WIDTH_TILES = 6.8;

/** Normalized peak upward displacement of the raised rim crest (0..1). */
export const RIM_HEIGHT = 1.0;

/** Normalized peak downward depth of the circular crater trough (0..1). */
export const CRATER_DEPTH = 0.88;

/** Normalized amplitude of the scattered per-tile hash noise in the wake tail (0..1). */
export const TAIL_NOISE_AMP = 0.72;

/** Maximum 2.5D pixel extrusion shift for raised/depressed cube tiles at full height. */
export const TILE_MAX_EXTRUDE_PX = 7.5;

/** Maximum total tiles across the composition before stepping up the tile size multiple for 60fps safety. */
export const MAX_COMPOSITION_TILES = 2200;

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface RippleOrigin {
  x: number;
  y: number;
}

export interface RippleCompositionBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RippleFieldConfig {
  tileSize: number;
  maxCornerDist: number;
  totalWaveSpanPx: number;
  ringRadiusPx: number;
  waveEnvelope: number;
  reducedMotion?: boolean;
}

export interface RippleTileSample {
  /** 0 ahead of the shockwave ring (pond remains visible); 1 inside/behind the ring. */
  reveal: number;
  /** Signed vertical displacement in [-1, +1]: >0 on raised rim, <0 in crater, noisy in tail, 0 when settled. */
  height: number;
  /** 0..1 highlight intensity on the raised 3-4 tile wide crest rim (catches --bp-gold-foil). */
  rimFactor: number;
  /** 0..1 depression intensity inside the circular crater trough (darker crimson/sumi shade). */
  craterFactor: number;
  /** 0..1 scattered unevenness intensity in the noisy tail behind the crater. */
  tailFactor: number;
  /** 0..1 opacity of the hairline gold/ink tile grid lines (fades to 0 as the tile settles). */
  gridAlpha: number;
  /** Deterministic per-tile hash in [0, 1) used for subtle brocade/tile facet variation. */
  tileHash: number;
  /** True when the tile is behind the noisy tail and has completely settled to a flat surface. */
  settled: boolean;
}

// ============================================================================
// CORE MATH HELPERS
// ============================================================================

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function easeOutCubic(t: number): number {
  const u = clamp01(t);
  const inv = 1 - u;
  return 1 - inv * inv * inv;
}

/**
 * Single continuous monotonic easing curve used across [0, 1] so the shockwave ring
 * never stalls mid-animation and never snaps at completion.
 */
export function evaluateRippleProgressCurve(p: number): number {
  const u = clamp01(p);
  return 0.62 * easeOutCubic(u) + 0.38 * u;
}

/**
 * Deterministic 2D spatial hash for grid cell coordinates `(col, row)`.
 * Zero allocations, identical across CPU/Canvas calls in both engines.
 */
export function hashTile2D(col: number, row: number): number {
  let n = Math.imul(col, 374761393) + Math.imul(row, 668265263);
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/**
 * Returns the virtual centre `(x, y)` of a rectangular surface bounds `{ minX, minY, maxX, maxY }`.
 */
export function computeVirtualCenter(bounds: RippleCompositionBounds): RippleOrigin {
  return {
    x: (bounds.minX + bounds.maxX) * 0.5,
    y: (bounds.minY + bounds.maxY) * 0.5,
  };
}

/**
 * Computes the square tile size in CSS pixels as an exact integer multiple of the pond's
 * pond grid cell size (`cellWidth`/`cellHeight`) landing in `[16, 24]px`, while respecting
 * the engine's quality governor (`qualityLevel`) and mobile/total tile count caps.
 */
export function computeAlignedTileSize(
  cellW: number,
  cellH: number,
  viewportW: number,
  viewportH: number,
  qualityLevel = 0
): number {
  const rawCell = Math.max(4, Math.round(Math.max(cellW || 8, cellH || 8)));
  let bestMult = Math.max(1, Math.round(RIPPLE_TARGET_TILE_PX / rawCell));
  let tilePx = bestMult * rawCell;

  while (tilePx < RIPPLE_MIN_TILE_PX) {
    bestMult++;
    tilePx = bestMult * rawCell;
  }
  while (tilePx > RIPPLE_MAX_TILE_PX && bestMult > 1 && (bestMult - 1) * rawCell >= RIPPLE_MIN_TILE_PX) {
    bestMult--;
    tilePx = bestMult * rawCell;
  }

  // Quality governor & mobile viewport adaptive step-up
  if (qualityLevel >= 2 || viewportW < 820) {
    bestMult += 1;
    tilePx = bestMult * rawCell;
  }
  if (qualityLevel >= 3) {
    bestMult += 1;
    tilePx = bestMult * rawCell;
  }

  // Enforce total composition tile cap so mid-range laptops stay locked at 60fps
  const approxArea = Math.max(1, viewportW * viewportH * 0.72);
  while (approxArea / (tilePx * tilePx) > MAX_COMPOSITION_TILES) {
    bestMult++;
    tilePx = bestMult * rawCell;
  }

  return tilePx;
}

/**
 * Computes the distance from `origin` to the farthest corner of `bounds`.
 */
export function computeMaxCornerDistance(
  origin: RippleOrigin,
  bounds: RippleCompositionBounds
): number {
  const dx0 = origin.x - bounds.minX;
  const dx1 = origin.x - bounds.maxX;
  const dy0 = origin.y - bounds.minY;
  const dy1 = origin.y - bounds.maxY;

  const d00 = Math.hypot(dx0, dy0);
  const d10 = Math.hypot(dx1, dy0);
  const d01 = Math.hypot(dx0, dy1);
  const d11 = Math.hypot(dx1, dy1);

  return Math.max(64, d00, d10, d01, d11);
}

/**
 * Builds the per-frame `RippleFieldConfig` from `flipProgress (0..1)`, `origin`, and `bounds`.
 *
 * Uses a single continuous, strictly monotonic curve across `p in [0, 1]` from `0` to
 * `maxCornerDist + totalWaveSpanPx * 1.06` so the wave never pauses at the corners and
 * every tile settles smoothly before `p = 1.0` with zero abruptness.
 */
export function buildRippleFieldConfig(
  flipProgress: number,
  origin: RippleOrigin,
  bounds: RippleCompositionBounds,
  tileSize: number,
  reducedMotion = false
): RippleFieldConfig {
  const p = clamp01(flipProgress);
  const maxCornerDist = computeMaxCornerDistance(origin, bounds);
  const totalWaveTiles = RIM_WIDTH_TILES + CRATER_WIDTH_TILES + TAIL_WIDTH_TILES;
  const totalWaveSpanPx = totalWaveTiles * tileSize;
  const maxTotalRadius = maxCornerDist + totalWaveSpanPx * 1.06;

  const ringRadiusPx =
    p <= 0.0001 ? 0 : maxTotalRadius * evaluateRippleProgressCurve(p);

  // Smooth ramp-in at p -> 0; at p -> 1 each tile naturally settles to 0 as deltaTiles passes totalWaveTiles
  const waveEnvelope = clamp01(p / 0.032);

  return {
    tileSize,
    maxCornerDist,
    totalWaveSpanPx,
    ringRadiusPx,
    waveEnvelope,
    reducedMotion,
  };
}

/**
 * Evaluates the exact `flipProgress` (0..1) at which the shockwave ring crest crosses
 * a given radial distance `distancePx` from `origin`. Used to trigger each column's
 * `.bp-col-inner` text fade-in right as the ring crosses that column's center.
 */
export function getFlipProgressAtDistance(
  distancePx: number,
  maxCornerDist: number,
  totalWaveSpanPx = 0
): number {
  const maxTotalRadius = Math.max(1, maxCornerDist + totalWaveSpanPx * 1.06);
  const targetRatio = clamp01(distancePx / maxTotalRadius);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) * 0.5;
    if (evaluateRippleProgressCurve(mid) < targetRatio) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/**
 * Evaluates a single square tile centered at `(tileCenterX, tileCenterY)` in viewport coordinates.
 * Called identically by both the DOM column shockwave renderer and the pond canvas portrait frame renderer.
 */
export function evaluateRippleTile(
  tileCenterX: number,
  tileCenterY: number,
  flipProgress: number,
  origin: RippleOrigin,
  config: RippleFieldConfig
): RippleTileSample {
  const p = clamp01(flipProgress);
  const col = Math.floor(tileCenterX / config.tileSize);
  const row = Math.floor(tileCenterY / config.tileSize);
  const tileHash = hashTile2D(col, row);

  if (config.reducedMotion) {
    return {
      reveal: p,
      height: 0,
      rimFactor: 0,
      craterFactor: 0,
      tailFactor: 0,
      gridAlpha: 0,
      tileHash,
      settled: p >= 0.999,
    };
  }

  if (p <= 0.0005) {
    return {
      reveal: 0,
      height: 0,
      rimFactor: 0,
      craterFactor: 0,
      tailFactor: 0,
      gridAlpha: 0,
      tileHash,
      settled: false,
    };
  }

  if (p >= 0.9995) {
    return {
      reveal: 1,
      height: 0,
      rimFactor: 0,
      craterFactor: 0,
      tailFactor: 0,
      gridAlpha: 0,
      tileHash,
      settled: true,
    };
  }

  const distPx = Math.hypot(tileCenterX - origin.x, tileCenterY - origin.y);
  // Subtle per-tile organic wavefront jitter (±0.26 tile) so the ring crest reads like physical cubes
  const jitterTiles = (tileHash - 0.5) * 0.52;
  const deltaTiles = (config.ringRadiusPx - distPx) / config.tileSize + jitterTiles;

  // 1. Ahead of the shockwave ring: show nothing (pond stays 100% visible)
  if (deltaTiles < 0) {
    return {
      reveal: 0,
      height: 0,
      rimFactor: 0,
      craterFactor: 0,
      tailFactor: 0,
      gridAlpha: 0,
      tileHash,
      settled: false,
    };
  }

  const craterEndTiles = RIM_WIDTH_TILES + CRATER_WIDTH_TILES;
  const totalWaveTiles = craterEndTiles + TAIL_WIDTH_TILES;

  // 2. Behind the noisy tail: tile has completely settled into the flat revealed surface
  if (deltaTiles >= totalWaveTiles) {
    return {
      reveal: 1,
      height: 0,
      rimFactor: 0,
      craterFactor: 0,
      tailFactor: 0,
      gridAlpha: 0,
      tileHash,
      settled: true,
    };
  }

  const env = config.waveEnvelope;
  const hash2 = hashTile2D(col + 101, row + 211);

  // 3. Zone A: Raised Rim at the Wave Crest (0 .. RIM_WIDTH_TILES, 3-4 tiles wide)
  if (deltaTiles < RIM_WIDTH_TILES) {
    const rimU = deltaTiles / RIM_WIDTH_TILES;
    const rimBell = Math.sin(rimU * Math.PI);
    const facetVar = 0.80 + 0.38 * tileHash;
    const height = RIM_HEIGHT * rimBell * facetVar * env;
    const rimFactor = clamp01(rimBell * (0.78 + 0.22 * hash2) * env);
    const leadReveal = clamp01(deltaTiles / 0.45);
    const gridAlpha = clamp01(leadReveal * 0.92 * env);

    return {
      reveal: 1,
      height,
      rimFactor,
      craterFactor: 0,
      tailFactor: 0,
      gridAlpha,
      tileHash,
      settled: false,
    };
  }

  // 4. Zone B: Depressed Circular Crater Inside the Rim (RIM_WIDTH_TILES .. craterEndTiles)
  if (deltaTiles < craterEndTiles) {
    const craterU = (deltaTiles - RIM_WIDTH_TILES) / CRATER_WIDTH_TILES;
    const craterBell = Math.sin(craterU * Math.PI);
    const facetVar = 0.82 + 0.34 * tileHash;
    const height = -CRATER_DEPTH * craterBell * facetVar * env;
    const craterFactor = clamp01(craterBell * env);
    const gridAlpha = clamp01(0.88 * env);

    return {
      reveal: 1,
      height,
      rimFactor: 0,
      craterFactor,
      tailFactor: 0,
      gridAlpha,
      tileHash,
      settled: false,
    };
  }

  // 5. Zone C: Short Scattered Noisy Tail Behind the Crater (craterEndTiles .. totalWaveTiles)
  const tailU = (deltaTiles - craterEndTiles) / TAIL_WIDTH_TILES;
  const tailDecay = Math.pow(1 - clamp01(tailU), 1.85);
  const signedScatter = (tileHash - 0.48) * 2.0 * (0.65 + 0.70 * hash2);
  const height = TAIL_NOISE_AMP * signedScatter * tailDecay * env;
  const tailFactor = clamp01(tailDecay * env);
  const gridAlpha = clamp01(Math.pow(1 - clamp01(tailU), 1.35) * 0.84 * env);

  return {
    reveal: 1,
    height,
    rimFactor: tailSelectHighlight(signedScatter, tailDecay, env),
    craterFactor: signedScatter < -0.15 ? clamp01(-signedScatter * tailDecay * 0.65 * env) : 0,
    tailFactor,
    gridAlpha,
    tileHash,
    settled: false,
  };
}

function tailSelectHighlight(signedScatter: number, tailDecay: number, env: number): number {
  if (signedScatter <= 0.18) return 0;
  return clamp01(signedScatter * tailDecay * 0.55 * env);
}
