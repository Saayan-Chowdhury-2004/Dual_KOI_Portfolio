/**
 * Anatomically authentic Japanese Koi Caudal (Tail) Fin System.
 *
 * Implements:
 * 1. Single source of truth: `computeCaudalFin(fish, time)` produces unified geometry
 *    consumed synchronously by both membrane and rays under the same frame and transform.
 * 2. Koi-correct morphology:
 *    - Length: 0.25 x body length (range 0.22 - 0.28).
 *    - Fan spread: 42° straight swim eased to 62° during hard turns/acceleration.
 *    - Trailing width: ~0.90 x fin length.
 *    - Trailing margin: shallow, rounded fork with notch = 0.18 and t^8 soft lobe tips.
 *    - 12 principal rays with bifurcation (60%) -> 24 terminal tips.
 *    - Scalloped trailing margin between tips (3-5% of L).
 * 3. Phase-delayed traveling wave displacement: A(s) * sin(w*t - k*s - phi_i) with s^2 amplitude.
 * 4. Caudal peduncle organic taper (0.28 max body width) and seamless overlap draw order.
 * 5. Zero per-frame memory allocation using preallocated typed arrays.
 */

import { koiClamp, koiSmoothstep, koiLerp } from './koiMath';
import { koiBodyHalfWidth } from './koiGeometry';
import type { KoiFish } from './koiTypes';

export const CAUDAL_FIN_CONFIG = {
  // Dimension ratios
  lengthRatio: 0.25,          // Fin length = 0.25 * bodyLength
  minSpreadDeg: 42,           // Straight swim spread (degrees)
  maxSpreadDeg: 62,           // Hard turn / acceleration max spread (degrees)
  maxWidthRatio: 0.90,        // Trailing edge max width / fin length ≈ 0.90
  notch: 0.18,                // Shallow, smooth authentic koi fork (notch depth ~0.15-0.18 L)
  t8Factor: 0.08,             // Lobe rounder factor (1 - 0.08 * t^8) for soft rounded lobe tips
  scallopPct: 0.032,          // Scallop inward dip between adjacent ray tips (3-5% of L)
  // Ray structure
  principalRayCount: 12,      // 12 primary rays
  split1Pct: 0.60,            // First bifurcation at 60% length
  terminalRayCount: 24,       // 12 * 2 = 24 terminal ray tips
  // Strokes & Opacities
  rayStrokeRootWidth: 1.0,    // 1.0 px at root
  rayStrokeTipWidth: 0.5,     // 0.5 px at tip
  rayAlphaRoot: 0.50,         // Ray root opacity
  rayAlphaTip: 0.15,          // Ray tip opacity
  membraneAlphaRoot: 0.70,    // Membrane root opacity
  membraneAlphaMargin: 0.25,  // Membrane margin opacity
  // Peduncle & Root Zone
  peduncleTaperRatio: 0.28,   // Peduncle width ≈ 0.28 * maxBodyWidth
  peduncleTaperLengthPct: 0.20, // Eased over last 20% of body length
  bodyOverlapPct: 0.05,       // Body overlaps fin base by 5% of fin length
  rootZonePct: 0.12,          // Dense root zone (first 12% of fin length)
  baseShadowAlpha: 0.25,      // Soft root anchoring shadow
  // Wave dynamics
  waveK: 2.2,                 // Spatial frequency along fin length
  flutterMaxRad: 0.06,        // Max per-ray flutter variation
};

const DEG2RAD = Math.PI / 180;

/**
 * Preallocated typed buffers for zero-allocation per-frame computation.
 */
export class CaudalFinScratchBuffer {
  baseX = new Float64Array(16);
  baseY = new Float64Array(16);

  tipX = new Float64Array(64);
  tipY = new Float64Array(64);

  scallopMidX = new Float64Array(63);
  scallopMidY = new Float64Array(63);

