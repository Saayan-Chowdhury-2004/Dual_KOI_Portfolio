import { clamp, smoothstep } from "./math";

export type FluidMaskPhase = "idle" | "dragging" | "flooding" | "retracting";

export interface FluidMaskCallbacks {
  onCoverageChange?: (coverage: number, phase: FluidMaskPhase) => void;
  onSwapComplete?: () => void;
  onDragStart?: () => void;
}

interface FBO {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
  attach(id: number): number;
}

interface DoubleFBO {
  width: number;
  height: number;
  texelSizeX: number;
  texelSizeY: number;
  read: FBO;
  write: FBO;
  swap(): void;
}

interface GLProgram {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
  bind(): void;
}

const COVERAGE_THRESHOLD = 0.60;
const DRAG_PIXEL_THRESHOLD = 10;

export class FluidMaskEngine {
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  private isWebGL2 = false;
  private halfFloatTexType = 0;
  private supportLinearFiltering = false;
  private rgbaFormat: { internalFormat: number; format: number } = { internalFormat: 0, format: 0 };
  private rgFormat: { internalFormat: number; format: number } = { internalFormat: 0, format: 0 };
  private rFormat: { internalFormat: number; format: number } = { internalFormat: 0, format: 0 };

  private velocityFBO!: DoubleFBO;
  private dyeFBO!: DoubleFBO;
  private divergenceFBO!: FBO;
  private curlFBO!: FBO;
  private pressureFBO!: DoubleFBO;
  private coverageFBO!: FBO;

  private clearProg!: GLProgram;
  private splatProg!: GLProgram;
  private advectionProg!: GLProgram;
  private divergenceProg!: GLProgram;
  private curlProg!: GLProgram;
  private vorticityProg!: GLProgram;
  private pressureProg!: GLProgram;
  private gradSubtractProg!: GLProgram;
  private coverageProg!: GLProgram;
  private displayProg!: GLProgram;

  private quadBuffer: WebGLBuffer | null = null;
  private bottomCanvasTex: WebGLTexture | null = null;
  private topCanvasTex: WebGLTexture | null = null;

  private coveragePixels = new Uint8Array(64 * 64 * 4);
  private cssMaskCanvas: HTMLCanvasElement;
  private cssMaskCtx: CanvasRenderingContext2D | null;
  private cssMaskImageData: ImageData | null = null;
  private readonly maskW = 160;
  private readonly maskH = 100;

  private phase: FluidMaskPhase = "idle";
  private coverage = 0;
  private floodProgress = 0;
  private retractProgress = 0;
  private pointerDown = false;
  private isDragging = false;
  private startClientX = 0;
  private startClientY = 0;
  private lastClientX = 0;
  private lastClientY = 0;
  private curClientX = 0;
  private curClientY = 0;
  private movedDistance = 0;
  private suppressClickUntil = 0;
  private swapCooldownUntil = 0;

  private viewW = 1;
  private viewH = 1;
  private dpr = 1;
  private disposed = false;

  constructor(
    private overlayCanvas: HTMLCanvasElement,
    private getTopLayerEl: () => HTMLElement,
    private getBottomCanvas: () => HTMLCanvasElement,
    private callbacks: FluidMaskCallbacks = {},
    private getTopCanvas?: () => HTMLCanvasElement,
    private getColumnsUvBounds?: () => [number, number, number, number] | null
  ) {
    this.cssMaskCanvas = document.createElement("canvas");
    this.cssMaskCanvas.width = this.maskW;
    this.cssMaskCanvas.height = this.maskH;
    this.cssMaskCtx = this.cssMaskCanvas.getContext("2d", { willReadFrequently: true });
    if (this.cssMaskCtx) {
      this.cssMaskImageData = this.cssMaskCtx.createImageData(this.maskW, this.maskH);
    }

    this.initWebGL();
    this.resize();
  }

  public getPhase(): FluidMaskPhase {
    return this.phase;
  }

  public getCoverage(): number {
    return this.coverage;
  }

  public isPointerDown(): boolean {
    return this.pointerDown;
  }

  public shouldSuppressClick(): boolean {
    return performance.now() < this.suppressClickUntil;
  }

