import { FluidMaskEngine } from "./fluidMaskEngine";
import { IDLE_SCROLL_BODY_URI, IDLE_SCROLL_ROLLER_URI } from "./koi/columnArtData";
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
const DEFAULT_BTN_SIZE_PX = 79;
const DEFAULT_BTN_SHADOW_SIZE_PX = 14;
const DEFAULT_BTN_SHADOW_OPACITY = 0.67;
const DEFAULT_IDLE_SCROLL_WIDTH_PX = 445;

export class KoiFluidApp {
  private stageEl: HTMLElement;
  private mokkotsuLayerEl: HTMLElement;
  private sumieLayerEl: HTMLElement;
  private mokkotsuCanvas: HTMLCanvasElement;
  private sumieCanvas: HTMLCanvasElement;
  private fluidCanvas: HTMLCanvasElement;
  private idleCurtainEl: HTMLElement | null = null;
  private scrollCueTimers: number[] = [];
  private scrollCueScheduleStarted = false;
  private idleCurtainOpenTimer: number | null = null;
  private idleCurtainDismissTimer: number | null = null;
  private loaderDismissTimer: number | null = null;
  private hasSwitchedToSumieOnce = false;
  private isProfileMenuOpen = false;

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
      this.handlePortfolioStateChange(state);
    };
    this.sumieEngine.onStateChange = (state: SharedPortfolioState) => {
      this.mokkotsuEngine.applySyncedState(state);
      this.handlePortfolioStateChange(state);
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

    // Reveal pond smoothly once first frame and fonts settle, then start the 20s pond idle timer
    this.scheduleLoadingScreenDismissal();
  }

  private scheduleLoadingScreenDismissal(): void {
    const loaderEl = document.getElementById("koi-loading-screen");
    if (!loaderEl) {
      this.startIdleDragCurtainTimer();
      return;
    }

    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get("holdLoader") === "1") {
        return;
      }
    } catch {
      // Ignore URL parsing errors
    }

    const startTime = performance.now();
    const MIN_DISPLAY_MS = 720;
    const MAX_FONT_WAIT_MS = 900;

    const finishDismiss = () => {
      if (this.disposed) return;
      const elapsed = performance.now() - startTime;
      const remaining = Math.max(0, MIN_DISPLAY_MS - elapsed);
      this.loaderDismissTimer = window.setTimeout(() => {
        this.loaderDismissTimer = null;
        if (this.disposed) return;
        loaderEl.classList.add("koi-loader--hidden");
        window.setTimeout(() => {
          loaderEl.remove();
        }, 720);
        if (!this.hasSwitchedToSumieOnce) {
          this.startIdleDragCurtainTimer();
        }
      }, remaining);
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const fontsReady = document.fonts?.ready;
        if (fontsReady) {
          let settled = false;
          const once = () => {
            if (settled) return;
            settled = true;
            finishDismiss();
          };
          fontsReady.then(once, once);
          window.setTimeout(once, MAX_FONT_WAIT_MS);
        } else {
          finishDismiss();
        }
      });
    });
  }

  private handlePortfolioStateChange(state: SharedPortfolioState): void {
    const nextOpen = Boolean(state.isPortfolioOpen);
    if (nextOpen === this.isProfileMenuOpen) return;
    this.isProfileMenuOpen = nextOpen;

    // Never show the scroll cue inside the profile menu
    if (nextOpen && this.idleCurtainEl) {
      this.dismissIdleDragCurtain();
    }
  }

  private clearScrollCueTimers(): void {
    for (const tid of this.scrollCueTimers) {
      window.clearTimeout(tid);
    }
    this.scrollCueTimers = [];
  }

  /**
   * Schedules the scroll cue exactly twice after the portfolio website is viewed:
   *  1st pop-in at 20s, 2nd pop-in 30s later (50s total). Never pops in inside the profile menu.
   */
  private startIdleDragCurtainTimer(): void {
    if (this.scrollCueScheduleStarted || this.hasSwitchedToSumieOnce || this.disposed) return;
    this.scrollCueScheduleStarted = true;
    const scheduleMs = [20000, 50000];
    for (const delayMs of scheduleMs) {
      const tid = window.setTimeout(() => {
        this.scrollCueTimers = this.scrollCueTimers.filter((id) => id !== tid);
        if (!this.hasSwitchedToSumieOnce && !this.disposed && !this.isProfileMenuOpen && this.activeStyle !== "sumie") {
          this.showIdleDragCurtain();
        }
      }, delayMs);
      this.scrollCueTimers.push(tid);
    }
  }

  private showIdleDragCurtain(): void {
    if (this.disposed || this.hasSwitchedToSumieOnce || this.isProfileMenuOpen || this.activeStyle === "sumie") return;

    if (this.idleCurtainOpenTimer !== null) {
      window.clearTimeout(this.idleCurtainOpenTimer);
      this.idleCurtainOpenTimer = null;
    }
    if (this.idleCurtainDismissTimer !== null) {
      window.clearTimeout(this.idleCurtainDismissTimer);
      this.idleCurtainDismissTimer = null;
    }
    if (this.loaderDismissTimer !== null) {
      window.clearTimeout(this.loaderDismissTimer);
      this.loaderDismissTimer = null;
    }
    if (this.idleCurtainOpenTimer !== null) {
      window.clearTimeout(this.idleCurtainOpenTimer);
      this.idleCurtainOpenTimer = null;
    }

    if (this.idleCurtainEl) return;

    const curtain = document.createElement("div");
    curtain.id = "idle-drag-curtain";
    curtain.setAttribute("aria-live", "polite");
    curtain.innerHTML = `
      <div class="idc-scroll" role="button" tabindex="0" aria-label="Click and drag on the Koi pond. Click to dismiss.">
        <div class="idc-scroll-roller">
          <img class="idc-scroll-roller-img" src="${IDLE_SCROLL_ROLLER_URI}" alt="" draggable="false" />
        </div>
        <div class="idc-scroll-body-clip">
          <div class="idc-scroll-body-inner">
            <img class="idc-scroll-body-img" src="${IDLE_SCROLL_BODY_URI}" alt="" draggable="false" />
            <div class="idc-scroll-text-area" role="status">
              <span class="idc-label">Click and drag on the Koi pond.</span>
            </div>
          </div>
        </div>
      </div>
    `;

    const scrollEl = curtain.querySelector<HTMLElement>(".idc-scroll");
    scrollEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.dismissIdleDragCurtain();
    });
    scrollEl?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        this.dismissIdleDragCurtain();
      }
    });

    this.stageEl.appendChild(curtain);
    this.idleCurtainEl = curtain;

    // Step 1: Pop in closed scroll roller from bottom edge at 445px reference scale
    void curtain.offsetWidth;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.idleCurtainEl !== curtain || this.hasSwitchedToSumieOnce || this.isProfileMenuOpen) return;
        curtain.classList.add("idc-popped");

        // Step 2: Simultaneously shrink by 10%, unroll parchment, and shift horizontally into center
        this.idleCurtainOpenTimer = window.setTimeout(() => {
          this.idleCurtainOpenTimer = null;
          if (this.idleCurtainEl === curtain && !this.hasSwitchedToSumieOnce && !this.isProfileMenuOpen) {
            curtain.classList.add("idc-opened");
          }
        }, 360);
      });
    });
  }

  private dismissIdleDragCurtain(): void {
    if (this.idleCurtainOpenTimer !== null) {
      window.clearTimeout(this.idleCurtainOpenTimer);
      this.idleCurtainOpenTimer = null;
    }

    const curtain = this.idleCurtainEl;
    if (!curtain) return;

    // Roll back closed and pop off the bottom edge
    curtain.classList.remove("idc-opened");
    curtain.classList.remove("idc-popped");
    curtain.classList.add("idc-dismissed");
    this.idleCurtainEl = null;

    if (this.idleCurtainDismissTimer !== null) {
      window.clearTimeout(this.idleCurtainDismissTimer);
    }
    this.idleCurtainDismissTimer = window.setTimeout(() => {
      this.idleCurtainDismissTimer = null;
      curtain.remove();
    }, 520);
  }

  private handleUserDragDetected(): void {
    this.dismissIdleDragCurtain();
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
    if (this.activeStyle === "sumie") {
      this.hasSwitchedToSumieOnce = true;
      this.clearScrollCueTimers();
      this.dismissIdleDragCurtain();
    }
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

      /* 10-second idle bottom-edge unrolling scroll cue */
      #idle-drag-curtain {
        --scroll-full-w: min(445px, 92vw);
        --scroll-h: calc(var(--scroll-full-w) * 213 / 785);
        --scroll-roller-w: calc(var(--scroll-full-w) * 66 / 785);
        --scroll-body-w: calc(var(--scroll-full-w) * 721 / 785);
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 40;
        pointer-events: none;
        display: flex;
        align-items: flex-end;
        justify-content: center;
        padding-bottom: clamp(14px, 3vh, 32px);
        box-sizing: border-box;
        overflow: hidden;
      }

      .idc-scroll {
        position: relative;
        display: inline-flex;
        align-items: stretch;
        height: var(--scroll-h);
        pointer-events: auto;
        cursor: pointer;
        transform-origin: center bottom;
        transform: translate3d(0, calc(100% + 56px), 0) scale(1);
        opacity: 0;
        will-change: transform, opacity;
        transition:
          transform 380ms cubic-bezier(0.22, 1.12, 0.36, 1),
          opacity 280ms ease-out;
        filter: drop-shadow(0 10px 22px rgba(10, 6, 2, 0.44));
        outline: none;
      }

      /* Phase 1: Closed scroll roller pops in from bottom edge at 100% (445px scale) */
      #idle-drag-curtain.idc-popped .idc-scroll {
        transform: translate3d(0, 0, 0) scale(1);
        opacity: 1;
      }

      /* Phase 2: Simultaneously shrinks by 10% while unrolling and shifting into center */
      #idle-drag-curtain.idc-popped.idc-opened .idc-scroll {
        transform: translate3d(0, 0, 0) scale(0.90);
        transition:
          transform 700ms cubic-bezier(0.22, 0.92, 0.28, 1),
          opacity 280ms ease-out;
      }

      #idle-drag-curtain.idc-dismissed .idc-scroll {
        transform: translate3d(0, calc(100% + 56px), 0) scale(0.90);
        opacity: 0;
        pointer-events: none;
        transition:
          transform 440ms cubic-bezier(0.55, 0.06, 0.68, 0.19),
          opacity 320ms ease-in;
      }

      .idc-scroll-roller {
        position: relative;
        z-index: 2;
        width: var(--scroll-roller-w);
        height: 100%;
        flex-shrink: 0;
      }

      .idc-scroll-roller-img {
        width: 100%;
        height: 100%;
        display: block;
        pointer-events: none;
        user-select: none;
        -webkit-user-drag: none;
      }

      /* Unrolling parchment clip: expands smoothly out from behind the roller's right edge */
      .idc-scroll-body-clip {
        position: relative;
        z-index: 1;
        width: 0;
        height: 100%;
        margin-left: calc(var(--scroll-full-w) * -2 / 785);
        overflow: hidden;
        flex-shrink: 0;
        will-change: width;
        transition: width 700ms cubic-bezier(0.22, 0.92, 0.28, 1);
      }

      #idle-drag-curtain.idc-opened .idc-scroll-body-clip {
        width: var(--scroll-body-w);
      }

      #idle-drag-curtain.idc-dismissed .idc-scroll-body-clip {
        width: 0;
        transition: width 300ms cubic-bezier(0.55, 0.06, 0.68, 0.19);
      }

      /* Anchored right: 0 so the parchment physically unrolls out from behind the cylinder */
      .idc-scroll-body-inner {
        position: absolute;
        top: 0;
        right: 0;
        width: var(--scroll-body-w);
        height: 100%;
      }

      .idc-scroll-body-img {
        width: 100%;
        height: 100%;
        display: block;
        pointer-events: none;
        user-select: none;
        -webkit-user-drag: none;
      }

      /* Centered strictly inside the parchment window of the body slice */
      .idc-scroll-text-area {
        position: absolute;
        left: 1.5%;
        right: 4.8%;
        top: 13.15%;
        bottom: 18.78%;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 0 2.5%;
        box-sizing: border-box;
        pointer-events: none;
      }

      .idc-label {
        font-family: "Cormorant Garamond", "EB Garamond", "Noto Serif JP", Georgia, serif;
        font-size: calc(var(--scroll-full-w) * 0.045);
        font-weight: 700;
        letter-spacing: 0.05em;
        line-height: 1.1;
        color: #18100a;
        white-space: nowrap;
      }
    `;
    document.head.appendChild(style);
  }

  public destroy(): void {
    this.disposed = true;
    this.clearScrollCueTimers();
    if (this.idleCurtainDismissTimer !== null) {
      window.clearTimeout(this.idleCurtainDismissTimer);
      this.idleCurtainDismissTimer = null;
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
