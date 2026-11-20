import type { KoiArtStyle } from "./koiRenderer";

export type MizuhikiCoinVariant = "brass" | "sumie-day" | "sumie-night";

const SVG_NS = "http://www.w3.org/2000/svg";

// Cache baked 192x192 coin data URLs keyed by sourceUri + variant + isOni
const coinBakeCache = new Map<string, string>();

/**
 * Extracts a crisp silhouette alpha mask from a square icon URI (perimeter-sampled
 * crimson background removal) and bakes a 2x-retina sculpted 3D cast-metal Japanese
 * coin medallion filling the full circle edge-to-edge (zero transparent border),
 * with beveled rim, recessed patina, pierced top/bottom cord eyelets, and embossed
 * relief emblem.
 */
export function bakeMizuhikiCoinDataUrl(
  sourceUri: string,
  variant: MizuhikiCoinVariant,
  isOni: boolean,
  onReady: (dataUrl: string) => void
): void {
  const cacheKey = `${variant}|${isOni ? "oni" : "std"}|${sourceUri.slice(0, 64)}|${sourceUri.length}`;
  const cached = coinBakeCache.get(cacheKey);
  if (cached) {
    onReady(cached);
    return;
  }

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    const size = 192;
    const cx = size * 0.5;
    const cy = size * 0.5;
    // Fill edge-to-edge (99.4% of radius) so there is zero transparent boundary around the coin
    const outerR = size * 0.496;
    const rimInnerR = size * 0.402;

    // 1. Sample icon silhouette into a clean alpha mask
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = size;
    srcCanvas.height = size;
    const sctx = srcCanvas.getContext("2d");
    if (!sctx) return;

    const emblemSize = Math.round(size * 0.64);
    const emblemOff = Math.round((size - emblemSize) * 0.5);
    sctx.drawImage(img, emblemOff, emblemOff, emblemSize, emblemSize);

    const imgData = sctx.getImageData(0, 0, size, size);
    const data = imgData.data;

    let bgR = 0;
    let bgG = 0;
    let bgB = 0;
    let bgCount = 0;
    const p0 = emblemOff + 3;
    const p1 = emblemOff + emblemSize - 4;
    for (let x = p0; x <= p1; x += 2) {
      for (const y of [p0, p1]) {
        const idx = (y * size + x) * 4;
        if (data[idx + 3] > 200) {
          bgR += data[idx];
          bgG += data[idx + 1];
          bgB += data[idx + 2];
          bgCount++;
        }
      }
    }
    if (bgCount > 0) {
      bgR /= bgCount;
      bgG /= bgCount;
      bgB /= bgCount;
    } else {
      bgR = 115;
      bgG = 20;
      bgB = 18;
    }

    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = size;
    maskCanvas.height = size;
    const mctx = maskCanvas.getContext("2d");
    if (!mctx) return;
    const maskData = mctx.createImageData(size, size);
    const md = maskData.data;

    const maxEmblemR = rimInnerR - 6.0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const a = data[idx + 3];
        if (a < 20) continue;
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > maxEmblemR * maxEmblemR) continue;

        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        const bgLuma = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;
        const dist = Math.hypot(r - bgR, g - bgG, b - bgB);
        const lumaDiff = luma - bgLuma;

        let alpha = 0;
        if (lumaDiff > 24 && dist > 38) {
          const t = Math.min(1, Math.max(0, (lumaDiff - 24) / 72));
          alpha = t * t * (3 - 2 * t);
        }
        if (alpha < 0.14) alpha = 0;
        md[idx] = 255;
        md[idx + 1] = 255;
        md[idx + 2] = 255;
        md[idx + 3] = Math.round(alpha * 255);
      }
    }
    mctx.putImageData(maskData, 0, 0);

    // 2. Render sculpted cast-metal coin onto output canvas
    const out = document.createElement("canvas");
    out.width = size;
    out.height = size;
    const ctx = out.getContext("2d");
    if (!ctx) return;

    const isBrass = variant === "brass";
    const isSumieNight = variant === "sumie-night";

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    const rimGrad = ctx.createLinearGradient(cx - outerR, cy - outerR, cx + outerR, cy + outerR);
    if (isBrass) {
      rimGrad.addColorStop(0, "#f6dd94");
      rimGrad.addColorStop(0.24, "#cfa246");
      rimGrad.addColorStop(0.58, "#8c6320");
      rimGrad.addColorStop(0.86, "#573a0d");
      rimGrad.addColorStop(1, "#362206");
    } else if (isSumieNight) {
      rimGrad.addColorStop(0, "#7c7568");
      rimGrad.addColorStop(0.26, "#46423c");
      rimGrad.addColorStop(0.62, "#24221f");
      rimGrad.addColorStop(1, "#0d0c0b");
    } else {
      rimGrad.addColorStop(0, "#5e5850");
      rimGrad.addColorStop(0.26, "#312e2a");
      rimGrad.addColorStop(0.65, "#191816");
      rimGrad.addColorStop(1, "#090808");
    }
    ctx.fillStyle = rimGrad;
    ctx.fill();

    // Inner bevel stroke strictly inside outerR so nothing bleeds outside the circle
    ctx.beginPath();
    ctx.arc(cx, cy, outerR - 1.2, 0, Math.PI * 2);
    ctx.lineWidth = 2.0;
    ctx.strokeStyle = isBrass
      ? "rgba(255, 244, 200, 0.50)"
      : isSumieNight
        ? "rgba(220, 212, 196, 0.34)"
        : "rgba(180, 172, 158, 0.26)";
    ctx.stroke();

    // Recessed cast interior field
    ctx.beginPath();
    ctx.arc(cx, cy, rimInnerR, 0, Math.PI * 2);
    const fieldGrad = ctx.createRadialGradient(
      cx - rimInnerR * 0.28,
      cy - rimInnerR * 0.3,
      rimInnerR * 0.08,
      cx,
      cy,
      rimInnerR
    );
    if (isBrass) {
      fieldGrad.addColorStop(0, "#9f762e");
      fieldGrad.addColorStop(0.55, "#74521c");
      fieldGrad.addColorStop(0.88, "#523710");
      fieldGrad.addColorStop(1, "#382409");
    } else if (isSumieNight) {
      fieldGrad.addColorStop(0, "#2b2926");
      fieldGrad.addColorStop(0.6, "#1b1a18");
      fieldGrad.addColorStop(1, "#100f0e");
    } else {
      fieldGrad.addColorStop(0, "#23211e");
      fieldGrad.addColorStop(0.6, "#161513");
      fieldGrad.addColorStop(1, "#0c0b0a");
    }
    ctx.fillStyle = fieldGrad;
    ctx.fill();

    // Inner recessed bevel shadow
    ctx.beginPath();
    ctx.arc(cx, cy, rimInnerR, 0, Math.PI * 2);
    const innerLip = ctx.createLinearGradient(
      cx - rimInnerR,
      cy - rimInnerR,
      cx + rimInnerR,
      cy + rimInnerR
    );
    if (isBrass) {
      innerLip.addColorStop(0, "rgba(28, 16, 4, 0.85)");
      innerLip.addColorStop(0.5, "rgba(60, 38, 10, 0.35)");
      innerLip.addColorStop(1, "rgba(248, 224, 150, 0.65)");
    } else {
      innerLip.addColorStop(0, "rgba(0, 0, 0, 0.88)");
      innerLip.addColorStop(0.5, "rgba(18, 16, 14, 0.4)");
      innerLip.addColorStop(1, isSumieNight ? "rgba(180, 172, 156, 0.42)" : "rgba(140, 134, 124, 0.32)");
    }
    ctx.lineWidth = 3.2;
    ctx.strokeStyle = innerLip;
    ctx.stroke();

    // Subtle hammered cast-metal patina grain clipped inside coin
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, outerR - 1, 0, Math.PI * 2);
    ctx.clip();
    let seed = 1337;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    for (let i = 0; i < 640; i++) {
      const gx = rand() * size;
      const gy = rand() * size;
      const gr = 0.8 + rand() * 1.9;
      const bright = rand() > 0.5;
      ctx.fillStyle = isBrass
        ? bright
          ? "rgba(255, 236, 175, 0.065)"
          : "rgba(32, 18, 4, 0.085)"
        : bright
          ? "rgba(225, 218, 204, 0.048)"
          : "rgba(0, 0, 0, 0.11)";
      ctx.beginPath();
      ctx.arc(gx, gy, gr, 0, Math.PI * 2);
      ctx.fill();
    }

    // Fine traditional milled inner bead ring
    const beadR = (outerR + rimInnerR) * 0.5;
    const beadCount = 40;
    for (let b = 0; b < beadCount; b++) {
      const ang = (b / beadCount) * Math.PI * 2;
      const bx = cx + Math.cos(ang) * beadR;
      const by = cy + Math.sin(ang) * beadR;
      if (Math.abs(bx - cx) < 13.5) continue;
      ctx.fillStyle = isBrass
        ? "rgba(255, 240, 185, 0.34)"
        : isSumieNight
          ? "rgba(180, 174, 160, 0.25)"
          : "rgba(150, 144, 134, 0.20)";
      ctx.beginPath();
      ctx.arc(bx, by, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // 3. Sculpted 3D Embossed Relief Emblem (Shadow + Highlight + Cast Face)
    const tintMask = (fillStyle: string | CanvasGradient): HTMLCanvasElement => {
      const c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      const cctx = c.getContext("2d")!;
      cctx.drawImage(maskCanvas, 0, 0);
      cctx.globalCompositeOperation = "source-in";
      cctx.fillStyle = fillStyle;
      cctx.fillRect(0, 0, size, size);
      return c;
    };

    const shadowMask = tintMask(isBrass ? "rgba(26, 14, 3, 0.78)" : "rgba(0, 0, 0, 0.85)");
    ctx.drawImage(shadowMask, 2.4, 3.0);

    const hiColor = isBrass
      ? "rgba(255, 248, 212, 0.86)"
      : isOni
        ? "rgba(252, 132, 114, 0.80)"
        : "rgba(255, 252, 244, 0.78)";
    const hiMask = tintMask(hiColor);
    ctx.drawImage(hiMask, -1.7, -1.7);

    const faceCanvas = document.createElement("canvas");
    faceCanvas.width = size;
    faceCanvas.height = size;
    const fctx = faceCanvas.getContext("2d")!;
    fctx.drawImage(maskCanvas, 0, 0);
    fctx.globalCompositeOperation = "source-in";
    const faceGrad = fctx.createLinearGradient(
      emblemOff,
      emblemOff,
      emblemOff + emblemSize,
      emblemOff + emblemSize
    );
    if (isBrass) {
      faceGrad.addColorStop(0, "#fff0b6");
      faceGrad.addColorStop(0.45, "#e8be62");
      faceGrad.addColorStop(1, "#b4822b");
    } else if (isOni) {
      faceGrad.addColorStop(0, "#e24737");
      faceGrad.addColorStop(0.55, "#c4281c");
      faceGrad.addColorStop(1, "#8d1810");
    } else {
      faceGrad.addColorStop(0, "#f2ece0");
      faceGrad.addColorStop(0.55, "#d2cab8");
      faceGrad.addColorStop(1, "#9a9282");
    }
    fctx.fillStyle = faceGrad;
    fctx.fillRect(0, 0, size, size);
    ctx.drawImage(faceCanvas, 0, 0);

    // 4. Pierced Top & Bottom Cord Eyelets
    const eyeletOffset = (outerR + rimInnerR) * 0.5;
    for (const ey of [cy - eyeletOffset, cy + eyeletOffset]) {
      ctx.beginPath();
      ctx.arc(cx, ey, 5.2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(10, 6, 3, 0.92)";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = isBrass
        ? "rgba(246, 218, 138, 0.65)"
        : "rgba(160, 152, 138, 0.45)";
      ctx.stroke();
    }

    ctx.restore();

    const dataUrl = out.toDataURL("image/png");
    coinBakeCache.set(cacheKey, dataUrl);
    onReady(dataUrl);
  };
  img.src = sourceUri;
}

interface ChainNodeState {
  el: HTMLElement;
  sheenEl: HTMLElement | null;
  angle: number;
  vel: number;
  twist: number;
  twistVel: number;
}

/**
 * Manages the physical Japanese Mizuhiki Knot Coin Chain (1.5x scaled):
 * - Crowning traditional Awaji-musubi knot anchored at top
 * - Multi-strand braided vermilion (+ gold in Mokkotsu) mizuhiki cords linking coins
 * - Tight hitch knots visibly threading into each coin's top/bottom eyelet
 * - Dynamic vermilion silk tassel (fusa) hanging below the bottommost visible coin
 * - Coupled damped-pendulum sway physics triggered gently on cursor hover & coin flips
 */
export class MizuhikiCoinChain {
  private container: HTMLElement;
  private svgEl: SVGSVGElement;
  private nodes: ChainNodeState[] = [];
  private artStyle: KoiArtStyle = "mokkotsu";
  private tasselAngle = 0;
  private tasselVel = 0;

  // Smooth animated drop state for the bottommost (flashlight) coin:
  // 0 = tucked cleanly behind preceding LinkedIn coin, 1 = dropped into hanging slot
  private flashlightDrop = 0;
  private flashlightDropVel = 0;
  private flashlightDropTarget = 0;

  private raf = 0;
  private lastTs = 0;
  private lastPointerX = 0;
  private disposed = false;

  private gKnot: SVGGElement;
  private gCords: SVGGElement;
  private gHitches: SVGGElement;
  private gTassel: SVGGElement;

  constructor(container: HTMLElement, coinEls: HTMLElement[]) {
    this.container = container;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "ms-mizuhiki-svg");
    svg.setAttribute("aria-hidden", "true");
    this.svgEl = svg;

    this.gCords = document.createElementNS(SVG_NS, "g");
    this.gKnot = document.createElementNS(SVG_NS, "g");
    this.gHitches = document.createElementNS(SVG_NS, "g");
    this.gTassel = document.createElementNS(SVG_NS, "g");

    svg.appendChild(this.gCords);
    svg.appendChild(this.gKnot);
    svg.appendChild(this.gHitches);
    svg.appendChild(this.gTassel);
    container.appendChild(svg);

    for (const el of coinEls) {
      const sheen = document.createElement("span");
      sheen.className = "ms-coin-sheen";
      sheen.setAttribute("aria-hidden", "true");
      el.appendChild(sheen);

      const node: ChainNodeState = {
        el,
        sheenEl: sheen,
        angle: 0,
        vel: 0,
        twist: 0,
        twistVel: 0,
      };
      this.nodes.push(node);

      el.addEventListener("pointerenter", (e) => {
        const rect = el.getBoundingClientRect();
        const relX = (e.clientX - (rect.left + rect.width * 0.5)) / Math.max(1, rect.width * 0.5);
        const dir = relX >= 0 ? -1 : 1;
        this.nudgeNode(node, dir * 0.56, dir * 18);
        this.lastPointerX = e.clientX;
      });

      el.addEventListener("pointermove", (e) => {
        const dx = e.clientX - this.lastPointerX;
        this.lastPointerX = e.clientX;
        if (Math.abs(dx) > 1.0) {
          const impulse = Math.max(-0.24, Math.min(0.24, dx * 0.014));
          this.nudgeNode(node, impulse, impulse * 34);
        }
      });
    }

    requestAnimationFrame(() => {
      if (!this.disposed) this.renderGeometry();
    });
  }

  public setArtStyle(style: KoiArtStyle): void {
    if (this.artStyle === style) return;
    this.artStyle = style;
    this.renderGeometry();
  }

  /**
   * Smoothly drops the bottommost flashlight coin out from behind the preceding
   * LinkedIn coin (Night mode) or tucks it smoothly back behind it (Day mode).
   */
  public setFlashlightVisible(visible: boolean, immediate = false): void {
    const nextTarget = visible ? 1 : 0;
    const changed = nextTarget !== this.flashlightDropTarget;
    this.flashlightDropTarget = nextTarget;

    if (immediate) {
      this.flashlightDrop = nextTarget;
      this.flashlightDropVel = 0;
      this.renderGeometry();
      return;
    }

    if (changed) {
      const flashNode = this.nodes[this.nodes.length - 1];
      if (visible && flashNode) {
        // Gentle weighted settle sway as the coin drops down on its red cord
        flashNode.vel += 0.34;
        this.tasselVel += 0.52;
      } else {
        this.tasselVel -= 0.28;
      }
      this.ensureLoop();
    }
  }

  public nudgeByElement(el: HTMLElement, dir = 1): void {
    const node = this.nodes.find((n) => n.el === el);
    if (node) {
      this.nudgeNode(node, dir * 0.44, 0);
    }
  }

  public refreshLayout(): void {
    if (this.disposed) return;
    this.renderGeometry();
  }

  private nudgeNode(target: ChainNodeState, velImpulse: number, twistImpulse: number): void {
    const idx = this.nodes.indexOf(target);
    if (idx < 0) return;

    target.vel = Math.max(-1.8, Math.min(1.8, target.vel + velImpulse));
    target.twistVel = Math.max(-90, Math.min(90, target.twistVel + twistImpulse));

    // Propagate smooth weighted wave up and down the full linked chain
    for (let i = 0; i < this.nodes.length; i++) {
      if (i === idx) continue;
      const dist = Math.abs(i - idx);
      const falloff = i > idx ? Math.pow(0.62, dist) : Math.pow(0.42, dist);
      this.nodes[i].vel += velImpulse * falloff;
      this.nodes[i].twistVel += twistImpulse * falloff * 0.55;
    }
    this.tasselVel += velImpulse * 0.72;

    this.ensureLoop();
  }

  private ensureLoop(): void {
    if (this.raf || this.disposed) return;
    this.lastTs = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    this.raf = 0;
    if (this.disposed) return;

    const dt = Math.min(0.032, Math.max(0.004, (now - this.lastTs) / 1000));
    this.lastTs = now;

    let energy = 0;

    // 1. Spring-smoothed drop-down / tuck-away animation for flashlight coin
    const dropDiff = this.flashlightDropTarget - this.flashlightDrop;
    if (Math.abs(dropDiff) > 0.001 || Math.abs(this.flashlightDropVel) > 0.001) {
      const dropK = this.flashlightDropTarget > 0.5 ? 58.0 : 72.0;
      const dropDamp = this.flashlightDropTarget > 0.5 ? Math.exp(-8.2 * dt) : Math.exp(-11.5 * dt);
      this.flashlightDropVel = (this.flashlightDropVel + dropK * dropDiff * dt) * dropDamp;
      this.flashlightDrop = Math.max(0, Math.min(1.06, this.flashlightDrop + this.flashlightDropVel * dt));
      energy += Math.abs(dropDiff) * 2.0 + Math.abs(this.flashlightDropVel);
    } else {
      this.flashlightDrop = this.flashlightDropTarget;
      this.flashlightDropVel = 0;
    }

    // 2. Fluid, weighted hanging-chain pendulum physics (natural languid swing + phase ripple)
    const gravityK = 11.5;
    const coupleK = 16.0;
    const damping = Math.exp(-1.55 * dt);
    const twistK = 24.0;
    const twistDamp = Math.exp(-3.2 * dt);

    const activeCount = this.flashlightDrop > 0.02 ? this.nodes.length : Math.max(1, this.nodes.length - 1);

    for (let i = 0; i < activeCount; i++) {
      const n = this.nodes[i];
      const prevAngle = i > 0 ? this.nodes[i - 1].angle : 0;
      const nextAngle = i + 1 < activeCount ? this.nodes[i + 1].angle : n.angle;

      // Restoring gravity torque + smooth cord tension coupling to upper & lower coins
      const acc =
        -gravityK * n.angle +
        coupleK * (prevAngle - n.angle) +
        coupleK * 0.52 * (nextAngle - n.angle);

      n.vel = (n.vel + acc * dt) * damping;
      n.angle = Math.max(-0.28, Math.min(0.28, n.angle + n.vel * dt));

      // Couple subtle 3D Y-turn smoothly to pendulum swing velocity so metallic light glints naturally
      const tAcc = -twistK * n.twist + n.vel * 22.0;
      n.twistVel = (n.twistVel + tAcc * dt) * twistDamp;
      n.twist = Math.max(-24, Math.min(24, n.twist + n.twistVel * dt));

      energy +=
        Math.abs(n.angle) +
        Math.abs(n.vel) * 0.25 +
        Math.abs(n.twist) * 0.008 +
        Math.abs(n.twistVel) * 0.002;
    }

    // 3. Trailing silk tassel with looser, silky inertia
    const lastActive = this.nodes[activeCount - 1];
    const lastAngle = lastActive ? lastActive.angle : 0;
    const tasselAcc = -10.5 * this.tasselAngle + 15.0 * (lastAngle - this.tasselAngle);
    this.tasselVel = (this.tasselVel + tasselAcc * dt) * Math.exp(-1.45 * dt);
    this.tasselAngle = Math.max(-0.42, Math.min(0.42, this.tasselAngle + this.tasselVel * dt));
    energy += Math.abs(this.tasselAngle) + Math.abs(this.tasselVel) * 0.25;

    this.renderGeometry();

    if (energy > 0.002) {
      this.raf = requestAnimationFrame(this.tick);
    } else {
      for (const n of this.nodes) {
        n.angle = 0;
        n.vel = 0;
        n.twist = 0;
        n.twistVel = 0;
      }
      this.tasselAngle = 0;
      this.tasselVel = 0;
      this.flashlightDrop = this.flashlightDropTarget;
      this.flashlightDropVel = 0;
      this.renderGeometry();
    }
  };

  private renderGeometry(): void {
    if (this.nodes.length === 0) return;

    // 10% reduced scale (1.5 * 0.90 = 1.35) matching 79px coins
    const S = 1.35;
    const svgW = Math.round(128 * S); // 173px
    const cx = svgW * 0.5;
    const topAnchorY = 16.5 * S; // ~22.3px (40% shorter top link)

    const isSumie = this.artStyle === "sumie";
    const cordMain = isSumie ? "#b82018" : "#c41e18";
    const cordHi = isSumie ? "#d84034" : "#e83a2c";
    const cordAccent = isSumie ? "#7d120d" : "#e8c064";
    const cordShadow = "rgba(18, 4, 2, 0.42)";

    const coinSize = this.nodes[0].el.offsetWidth || 79;
    const coinR = coinSize * 0.5;
    const eyeletInset = coinR * 0.898;
    const flashIdx = this.nodes.length - 1;
    const pDrop = this.flashlightDrop;

    const centers: Array<{
      x: number;
      y: number;
      topX: number;
      topY: number;
      botX: number;
      botY: number;
      angle: number;
      alpha: number;
    }> = [];

    let cumX = 0;
    let cumYLift = 0;

    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const isFlash = i === flashIdx;
      const baseCenterY = n.el.offsetTop + coinR;
      const prevBaseY = i > 0 ? this.nodes[i - 1].el.offsetTop + coinR : topAnchorY;
      const fullLinkLen = Math.max(24, baseCenterY - prevBaseY);

      if (isFlash) {
        // Drop smoothly out from behind the preceding LinkedIn coin (y = prevBaseY at pDrop=0)
        const clampedP = Math.max(0, Math.min(1.06, pDrop));
        const dropOffsetY = -(1 - clampedP) * fullLinkLen;
        const visAlpha = clampedP <= 0.03 ? 0 : Math.min(1, clampedP * 1.45);
        const dropScale = 0.88 + 0.12 * Math.min(1, clampedP);

        const activeLink = fullLinkLen * Math.min(1, clampedP);
        const segX = Math.sin(n.angle) * activeLink * 0.72;
        const segLift = (1 - Math.cos(n.angle)) * activeLink * 0.35;
        const fx = cx + cumX + segX;
        const fy = baseCenterY + dropOffsetY - cumYLift - segLift;
        // Hanging pendulum: positive angle swings right (+x), so coin tilts counter-clockwise (-degZ)
        const degZ = -(n.angle * 180) / Math.PI;
        const degY = n.twist;

        n.el.style.opacity = visAlpha.toFixed(3);
        n.el.style.pointerEvents = clampedP > 0.45 ? "auto" : "none";
        n.el.style.transform = `translate3d(${(cumX + segX).toFixed(2)}px, ${(dropOffsetY - cumYLift - segLift).toFixed(2)}px, 0) scale(${dropScale.toFixed(3)}) perspective(460px) rotateZ(${degZ.toFixed(2)}deg) rotateY(${degY.toFixed(2)}deg)`;

        if (n.sheenEl) {
          const sheenX = 50 - degY * 2.1 - degZ * 1.4;
          const sheenOp = Math.min(0.45, 0.14 + Math.abs(degY) * 0.014 + Math.abs(degZ) * 0.012);
          n.sheenEl.style.background = `radial-gradient(circle at ${sheenX.toFixed(1)}% 26%, rgba(255, 246, 210, ${sheenOp.toFixed(2)}) 0%, transparent 62%)`;
        }

        if (clampedP > 0.04) {
          // Exact rotated top/bottom eyelet coordinates around 50% 50% center for rotateZ(-angle)
          const sinA = Math.sin(n.angle);
          const cosA = Math.cos(n.angle);
          const effInset = eyeletInset * dropScale;
          centers.push({
            x: fx,
            y: fy,
            topX: fx - sinA * effInset,
            topY: fy - cosA * effInset,
            botX: fx + sinA * effInset,
            botY: fy + cosA * effInset,
            angle: n.angle,
            alpha: visAlpha,
          });
        }
        continue;
      }

      cumX += Math.sin(n.angle) * fullLinkLen * 0.72;
      cumYLift += (1 - Math.cos(n.angle)) * fullLinkLen * 0.35;
      const degZ = -(n.angle * 180) / Math.PI;
      const degY = n.twist;

      n.el.style.transform = `translate3d(${cumX.toFixed(2)}px, ${(-cumYLift).toFixed(2)}px, 0) perspective(460px) rotateZ(${degZ.toFixed(2)}deg) rotateY(${degY.toFixed(2)}deg)`;

      if (n.sheenEl) {
        const sheenX = 50 - degY * 2.1 - degZ * 1.4;
        const sheenOp = Math.min(0.45, 0.14 + Math.abs(degY) * 0.014 + Math.abs(degZ) * 0.012);
        n.sheenEl.style.background = `radial-gradient(circle at ${sheenX.toFixed(1)}% 26%, rgba(255, 246, 210, ${sheenOp.toFixed(2)}) 0%, transparent 62%)`;
      }

      const sinA = Math.sin(n.angle);
      const cosA = Math.cos(n.angle);
      const x = cx + cumX;
      const y = baseCenterY - cumYLift;
      centers.push({
        x,
        y,
        topX: x - sinA * eyeletInset,
        topY: y - cosA * eyeletInset,
        botX: x + sinA * eyeletInset,
        botY: y + cosA * eyeletInset,
        angle: n.angle,
        alpha: 1,
      });
    }

    const lastCoin = centers[centers.length - 1];
    const totalH = Math.ceil(lastCoin.y + coinR + 82);
    this.svgEl.setAttribute("viewBox", `0 0 ${svgW} ${totalH}`);
    this.svgEl.style.width = `${svgW}px`;
    this.svgEl.style.height = `${totalH}px`;

    const makePath = (d: string, stroke: string, width: number, opacity = 1): SVGPathElement => {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      p.setAttribute("stroke", stroke);
      p.setAttribute("stroke-width", width.toFixed(2));
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
      p.setAttribute("fill", "none");
      if (opacity < 0.999) p.setAttribute("stroke-opacity", opacity.toFixed(3));
      return p;
    };

    this.gCords.innerHTML = "";
    this.gKnot.innerHTML = "";
    this.gHitches.innerHTML = "";
    this.gTassel.innerHTML = "";

    // 1. Multi-strand braided mizuhiki cords (10% smaller scale S = 1.35)
    const drawMultiCord = (x0: number, y0: number, x1: number, y1: number, opacity = 1) => {
      const midY = (y0 + y1) * 0.5;
      const dx = x1 - x0;
      const c1x = x0 + dx * 0.18;
      const c2x = x1 - dx * 0.18;
      const off = 1.5 * S;
      this.gCords.appendChild(
        makePath(`M ${x0 + 1.3} ${y0 + 1.3} C ${c1x + 1.3} ${midY + 1.3}, ${c2x + 1.3} ${midY + 1.3}, ${x1 + 1.3} ${y1 + 1.3}`, cordShadow, 5.0 * S, opacity)
      );
      this.gCords.appendChild(
        makePath(`M ${x0 - off} ${y0} C ${c1x - off} ${midY}, ${c2x - off} ${midY}, ${x1 - off} ${y1}`, cordMain, 1.5 * S, opacity)
      );
      this.gCords.appendChild(
        makePath(`M ${x0} ${y0} C ${c1x} ${midY}, ${c2x} ${midY}, ${x1} ${y1}`, cordAccent, 1.3 * S, opacity)
      );
      this.gCords.appendChild(
        makePath(`M ${x0 + off} ${y0} C ${c1x + off} ${midY}, ${c2x + off} ${midY}, ${x1 + off} ${y1}`, cordHi, 1.4 * S, opacity)
      );
    };

    drawMultiCord(cx, 0, cx, topAnchorY);
    drawMultiCord(cx, topAnchorY + 5 * S, centers[0].topX, centers[0].topY);

    for (let i = 1; i < centers.length; i++) {
      // Only draw connecting cord once the dropping coin emerges below the preceding coin's bottom eyelet
      if (centers[i].topY > centers[i - 1].botY - 4) {
        drawMultiCord(centers[i - 1].botX, centers[i - 1].botY, centers[i].topX, centers[i].topY, centers[i].alpha);
      }
    }

    // 2. Crowning Awaji-musubi (Abalone) Mizuhiki Knot (10% reduced scale S = 1.35)
    const kx = cx;
    const ky = topAnchorY;
    const awajiLoops = [
      `M ${kx - 3 * S} ${ky - 7 * S} C ${kx - 20 * S} ${ky - 14 * S}, ${kx - 25 * S} ${ky + 7 * S}, ${kx - 6 * S} ${ky + 6 * S} C ${kx + 2 * S} ${ky + 5 * S}, ${kx + 6 * S} ${ky - 4 * S}, ${kx + 12 * S} ${ky - 5 * S}`,
      `M ${kx + 3 * S} ${ky - 7 * S} C ${kx + 20 * S} ${ky - 14 * S}, ${kx + 25 * S} ${ky + 7 * S}, ${kx + 6 * S} ${ky + 6 * S} C ${kx - 2 * S} ${ky + 5 * S}, ${kx - 6 * S} ${ky - 4 * S}, ${kx - 12 * S} ${ky - 5 * S}`,
      `M ${kx - 10 * S} ${ky + 4 * S} Q ${kx - 18 * S} ${ky + 11 * S}, ${kx - 22 * S} ${ky + 15 * S}`,
      `M ${kx + 10 * S} ${ky + 4 * S} Q ${kx + 18 * S} ${ky + 11 * S}, ${kx + 22 * S} ${ky + 15 * S}`,
    ];
    for (const d of awajiLoops) {
      this.gKnot.appendChild(makePath(d, cordShadow, 5.2 * S));
      this.gKnot.appendChild(makePath(d, cordMain, 3.6 * S));
      this.gKnot.appendChild(makePath(d, cordAccent, 1.4 * S));
      this.gKnot.appendChild(makePath(d, cordHi, 0.72 * S));
    }
    this.gKnot.appendChild(
      makePath(`M ${kx - 4 * S} ${ky + 1 * S} Q ${kx} ${ky - 3 * S}, ${kx + 4 * S} ${ky + 1 * S}`, cordAccent, 2.1 * S)
    );

    // 3. Tight Vermilion Hitch Knots at each coin's top & bottom eyelets
    const drawHitchKnot = (hx: number, hy: number, isTop: boolean, opacity = 1) => {
      const dir = isTop ? -1 : 1;
      const loopD = `M ${hx} ${hy} L ${hx} ${hy + dir * 4.8 * S}`;
      this.gHitches.appendChild(makePath(loopD, cordShadow, 4.4 * S, opacity));
      this.gHitches.appendChild(makePath(loopD, cordMain, 2.9 * S, opacity));
      this.gHitches.appendChild(makePath(loopD, cordAccent, 1.15 * S, opacity));

      const cinchY = hy + dir * 3.5 * S;
      this.gHitches.appendChild(
        makePath(`M ${hx - 3.4 * S} ${cinchY} Q ${hx} ${cinchY - dir * 1.5 * S}, ${hx + 3.4 * S} ${cinchY}`, cordShadow, 3.4 * S, opacity)
      );
      this.gHitches.appendChild(
        makePath(`M ${hx - 3.4 * S} ${cinchY} Q ${hx} ${cinchY - dir * 1.5 * S}, ${hx + 3.4 * S} ${cinchY}`, cordHi, 2.1 * S, opacity)
      );
      this.gHitches.appendChild(
        makePath(`M ${hx - 2.2 * S} ${cinchY} L ${hx + 2.2 * S} ${cinchY}`, cordAccent, 0.95 * S, opacity)
      );
    };

    for (let i = 0; i < centers.length; i++) {
      // Hide dropping coin's top hitch until it clears the preceding coin
      if (i === flashIdx && centers[i].topY < centers[i - 1].botY - 2) {
        drawHitchKnot(centers[i].botX, centers[i].botY, false, centers[i].alpha);
      } else {
        drawHitchKnot(centers[i].topX, centers[i].topY, true, centers[i].alpha);
        drawHitchKnot(centers[i].botX, centers[i].botY, false, centers[i].alpha);
      }
    }

    // 4. Dynamic Vermilion Silk Tassel (Fusa) (40% shorter stem + 10% smaller scale)
    const tx0 = lastCoin.botX;
    const ty0 = lastCoin.botY + 2.2 * S;
    const collarLen = 7.2 * S;
    const tasselLen = 33 * S;
    const sinT = Math.sin(this.tasselAngle);
    const cosT = Math.cos(this.tasselAngle);
    const collarX = tx0 + sinT * collarLen;
    const collarY = ty0 + cosT * collarLen;

    drawMultiCord(tx0, ty0, collarX, collarY);

    for (let s = -3; s <= 3; s++) {
      const spread = s * 2.1 * S;
      const len = tasselLen - Math.abs(s) * 1.5 * S;
      const tipX = collarX + sinT * len + cosT * spread * 1.45;
      const tipY = collarY + cosT * len - sinT * spread * 1.45;
      const midX = collarX + sinT * (len * 0.48) + cosT * spread * 0.55;
      const midY = collarY + cosT * (len * 0.48) - sinT * spread * 0.55;
      const strandColor = s === 0 ? cordAccent : s % 2 === 0 ? cordHi : cordMain;
      this.gTassel.appendChild(
        makePath(`M ${collarX} ${collarY + 2 * S} Q ${midX} ${midY}, ${tipX} ${tipY}`, strandColor, 1.4 * S)
      );
    }

    const capAngleDeg = (-this.tasselAngle * 180) / Math.PI;
    const cap = document.createElementNS(SVG_NS, "g");
    cap.setAttribute("transform", `translate(${collarX.toFixed(2)}, ${collarY.toFixed(2)}) rotate(${capAngleDeg.toFixed(2)})`);
    cap.appendChild(
      makePath(
        `M ${-4.0 * S} ${-1.4 * S} L ${4.0 * S} ${-1.4 * S} M ${-4.3 * S} ${1.1 * S} L ${4.3 * S} ${1.1 * S} M ${-3.6 * S} ${3.4 * S} L ${3.6 * S} ${3.4 * S}`,
        cordShadow,
        2.7 * S
      )
    );
    cap.appendChild(
      makePath(
        `M ${-4.0 * S} ${-1.4 * S} L ${4.0 * S} ${-1.4 * S} M ${-4.3 * S} ${1.1 * S} L ${4.3 * S} ${1.1 * S}`,
        cordAccent,
        1.7 * S
      )
    );
    cap.appendChild(
      makePath(`M ${-3.6 * S} ${3.4 * S} L ${3.6 * S} ${3.4 * S}`, cordHi, 1.7 * S)
    );
    this.gTassel.appendChild(cap);
  }

  public destroy(): void {
    this.disposed = true;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.svgEl.remove();
  }
}
