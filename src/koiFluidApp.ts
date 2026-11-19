import { FluidMaskEngine } from "./fluidMaskEngine";
import { KoiPondEngine } from "./koi/engine";
import type { PortfolioLayerId, SharedPortfolioState } from "./sharedState";

const KOI_FLUID_STYLE_ID = "koi-fluid-ink-style-styles";

// Locked-in user defaults:
// - Mokkotsu (Default) KOI Sim Contrast: 1.20
// - Sumi-e (Ink) KOI Sim Contrast: 1.00
// - Btn Corner Rounding: 16%
// - Btn Size: 59px
// - Btn Shadow Size: 14px
// - Btn Shadow Opacity: 0.67
const DEFAULT_MOKKOTSU_CONTRAST = 1.2;
const DEFAULT_SUMIE_CONTRAST = 1.0;
const DEFAULT_BTN_RADIUS_PCT = 16;
const DEFAULT_BTN_SIZE_PX = 59;
const DEFAULT_BTN_SHADOW_SIZE_PX = 14;
const DEFAULT_BTN_SHADOW_OPACITY = 0.67;

export class KoiFluidApp {
  private stageEl: HTMLElement;
  private mokkotsuLayerEl: HTMLElement;
  private sumieLayerEl: HTMLElement;
  private mokkotsuCanvas: HTMLCanvasElement;
  private sumieCanvas: HTMLCanvasElement;
  private fluidCanvas: HTMLCanvasElement;
  private idleCurtainEl: HTMLElement | null = null;
  private idleCurtainTimer: number | null = null;
  private hasUserDragged = false;

  private mokkotsuEngine: KoiPondEngine;
  private sumieEngine: KoiPondEngine;
  public fluidMask: FluidMaskEngine;

  private activeStyle: PortfolioLayerId = "mokkotsu";
  private menuBlurPx = 8.0;
  private raf = 0;
  private disposed = false;

  constructor(container: HTMLElement = document.body) {
    this.injectStyles();

    this.stageEl = document.createElement("div");
    this.stageEl.id = "layer-koi";
    this.stageEl.addEventListener("dragstart", (e) => e.preventDefault());

    // Layer 1: Mokkotsu Watercolor (Initially on top: z-index 20)
    this.mokkotsuLayerEl = document.createElement("div");
    this.mokkotsuLayerEl.id = "layer-koi-mokkotsu";
    this.mokkotsuLayerEl.className = "dp-portfolio-layer dp-layer-top";
    this.mokkotsuCanvas = document.createElement("canvas");
    this.mokkotsuCanvas.id = "canvas-koi";
    this.mokkotsuCanvas.className = "dp-engine-canvas";
    this.mokkotsuLayerEl.appendChild(this.mokkotsuCanvas);

    // Layer 2: Sumi-e Zen Ink Wash (Initially underneath: z-index 10)
    this.sumieLayerEl = document.createElement("div");
    this.sumieLayerEl.id = "layer-koi-sumie";
    this.sumieLayerEl.className = "dp-portfolio-layer dp-layer-bottom";
    this.sumieCanvas = document.createElement("canvas");
    this.sumieCanvas.id = "canvas-koi-sumie";
    this.sumieCanvas.className = "dp-engine-canvas";
    this.sumieLayerEl.appendChild(this.sumieCanvas);

    // WebGL Fluid Meniscus & Refraction Overlay Canvas (z-index 30, pointer-events: none)
    this.fluidCanvas = document.createElement("canvas");
    this.fluidCanvas.id = "fluid-overlay-canvas";

    this.stageEl.appendChild(this.sumieLayerEl);
    this.stageEl.appendChild(this.mokkotsuLayerEl);
    this.stageEl.appendChild(this.fluidCanvas);
    container.appendChild(this.stageEl);

    this.applyDefaultVars();

    // Instantiate Mokkotsu engine and share its PondWorld with Sumi-e engine so every koi,
    // ripple, and food pellet is 100% pixel-aligned across both ink styles
    this.mokkotsuEngine = new KoiPondEngine(
      this.mokkotsuCanvas,
      undefined,
      undefined,
      undefined,
      "mokkotsu"
    );
    this.sumieEngine = new KoiPondEngine(
      this.sumieCanvas,
      undefined,
      undefined,
      this.mokkotsuEngine.getWorld(),
      "sumie"
    );

    this.mokkotsuEngine.setMenuBlurPx(this.menuBlurPx);
    this.sumieEngine.setMenuBlurPx(this.menuBlurPx);

    this.mokkotsuEngine.setActiveLayer(true);
    this.sumieEngine.setActiveLayer(false);
    this.sumieEngine.applySyncedState(this.mokkotsuEngine.getState());
    this.sumieEngine.syncVisualStateFrom(this.mokkotsuEngine);
    this.sumieEngine.setPaused(true);

    // Wire bidirectional state synchronization (Theme, System Time, Flashlight, Menu Open/Close, Expanded Column, Project Topic, Blur)
    this.mokkotsuEngine.onStateChange = (state: SharedPortfolioState) => {
      this.sumieEngine.applySyncedState(state);
    };
    this.sumieEngine.onStateChange = (state: SharedPortfolioState) => {
      this.mokkotsuEngine.applySyncedState(state);
    };

    // Wire 100% synchronous lockstep rendering of the bottom engine & WebGL fluid inside the active engine's frame
    this.mokkotsuEngine.onAfterActiveRender = (dt: number) => {
      this.onActiveEngineRendered(dt);
    };
    this.sumieEngine.onAfterActiveRender = (dt: number) => {
      this.onActiveEngineRendered(dt);
    };

    // Instantiate WebGL Fluid & Dynamic Layer Masking Engine to switch ink styles
    this.fluidMask = new FluidMaskEngine(
      this.fluidCanvas,
      () => this.getTopLayerEl(),
      () => this.getBottomCanvas(),
      {
        onSwapComplete: () => {
          this.swapInkStyleLayers();
        },
        onDragStart: () => {
          this.handleUserDragDetected();
        },
      },
      () => (this.activeStyle === "mokkotsu" ? this.mokkotsuCanvas : this.sumieCanvas),
      () => this.getActiveEngine().getColumnsUvBounds()
    );

    window.addEventListener("pointerdown", this.onPointerDownCapture, { capture: true });
    window.addEventListener("pointermove", this.onPointerMoveCapture, {
      capture: true,
      passive: true,
    });
    window.addEventListener("pointerup", this.onPointerUpCapture, { capture: true });
    window.addEventListener("pointercancel", this.onPointerUpCapture, { capture: true });
    window.addEventListener("blur", this.onWindowBlur);
    window.addEventListener("click", this.onClickCapture, { capture: true });
    window.addEventListener("resize", this.onResize);

    // Track viewer's first 10 seconds; if no click-drag occurs, reveal the golden curtain cue
    this.startIdleDragCurtainTimer();
  }

