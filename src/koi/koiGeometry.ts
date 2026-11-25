/**
 * Procedural Japanese koi geometry system.
 * Reconstructs each fish's 20 spine nodes along the exact recorded trajectory curve
 * (`restSpineX`, `restSpineY`) so the body never drifts sideways around a pivot point
 * during edge turns, while superimposing a natural posterior caudal propulsion wave
 * and a flowing bilobed forked tail fin.
 */

import { koiClamp } from './koiMath';
import type { KoiFish } from './koiTypes';

export const SPINE_NODE_COUNT = 20;

/**
 * Parametric half-width profile of a top-down Japanese koi along normalized
 * spine coordinate s in [0, 0.84] (caudal fin flares from 0.80 to 1.14).
 */
export function koiBodyHalfWidth(s: number, maxHalfWidth: number): number {
  if (s < 0 || s > 0.845) return 0;

  // 1. Continuous smooth convex ovoid head dome from rounded snout tip to gill shoulders (s: 0.0 -> 0.285)
  if (s < 0.285) {
    const t = s / 0.285;
    const ovoid = Math.pow(Math.sin(t * Math.PI * 0.5), 0.58);
    return maxHalfWidth * koiClamp(ovoid, 0, 1);
  }

  // 2. Full muscular cylindrical trunk behind gill covers (s: 0.285 -> 0.46)
  if (s < 0.46) {
    const t = (s - 0.285) / 0.175;
    return maxHalfWidth * (1.0 - 0.045 * t * t);
  }

  // 3. Smooth muscular carp taper through mid/lower torso into slender peduncle (s: 0.46 -> 0.845)
  const t = koiClamp((s - 0.46) / 0.385, 0, 1);
  const peduncleRatio = 0.165;
  const smoothT = t * t * (3 - 2 * t);
  const curve = 0.955 * Math.pow(1 - t, 1.14) * (1 - 0.12 * smoothT) + peduncleRatio * (1 - Math.pow(1 - t, 1.45));
  return maxHalfWidth * koiClamp(curve, peduncleRatio, 1.0);
}

/**
 * Updates the 20 world-space spine nodes from `restSpineX`/`restSpineY` (which lie
 * directly along the historical path curve traveled by the head) plus a natural
 * posterior tail-propulsion wave.
 */
export function updateFishSpineGeometry(fish: KoiFish): void {
  const n = SPINE_NODE_COUNT;
  const segLen = (fish.bodyLength * 0.83) / (n - 1);

  const speedRatio = koiClamp(fish.speed / (fish.baseCruiseSpeed || 120), 0.25, 1.35);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < n; i++) {
    const s = (i / (n - 1)) * 0.83;
    const node = fish.spine[i];
    node.s = s;
    node.halfWidth = koiBodyHalfWidth(s, fish.maxHalfWidth);

    let rtx: number;
    let rty: number;
    if (i === 0) {
      const dx = fish.restSpineX[0] - fish.restSpineX[1];
      const dy = fish.restSpineY[0] - fish.restSpineY[1];
      const len = Math.hypot(dx, dy) || 1;
      rtx = dx / len;
      rty = dy / len;
    } else if (i === n - 1) {
      const dx = fish.restSpineX[n - 2] - fish.restSpineX[n - 1];
      const dy = fish.restSpineY[n - 2] - fish.restSpineY[n - 1];
      const len = Math.hypot(dx, dy) || 1;
      rtx = dx / len;
      rty = dy / len;
    } else {
      const dx = fish.restSpineX[i - 1] - fish.restSpineX[i + 1];
      const dy = fish.restSpineY[i - 1] - fish.restSpineY[i + 1];
      const len = Math.hypot(dx, dy) || 1;
      rtx = dx / len;
      rty = dy / len;
    }

    const rnx = -rty;
    const rny = rtx;

    // Rigid Cranial Skull for i <= 4 (snout through eyes and operculum gill cover, s <= 0.21):
    // Zero internal wave bending on the cranium; subcarangiform S-wave starts strictly behind the skull (i > 4).
    const tNorm = i / (n - 1);
    const bodyFlex = i <= 4 ? 0 : Math.max(0, (tNorm - 0.21) / 0.79);
    const ampEnvelope = 0.064 * Math.pow(bodyFlex, 1.72);

    const waveAngle = fish.phase - tNorm * 3.05;
    const waveOffset =
      Math.sin(waveAngle) *
      fish.bodyLength *
      ampEnvelope *
      (0.48 + 0.52 * speedRatio);

    node.x = fish.restSpineX[i] + rnx * waveOffset;
    node.y = fish.restSpineY[i] + rny * waveOffset;
  }

  // Lock cranial nodes i = 0..4 onto a single rigid cranial chord (from neck pivot i = 4 through snout i = 0)
  // so the snout is 100% rigid with the head and never turns independently during direction changes!
  let headTx = fish.spine[0].x - fish.spine[4].x;
  let headTy = fish.spine[0].y - fish.spine[4].y;
  const headChordLen = Math.hypot(headTx, headTy) || 1;
  headTx /= headChordLen;
  headTy /= headChordLen;
  const headNx = -headTy;
  const headNy = headTx;

  for (let i = 1; i <= 4; i++) {
    fish.spine[i].x = fish.spine[0].x - headTx * (i * segLen);
    fish.spine[i].y = fish.spine[0].y - headTy * (i * segLen);
  }

  // Enforce exact arc-length spacing along the torso/tail spine (i >= 5) and compute smooth tangents/normals
  for (let i = 0; i < n; i++) {
    const node = fish.spine[i];
    if (i > 4) {
      const prev = fish.spine[i - 1];
      const dx = node.x - prev.x;
      const dy = node.y - prev.y;
      const d = Math.hypot(dx, dy) || 1;
      node.x = prev.x + (dx / d) * segLen;
      node.y = prev.y + (dy / d) * segLen;
    }

    if (i <= 3) {
      // Entire cranium (snout, barbels, eyes, cheeks) shares the exact same rigid cranial orientation
      node.tx = headTx;
      node.ty = headTy;
      node.nx = headNx;
      node.ny = headNy;
    } else {
      let tx: number;
      let ty: number;
      if (i === n - 1) {
        const prev = fish.spine[n - 2];
        tx = prev.x - node.x;
        ty = prev.y - node.y;
      } else {
        const prev = fish.spine[i - 1];
        const next = fish.spine[i + 1];
        tx = prev.x - next.x;
        ty = prev.y - next.y;
      }
      const len = Math.hypot(tx, ty) || 1;
      node.tx = tx / len;
      node.ty = ty / len;
      node.nx = -node.ty;
      node.ny = node.tx;
    }

    const pad = fish.maxHalfWidth * 2.35 * fish.finSpanFactor;
    if (node.x - pad < minX) minX = node.x - pad;
    if (node.y - pad < minY) minY = node.y - pad;
    if (node.x + pad > maxX) maxX = node.x + pad;
    if (node.y + pad > maxY) maxY = node.y + pad;
  }

  const tailNode = fish.spine[n - 1];
  const tailReach = fish.bodyLength * 0.36 * fish.tailLengthFactor;
  minX = Math.min(minX, tailNode.x - tailReach);
  minY = Math.min(minY, tailNode.y - tailReach);
  maxX = Math.max(maxX, tailNode.x + tailReach);
  maxY = Math.max(maxY, tailNode.y + tailReach);

  fish.bbox.minX = minX;
  fish.bbox.minY = minY;
  fish.bbox.maxX = maxX;
  fish.bbox.maxY = maxY;
}
