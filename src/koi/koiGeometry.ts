/**
 * Procedural Japanese koi geometry system.
 * Reconstructs each fish's 20 spine nodes along the exact recorded trajectory curve
 * (`restSpineX`, `restSpineY`) so the body never drifts sideways around a pivot point
 * during edge turns, while superimposing a natural posterior caudal propulsion wave
 * and a flowing bilobed forked tail fin.
 */

import { koiClamp, koiSmoothstep } from './koiMath';
import type { KoiFish, SampleHit } from './koiTypes';

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

/**
 * Evaluates a single world-space point (wx, wy) against a koi's procedural anatomy.
 */
export function evaluateKoiPoint(
  fish: KoiFish,
  wx: number,
  wy: number,
  out: SampleHit
): void {
  out.part = 'none';
  out.coverage = 0;
  out.s = 0;
  out.u = 0;
  out.shade = 0;
  out.rayAngle = 0;
  out.finSpanU = 0;
  out.finChordV = 0;

  const spine = fish.spine;
  const n = spine.length;

  let bestDistSq = Infinity;
  let bestSeg = 0;
  let bestT = 0;

  for (let i = 0; i < n - 1; i++) {
    const a = spine[i];
    const b = spine[i + 1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const apx = wx - a.x;
    const apy = wy - a.y;
    const abLenSq = abx * abx + aby * aby || 1;
    const t = koiClamp((apx * abx + apy * aby) / abLenSq, 0, 1);
    const cx = a.x + abx * t;
    const cy = a.y + aby * t;
    const dx = wx - cx;
    const dy = wy - cy;
    const dSq = dx * dx + dy * dy;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestSeg = i;
      bestT = t;
    }
  }

  const nodeA = spine[bestSeg];
  const nodeB = spine[bestSeg + 1];
  const cx = nodeA.x + (nodeB.x - nodeA.x) * bestT;
  const cy = nodeA.y + (nodeB.y - nodeA.y) * bestT;

  let tx = nodeA.tx + (nodeB.tx - nodeA.tx) * bestT;
  let ty = nodeA.ty + (nodeB.ty - nodeA.ty) * bestT;
  const tLen = Math.hypot(tx, ty) || 1;
  tx /= tLen;
  ty /= tLen;
  const nx = -ty;
  const ny = tx;

  const rx = wx - cx;
  const ry = wy - cy;
  let d = rx * nx + ry * ny;

  let s = ((bestSeg + bestT) / (n - 1)) * 0.83;

  if (bestSeg === 0 && bestT === 0) {
    const head = spine[0];
    const forwardProj = (wx - head.x) * head.tx + (wy - head.y) * head.ty;
    if (forwardProj > 0) {
      s = -forwardProj / fish.bodyLength;
      d = (wx - head.x) * head.nx + (wy - head.y) * head.ny;
      tx = head.tx;
      ty = head.ty;
    }
  } else if (bestSeg === n - 2 && bestT === 1) {
    const tail = spine[n - 1];
    const backProj = -((wx - tail.x) * tail.tx + (wy - tail.y) * tail.ty);
    if (backProj > 0) {
      s = 0.83 + backProj / fish.bodyLength;
      d = (wx - tail.x) * tail.nx + (wy - tail.y) * tail.ny;
      tx = tail.tx;
      ty = tail.ty;
    }
  }

  const absD = Math.abs(d);
  const hw = koiBodyHalfWidth(s, fish.maxHalfWidth);

  // -------------------------------------------------------------------------
  // A. Main Body, Smooth Rounded Head & Dorsal Fin Ridge (s in [0, 0.83])
  // -------------------------------------------------------------------------
  if (s >= 0 && s <= 0.835 && hw > 0.5 && absD <= hw) {
    const u = koiClamp(d / hw, -1, 1);
    const absU = Math.abs(u);

    const nz = Math.sqrt(Math.max(0.04, 1 - u * u * 0.88));
    const worldNx = nx * u * 0.72 - tx * (s < 0.18 ? (0.18 - s) * 2.2 : 0);
    const worldNy = ny * u * 0.72 - ty * (s < 0.18 ? (0.18 - s) * 2.2 : 0);
    const diffuse = koiClamp(worldNx * -0.32 + worldNy * -0.38 + nz * 0.86, 0.18, 1.0);

    const edgeSoftness = koiSmoothstep(1.0, 0.84, absU);

    // Central Dorsal Fin Ridge (s in [0.35, 0.67])
    if (s >= 0.35 && s <= 0.67) {
      const dorsalProgress = (s - 0.35) / 0.32;
      const swayU =
        Math.sin(fish.phase - s * 2.2) * 0.08 * (0.4 + dorsalProgress * 0.6) -
        koiClamp(fish.curvature * 0.14, -0.15, 0.15);
      const ridgeDist = Math.abs(u - swayU * 0.65);
      const ridgeHalfWidth = 0.11 + 0.04 * Math.sin(dorsalProgress * Math.PI);
      if (ridgeDist <= ridgeHalfWidth) {
        out.part = 'dorsal-fin';
        out.coverage = 0.96;
        out.s = s;
        out.u = u;
        out.shade = koiClamp(diffuse + 0.14, 0.4, 1.0);
        out.rayAngle = Math.atan2(-ty, -tx) + swayU * 0.3;
        out.finSpanU = 1 - ridgeDist / ridgeHalfWidth;
        out.finChordV = dorsalProgress;
        return;
      }
    }

    out.part = s < 0.21 ? 'head' : 'body';
    out.coverage = koiClamp(0.45 + 0.55 * edgeSoftness, 0.35, 1.0);
    out.s = s;
    out.u = u;
    out.shade = diffuse;
    out.rayAngle = Math.atan2(ty, tx);
    return;
  }

  // -------------------------------------------------------------------------
  // B. Rounded Fan Pectoral Fins (attached around s = 0.23)
  // -------------------------------------------------------------------------
  if (s >= 0.14 && s <= 0.43) {
    const attachIdx = Math.min(n - 1, Math.max(2, Math.round((0.23 / 0.83) * (n - 1))));
    const attachNode = spine[attachIdx];
    const side = d >= 0 ? 1 : -1;
    const attachHw = attachNode.halfWidth * 0.88;

    const rootX = attachNode.x + attachNode.nx * (side * attachHw);
    const rootY = attachNode.y + attachNode.ny * (side * attachHw);

    const flutter = Math.sin(fish.finPhase + side * 0.9) * 0.075;
    const turnOffset = koiClamp(fish.curvature * side * -0.1, -0.12, 0.12);

    const baseAngle =
      Math.atan2(attachNode.ny * side, attachNode.nx * side) +
      side * (0.48 + flutter + turnOffset);

    const fCos = Math.cos(baseAngle);
    const fSin = Math.sin(baseAngle);
    const cCos = -Math.sin(baseAngle) * side;
    const cSin = Math.cos(baseAngle) * side;

    const dx = wx - rootX;
    const dy = wy - rootY;

    const spanDist = dx * fCos + dy * fSin;
    const chordDist = dx * cCos + dy * cSin;

    const maxSpan = fish.maxHalfWidth * 1.28 * fish.finSpanFactor;
    if (spanDist >= -maxSpan * 0.06 && spanDist <= maxSpan) {
      const spanU = koiClamp(spanDist / maxSpan, 0, 1);
      const envelope = Math.sin(Math.pow(spanU, 0.68) * Math.PI);
      const halfChord = fish.bodyLength * 0.064 * fish.finSpanFactor * (0.32 + 0.68 * envelope);
      const chordCenter = spanU * fish.bodyLength * 0.025;
      const localChord = chordDist - chordCenter;

      if (Math.abs(localChord) <= halfChord) {
        const chordV = (localChord / (halfChord || 1) + 1) * 0.5;
        const tipFade = koiSmoothstep(1.0, 0.72, spanU);
        const rimFade = koiSmoothstep(1.0, 0.78, Math.abs(localChord) / (halfChord || 1));

        out.part = 'pectoral-fin';
        out.coverage = koiClamp(0.32 + 0.62 * tipFade * rimFade, 0.28, 0.92);
        out.s = 0.24;
        out.u = side * (1.0 + spanU);
        out.shade = koiClamp(0.62 + 0.28 * (1 - spanU) + 0.1 * (1 - chordV), 0.45, 0.98);
        out.rayAngle = Math.atan2(dy, dx);
        out.finSpanU = spanU;
        out.finChordV = chordV;
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // C. Paired Pelvic Fins (ventral-lateral fans around s in [0.46, 0.59])
  // -------------------------------------------------------------------------
  if (s >= 0.45 && s <= 0.6 && absD > hw * 0.92) {
    const pelvicMaxSpan = fish.maxHalfWidth * 0.54 * fish.finSpanFactor;
    const spanDist = absD - hw * 0.9;
    if (spanDist >= 0 && spanDist <= pelvicMaxSpan) {
      const spanU = spanDist / pelvicMaxSpan;
      const sCenter = 0.515 + spanU * 0.03;
      const halfS = 0.038 * Math.sin(Math.pow(spanU, 0.65) * Math.PI + 0.25);
      if (Math.abs(s - sCenter) <= halfS) {
        out.part = 'pelvic-fin';
        out.coverage = koiClamp(0.3 + 0.52 * (1 - spanU), 0.25, 0.82);
        out.s = s;
        out.u = (d >= 0 ? 1 : -1) * (1 + spanU * 0.6);
        out.shade = 0.68 * (1 - spanU * 0.3);
        out.rayAngle = Math.atan2(-ty + ny * (d >= 0 ? 0.5 : -0.5), -tx + nx * (d >= 0 ? 0.5 : -0.5));
        out.finSpanU = spanU;
        out.finChordV = (s - (sCenter - halfS)) / (2 * halfS || 1);
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // D. Top-Down Bilobed Caudal Fin with Natural Swimming Wave (s in [0.79, 1.15])
  // -------------------------------------------------------------------------
  if (s >= 0.79 && s <= 1.16) {
    const peduncle = spine[n - 1];
    const baseTailAngle = Math.atan2(-peduncle.ty, -peduncle.tx);
    const tCos = Math.cos(baseTailAngle);
    const tSin = Math.sin(baseTailAngle);
    const nCos = -tSin;
    const nSin = tCos;

    const dx = wx - peduncle.x;
    const dy = wy - peduncle.y;

    const tailX = dx * tCos + dy * tSin;
    const tailLen = fish.bodyLength * 0.25 * fish.tailLengthFactor;

    if (tailX >= -fish.bodyLength * 0.025 && tailX <= tailLen) {
      const uLen = koiClamp(tailX / tailLen, 0, 1);

      // Active rhythmic tail-fin sweep: travels smoothly from peduncle to tail tip
      const speedFactor = koiClamp(fish.speed / (fish.baseCruiseSpeed || 120), 0.35, 1.25);
      const sweepLag =
        Math.sin(fish.phase - 2.1 - uLen * 1.65) *
          fish.maxHalfWidth *
          0.46 *
          (0.45 + 0.55 * speedFactor) *
          Math.pow(uLen, 1.25) +
        koiClamp(fish.curvature, -1, 1) * fish.maxHalfWidth * 0.32 * Math.pow(uLen, 1.4);

      const tailY = dx * nCos + dy * nSin - sweepLag;
      const absTailY = Math.abs(tailY);

      const outerSpan =
        fish.maxHalfWidth *
        (0.18 + 0.78 * Math.sin(Math.pow(uLen, 0.65) * Math.PI * 0.84)) *
        fish.finSpanFactor;

      let innerFork = 0;
      if (uLen > 0.34) {
        const forkT = (uLen - 0.34) / 0.66;
        innerFork = outerSpan * 0.56 * Math.pow(forkT, 1.32);
      }

      const lobeMidY = (innerFork + outerSpan) * 0.5;
      const lobeHalfW = Math.max(1.0, (outerSpan - innerFork) * 0.5);
      const lobeLocalY = (absTailY - lobeMidY) / lobeHalfW;
      const maxTipULen = uLen > 0.58 ? 1.0 - 0.22 * lobeLocalY * lobeLocalY : 1.0;

      if (absTailY <= outerSpan && absTailY >= innerFork && uLen <= maxTipULen) {
        const lobeFill = 1 - Math.min(1, Math.abs(lobeLocalY));
        const veilFade = koiClamp(1.0 - uLen * 0.34, 0.36, 0.94);

        out.part = 'caudal-fin';
        out.coverage = veilFade * koiSmoothstep(0.0, 0.24, lobeFill);
        out.s = 0.83 + uLen * 0.17;
        out.u = koiClamp(tailY / (outerSpan || 1), -1, 1);
        out.shade = koiClamp(0.68 + lobeFill * 0.24 - uLen * 0.16, 0.44, 0.96);
        out.rayAngle = Math.atan2(dy, dx);
        out.finSpanU = uLen;
        out.finChordV = koiClamp((absTailY - innerFork) / (outerSpan - innerFork || 1), 0, 1);
        return;
      }
    }
  }
}