  private startIdleDragCurtainTimer(): void {
    if (this.hasUserDragged || this.disposed) return;
    if (this.idleCurtainTimer !== null) {
      window.clearTimeout(this.idleCurtainTimer);
    }
    this.idleCurtainTimer = window.setTimeout(() => {
      this.idleCurtainTimer = null;
      if (!this.hasUserDragged && !this.disposed) {
        this.showIdleDragCurtain();
      }
    }, 10000);
  }

  private showIdleDragCurtain(): void {
    if (this.idleCurtainEl || this.hasUserDragged || this.disposed) return;

    const curtain = document.createElement("div");
    curtain.id = "idle-drag-curtain";
    curtain.setAttribute("aria-live", "polite");
    curtain.innerHTML = `
      <div class="idc-gold-veil idc-gold-veil--base"></div>
      <div class="idc-gold-veil idc-gold-veil--shimmer"></div>
      <div class="idc-prompt" role="status">
        <span class="idc-arrow idc-arrow--left" aria-hidden="true">←</span>
        <span class="idc-label">Click drag on screen</span>
        <span class="idc-arrow idc-arrow--right" aria-hidden="true">→</span>
      </div>
    `;
    this.stageEl.appendChild(curtain);
    this.idleCurtainEl = curtain;

    // Trigger smooth CSS fade-in on next frame
    requestAnimationFrame(() => {
      if (this.idleCurtainEl === curtain && !this.hasUserDragged) {
        curtain.classList.add("idc-visible");
      }
    });
  }

  private handleUserDragDetected(): void {
    if (this.hasUserDragged) return;
    this.hasUserDragged = true;

    if (this.idleCurtainTimer !== null) {
      window.clearTimeout(this.idleCurtainTimer);
      this.idleCurtainTimer = null;
    }

    const curtain = this.idleCurtainEl;
    if (curtain) {
      curtain.classList.remove("idc-visible");
      curtain.classList.add("idc-dismissed");
      this.idleCurtainEl = null;
      window.setTimeout(() => {
        curtain.remove();
      }, 720);
    }
  }

  public setMenuBlurPx(px: number): void {
    const clamped = Math.max(0, Math.min(60, px));
    this.menuBlurPx = clamped;
    this.mokkotsuEngine.setMenuBlurPx(clamped);
    this.sumieEngine.setMenuBlurPx(clamped);
  }