  flankX0 = new Float64Array(6);
  flankY0 = new Float64Array(6);
  flankCtrlX = new Float64Array(6);
  flankCtrlY = new Float64Array(6);
  flankX1 = new Float64Array(6);
  flankY1 = new Float64Array(6);

  maxSegments = 112;
  segX0 = new Float64Array(112);
  segY0 = new Float64Array(112);
  segX1 = new Float64Array(112);
  segY1 = new Float64Array(112);
  segCtrlX = new Float64Array(112);
  segCtrlY = new Float64Array(112);
  segWidth0 = new Float32Array(112);
  segWidth1 = new Float32Array(112);
  segAlpha0 = new Float32Array(112);
  segAlpha1 = new Float32Array(112);
  segCount = 0;

  maxPolyPoints = 300;
  polyX = new Float64Array(300);
  polyY = new Float64Array(300);
  polyCount = 0;

  finLength = 0;
  baseWidth = 0;
  trailingWidth = 0;
  notchDepth = 0;
  spreadAngleRad = 0;
}

const scratch = new CaudalFinScratchBuffer();
const _pt = { x: 0, y: 0 };
const _lobe = new Float64Array(8);

function rayPoint(
  rootX: number, rootY: number, dirX: number, dirY: number, rayLen: number, s: number,
  nx: number, ny: number, amp0: number, swimPhase: number, waveK: number, phi: number
): void {
  const w = Math.sin(swimPhase - 1.9 - waveK * s - phi) * amp0 * s * s;
  const d = rayLen * s;
  _pt.x = rootX + dirX * d + nx * w;
  _pt.y = rootY + dirY * d + ny * w;
}

function writeSeg(idx: number, x0: number, y0: number, mx: number, my: number, x1: number, y1: number): void {
  scratch.segX0[idx] = x0;
  scratch.segY0[idx] = y0;
  scratch.segCtrlX[idx] = 2 * mx - 0.5 * (x0 + x1);
  scratch.segCtrlY[idx] = 2 * my - 0.5 * (y0 + y1);
  scratch.segX1[idx] = x1;
  scratch.segY1[idx] = y1;
}

function writeFlank(
  idx: number, x0: number, y0: number, cx: number, cy: number, x1: number, y1: number
): void {
  scratch.flankX0[idx] = x0;
  scratch.flankY0[idx] = y0;
  scratch.flankCtrlX[idx] = cx;
  scratch.flankCtrlY[idx] = cy;
  scratch.flankX1[idx] = x1;
  scratch.flankY1[idx] = y1;
}

function pushQuad(
  pIdx: number, x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, steps: number
): number {
  for (let s = 1; s <= steps; s++) {
    const u = s / steps;
    const inv = 1 - u;
    scratch.polyX[pIdx] = inv * inv * x0 + 2 * inv * u * cx + u * u * x1;
    scratch.polyY[pIdx] = inv * inv * y0 + 2 * inv * u * cy + u * u * y1;
    pIdx++;
  }
  return pIdx;
}