  public resize(): void {
    const rect = this.overlayCanvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width || window.innerWidth || 1280));
    const h = Math.max(1, Math.round(rect.height || window.innerHeight || 800));
    this.viewW = w;
    this.viewH = h;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    const physW = Math.max(1, Math.round(w * this.dpr));
    const physH = Math.max(1, Math.round(h * this.dpr));
    if (this.overlayCanvas.width !== physW || this.overlayCanvas.height !== physH) {
      this.overlayCanvas.width = physW;
      this.overlayCanvas.height = physH;
    }

    if (this.gl) {
      this.initFramebuffers();
    }
  }

  public onPointerDown(clientX: number, clientY: number): void {
    if (this.phase === "flooding" || performance.now() < this.swapCooldownUntil) return;

    // Only clear FBOs if starting from idle; if retracting, let the user seamlessly catch/resume the liquid
    if (this.phase === "idle") {
      this.clearSimulationFBOs();
      this.coverage = 0;
      this.retractProgress = 0;
    }

    this.pointerDown = true;
    this.isDragging = false;
    this.movedDistance = 0;
    this.startClientX = clientX;
    this.startClientY = clientY;
    this.lastClientX = clientX;
    this.lastClientY = clientY;
    this.curClientX = clientX;
    this.curClientY = clientY;
  }

  public onPointerMove(clientX: number, clientY: number): void {
    this.curClientX = clientX;
    this.curClientY = clientY;

    if (!this.pointerDown || this.phase === "flooding" || performance.now() < this.swapCooldownUntil) {
      return;
    }

    const dxTotal = clientX - this.startClientX;
    const dyTotal = clientY - this.startClientY;
    const distFromStart = Math.hypot(dxTotal, dyTotal);

    if (!this.isDragging && distFromStart >= DRAG_PIXEL_THRESHOLD) {
      this.isDragging = true;
      this.phase = "dragging";
      this.retractProgress = 0;
      this.callbacks.onDragStart?.();
      this.splatSegment(this.startClientX, this.startClientY, clientX, clientY, 1.0);
      this.lastClientX = clientX;
      this.lastClientY = clientY;
      return;
    }

    if (this.isDragging && this.phase === "dragging") {
      const segDist = Math.hypot(clientX - this.lastClientX, clientY - this.lastClientY);
      this.movedDistance += segDist;
      if (segDist > 0.5) {
        this.splatSegment(this.lastClientX, this.lastClientY, clientX, clientY, 1.0);
        this.lastClientX = clientX;
        this.lastClientY = clientY;
      }
    }
  }

  public onPointerUp(): void {
    if (!this.pointerDown) return;
    this.pointerDown = false;

    if (this.isDragging) {
      this.suppressClickUntil = performance.now() + 200;
    }
    this.isDragging = false;

    if (this.phase === "dragging") {
      if (this.coverage >= COVERAGE_THRESHOLD) {
        this.startFlood();
      } else {
        this.phase = "retracting";
        this.retractProgress = 0;
        this.callbacks.onCoverageChange?.(this.coverage, this.phase);
      }
    }
  }

  private startFlood(): void {
    if (this.phase === "flooding") return;
    this.phase = "flooding";
    this.floodProgress = 0.02;
    const cx = this.curClientX || this.viewW * 0.5;
    const cy = this.curClientY || this.viewH * 0.5;
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const tx = cx + Math.cos(angle) * 90;
      const ty = cy + Math.sin(angle) * 90;
      this.splatSegment(cx, cy, tx, ty, 1.5);
    }
    this.callbacks.onCoverageChange?.(this.coverage, this.phase);
  }

  public step(dt: number): void {
    if (this.disposed || !this.gl) return;
    if (this.phase === "idle") return;

    const clampedDt = clamp(dt, 0.004, 0.033);

    if (this.phase === "flooding") {
      this.floodProgress = Math.min(1.0, this.floodProgress + clampedDt / 0.52);
      const u = clamp(this.curClientX / Math.max(1, this.viewW), 0.15, 0.85);
      const v = clamp(1.0 - this.curClientY / Math.max(1, this.viewH), 0.15, 0.85);
      this.splatAtUv(u, v, 0, 0, 0.04 + this.floodProgress * 0.18, 1.4);
    } else if (this.phase === "retracting") {
      this.retractProgress = Math.min(1.0, this.retractProgress + clampedDt / 0.92);
    }

    this.stepSimulation(clampedDt);
    this.updateCoverageAndMask();
    this.renderOverlay();

    if (this.phase === "dragging" && this.coverage >= COVERAGE_THRESHOLD) {
      this.startFlood();
    } else if (this.phase === "flooding") {
      this.coverage = Math.max(this.coverage, smoothstep(0, 1, this.floodProgress));
      this.callbacks.onCoverageChange?.(this.coverage, this.phase);
      if (this.floodProgress >= 0.999) {
        this.completeSwap();
      }
    } else if (this.phase === "retracting") {
      this.callbacks.onCoverageChange?.(this.coverage, this.phase);
      if (this.retractProgress >= 0.999 || this.coverage <= 0.0001) {
        this.resetToIdle();
      }
    } else if (this.phase === "dragging") {
      this.callbacks.onCoverageChange?.(this.coverage, this.phase);
    }
  }

  private completeSwap(): void {
    this.pointerDown = false;
    this.isDragging = false;
    this.movedDistance = 0;
    this.suppressClickUntil = performance.now() + 260;
    this.swapCooldownUntil = performance.now() + 320;

    this.clearMaskStyle(this.getTopLayerEl());
    this.clearSimulationFBOs();
    this.coverage = 0;
    this.floodProgress = 0;
    this.retractProgress = 0;
    this.phase = "idle";
    this.clearOverlayCanvas();
    this.callbacks.onSwapComplete?.();
    this.callbacks.onCoverageChange?.(0, "idle");
  }

  public resetToIdle(): void {
    this.pointerDown = false;
    this.isDragging = false;
    this.movedDistance = 0;
    this.clearMaskStyle(this.getTopLayerEl());
    this.clearSimulationFBOs();
    this.coverage = 0;
    this.floodProgress = 0;
    this.retractProgress = 0;
    this.phase = "idle";
    this.clearOverlayCanvas();
    this.callbacks.onCoverageChange?.(0, "idle");
  }

  private clearOverlayCanvas(): void {
    const gl = this.gl;
    if (!gl) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private clearMaskStyle(el: HTMLElement): void {
    el.style.webkitMaskImage = "";
    el.style.maskImage = "";
    el.style.webkitMaskSize = "";
    el.style.maskSize = "";
    el.style.webkitMaskRepeat = "";
    el.style.maskRepeat = "";
  }

  private splatSegment(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    intensityScale = 1.0
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    const stepPx = 3.5;
    const steps = Math.max(1, Math.min(64, Math.ceil(dist / stepPx)));

    const vx = clamp(dx * 3.2, -160, 160);
    const vy = clamp(-dy * 3.2, -160, 160);

    // 80% smaller linear brush size: radius in squared-UV Gaussian space is ~0.00075..0.00115
    const speedFactor = clamp(dist / 45, 0, 1);
    const radius = (0.00075 + speedFactor * 0.00040) * intensityScale;

    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 1 : i / steps;
      const sx = x0 + dx * t;
      const sy = y0 + dy * t;
      const u = sx / Math.max(1, this.viewW);
      const v = 1.0 - sy / Math.max(1, this.viewH);
      this.splatAtUv(u, v, vx, vy, radius, 1.05 * intensityScale);
    }
  }

  private splatAtUv(
    u: number,
    v: number,
    vx: number,
    vy: number,
    radius: number,
    dyeAmount: number
  ): void {
    const gl = this.gl;
    if (!gl) return;

    const aspect = this.viewW / Math.max(1, this.viewH);
    gl.disable(gl.BLEND);

    this.splatProg.bind();
    gl.uniform1i(this.splatProg.uniforms.uTarget, this.velocityFBO.read.attach(0));
    gl.uniform1f(this.splatProg.uniforms.aspectRatio, aspect);
    gl.uniform2f(this.splatProg.uniforms.point, u, v);
    gl.uniform3f(this.splatProg.uniforms.color, vx, vy, 0.0);
    gl.uniform1f(this.splatProg.uniforms.radius, radius);
    gl.uniform1f(this.splatProg.uniforms.uIsDye, 0.0);
    this.blit(this.velocityFBO.write);
    this.velocityFBO.swap();

    gl.uniform1i(this.splatProg.uniforms.uTarget, this.dyeFBO.read.attach(0));
    gl.uniform3f(this.splatProg.uniforms.color, dyeAmount, dyeAmount * 0.92, dyeAmount);
    gl.uniform1f(this.splatProg.uniforms.radius, radius * 1.05);
    gl.uniform1f(this.splatProg.uniforms.uIsDye, 1.0);
    this.blit(this.dyeFBO.write);
    this.dyeFBO.swap();
  }

  private stepSimulation(dt: number): void {
    const gl = this.gl;
    if (!gl) return;

    gl.disable(gl.BLEND);

    // 1. Curl
    this.curlProg.bind();
    gl.uniform2f(
      this.curlProg.uniforms.texelSize,
      this.velocityFBO.texelSizeX,
      this.velocityFBO.texelSizeY
    );
    gl.uniform1i(this.curlProg.uniforms.uVelocity, this.velocityFBO.read.attach(0));
    this.blit(this.curlFBO);

    // 2. Vorticity confinement
    this.vorticityProg.bind();
    gl.uniform2f(
      this.vorticityProg.uniforms.texelSize,
      this.velocityFBO.texelSizeX,
      this.velocityFBO.texelSizeY
    );
    gl.uniform1i(this.vorticityProg.uniforms.uVelocity, this.velocityFBO.read.attach(0));
    gl.uniform1i(this.vorticityProg.uniforms.uCurl, this.curlFBO.attach(1));
    gl.uniform1f(
      this.vorticityProg.uniforms.curl,
      this.phase === "retracting" ? 16.0 : 12.0
    );
    gl.uniform1f(this.vorticityProg.uniforms.dt, dt);
    this.blit(this.velocityFBO.write);
    this.velocityFBO.swap();

    // 3. Divergence
    this.divergenceProg.bind();
    gl.uniform2f(
      this.divergenceProg.uniforms.texelSize,
      this.velocityFBO.texelSizeX,
      this.velocityFBO.texelSizeY
    );
    gl.uniform1i(this.divergenceProg.uniforms.uVelocity, this.velocityFBO.read.attach(0));
    this.blit(this.divergenceFBO);

    // 4. Clear pressure slightly for stability
    this.clearProg.bind();
    gl.uniform2f(
      this.clearProg.uniforms.texelSize,
      this.velocityFBO.texelSizeX,
      this.velocityFBO.texelSizeY
    );
    gl.uniform1i(this.clearProg.uniforms.uTexture, this.pressureFBO.read.attach(0));
    gl.uniform1f(this.clearProg.uniforms.value, 0.80);
    gl.uniform1f(this.clearProg.uniforms.subtractValue, 0.0);
    gl.uniform1f(this.clearProg.uniforms.uDiffuse, 0.0);
    this.blit(this.pressureFBO.write);
    this.pressureFBO.swap();

    // 5. Pressure Jacobi iterations
    this.pressureProg.bind();
    gl.uniform2f(
      this.pressureProg.uniforms.texelSize,
      this.velocityFBO.texelSizeX,
      this.velocityFBO.texelSizeY
    );
    gl.uniform1i(this.pressureProg.uniforms.uDivergence, this.divergenceFBO.attach(0));
    for (let i = 0; i < 14; i++) {
      gl.uniform1i(this.pressureProg.uniforms.uPressure, this.pressureFBO.read.attach(1));
      this.blit(this.pressureFBO.write);
      this.pressureFBO.swap();
    }

    // 6. Subtract pressure gradient from velocity
    this.gradSubtractProg.bind();
    gl.uniform2f(
      this.gradSubtractProg.uniforms.texelSize,
      this.velocityFBO.texelSizeX,
      this.velocityFBO.texelSizeY
    );
    gl.uniform1i(this.gradSubtractProg.uniforms.uPressure, this.pressureFBO.read.attach(0));
    gl.uniform1i(this.gradSubtractProg.uniforms.uVelocity, this.velocityFBO.read.attach(1));
    this.blit(this.velocityFBO.write);
    this.velocityFBO.swap();

    // 7. Advect velocity
    this.advectionProg.bind();
    gl.uniform2f(
      this.advectionProg.uniforms.texelSize,
      this.velocityFBO.texelSizeX,
      this.velocityFBO.texelSizeY
    );
    if (!this.supportLinearFiltering) {
      gl.uniform2f(
        this.advectionProg.uniforms.dyeTexelSize,
        this.velocityFBO.texelSizeX,
        this.velocityFBO.texelSizeY
      );
    }
    const velId = this.velocityFBO.read.attach(0);
    gl.uniform1i(this.advectionProg.uniforms.uVelocity, velId);
    gl.uniform1i(this.advectionProg.uniforms.uSource, velId);
    gl.uniform1f(this.advectionProg.uniforms.dt, dt);
    gl.uniform1f(
      this.advectionProg.uniforms.dissipation,
      this.phase === "retracting" ? 1.4 : 2.2
    );
    this.blit(this.velocityFBO.write);
    this.velocityFBO.swap();

    // 8. Advect dye (mask density field)
    if (!this.supportLinearFiltering) {
      gl.uniform2f(
        this.advectionProg.uniforms.dyeTexelSize,
        this.dyeFBO.texelSizeX,
        this.dyeFBO.texelSizeY
      );
    }
    gl.uniform1i(this.advectionProg.uniforms.uVelocity, this.velocityFBO.read.attach(0));
    gl.uniform1i(this.advectionProg.uniforms.uSource, this.dyeFBO.read.attach(1));
    const dyeDissipation =
      this.phase === "dragging"
        ? 0.0
        : this.phase === "flooding"
          ? 0.0
          : 1.35 + this.retractProgress * 2.2;
    gl.uniform1f(this.advectionProg.uniforms.dissipation, dyeDissipation);
    this.blit(this.dyeFBO.write);
    this.dyeFBO.swap();

    // 9. Smooth surface-tension inward retraction when released before 60%
    if (this.phase === "retracting") {
      this.clearProg.bind();
      gl.uniform2f(
        this.clearProg.uniforms.texelSize,
        this.dyeFBO.texelSizeX * 1.75,
        this.dyeFBO.texelSizeY * 1.75
      );
      gl.uniform1f(this.clearProg.uniforms.value, 0.974 - this.retractProgress * 0.028);
      gl.uniform1f(this.clearProg.uniforms.subtractValue, 0.0040 + this.retractProgress * 0.0095);
      gl.uniform1f(this.clearProg.uniforms.uDiffuse, 0.54);

      for (let pass = 0; pass < 2; pass++) {
        gl.uniform1i(this.clearProg.uniforms.uTexture, this.dyeFBO.read.attach(0));
        this.blit(this.dyeFBO.write);
        this.dyeFBO.swap();
      }
    }
  }

  private updateCoverageAndMask(): void {
    const gl = this.gl;
    if (!gl) return;

    this.coverageProg.bind();
    gl.uniform1i(this.coverageProg.uniforms.uDye, this.dyeFBO.read.attach(0));
    gl.uniform2f(
      this.coverageProg.uniforms.uTexelSize,
      this.dyeFBO.texelSizeX,
      this.dyeFBO.texelSizeY
    );
    gl.uniform1f(
      this.coverageProg.uniforms.uFlood,
      this.phase === "flooding" ? smoothstep(0, 1, this.floodProgress) : 0.0
    );
    gl.uniform1f(
      this.coverageProg.uniforms.uRetract,
      this.phase === "retracting" ? smoothstep(0, 1, this.retractProgress) : 0.0
    );
    const colUv = this.getColumnsUvBounds?.() ?? null;
    if (colUv) {
      gl.uniform4f(this.coverageProg.uniforms.uColBounds, colUv[0], colUv[1], colUv[2], colUv[3]);
    } else {
      gl.uniform4f(this.coverageProg.uniforms.uColBounds, 0.0, 0.0, -1.0, -1.0);
    }
    this.blit(this.coverageFBO);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.coverageFBO.fbo);
    gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, this.coveragePixels);

    let revealedSum = 0;
    let anyVisiblePixels = 0;
    const totalPixels = 64 * 64;
    for (let i = 0; i < totalPixels * 4; i += 4) {
      const val = this.coveragePixels[i];
      const visVal = this.coveragePixels[i + 2];
      if (val > 127) {
        revealedSum++;
      }
      if (visVal > 1) {
        anyVisiblePixels++;
      }
    }
    this.coverage = Math.max(
      revealedSum / totalPixels,
      this.phase === "retracting" && anyVisiblePixels > 0 ? 0.001 : 0
    );

    if (this.cssMaskCtx && this.cssMaskImageData) {
      const data = this.cssMaskImageData.data;
      const mw = this.maskW;
      const mh = this.maskH;
      // Bilinear interpolation of the inset G channel (domMask) so the DOM mask has zero staircase blocks
      for (let y = 0; y < mh; y++) {
        const gy = ((mh - 1 - y) / Math.max(1, mh - 1)) * 63;
        const y0 = Math.min(63, Math.max(0, Math.floor(gy)));
        const y1 = Math.min(63, y0 + 1);
        const fy = gy - y0;
        for (let x = 0; x < mw; x++) {
          const gx = (x / Math.max(1, mw - 1)) * 63;
          const x0 = Math.min(63, Math.max(0, Math.floor(gx)));
          const x1 = Math.min(63, x0 + 1);
          const fx = gx - x0;

          const v00 = this.coveragePixels[(y0 * 64 + x0) * 4 + 1];
          const v10 = this.coveragePixels[(y0 * 64 + x1) * 4 + 1];
          const v01 = this.coveragePixels[(y1 * 64 + x0) * 4 + 1];
          const v11 = this.coveragePixels[(y1 * 64 + x1) * 4 + 1];

          const topVal = v00 + (v10 - v00) * fx;
          const botVal = v01 + (v11 - v01) * fx;
          const revealVal = Math.round(topVal + (botVal - topVal) * fy);

          const dstIdx = (y * mw + x) * 4;
          data[dstIdx] = 0;
          data[dstIdx + 1] = 0;
          data[dstIdx + 2] = 0;
          data[dstIdx + 3] = 255 - revealVal;
        }
      }
      this.cssMaskCtx.putImageData(this.cssMaskImageData, 0, 0);
      const maskUrl = `url("${this.cssMaskCanvas.toDataURL()}")`;
      const topEl = this.getTopLayerEl();
      topEl.style.webkitMaskImage = maskUrl;
      topEl.style.maskImage = maskUrl;
      topEl.style.webkitMaskSize = "100% 100%";
      topEl.style.maskSize = "100% 100%";
      topEl.style.webkitMaskRepeat = "no-repeat";
      topEl.style.maskRepeat = "no-repeat";
    }
  }

  private renderOverlay(): void {
    const gl = this.gl;
    if (!gl) return;

    const bottomCanvas = this.getBottomCanvas();
    if (bottomCanvas && bottomCanvas.width > 0 && bottomCanvas.height > 0 && this.bottomCanvasTex) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.bottomCanvasTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bottomCanvas);
      } catch {
        // Ignore if canvas is momentarily resizing
      }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.disable(gl.BLEND);

    const topCanvas = this.getTopCanvas?.();
    if (topCanvas && topCanvas.width > 0 && topCanvas.height > 0 && this.topCanvasTex) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.topCanvasTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, topCanvas);
      } catch {
        // Ignore if canvas is momentarily resizing
      }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    }

    this.displayProg.bind();
    gl.uniform1i(this.displayProg.uniforms.uDye, this.dyeFBO.read.attach(0));
    gl.uniform1i(this.displayProg.uniforms.uVelocity, this.velocityFBO.read.attach(1));
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.bottomCanvasTex);
    gl.uniform1i(this.displayProg.uniforms.uBottomTex, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.topCanvasTex);
    gl.uniform1i(this.displayProg.uniforms.uTopTex, 3);
    gl.uniform2f(
      this.displayProg.uniforms.uTexelSize,
      this.dyeFBO.texelSizeX,
      this.dyeFBO.texelSizeY
    );
    gl.uniform2f(this.displayProg.uniforms.uResolution, this.viewW, this.viewH);
    gl.uniform1f(
      this.displayProg.uniforms.uFlood,
      this.phase === "flooding" ? smoothstep(0, 1, this.floodProgress) : 0.0
    );
    gl.uniform1f(
      this.displayProg.uniforms.uRetract,
      this.phase === "retracting" ? smoothstep(0, 1, this.retractProgress) : 0.0
    );
    const dispColUv = this.getColumnsUvBounds?.() ?? null;
    if (dispColUv) {
      gl.uniform4f(
        this.displayProg.uniforms.uColBounds,
        dispColUv[0],
        dispColUv[1],
        dispColUv[2],
        dispColUv[3]
      );
    } else {
      gl.uniform4f(this.displayProg.uniforms.uColBounds, 0.0, 0.0, -1.0, -1.0);
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
  }

  private clearSimulationFBOs(): void {
    const gl = this.gl;
    if (!gl) return;

    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    const fbosToClear: (FBO | undefined)[] = [
      this.dyeFBO?.read,
      this.dyeFBO?.write,
      this.velocityFBO?.read,
      this.velocityFBO?.write,
      this.pressureFBO?.read,
      this.pressureFBO?.write,
      this.divergenceFBO,
      this.curlFBO,
      this.coverageFBO,
    ];

    gl.clearColor(0, 0, 0, 0);
    for (const target of fbosToClear) {
      if (!target) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.width, target.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.coveragePixels.fill(0);
  }

  private initWebGL(): void {
    const params: WebGLContextAttributes = {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    };

    let gl = this.overlayCanvas.getContext("webgl2", params) as
      | WebGL2RenderingContext
      | WebGLRenderingContext
      | null;
    const isWebGL2 = !!gl;
    if (!gl) {
      gl = (this.overlayCanvas.getContext("webgl", params) ||
        this.overlayCanvas.getContext("experimental-webgl", params)) as WebGLRenderingContext | null;
    }
    if (!gl) return;

    this.gl = gl;
    this.isWebGL2 = isWebGL2;

    let halfFloatTexType: number = gl.UNSIGNED_BYTE;
    let supportLinearFiltering = false;

    if (isWebGL2) {
      const gl2 = gl as WebGL2RenderingContext;
      const extFloat = gl2.getExtension("EXT_color_buffer_float");
      supportLinearFiltering = !!gl2.getExtension("OES_texture_float_linear");
      if (extFloat) {
        halfFloatTexType = gl2.HALF_FLOAT;
      }
    } else {
      const halfFloat = gl.getExtension("OES_texture_half_float");
      supportLinearFiltering = !!gl.getExtension("OES_texture_half_float_linear");
      if (halfFloat) {
        halfFloatTexType = halfFloat.HALF_FLOAT_OES;
      }
    }

    this.halfFloatTexType = halfFloatTexType;
    this.supportLinearFiltering = supportLinearFiltering;

    if (isWebGL2 && halfFloatTexType !== gl.UNSIGNED_BYTE) {
      const gl2 = gl as WebGL2RenderingContext;
      this.rgbaFormat =
        this.getSupportedFormat(gl2, gl2.RGBA16F, gl2.RGBA, halfFloatTexType) || {
          internalFormat: gl.RGBA,
          format: gl.RGBA,
        };
      this.rgFormat =
        this.getSupportedFormat(gl2, gl2.RG16F, gl2.RG, halfFloatTexType) || this.rgbaFormat;
      this.rFormat =
        this.getSupportedFormat(gl2, gl2.R16F, gl2.RED, halfFloatTexType) || this.rgbaFormat;
      if (this.rgbaFormat.internalFormat === gl.RGBA) {
        this.halfFloatTexType = gl.UNSIGNED_BYTE;
        this.supportLinearFiltering = true;
      }
    } else {
      const fmt = this.getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
      if (!fmt) {
        this.halfFloatTexType = gl.UNSIGNED_BYTE;
        this.supportLinearFiltering = true;
      }
      this.rgbaFormat = { internalFormat: gl.RGBA, format: gl.RGBA };
      this.rgFormat = { internalFormat: gl.RGBA, format: gl.RGBA };
      this.rFormat = { internalFormat: gl.RGBA, format: gl.RGBA };
    }

    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.bottomCanvasTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.bottomCanvasTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      2,
      2,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(16)
    );

    this.topCanvasTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.topCanvasTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      2,
      2,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(16)
    );

    this.compilePrograms();
    this.initFramebuffers();
  }

  private getSupportedFormat(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    internalFormat: number,
    format: number,
    type: number
  ): { internalFormat: number; format: number } | null {
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(texture);

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      return null;
    }
    return { internalFormat, format };
  }

  private compilePrograms(): void {
    const gl = this.gl!;

    const baseVertexShader = this.compileShader(
      gl.VERTEX_SHADER,
      `
      precision highp float;
      attribute vec2 aPosition;
      varying vec2 vUv;
      varying vec2 vL;
      varying vec2 vR;
      varying vec2 vT;
      varying vec2 vB;
      uniform vec2 texelSize;

      void main () {
        vUv = aPosition * 0.5 + 0.5;
        vL = vUv - vec2(texelSize.x, 0.0);
        vR = vUv + vec2(texelSize.x, 0.0);
        vT = vUv + vec2(0.0, texelSize.y);
        vB = vUv - vec2(0.0, texelSize.y);
        gl_Position = vec4(aPosition, 0.0, 1.0);
      }
      `
    );

    const clearShader = this.compileShader(
      gl.FRAGMENT_SHADER,
      `
      precision mediump float;
      precision mediump sampler2D;
      varying highp vec2 vUv;
      varying highp vec2 vL;
      varying highp vec2 vR;
      varying highp vec2 vT;
      varying highp vec2 vB;
      uniform sampler2D uTexture;
      uniform float value;
      uniform float subtractValue;
      uniform float uDiffuse;

      void main () {
        vec4 c = texture2D(uTexture, vUv);
        if (uDiffuse > 0.001) {
          vec4 l = texture2D(uTexture, vL);
          vec4 r = texture2D(uTexture, vR);
          vec4 t = texture2D(uTexture, vT);
          vec4 b = texture2D(uTexture, vB);
          vec4 avg = 0.25 * (l + r + t + b);
          c = mix(c, avg, uDiffuse);
        }
        c *= value;
        c.rgb = max(vec3(0.0), c.rgb - vec3(subtractValue));
        gl_FragColor = c;
      }
      `
    );

    const splatShader = this.compileShader(
      gl.FRAGMENT_SHADER,
      `
      precision highp float;
      precision highp sampler2D;
      varying vec2 vUv;
      uniform sampler2D uTarget;
      uniform float aspectRatio;
      uniform vec3 color;
      uniform vec2 point;
      uniform float radius;
      uniform float uIsDye;

      void main () {
        vec2 p = vUv - point.xy;
        p.x *= aspectRatio;
        float falloff = exp(-dot(p, p) / max(0.000001, radius));
        vec3 splat = falloff * color;
        vec3 base = texture2D(uTarget, vUv).xyz;
        vec3 res = base + splat;
        if (uIsDye > 0.5) {
          res = min(vec3(1.55), res);
        }
        gl_FragColor = vec4(res, 1.0);
      }
      `
    );

    const advectionShader = this.compileShader(
      gl.FRAGMENT_SHADER,
      `
      precision highp float;
      precision highp sampler2D;
      varying vec2 vUv;
      uniform sampler2D uVelocity;
      uniform sampler2D uSource;
      uniform vec2 texelSize;
      uniform vec2 dyeTexelSize;
      uniform float dt;
      uniform float dissipation;

      vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
        vec2 st = uv / tsize - 0.5;
        vec2 iuv = floor(st);
        vec2 fuv = fract(st);
        vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
        vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
        vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
        vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
        return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
      }

      void main () {
        ${
          this.supportLinearFiltering
            ? `
          vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
          vec4 result = texture2D(uSource, coord);
          `
            : `
          vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
          vec4 result = bilerp(uSource, coord, dyeTexelSize);
          `
        }
        float decay = 1.0 + dissipation * dt;
        gl_FragColor = result / decay;
      }
      `
    );

    const divergenceShader = this.compileShader(
      gl.FRAGMENT_SHADER,
      `
      precision mediump float;
      precision mediump sampler2D;
      varying highp vec2 vUv;
      varying highp vec2 vL;
      varying highp vec2 vR;
      varying highp vec2 vT;
      varying highp vec2 vB;
      uniform sampler2D uVelocity;

      void main () {
        float L = texture2D(uVelocity, vL).x;
        float R = texture2D(uVelocity, vR).x;
        float T = texture2D(uVelocity, vT).y;
        float B = texture2D(uVelocity, vB).y;
        vec2 C = texture2D(uVelocity, vUv).xy;
        if (vL.x < 0.0) { L = -C.x; }
        if (vR.x > 1.0) { R = -C.x; }
        if (vT.y > 1.0) { T = -C.y; }
        if (vB.y < 0.0) { B = -C.y; }
        float div = 0.5 * (R - L + T - B);
        gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
      }
      `
    );

    const curlShader = this.compileShader(
      gl.FRAGMENT_SHADER,
      `
      precision mediump float;
      precision mediump sampler2D;
      varying highp vec2 vUv;
      varying highp vec2 vL;
      varying highp vec2 vR;
      varying highp vec2 vT;
      varying highp vec2 vB;
      uniform sampler2D uVelocity;

      void main () {
        float L = texture2D(uVelocity, vL).y;
        float R = texture2D(uVelocity, vR).y;
        float T = texture2D(uVelocity, vT).x;
        float B = texture2D(uVelocity, vB).x;
        float vorticity = R - L - T + B;
        gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
      }
      `
    );

    const vorticityShader = this.compileShader(
      gl.FRAGMENT_SHADER,
      `
      precision highp float;
      precision highp sampler2D;
      varying vec2 vUv;
      varying vec2 vL;
      varying vec2 vR;
      varying vec2 vT;
      varying vec2 vB;
      uniform sampler2D uVelocity;
      uniform sampler2D uCurl;
      uniform float curl;
      uniform float dt;

      void main () {
        float L = texture2D(uCurl, vL).x;
        float R = texture2D(uCurl, vR).x;
        float T = texture2D(uCurl, vT).x;
        float B = texture2D(uCurl, vB).x;
        float C = texture2D(uCurl, vUv).x;
        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 0.0001;
        force *= curl * C;
        force.y *= -1.0;
        vec2 velocity = texture2D(uVelocity, vUv).xy;
        velocity += force * dt;
        velocity = min(max(velocity, -300.0), 300.0);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
      }
      `
    );

    const pressureShader = this.compileShader(
      gl.FRAGMENT_SHADER,
      `
      precision mediump float;
      precision mediump sampler2D;
      varying highp vec2 vUv;
      varying highp vec2 vL;
      varying highp vec2 vR;
      varying highp vec2 vT;
      varying highp vec2 vB;
      uniform sampler2D uPressure;
      uniform sampler2D uDivergence;

      void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        float divergence = texture2D(uDivergence, vUv).x;
        float pressure = (L + R + B + T - divergence) * 0.25;
        gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
      }
      `
    );

    const gradSubtractShader = this.compileShader(
      gl.FRAGMENT_SHADER,
      `
      precision mediump float;
      precision mediump sampler2D;
      varying highp vec2 vUv;
      varying highp vec2 vL;
      varying highp vec2 vR;
      varying highp vec2 vT;
      varying highp vec2 vB;
      uniform sampler2D uPressure;
      uniform sampler2D uVelocity;

      void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        vec2 velocity = texture2D(uVelocity, vUv).xy;
        velocity.xy -= vec2(R - L, T - B);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
      }
      `
    );

    const coverageShader = this.compileShader(
      gl.FRAGMENT_SHADER,
      `
      precision highp float;
      precision highp sampler2D;
      varying vec2 vUv;
      uniform sampler2D uDye;
      uniform vec2 uTexelSize;
      uniform float uFlood;
      uniform float uRetract;
      uniform vec4 uColBounds;

      float sampleField(vec2 uv) {
        float c = texture2D(uDye, uv).r;
        float l = texture2D(uDye, uv - vec2(uTexelSize.x, 0.0)).r;
        float r = texture2D(uDye, uv + vec2(uTexelSize.x, 0.0)).r;
        float t = texture2D(uDye, uv + vec2(0.0, uTexelSize.y)).r;
        float b = texture2D(uDye, uv - vec2(0.0, uTexelSize.y)).r;
        return (c * 2.0 + l + r + t + b) / 6.0;
      }

      void main () {
        float d = sampleField(vUv) * (1.0 - uRetract * 0.92);
        float thresh = mix(0.42, -0.05, uFlood);
        // R channel: accurate coverage metric at thresh
        float cov = smoothstep(thresh - 0.04, thresh + 0.04, d + uFlood * 1.15);
        bool inCols = (uColBounds.z > uColBounds.x) &&
                      (vUv.x >= uColBounds.x && vUv.x <= uColBounds.z) &&
                      (vUv.y >= uColBounds.y && vUv.y <= uColBounds.w);
        // Over HTML accordion columns, align the DOM mask right at the meniscus edge (thresh - 0.03..thresh + 0.06);
        // over the canvas pond/portrait, keep it tucked inside the opaque WebGL bridge (thresh + 0.07..0.22).
        float domLo = inCols ? (thresh - 0.03) : (thresh + 0.07);
        float domHi = inCols ? (thresh + 0.06) : (thresh + 0.22);
        float domMask = smoothstep(domLo, domHi, d + uFlood * 1.15) * (1.0 - smoothstep(0.55, 0.88, uRetract));
        // B channel: full visible fluid envelope (including outer refractive lens & rim) so retraction never snaps off early
        float vis = smoothstep(thresh - 0.24, thresh - 0.04, d) * (1.0 - smoothstep(0.92, 1.0, uRetract));
        gl_FragColor = vec4(cov, domMask, vis, 1.0);
      }
      `
    );

    const displayShader = this.compileShader(
      gl.FRAGMENT_SHADER,
      `
      precision highp float;
      precision highp sampler2D;
      varying vec2 vUv;
      uniform sampler2D uDye;
      uniform sampler2D uVelocity;
      uniform sampler2D uBottomTex;
      uniform sampler2D uTopTex;
      uniform vec2 uTexelSize;
      uniform vec2 uResolution;
      uniform float uFlood;
      uniform float uRetract;
      uniform vec4 uColBounds;

      float sampleSmoothDye(vec2 uv) {
        vec2 tx1 = uTexelSize * 1.05;
        vec2 tx2 = uTexelSize * 2.15;
        float c  = texture2D(uDye, uv).r * 6.0;
        float l1 = texture2D(uDye, uv - vec2(tx1.x, 0.0)).r * 3.0;
        float r1 = texture2D(uDye, uv + vec2(tx1.x, 0.0)).r * 3.0;
        float t1 = texture2D(uDye, uv + vec2(0.0, tx1.y)).r * 3.0;
        float b1 = texture2D(uDye, uv - vec2(0.0, tx1.y)).r * 3.0;
        float tl = texture2D(uDye, uv + vec2(-tx1.x, tx1.y)).r * 1.5;
        float tr = texture2D(uDye, uv + vec2(tx1.x, tx1.y)).r * 1.5;
        float bl = texture2D(uDye, uv + vec2(-tx1.x, -tx1.y)).r * 1.5;
        float br = texture2D(uDye, uv + vec2(tx1.x, -tx1.y)).r * 1.5;
        float l2 = texture2D(uDye, uv - vec2(tx2.x, 0.0)).r;
        float r2 = texture2D(uDye, uv + vec2(tx2.x, 0.0)).r;
        float t2 = texture2D(uDye, uv + vec2(0.0, tx2.y)).r;
        float b2 = texture2D(uDye, uv - vec2(0.0, tx2.y)).r;
        return (c + l1 + r1 + t1 + b1 + tl + tr + bl + br + l2 + r2 + t2 + b2) / 28.0;
      }

      void main () {
        float retractScale = 1.0 - uRetract * 0.92;
        float dCenter = sampleSmoothDye(vUv) * retractScale + uFlood * 1.15;
        float thresh = mix(0.42, -0.05, uFlood);

        // Wide outer refractive swell zone so live top-layer pixels visibly bend and magnify along the liquid meniscus
        float outerLensMask = smoothstep(thresh - 0.24, thresh - 0.08, dCenter);
        if (outerLensMask <= 0.001) {
          gl_FragColor = vec4(0.0);
          return;
        }

        vec2 stepUv = uTexelSize * 2.0;
        float dL = sampleSmoothDye(vUv - vec2(stepUv.x, 0.0)) * retractScale + uFlood * 1.15;
        float dR = sampleSmoothDye(vUv + vec2(stepUv.x, 0.0)) * retractScale + uFlood * 1.15;
        float dB = sampleSmoothDye(vUv - vec2(0.0, stepUv.y)) * retractScale + uFlood * 1.15;
        float dT = sampleSmoothDye(vUv + vec2(0.0, stepUv.y)) * retractScale + uFlood * 1.15;

        vec2 grad = vec2(dR - dL, dT - dB);

        float innerMask = smoothstep(thresh + 0.03, thresh + 0.26, dCenter);
        float rimBand = clamp(outerLensMask - innerMask, 0.0, 1.0);
        float edgeProfile = sin(clamp((dCenter - (thresh - 0.18)) / 0.40, 0.0, 1.0) * 3.14159265);

        // Smooth fade envelope for the outer liquid material once the inner window closes during retraction
        float tailFade = smoothstep(thresh - 0.24, thresh + 0.02, dCenter) * (1.0 - smoothstep(0.65, 1.0, uRetract));

        vec3 normal = normalize(vec3(-grad * 6.4, 1.0));
        vec3 viewDir = vec3(0.0, 0.0, 1.0);

        vec3 lightDir1 = normalize(vec3(-0.45, 0.58, 0.68));
        vec3 lightDir2 = normalize(vec3(0.52, -0.42, 0.74));
        vec3 half1 = normalize(lightDir1 + viewDir);
        vec3 half2 = normalize(lightDir2 + viewDir);

        float slope = smoothstep(0.012, 0.095, length(grad));
        float spec1 = pow(max(0.0, dot(normal, half1)), 48.0) * slope;
        float spec2 = pow(max(0.0, dot(normal, half2)), 24.0) * slope;
        float fresnel = pow(1.0 - max(0.0, normal.z), 2.2) * slope;

        vec2 vel = texture2D(uVelocity, vUv).xy * 0.000055 * (1.0 - uRetract * 0.75);
        vec2 refractOffset = (normal.xy * (0.022 * edgeProfile + 0.004 * innerMask) + vel) * tailFade;

        vec3 bottomRefractCol;
        bottomRefractCol.r = texture2D(uBottomTex, clamp(vUv + refractOffset * 1.16, 0.001, 0.999)).r;
        bottomRefractCol.g = texture2D(uBottomTex, clamp(vUv + refractOffset * 1.00, 0.001, 0.999)).g;
        bottomRefractCol.b = texture2D(uBottomTex, clamp(vUv + refractOffset * 0.86, 0.001, 0.999)).b;

        // Live pixel refraction of the top portfolio canvas
        vec2 topRefractOffset = (-normal.xy * (0.068 * edgeProfile) + vel * 1.85) * tailFade;
        vec3 topRefractCol;
        topRefractCol.r = texture2D(uTopTex, clamp(vUv + topRefractOffset * 1.15, 0.001, 0.999)).r;
        topRefractCol.g = texture2D(uTopTex, clamp(vUv + topRefractOffset * 1.00, 0.001, 0.999)).g;
        topRefractCol.b = texture2D(uTopTex, clamp(vUv + topRefractOffset * 0.86, 0.001, 0.999)).b;

        // Anti-aliased native-resolution meniscus transition between topRefractCol and bottomRefractCol
        float revealBlend = smoothstep(thresh - 0.045, thresh + 0.045, dCenter) * (1.0 - smoothstep(0.58, 0.90, uRetract));
        vec3 refractedCol = mix(topRefractCol, bottomRefractCol, revealBlend);

        vec3 rimTint = mix(
          vec3(1.0, 0.42, 0.12),
          vec3(1.0, 0.88, 0.58),
          clamp(normal.x * 0.5 + 0.5, 0.0, 1.0)
        );
        vec3 specularHighlight = vec3(1.0, 0.98, 0.94) * (spec1 * 1.35 + spec2 * 0.55) * edgeProfile;

        float velSheen = clamp(length(vel) * 14.0, 0.0, 0.28) * innerMask;
        float rimStrength = mix(tailFade, 1.0, innerMask);
        vec3 finalRgb = refractedCol + (rimTint * (fresnel * 0.85) + specularHighlight * 0.85) * rimStrength;

        bool inCols = (uColBounds.z > uColBounds.x) &&
                      (vUv.x >= uColBounds.x && vUv.x <= uColBounds.z) &&
                      (vUv.y >= uColBounds.y && vUv.y <= uColBounds.w);

        if (inCols) {
          // Over HTML accordion columns (default closed or expanded): render a crystal-clear 3D specular/fresnel
          // liquid meniscus rim so the top and bottom DOM columns show cleanly without pond-canvas bleed-through!
          vec3 colRimRgb = rimTint * 0.68 + specularHighlight * 1.15;
          float colRimAlpha = clamp(
            (edgeProfile * 0.58 + (spec1 * 1.35 + spec2 * 0.65) + fresnel * 0.75) *
              outerLensMask *
              (1.0 - innerMask * 0.86),
            0.0,
            0.86
          );
          float colOutAlpha = colRimAlpha * (1.0 - uFlood * 0.85) * (1.0 - smoothstep(0.88, 1.0, uRetract));
          gl_FragColor = vec4(colRimRgb, colOutAlpha);
          return;
        }

        // Seamless 100%-opaque native-resolution bridge across the meniscus and inset DOM-mask zone,
        // and graceful continuous fade-to-zero as the liquid retracts
        float innerHandoff = 1.0 - smoothstep(thresh + 0.24, thresh + 0.38, dCenter) * (1.0 - velSheen);
        float bridgeAlpha = outerLensMask * innerHandoff;
        float rimGlowAlpha = edgeProfile * 0.96 + rimBand * 0.78 + (spec1 + spec2 * 0.5) * 0.9 + velSheen;
        float rawAlpha = clamp(max(bridgeAlpha, rimGlowAlpha * outerLensMask), 0.0, 1.0);
        float overlayAlpha = rawAlpha * mix(tailFade, 1.0, revealBlend) * (1.0 - uFlood * 0.85) * (1.0 - smoothstep(0.88, 1.0, uRetract));

        gl_FragColor = vec4(finalRgb, overlayAlpha);
      }
      `
    );

    this.clearProg = this.createProgram(baseVertexShader, clearShader);
    this.splatProg = this.createProgram(baseVertexShader, splatShader);
    this.advectionProg = this.createProgram(baseVertexShader, advectionShader);
    this.divergenceProg = this.createProgram(baseVertexShader, divergenceShader);
    this.curlProg = this.createProgram(baseVertexShader, curlShader);
    this.vorticityProg = this.createProgram(baseVertexShader, vorticityShader);
    this.pressureProg = this.createProgram(baseVertexShader, pressureShader);
    this.gradSubtractProg = this.createProgram(baseVertexShader, gradSubtractShader);
    this.coverageProg = this.createProgram(baseVertexShader, coverageShader);
    this.displayProg = this.createProgram(baseVertexShader, displayShader);
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl!;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  }

  private createProgram(vertexShader: WebGLShader, fragmentShader: WebGLShader): GLProgram {
    const gl = this.gl!;
    const program = gl.createProgram()!;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.bindAttribLocation(program, 0, "aPosition");
    gl.linkProgram(program);

    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < uniformCount; i++) {
      const info = gl.getActiveUniform(program, i);
      if (info) {
        uniforms[info.name] = gl.getUniformLocation(program, info.name);
      }
    }

    return {
      program,
      uniforms,
      bind() {
        gl.useProgram(program);
      },
    };
  }

  private getResolution(resolution: number): { width: number; height: number } {
    const aspect = this.viewW / Math.max(1, this.viewH);
    if (aspect > 1) {
      return {
        width: Math.round(resolution * aspect),
        height: resolution,
      };
    }
    return {
      width: resolution,
      height: Math.round(resolution / Math.max(0.1, aspect)),
    };
  }

  private initFramebuffers(): void {
    const gl = this.gl;
    if (!gl) return;

    const simRes = this.getResolution(192);
    const dyeRes = this.getResolution(384);

    const texType = this.halfFloatTexType;
    const rgba = this.rgbaFormat;
    const rg = this.rgFormat;
    const r = this.rFormat;
    const filtering = this.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    if (!this.dyeFBO) {
      this.dyeFBO = this.createDoubleFBO(
        dyeRes.width,
        dyeRes.height,
        rgba.internalFormat,
        rgba.format,
        texType,
        filtering
      );
    } else {
      this.dyeFBO = this.resizeDoubleFBO(
        this.dyeFBO,
        dyeRes.width,
        dyeRes.height,
        rgba.internalFormat,
        rgba.format,
        texType,
        filtering
      );
    }

    if (!this.velocityFBO) {
      this.velocityFBO = this.createDoubleFBO(
        simRes.width,
        simRes.height,
        rg.internalFormat,
        rg.format,
        texType,
        filtering
      );
    } else {
      this.velocityFBO = this.resizeDoubleFBO(
        this.velocityFBO,
        simRes.width,
        simRes.height,
        rg.internalFormat,
        rg.format,
        texType,
        filtering
      );
    }

    this.divergenceFBO = this.createFBO(
      simRes.width,
      simRes.height,
      r.internalFormat,
      r.format,
      texType,
      gl.NEAREST
    );
    this.curlFBO = this.createFBO(
      simRes.width,
      simRes.height,
      r.internalFormat,
      r.format,
      texType,
      gl.NEAREST
    );
    this.pressureFBO = this.createDoubleFBO(
      simRes.width,
      simRes.height,
      r.internalFormat,
      r.format,
      texType,
      gl.NEAREST
    );
    this.coverageFBO = this.createFBO(64, 64, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
  }

  private createFBO(
    w: number,
    h: number,
    internalFormat: number,
    format: number,
    type: number,
    param: number
  ): FBO {
    const gl = this.gl!;
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return {
      texture,
      fbo,
      width: w,
      height: h,
      attach(id: number) {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      },
    };
  }

  private createDoubleFBO(
    w: number,
    h: number,
    internalFormat: number,
    format: number,
    type: number,
    param: number
  ): DoubleFBO {
    let fbo1 = this.createFBO(w, h, internalFormat, format, type, param);
    let fbo2 = this.createFBO(w, h, internalFormat, format, type, param);

    return {
      width: w,
      height: h,
      texelSizeX: 1.0 / w,
      texelSizeY: 1.0 / h,
      get read() {
        return fbo1;
      },
      set read(value) {
        fbo1 = value;
      },
      get write() {
        return fbo2;
      },
      set write(value) {
        fbo2 = value;
      },
      swap() {
        const temp = fbo1;
        fbo1 = fbo2;
        fbo2 = temp;
      },
    };
  }

  private resizeDoubleFBO(
    target: DoubleFBO,
    w: number,
    h: number,
    internalFormat: number,
    format: number,
    type: number,
    param: number
  ): DoubleFBO {
    if (target.width === w && target.height === h) return target;
    target.read = this.createFBO(w, h, internalFormat, format, type, param);
    target.write = this.createFBO(w, h, internalFormat, format, type, param);
    target.width = w;
    target.height = h;
    target.texelSizeX = 1.0 / w;
    target.texelSizeY = 1.0 / h;
    return target;
  }

  private blit(destination: FBO | null): void {
    const gl = this.gl!;
    if (destination == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, destination.width, destination.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, destination.fbo);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  public destroy(): void {
    this.disposed = true;
    this.clearMaskStyle(this.getTopLayerEl());
  }
}