  public getMenuBlurPx(): number {
    return this.menuBlurPx;
  }

  public getActiveStyle(): PortfolioLayerId {
    return this.activeStyle;
  }

  public getActiveEngine(): KoiPondEngine {
    return this.activeStyle === "mokkotsu" ? this.mokkotsuEngine : this.sumieEngine;
  }

  public getMokkotsuEngine(): KoiPondEngine {
    return this.mokkotsuEngine;
  }

  public getSumieEngine(): KoiPondEngine {
    return this.sumieEngine;
  }

  private getTopLayerEl(): HTMLElement {
    return this.activeStyle === "mokkotsu" ? this.mokkotsuLayerEl : this.sumieLayerEl;
  }

  private getBottomCanvas(): HTMLCanvasElement {
    return this.activeStyle === "mokkotsu" ? this.sumieCanvas : this.mokkotsuCanvas;
  }

  private applyDefaultVars(): void {
    this.stageEl.style.setProperty(
      "--koi-mokkotsu-contrast",
      DEFAULT_MOKKOTSU_CONTRAST.toFixed(2)
    );
    this.stageEl.style.setProperty(
      "--koi-sumie-contrast",
      DEFAULT_SUMIE_CONTRAST.toFixed(2)
    );
    this.stageEl.style.setProperty(
      "--koi-fluid-contrast",
      (this.activeStyle === "mokkotsu"
        ? DEFAULT_MOKKOTSU_CONTRAST
        : DEFAULT_SUMIE_CONTRAST
      ).toFixed(2)
    );
    this.stageEl.style.setProperty("--ctrl-btn-radius", `${DEFAULT_BTN_RADIUS_PCT}%`);
    this.stageEl.style.setProperty("--ctrl-btn-size", `${DEFAULT_BTN_SIZE_PX}px`);
    this.stageEl.style.setProperty(
      "--ctrl-btn-shadow-size",
      `${DEFAULT_BTN_SHADOW_SIZE_PX}px`
    );
    this.stageEl.style.setProperty(
      "--ctrl-btn-shadow-opacity",
      DEFAULT_BTN_SHADOW_OPACITY.toFixed(2)
    );
  }

  private swapInkStyleLayers(): void {
    const prevTop = this.getActiveEngine();
    this.activeStyle = this.activeStyle === "mokkotsu" ? "sumie" : "mokkotsu";
    const isMokkotsuTop = this.activeStyle === "mokkotsu";
    const nextTop = this.getActiveEngine();

    nextTop.syncVisualStateFrom(prevTop);

    // Keep fluid overlay contrast synced with the active ink mode (1.20 in Mokkotsu, 1.00 in Sumi-e)
    this.stageEl.style.setProperty(
      "--koi-fluid-contrast",
      (isMokkotsuTop ? DEFAULT_MOKKOTSU_CONTRAST : DEFAULT_SUMIE_CONTRAST).toFixed(2)
    );

    this.mokkotsuLayerEl.classList.toggle("dp-layer-top", isMokkotsuTop);
    this.mokkotsuLayerEl.classList.toggle("dp-layer-bottom", !isMokkotsuTop);
    this.sumieLayerEl.classList.toggle("dp-layer-top", !isMokkotsuTop);
    this.sumieLayerEl.classList.toggle("dp-layer-bottom", isMokkotsuTop);

    for (const el of [this.mokkotsuLayerEl, this.sumieLayerEl]) {
      el.style.webkitMaskImage = "";
      el.style.maskImage = "";
      el.style.webkitMaskSize = "";
      el.style.maskSize = "";
      el.style.webkitMaskRepeat = "";
      el.style.maskRepeat = "";
    }

    this.mokkotsuEngine.setActiveLayer(isMokkotsuTop);
    this.sumieEngine.setActiveLayer(!isMokkotsuTop);

    this.mokkotsuEngine.setPaused(!isMokkotsuTop);
    this.sumieEngine.setPaused(isMokkotsuTop);
  }

  private onActiveEngineRendered(dt: number): void {
    if (this.disposed) return;
    if (this.fluidMask.getPhase() === "idle" && !this.fluidMask.isPointerDown()) {
      return;
    }
    const topEng = this.getActiveEngine();
    const botEng = this.activeStyle === "mokkotsu" ? this.sumieEngine : this.mokkotsuEngine;
    // Show that layer's painting on the revealed layer underneath
    botEng.setPortraitPhotoRevealed(false, true);
    botEng.syncVisualStateFrom(topEng);
    botEng.renderFrame();
    this.fluidMask.step(dt);
  }