export function computeCaudalFin(fish: KoiFish, _time?: number): CaudalFinScratchBuffer {
  const cfg = CAUDAL_FIN_CONFIG;
  const spine = fish.spine;
  const tail = spine[spine.length - 1];

  const finLength = fish.bodyLength * cfg.lengthRatio * (fish.tailLengthFactor || 1.0);
  scratch.finLength = finLength;

  const tailHw = koiBodyHalfWidth(tail.s, fish.maxHalfWidth);
  scratch.baseWidth = tailHw * 2;

  // Frame at the peduncle tip: b points backward, n is the lateral normal
  let bx = -tail.tx;
  let by = -tail.ty;
  const bLen = Math.hypot(bx, by) || 1;
  bx /= bLen;
  by /= bLen;
  let nx = tail.nx;
  let ny = tail.ny;
  const nLen = Math.hypot(nx, ny) || 1;
  nx /= nLen;
  ny /= nLen;

  // Fan spread: eased on turns / acceleration
  const speedRatio = fish.baseCruiseSpeed > 0 ? fish.speed / fish.baseCruiseSpeed : 0.8;
  const turnDrive = koiClamp(Math.abs(fish.turnRate) * 1.5, 0, 1);
  const accelDrive = koiClamp((speedRatio - 0.9) * 1.6, 0, 1);
  const spreadFactor = koiSmoothstep(0, 1, Math.max(turnDrive, accelDrive));
  const spreadDeg = koiLerp(cfg.minSpreadDeg, cfg.maxSpreadDeg, spreadFactor);
  const spreadRad = spreadDeg * DEG2RAD;
  scratch.spreadAngleRad = spreadRad;
  const halfSpread = spreadRad * 0.5;
  const halfMin = cfg.minSpreadDeg * DEG2RAD * 0.5;

  const pCount = cfg.principalRayCount; // 12
  const last = pCount - 1;
  const tipCount = pCount * 2;

  // Base arc: roots spread across 85% of peduncle width, tucked under dome
  const rootSpan = tailHw * 0.85;
  const rootTuck = finLength * 0.05 * 0.30;
  for (let i = 0; i < pCount; i++) {
    const u = -1 + (2 * i) / last;
    const arcBulge = (1 - u * u) * (tailHw * 0.20);
    scratch.baseX[i] = tail.x + nx * (u * rootSpan) + bx * (arcBulge + rootTuck);
    scratch.baseY[i] = tail.y + ny * (u * rootSpan) + by * (arcBulge + rootTuck);
  }

  const amp0 = fish.maxHalfWidth * 0.44 * (0.65 + 0.35 * speedRatio);
  const swimPhase = fish.phase;
  const waveK = cfg.waveK;
  const split1 = cfg.split1Pct; // 0.60
  const splitMid = (split1 + 1) * 0.5;

  const forkAngle = (0.25 * spreadRad) / last;
  scratch.segCount = 0;

  for (let i = 0; i < pCount; i++) {
    const t = -1 + (2 * i) / last; // [-1, 1]
    const phiFan = t * halfSpread;
    const c0 = Math.cos(phiFan);
    const s0 = Math.sin(phiFan);
    const dirX = bx * c0 + nx * s0;
    const dirY = by * c0 + ny * s0;

    const t2 = t * t;
    const t4 = t2 * t2;
    const rayLen =
      finLength * (1 - cfg.notch * Math.cos((Math.PI * t) / 2) ** 2) * (1 - cfg.t8Factor * t4 * t4) *
      (Math.cos(t * halfMin) / Math.cos(phiFan));
    const phi = cfg.flutterMaxRad * (1 - t2) * Math.sin(t * Math.PI * 2.0);

    const r0x = scratch.baseX[i];
    const r0y = scratch.baseY[i];

    // Primary segment: root -> split point
    rayPoint(r0x, r0y, dirX, dirY, rayLen, split1, nx, ny, amp0, swimPhase, waveK, phi);
    const p1x = _pt.x;
    const p1y = _pt.y;
    rayPoint(r0x, r0y, dirX, dirY, rayLen, split1 * 0.5, nx, ny, amp0, swimPhase, waveK, phi);
    const prim = scratch.segCount++;
    writeSeg(prim, r0x, r0y, _pt.x, _pt.y, p1x, p1y);
    if (i === 0) {
      writeFlank(0, r0x, r0y, scratch.segCtrlX[prim], scratch.segCtrlY[prim], p1x, p1y);
    }
    if (i === last) {
      writeFlank(3, p1x, p1y, scratch.segCtrlX[prim], scratch.segCtrlY[prim], r0x, r0y);
    }

    // Two terminal branches
    for (let b = 0; b < 2; b++) {
      const subPhi = phiFan + (b === 0 ? -forkAngle : forkAngle);
      const cs = Math.cos(subPhi);
      const sn = Math.sin(subPhi);
      const sdx = bx * cs + nx * sn;
      const sdy = by * cs + ny * sn;

      rayPoint(r0x, r0y, sdx, sdy, rayLen, split1, nx, ny, amp0, swimPhase, waveK, phi);
      const q0x = _pt.x;
      const q0y = _pt.y;
      rayPoint(r0x, r0y, sdx, sdy, rayLen, splitMid, nx, ny, amp0, swimPhase, waveK, phi);
      const qmx = _pt.x;
      const qmy = _pt.y;
      rayPoint(r0x, r0y, sdx, sdy, rayLen, 1.0, nx, ny, amp0, swimPhase, waveK, phi);
      const tipx = _pt.x;
      const tipy = _pt.y;

      const mx = qmx + 0.5 * (p1x - q0x);
      const my = qmy + 0.5 * (p1y - q0y);

      const seg = scratch.segCount++;
      writeSeg(seg, p1x, p1y, mx, my, tipx, tipy);

      const tipIdx = i * 2 + b;
      scratch.tipX[tipIdx] = tipx;
      scratch.tipY[tipIdx] = tipy;

      if (i === 0 && b === 0) {
        writeFlank(1, p1x, p1y, scratch.segCtrlX[seg], scratch.segCtrlY[seg], tipx, tipy);
      }
      if (i === last && b === 1) {
        writeFlank(2, tipx, tipy, scratch.segCtrlX[seg], scratch.segCtrlY[seg], p1x, p1y);
      }
    }
  }

  // Margin scallops
  const maxDepth = finLength * cfg.scallopPct;
  for (let j = 0; j < tipCount - 1; j++) {
    const ax = scratch.tipX[j];
    const ay = scratch.tipY[j];
    const cx = scratch.tipX[j + 1];
    const cy = scratch.tipY[j + 1];
    const mx = (ax + cx) * 0.5;
    const my = (ay + cy) * 0.5;
    const chord = Math.hypot(cx - ax, cy - ay);
    const depth = Math.min(maxDepth, chord * 0.36);
    let ix = tail.x - mx;
    let iy = tail.y - my;
    const il = Math.hypot(ix, iy) || 1;
    ix /= il;
    iy /= il;
    scratch.scallopMidX[j] = mx + ix * depth;
    scratch.scallopMidY[j] = my + iy * depth;
  }

  // Measurements
  const leftTipX = scratch.tipX[0];
  const leftTipY = scratch.tipY[0];
  const rightTipX = scratch.tipX[tipCount - 1];
  const rightTipY = scratch.tipY[tipCount - 1];
  scratch.trailingWidth = Math.hypot(rightTipX - leftTipX, rightTipY - leftTipY);
  const midA = pCount - 1;
  const midB = pCount;
  const midTipX = (scratch.tipX[midA] + scratch.tipX[midB]) * 0.5;
  const midTipY = (scratch.tipY[midA] + scratch.tipY[midB]) * 0.5;
  scratch.notchDepth = Math.hypot((leftTipX + rightTipX) * 0.5 - midTipX, (leftTipY + rightTipY) * 0.5 - midTipY);

  // Soft rounded lobes
  const lobeR = finLength * 0.06;
  {
    const p0x = scratch.flankX0[1], p0y = scratch.flankY0[1];
    const cx = scratch.flankCtrlX[1], cy = scratch.flankCtrlY[1];
    const p1x2 = scratch.flankX1[1], p1y2 = scratch.flankY1[1];
    const u0 = 1 - Math.min(0.5, lobeR / (Math.hypot(p1x2 - p0x, p1y2 - p0y) || 1));
    const q0x = p0x + u0 * (cx - p0x), q0y = p0y + u0 * (cy - p0y);
    const q1x = cx + u0 * (p1x2 - cx), q1y = cy + u0 * (p1y2 - cy);
    _lobe[0] = q0x + u0 * (q1x - q0x);
    _lobe[1] = q0y + u0 * (q1y - q0y);
    _lobe[4] = q0x;
    _lobe[5] = q0y;
  }
  {
    const p0x = scratch.flankX0[2], p0y = scratch.flankY0[2];
    const cx = scratch.flankCtrlX[2], cy = scratch.flankCtrlY[2];
    const p1x2 = scratch.flankX1[2], p1y2 = scratch.flankY1[2];
    const u0 = Math.min(0.5, lobeR / (Math.hypot(p1x2 - p0x, p1y2 - p0y) || 1));
    const q0x = p0x + u0 * (cx - p0x), q0y = p0y + u0 * (cy - p0y);
    const q1x = cx + u0 * (p1x2 - cx), q1y = cy + u0 * (p1y2 - cy);
    _lobe[2] = q0x + u0 * (q1x - q0x);
    _lobe[3] = q0y + u0 * (q1y - q0y);
    _lobe[6] = q1x;
    _lobe[7] = q1y;
  }

  // Outer boundary polygon
  let pIdx = 0;
  scratch.polyX[pIdx] = scratch.flankX0[0];
  scratch.polyY[pIdx] = scratch.flankY0[0];
  pIdx++;
  pIdx = pushQuad(pIdx, scratch.flankX0[0], scratch.flankY0[0], scratch.flankCtrlX[0], scratch.flankCtrlY[0], scratch.flankX1[0], scratch.flankY1[0], 6);
  pIdx = pushQuad(pIdx, scratch.flankX0[1], scratch.flankY0[1], _lobe[4], _lobe[5], _lobe[0], _lobe[1], 6);
  scratch.polyX[pIdx] = leftTipX; scratch.polyY[pIdx] = leftTipY; pIdx++;
  scratch.polyX[pIdx] = scratch.tipX[2]; scratch.polyY[pIdx] = scratch.tipY[2]; pIdx++;
  for (let j = 2; j <= tipCount - 4; j++) {
    scratch.polyX[pIdx] = scratch.scallopMidX[j]; scratch.polyY[pIdx] = scratch.scallopMidY[j]; pIdx++;
    scratch.polyX[pIdx] = scratch.tipX[j + 1]; scratch.polyY[pIdx] = scratch.tipY[j + 1]; pIdx++;
  }
  scratch.polyX[pIdx] = rightTipX; scratch.polyY[pIdx] = rightTipY; pIdx++;
  scratch.polyX[pIdx] = _lobe[2]; scratch.polyY[pIdx] = _lobe[3]; pIdx++;
  pIdx = pushQuad(pIdx, _lobe[2], _lobe[3], _lobe[6], _lobe[7], scratch.flankX1[2], scratch.flankY1[2], 6);
  pIdx = pushQuad(pIdx, scratch.flankX0[3], scratch.flankY0[3], scratch.flankCtrlX[3], scratch.flankCtrlY[3], scratch.flankX1[3], scratch.flankY1[3], 6);
  for (let i = pCount - 2; i > 0; i--) {
    scratch.polyX[pIdx] = scratch.baseX[i];
    scratch.polyY[pIdx] = scratch.baseY[i];
    pIdx++;
  }
  scratch.polyCount = pIdx;

  return scratch;
}

