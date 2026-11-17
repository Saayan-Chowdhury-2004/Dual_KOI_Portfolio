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
    `;
    document.head.appendChild(style);
  }

  public destroy(): void {
    this.disposed = true;
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