  /**
   * Simple rule: dragging overrides clicking everywhere (including over closed or expanded
   * accordion columns and the portrait frame). Only the top-right floating control buttons
   * bypass WebGL fluid capture.
   */
  private onPointerDownCapture = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;

    const targetEl = e.target instanceof Element ? e.target : null;
    if (targetEl && targetEl.closest(".ms-floating-controls")) {
      return;
    }

    const topEng = this.getActiveEngine();
    const botEng = this.activeStyle === "mokkotsu" ? this.sumieEngine : this.mokkotsuEngine;
    botEng.setPortraitPhotoRevealed(false, true);
    botEng.syncVisualStateFrom(topEng);
    botEng.renderFrame();

    this.fluidMask.onPointerDown(e.clientX, e.clientY);
  };

  private onPointerMoveCapture = (e: PointerEvent) => {
    this.fluidMask.onPointerMove(e.clientX, e.clientY);
  };

  private onPointerUpCapture = () => {
    this.fluidMask.onPointerUp();
  };

  private onWindowBlur = () => {
    this.fluidMask.onPointerUp();
  };

  private onClickCapture = (e: MouseEvent) => {
    if (this.fluidMask.shouldSuppressClick()) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  };

  private onResize = () => {
    this.fluidMask.resize();
  };

  private injectStyles(): void {
    if (document.getElementById(KOI_FLUID_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = KOI_FLUID_STYLE_ID;
    style.textContent = `
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #0b0a09;
        overscroll-behavior: none;
        cursor: default;
      }

      #layer-koi {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        overflow: hidden;
        user-select: none;
        -webkit-user-select: none;
      }

      .dp-portfolio-layer {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        will-change: mask-image, -webkit-mask-image;
      }

      .dp-layer-top {
        z-index: 20;
        pointer-events: auto;
      }

      .dp-layer-bottom {
        z-index: 10;
        pointer-events: none;
      }

      .dp-engine-canvas {
        display: block;
        width: 100%;
        height: 100%;
        font-family: "JetBrains Mono", "Fira Code", "SF Mono", "Cascadia Mono", ui-monospace, monospace;
      }

      /* Mokkotsu (Default) locked at 1.20 contrast; Sumi-e (Ink) locked at 1.00 contrast */
      #canvas-koi {
        filter: contrast(var(--koi-mokkotsu-contrast, 1.20));
      }

      #canvas-koi-sumie {
        filter: contrast(var(--koi-sumie-contrast, 1.00));
      }

      #fluid-overlay-canvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        z-index: 30;
        pointer-events: none;
        display: block;
        filter: contrast(var(--koi-fluid-contrast, 1.20));
      }

      /* 10-second idle non-uniform translucent golden curtain & drag cue */
      #idle-drag-curtain {
        position: absolute;
        inset: 0;
        z-index: 40;
        pointer-events: none;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity 950ms cubic-bezier(0.22, 1, 0.36, 1);
        overflow: hidden;
      }

      #idle-drag-curtain.idc-visible {
        opacity: 1;
      }

      #idle-drag-curtain.idc-dismissed {
        opacity: 0;
        transition: opacity 600ms ease-out;
      }

      .idc-gold-veil {
        position: absolute;
        inset: -8%;
        pointer-events: none;
      }

      /* Multi-tone dappled gold leaf / burnished amber & pale champagne pockets (never uniform) */
      .idc-gold-veil--base {
        background:
          radial-gradient(ellipse 56% 48% at 14% 18%, rgba(132, 84, 14, 0.38) 0%, rgba(162, 110, 24, 0.14) 54%, transparent 82%),
          radial-gradient(ellipse 62% 52% at 86% 82%, rgba(124, 78, 12, 0.40) 0%, rgba(158, 106, 22, 0.16) 56%, transparent 84%),
          radial-gradient(ellipse 50% 44% at 76% 20%, rgba(252, 224, 138, 0.34) 0%, rgba(226, 182, 74, 0.12) 56%, transparent 82%),
          radial-gradient(ellipse 54% 46% at 24% 78%, rgba(248, 214, 118, 0.30) 0%, rgba(212, 162, 54, 0.10) 58%, transparent 84%),
          radial-gradient(ellipse 46% 38% at 52% 48%, rgba(255, 238, 174, 0.24) 0%, rgba(196, 146, 44, 0.16) 62%, rgba(138, 92, 18, 0.24) 100%),
          linear-gradient(132deg, rgba(142, 94, 18, 0.22) 0%, rgba(232, 188, 86, 0.18) 38%, rgba(166, 114, 28, 0.24) 68%, rgba(246, 212, 118, 0.20) 100%);
        animation: idcGoldDrift 14s ease-in-out infinite alternate;
      }

      /* Secondary counter-drifting darker/lighter gold pockets for living organic depth */
      .idc-gold-veil--shimmer {
        background:
          radial-gradient(circle 34vmax at 36% 32%, rgba(255, 242, 188, 0.22) 0%, transparent 68%),
          radial-gradient(circle 38vmax at 66% 64%, rgba(128, 82, 14, 0.28) 0%, transparent 70%),
          radial-gradient(circle 28vmax at 84% 42%, rgba(246, 206, 104, 0.20) 0%, transparent 66%),
          radial-gradient(circle 32vmax at 16% 58%, rgba(144, 96, 20, 0.26) 0%, transparent 68%);
        mix-blend-mode: soft-light;
        animation: idcGoldDriftReverse 18s ease-in-out infinite alternate;
      }

      .idc-prompt {
        position: relative;
        z-index: 2;
        display: inline-flex;
        align-items: center;
        gap: 0.75em;
        padding: 0.72rem 1.85rem;
        border-radius: 999px;
        background: radial-gradient(
          ellipse 120% 140% at 50% 40%,
          rgba(32, 22, 8, 0.56) 0%,
          rgba(22, 15, 6, 0.44) 65%,
          rgba(16, 10, 4, 0.34) 100%
        );
        border: 1px solid rgba(252, 224, 140, 0.48);
        box-shadow:
          0 10px 36px rgba(24, 14, 2, 0.32),
          inset 0 1px 0 rgba(255, 244, 204, 0.36);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        font-family: "Cormorant Garamond", "EB Garamond", "Noto Serif JP", Georgia, serif;
        font-size: clamp(1.18rem, 2.1vw, 1.72rem);
        font-weight: 600;
        letter-spacing: 0.14em;
        color: #fff3cc;
        text-shadow:
          0 1px 12px rgba(20, 12, 2, 0.78),
          0 0 22px rgba(242, 196, 86, 0.45);
        animation: idcPromptBreathe 3.2s ease-in-out infinite;
      }

      .idc-arrow {
        display: inline-block;
        color: #f6cf6e;
        font-weight: 500;
      }

      .idc-arrow--left {
        animation: idcNudgeLeft 2.2s ease-in-out infinite;
      }

      .idc-arrow--right {
        animation: idcNudgeRight 2.2s ease-in-out infinite;
      }

      @keyframes idcGoldDrift {
        0% { transform: translate3d(-1.2%, -0.8%, 0) scale(1.02); }
        100% { transform: translate3d(1.4%, 1.0%, 0) scale(1.05); }
      }

      @keyframes idcGoldDriftReverse {
        0% { transform: translate3d(1.5%, -1.0%, 0) scale(1.04); }
        100% { transform: translate3d(-1.5%, 1.2%, 0) scale(1.01); }
      }

      @keyframes idcPromptBreathe {
        0%, 100% { transform: translateY(0px); opacity: 0.94; }
        50% { transform: translateY(-2px); opacity: 1; }
      }

      @keyframes idcNudgeLeft {
        0%, 100% { transform: translateX(0px); }
        50% { transform: translateX(-5px); }
      }

      @keyframes idcNudgeRight {
        0%, 100% { transform: translateX(0px); }
        50% { transform: translateX(5px); }
      }
    `;
    document.head.appendChild(style);
  }

  public destroy(): void {
    this.disposed = true;
    if (this.idleCurtainTimer !== null) {
      window.clearTimeout(this.idleCurtainTimer);
      this.idleCurtainTimer = null;
    }
    if (this.idleCurtainEl) {
      this.idleCurtainEl.remove();
      this.idleCurtainEl = null;
    }
    cancelAnimationFrame(this.raf);
    window.removeEventListener("pointerdown", this.onPointerDownCapture, { capture: true });
    window.removeEventListener("pointermove", this.onPointerMoveCapture, { capture: true });
    window.removeEventListener("pointerup", this.onPointerUpCapture, { capture: true });
    window.removeEventListener("pointercancel", this.onPointerUpCapture, { capture: true });
    window.removeEventListener("blur", this.onWindowBlur);
    window.removeEventListener("click", this.onClickCapture, { capture: true });
    window.removeEventListener("resize", this.onResize);
    this.fluidMask.destroy();
    this.mokkotsuEngine.destroy();
    this.sumieEngine.destroy();
    this.stageEl.remove();
  }
}