export function traceCaudalFinPath(
  ctx: CanvasRenderingContext2D,
  fin: CaudalFinScratchBuffer,
  offsetX = 0,
  offsetY = 0
): void {
  const pCount = CAUDAL_FIN_CONFIG.principalRayCount;
  const tipCount = pCount * 2;
  const ox = offsetX;
  const oy = offsetY;

  ctx.beginPath();
  ctx.moveTo(fin.flankX0[0] + ox, fin.flankY0[0] + oy);
  ctx.quadraticCurveTo(fin.flankCtrlX[0] + ox, fin.flankCtrlY[0] + oy, fin.flankX1[0] + ox, fin.flankY1[0] + oy);
  ctx.quadraticCurveTo(_lobe[4] + ox, _lobe[5] + oy, _lobe[0] + ox, _lobe[1] + oy);
  ctx.quadraticCurveTo(fin.tipX[0] + ox, fin.tipY[0] + oy, fin.tipX[2] + ox, fin.tipY[2] + oy);
  for (let j = 2; j <= tipCount - 4; j++) {
    ctx.quadraticCurveTo(fin.scallopMidX[j] + ox, fin.scallopMidY[j] + oy, fin.tipX[j + 1] + ox, fin.tipY[j + 1] + oy);
  }
  ctx.quadraticCurveTo(fin.tipX[tipCount - 1] + ox, fin.tipY[tipCount - 1] + oy, _lobe[2] + ox, _lobe[3] + oy);
  ctx.quadraticCurveTo(_lobe[6] + ox, _lobe[7] + oy, fin.flankX1[2] + ox, fin.flankY1[2] + oy);
  ctx.quadraticCurveTo(fin.flankCtrlX[3] + ox, fin.flankCtrlY[3] + oy, fin.flankX1[3] + ox, fin.flankY1[3] + oy);
  for (let i = pCount - 2; i >= 0; i--) {
    ctx.lineTo(fin.baseX[i] + ox, fin.baseY[i] + oy);
  }
  ctx.closePath();
}

export function strokeCaudalFinRays(
  ctx: CanvasRenderingContext2D,
  fin: CaudalFinScratchBuffer,
  strokeRgb: [number, number, number],
  koiExposure = 1.0,
  offsetX = 0,
  offsetY = 0
): void {
  const cfg = CAUDAL_FIN_CONFIG;
  const pCount = cfg.principalRayCount;
  const tipCount = pCount * 2;
  const ox = offsetX;
  const oy = offsetY;

  ctx.save();
  traceCaudalFinPath(ctx, fin, ox, oy);
  ctx.clip(); // Rays strictly clipped to membrane polygon
  ctx.lineCap = 'round';

  const gx0 = (fin.baseX[0] + fin.baseX[pCount - 1]) * 0.5 + ox;
  const gy0 = (fin.baseY[0] + fin.baseY[pCount - 1]) * 0.5 + oy;
  const gx1 = (fin.tipX[0] + fin.tipX[tipCount - 1]) * 0.5 + ox;
  const gy1 = (fin.tipY[0] + fin.tipY[tipCount - 1]) * 0.5 + oy;
  const grad = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
  const rgb = `${strokeRgb[0]}, ${strokeRgb[1]}, ${strokeRgb[2]}`;
  grad.addColorStop(0.0, `rgba(${rgb}, ${(cfg.rayAlphaRoot * koiExposure).toFixed(3)})`);
  grad.addColorStop(0.6, `rgba(${rgb}, ${(cfg.rayAlphaRoot * 0.7 * koiExposure).toFixed(3)})`);
  grad.addColorStop(1.0, `rgba(${rgb}, ${(cfg.rayAlphaTip * koiExposure).toFixed(3)})`);
  ctx.strokeStyle = grad;

  // Primary rays
  ctx.beginPath();
  ctx.lineWidth = cfg.rayStrokeRootWidth;
  for (let i = 0; i < pCount; i++) {
    const s = i * 3;
    ctx.moveTo(fin.segX0[s] + ox, fin.segY0[s] + oy);
    ctx.quadraticCurveTo(fin.segCtrlX[s] + ox, fin.segCtrlY[s] + oy, fin.segX1[s] + ox, fin.segY1[s] + oy);
  }
  ctx.stroke();

  // Branch rays
  ctx.beginPath();
  ctx.lineWidth = (cfg.rayStrokeRootWidth + cfg.rayStrokeTipWidth) * 0.5;
  for (let i = 0; i < pCount; i++) {
    for (let b = 1; b <= 2; b++) {
      const s = i * 3 + b;
      ctx.moveTo(fin.segX0[s] + ox, fin.segY0[s] + oy);
      ctx.quadraticCurveTo(fin.segCtrlX[s] + ox, fin.segCtrlY[s] + oy, fin.segX1[s] + ox, fin.segY1[s] + oy);
    }
  }
  ctx.stroke();

  ctx.restore();
}
