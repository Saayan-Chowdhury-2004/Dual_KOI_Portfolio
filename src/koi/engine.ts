import {
  ICON_FLASHLIGHT_URI,
  ICON_MOON_URI,
  ICON_ONI_URI,
  ICON_SUN_URI,
} from "./columnArtData";
import { clamp } from "../math";
import type { SharedPortfolioState } from "../sharedState";
import { BrutalistPortfolioUI } from "./portfolioColumns";
import {
  AsciiKoiPondRenderer,
  type KoiArtStyle,
  type KoiArtStyleMeta,
} from "./koiRenderer";
import { DEFAULT_KOI_CONFIG, PondWorld } from "./pondWorld";
import type { KoiPondConfig, KoiSpec } from "./koiTypes";

const STEP = 1 / 60;

const COST_HIGH_MS = 14.5;
const COST_LOW_MS = 6;
const GOVERNOR_DOWN_AFTER_S = 1.5;
const GOVERNOR_UP_AFTER_S = 6;
const MAX_QUALITY_LEVEL = 4;

const CONTROLS_STYLE_ID = "manuscript-floating-controls-styles";

export class KoiPondEngine {
  private world: PondWorld;
  private renderer: AsciiKoiPondRenderer;
  private portfolioUI: BrutalistPortfolioUI;
  private controlsEl: HTMLElement;
  private toggleBtn!: HTMLButtonElement;
  private toggleIconEl!: HTMLImageElement;
  private profileBtn!: HTMLButtonElement;
  private flashlightBtn!: HTMLButtonElement;

  private profileOpen = false;
  private manualThemeOverride: boolean | null = null;
  private simulatedSystemHours: number | null = null;
  private lastSystemSyncMs = 0;

  private lastControlsLightMode: boolean | null = null;
  private lastControlsOpen: boolean | null = null;
  private lastControlsStyle: KoiArtStyle | null = null;
  private lastControlsFlashlight: boolean | null = null;

  private viewW = 0;
  private viewH = 0;

  private ctx: CanvasRenderingContext2D | null = null;

  private readonly baseDetail: KoiPondConfig["detailQuality"];
  private qualityLevel = 0;
  private dprCap = 2;
  private costEma = 3;
  private overBudgetS = 0;
  private underBudgetS = 0;
  private upgradeDelayS = GOVERNOR_UP_AFTER_S;
  private lastUpgradeAt = -Infinity;
  private renderTick = 0;

  private accumulator = 0;

  private raf = 0;
  private last = 0;
  private visible = true;
  private paused = false;
  private isActiveLayer = true;
  private syncingState = false;
  public onStateChange: ((state: SharedPortfolioState) => void) | null = null;
  public onAfterActiveRender: ((dt: number) => void) | null = null;

  private reducedMotion: MediaQueryList;
  private resizeObserver: ResizeObserver;
  private intersectionObserver: IntersectionObserver;
  private disposed = false;

  constructor(
    private canvas: HTMLCanvasElement,
    koiSpecs?: KoiSpec[],
    configOverrides?: Partial<KoiPondConfig>,
    sharedWorld?: PondWorld,
    initialStyle?: KoiArtStyle
  ) {
    const config: KoiPondConfig = {
      ...DEFAULT_KOI_CONFIG,
      ...configOverrides,
    };
    if (koiSpecs && koiSpecs.length > 0) {
      config.fishSpecs = koiSpecs.slice(0, 4);
      config.fishCount = clamp(config.fishSpecs.length, 1, 4);
    }
    this.baseDetail = config.detailQuality;

    this.world = sharedWorld ?? new PondWorld(config);
    this.renderer = new AsciiKoiPondRenderer();
    if (initialStyle) {
      this.renderer.setArtStyle(initialStyle);
    }
    // Initialize pond time-of-day directly from the viewer's local system clock
    this.renderer.setTimeOfDayHours(this.getCurrentSystemHours(), true);
    this.lastSystemSyncMs = performance.now();

    this.renderer.setFontFamily(getComputedStyle(canvas).fontFamily);
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    this.portfolioUI = new BrutalistPortfolioUI(
      this.canvas.parentElement ?? document.body,
      () => {
        this.schedule();
      }
    );
    this.portfolioUI.onUserInteraction = () => {
      this.emitStateChange();
    };

    this.controlsEl = this.createControls();
    this.updateControlsUI();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.intersectionObserver = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      this.schedule();
    });
    this.intersectionObserver.observe(canvas);

    this.reducedMotion.addEventListener("change", this.onMotionPreference);
    window.addEventListener("pointermove", this.onPointerMove, { passive: true });
    window.addEventListener("pointerdown", this.onPointerDown, { passive: true });
    window.addEventListener("click", this.onWindowClick);

    document.documentElement.addEventListener("pointerleave", this.onPointerLeave);
    document.addEventListener("mouseleave", this.onPointerLeave);
    window.addEventListener("mouseout", this.onWindowMouseOut);
    window.addEventListener("blur", this.onPointerLeave);
    document.addEventListener("visibilitychange", this.onVisibilityChange);

    this.resize();
    document.fonts?.load(`600 16px ${getComputedStyle(canvas).fontFamily}`).then(() => {
      if (!this.disposed && this.reducedMotion.matches) {
        this.drawStill();
      }
    });
    this.schedule();
  }

  private getCurrentSystemHours(): number {
    if (this.simulatedSystemHours !== null && Number.isFinite(this.simulatedSystemHours)) {
      return AsciiKoiPondRenderer.normalizeHours(this.simulatedSystemHours);
    }
    const now = new Date();
    return (
      now.getHours() +
      now.getMinutes() / 60 +
      now.getSeconds() / 3600 +
      now.getMilliseconds() / 3600000
    );
  }

  /**
   * Synchronizes the pond time of day with the live system clock whenever no manual
   * light/dark button override is active.
   */
  private syncTimeWithSystemClock(nowMs: number, force = false): void {
    if (this.manualThemeOverride !== null) return;
    if (!force && nowMs - this.lastSystemSyncMs < 1000) return;
    this.lastSystemSyncMs = nowMs;
    const sysHours = this.getCurrentSystemHours();
    const prevLight = this.renderer.isLightMode;
    this.renderer.setTimeOfDayHours(sysHours, false);
    if (this.renderer.isLightMode !== prevLight) {
      this.updateControlsUI();
      this.syncPortfolioUI(0);
    }
  }

  public getTimeOfDayHours(): number {
    return this.renderer.getTimeOfDayHours();
  }

  /**
   * Allows testing or previewing a specific system clock hour while keeping automatic system-time mode.
   * Pass `null` to resume reading `new Date()`.
   */
  public setSimulatedSystemHours(hours: number | null): void {
    this.simulatedSystemHours = hours;
    this.manualThemeOverride = null;
    this.renderer.setTimeOfDayHours(this.getCurrentSystemHours(), true);
    this.updateControlsUI();
    this.syncPortfolioUI(0);
    this.renderFrame();
    this.schedule();
    this.emitStateChange();
  }

  public getColumnsUvBounds(): [number, number, number, number] | null {
    const b = this.portfolioUI.getColumnsViewportBounds();
    if (!b || this.viewW < 1 || this.viewH < 1) return null;
    const uMin = clamp(b.left / this.viewW, 0, 1);
    const uMax = clamp(b.right / this.viewW, 0, 1);
    const vMin = clamp(1.0 - b.bottom / this.viewH, 0, 1);
    const vMax = clamp(1.0 - b.top / this.viewH, 0, 1);
    if (uMax <= uMin || vMax <= vMin) return null;
    return [uMin, vMin, uMax, vMax];
  }

  public getState(): SharedPortfolioState {
    return {
      isLightMode: this.renderer.isLightMode,
      isPortfolioOpen: this.profileOpen,
      expandedColumnIndex: this.portfolioUI.getExpandedColumn(),
      activeProjectTopic: this.portfolioUI.getActiveProjectTopic(),
      isFlashlightEnabled: this.renderer.isFlashlightEnabled,
      menuBlurPx: this.renderer.getMenuBlurPx(),
      timeOfDayHours: this.renderer.getTimeOfDayHours(),
      manualThemeOverride: this.manualThemeOverride,
    };
  }

  public applySyncedState(state: SharedPortfolioState): void {
    this.syncingState = true;
    try {
      if (state.manualThemeOverride !== undefined) {
        this.manualThemeOverride = state.manualThemeOverride;
      }
      if (this.manualThemeOverride !== null) {
        this.renderer.setLightMode(this.manualThemeOverride, !this.isActiveLayer);
      } else if (typeof state.timeOfDayHours === "number") {
        this.renderer.setTimeOfDayHours(state.timeOfDayHours, !this.isActiveLayer);
      } else {
        this.renderer.setLightMode(state.isLightMode, !this.isActiveLayer);
      }
      if (
        typeof state.isFlashlightEnabled === "boolean" &&
        this.renderer.isFlashlightEnabled !== state.isFlashlightEnabled
      ) {
        this.renderer.setFlashlightEnabled(state.isFlashlightEnabled);
      }
      if (typeof state.menuBlurPx === "number") {
        this.renderer.setMenuBlurPx(state.menuBlurPx);
      }
      this.profileOpen = state.isPortfolioOpen;
      this.renderer.setProfileTargetOpen(this.profileOpen);
      this.portfolioUI.syncState(
        state.isPortfolioOpen,
        state.expandedColumnIndex,
        state.activeProjectTopic
      );
      this.updateControlsUI();
      this.syncPortfolioUI(STEP);
      this.renderFrame();
      this.schedule();
    } finally {
      this.syncingState = false;
    }
  }

  public getWorld(): PondWorld {
    return this.world;
  }

  public setMenuBlurPx(px: number): void {
    this.renderer.setMenuBlurPx(px);
    this.renderFrame();
    this.schedule();
  }

  public getMenuBlurPx(): number {
    return this.renderer.getMenuBlurPx();
  }

  public setPortraitPhotoRevealed(revealed: boolean, immediate = true): void {
    this.renderer.setPortraitPhotoRevealed(revealed, immediate);
  }

  public syncVisualStateFrom(other: KoiPondEngine): void {
    this.manualThemeOverride = other.manualThemeOverride;
    this.simulatedSystemHours = other.simulatedSystemHours;
    this.renderer.syncDynamicStateFrom(other.renderer);
    const openProg = other.portfolioUI.getOpenProgress();
    this.portfolioUI.syncLayoutFrom(other.portfolioUI);
    this.portfolioUI.syncFlipProgress(openProg);
    this.renderer.setRectProgress(openProg);
    this.renderer.setActiveColumnRects(other.portfolioUI.getColumnScreenRects());
    this.updateControlsUI();
  }

  private emitStateChange(): void {
    if (this.syncingState) return;
    this.onStateChange?.(this.getState());
  }

  public setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    } else {
      this.schedule();
    }
  }

  public setActiveLayer(active: boolean): void {
    this.isActiveLayer = active;
    if (!active) {
      this.world.pointer.active = false;
      this.renderer.setFlashlightPointer(-1, -1, false);
    }
  }

  public setArtStyle(style: KoiArtStyle): KoiArtStyleMeta {
    const meta = this.renderer.setArtStyle(style);
    this.updateControlsUI();
    this.schedule();
    if (this.reducedMotion.matches) this.drawStill();
    return meta;
  }

  public cycleArtStyle(): KoiArtStyleMeta {
    const meta = this.renderer.cycleArtStyle();
    this.updateControlsUI();
    this.schedule();
    if (this.reducedMotion.matches) this.drawStill();
    return meta;
  }

  public getArtStyle(): KoiArtStyle {
    return this.renderer.getArtStyle();
  }

  destroy() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.renderer.destroy();
    this.portfolioUI.destroy();
    this.controlsEl.remove();
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    this.reducedMotion.removeEventListener("change", this.onMotionPreference);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("click", this.onWindowClick);
    document.documentElement.addEventListener("pointerleave", this.onPointerLeave);
    document.removeEventListener("mouseleave", this.onPointerLeave);
    window.removeEventListener("mouseout", this.onWindowMouseOut);
    window.removeEventListener("blur", this.onPointerLeave);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  private getCtx(): CanvasRenderingContext2D | null {
    if (!this.ctx) this.ctx = this.canvas.getContext("2d", { alpha: false });
    return this.ctx;
  }

  private onWindowMouseOut = (e: MouseEvent) => {
    const toEl = e.relatedTarget || (e as unknown as { toElement?: EventTarget | null }).toElement;
    if (!toEl) {
      this.onPointerLeave();
    }
  };

  private onVisibilityChange = () => {
    if (document.hidden) {
      cancelAnimationFrame(this.raf);
      this.onPointerLeave();
    } else {
      this.syncTimeWithSystemClock(performance.now(), true);
      this.schedule();
    }
  };

  private injectControlStyles(): void {
    if (document.getElementById(CONTROLS_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = CONTROLS_STYLE_ID;
    style.textContent = `
      #layer-koi .ms-floating-controls {
        position: absolute;
        top: 24px;
        right: 16px;
        z-index: 50;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        user-select: none;
        box-sizing: border-box;
      }

      #layer-koi .ms-ctrl-btn {
        appearance: none;
        position: relative;
        width: var(--ctrl-btn-size, 59px);
        height: var(--ctrl-btn-size, 59px);
        padding: 0;
        margin: 0;
        background: transparent;
        border: none;
        outline: none;
        border-radius: var(--ctrl-btn-radius, 16%);
        box-shadow:
          0 calc(var(--ctrl-btn-shadow-size, 14px) * 0.48) var(--ctrl-btn-shadow-size, 14px) rgba(0, 0, 0, var(--ctrl-btn-shadow-opacity, 0.67)),
          0 calc(var(--ctrl-btn-shadow-size, 14px) * 0.20) calc(var(--ctrl-btn-shadow-size, 14px) * 0.45) rgba(0, 0, 0, calc(var(--ctrl-btn-shadow-opacity, 0.67) * 0.68));
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        box-sizing: border-box;
        transition: transform 140ms ease, box-shadow 140ms ease, filter 140ms ease, opacity 140ms ease;
      }

      #layer-koi .ms-ctrl-btn:hover,
      #layer-koi .ms-ctrl-btn:focus-visible {
        border: none;
        outline: none;
        box-shadow:
          0 calc(var(--ctrl-btn-shadow-size, 14px) * 0.56) calc(var(--ctrl-btn-shadow-size, 14px) * 1.15) rgba(0, 0, 0, min(1, calc(var(--ctrl-btn-shadow-opacity, 0.67) * 1.15))),
          0 calc(var(--ctrl-btn-shadow-size, 14px) * 0.24) calc(var(--ctrl-btn-shadow-size, 14px) * 0.52) rgba(0, 0, 0, calc(var(--ctrl-btn-shadow-opacity, 0.67) * 0.78));
        transform: translate3d(0, -1.5px, 0);
        filter: brightness(1.07);
      }

      #layer-koi .ms-ctrl-btn--active {
        border: none;
      }

      #layer-koi .ms-ctrl-icon {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
        border-radius: inherit;
        pointer-events: none;
        user-select: none;
      }

      #layer-koi .ms-ctrl-btn--flashlight-off {
        opacity: 0.62;
        filter: saturate(0.72) brightness(0.76);
      }

      /* Sumi-e Zen Ink Wash Style Synchronization for Control Buttons & Icons */
      #layer-koi .ms-floating-controls[data-art-style="sumie"] .ms-ctrl-icon {
        filter: grayscale(1) contrast(1.22) brightness(0.96);
      }

      #layer-koi .ms-floating-controls[data-art-style="sumie"]:not(.ms-controls--night) .ms-ctrl-icon {
        filter: grayscale(1) contrast(1.30) brightness(0.88);
      }
    `;
    document.head.appendChild(style);
  }

  private createControls(): HTMLElement {
    this.injectControlStyles();

    const container = document.createElement("nav");
    container.className = "ms-floating-controls";
    container.setAttribute("aria-label", "Portfolio Controls");

    // 1. Sun / Moon Light-Dark Mode Override Toggle Button
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "ms-ctrl-btn";
    toggleBtn.setAttribute("role", "switch");
    toggleBtn.setAttribute("aria-checked", this.renderer.isLightMode ? "true" : "false");
    toggleBtn.setAttribute("aria-label", "Toggle black and light pond");

    const toggleIcon = document.createElement("img");
    toggleIcon.className = "ms-ctrl-icon";
    toggleIcon.alt = "";
    toggleIcon.draggable = false;
    toggleIcon.src = this.renderer.isLightMode ? ICON_SUN_URI : ICON_MOON_URI;
    toggleBtn.appendChild(toggleIcon);

    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const nextLight = !this.renderer.isLightMode;
      this.manualThemeOverride = nextLight;
      this.renderer.setLightMode(nextLight, false);
      this.updateControlsUI();
      this.syncPortfolioUI(0);
      this.schedule();
      if (this.reducedMotion.matches) this.drawStill();
      this.emitStateChange();
    });

    // 2. Oni Profile Reveal Button
    const profileBtn = document.createElement("button");
    profileBtn.type = "button";
    profileBtn.className = "ms-ctrl-btn";
    profileBtn.setAttribute("aria-label", "Toggle portfolio reveal");
    profileBtn.setAttribute("aria-expanded", "false");

    const profileIcon = document.createElement("img");
    profileIcon.className = "ms-ctrl-icon";
    profileIcon.alt = "";
    profileIcon.draggable = false;
    profileIcon.src = ICON_ONI_URI;
    profileBtn.appendChild(profileIcon);

    profileBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const btnRect = profileBtn.getBoundingClientRect();
      const canvasRect = this.canvas.getBoundingClientRect();
      const btnX =
        btnRect.width > 0
          ? btnRect.left + btnRect.width * 0.5 - canvasRect.left
          : Math.max(40, this.viewW - 46);
      const btnY =
        btnRect.height > 0
          ? btnRect.top + btnRect.height * 0.5 - canvasRect.top
          : 115;

      this.profileOpen = !this.profileOpen;
      if (this.profileOpen) {
        this.renderer.setPortraitPhotoRevealed(false, true);
        // Pond reaction at t=0 on open: convert button position to pond-local coordinates
        // the exact same way toLocal() does (via getActivePondRect)
        const pondRect = this.renderer.getActivePondRect(this.viewW, this.viewH);
        const localX = (btnX - pondRect.x) / pondRect.scale;
        const localY = (btnY - pondRect.y) / pondRect.scale;
        this.world.splash(localX, localY);
        this.renderer.triggerPondClick(localX, localY, this.viewW, this.viewH);
      }
      this.renderer.setProfileTargetOpen(this.profileOpen);
      this.updateControlsUI();
      this.syncPortfolioUI(0);
      this.renderFrame();
      this.schedule();
      this.emitStateChange();
    });

    // 3. Lamp / Flashlight Toggle Button (Shown in Night Mode)
    const flashlightBtn = document.createElement("button");
    flashlightBtn.type = "button";
    flashlightBtn.className = "ms-ctrl-btn ms-ctrl-btn--active";
    flashlightBtn.setAttribute("role", "switch");
    flashlightBtn.setAttribute("aria-checked", "true");
    flashlightBtn.setAttribute("aria-label", "Toggle dark mode flashlight");
    flashlightBtn.title = "Toggle Flashlight On / Off";

    const flashlightIcon = document.createElement("img");
    flashlightIcon.className = "ms-ctrl-icon";
    flashlightIcon.alt = "";
    flashlightIcon.draggable = false;
    flashlightIcon.src = ICON_FLASHLIGHT_URI;
    flashlightBtn.appendChild(flashlightIcon);

    flashlightBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.renderer.toggleFlashlightEnabled();
      this.updateControlsUI();
      this.schedule();
      if (this.reducedMotion.matches) this.drawStill();
      this.emitStateChange();
    });

    this.toggleBtn = toggleBtn;
    this.toggleIconEl = toggleIcon;
    this.profileBtn = profileBtn;
    this.flashlightBtn = flashlightBtn;

    container.appendChild(toggleBtn);
    container.appendChild(profileBtn);
    container.appendChild(flashlightBtn);

    (this.canvas.parentElement ?? document.body).appendChild(container);
    return container;
  }

  private updateControlsUI(): void {
    const isLight = this.renderer.isLightMode;
    const isOpen = this.profileOpen;
    const styleMeta = this.renderer.getArtStyleMeta();

    if (this.lastControlsLightMode !== isLight) {
      this.lastControlsLightMode = isLight;
      this.controlsEl.classList.toggle("ms-controls--night", !isLight);
      this.toggleBtn.setAttribute("aria-checked", isLight ? "true" : "false");
      this.toggleIconEl.src = isLight ? ICON_SUN_URI : ICON_MOON_URI;
      // Keep the Lantern button hidden in Light Mode; show it only in Dark Mode
      this.flashlightBtn.style.display = isLight ? "none" : "flex";
    }

    if (this.lastControlsOpen !== isOpen) {
      this.lastControlsOpen = isOpen;
      this.profileBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
      this.profileBtn.classList.toggle("ms-ctrl-btn--active", isOpen);
    }

    if (this.lastControlsStyle !== styleMeta.id) {
      this.lastControlsStyle = styleMeta.id;
      this.controlsEl.setAttribute("data-art-style", styleMeta.id);
      this.portfolioUI.setArtStyle(styleMeta.id);
    }

    const flashOn = this.renderer.isFlashlightEnabled;
    if (this.lastControlsFlashlight !== flashOn) {
      this.lastControlsFlashlight = flashOn;
      this.flashlightBtn.setAttribute("aria-checked", flashOn ? "true" : "false");
      this.flashlightBtn.classList.toggle("ms-ctrl-btn--active", flashOn);
      this.flashlightBtn.classList.toggle("ms-ctrl-btn--flashlight-off", !flashOn);
    }
  }

  private syncPortfolioUI(dt = STEP) {
    if (!this.canvas.parentElement || this.viewW < 1 || this.viewH < 1) return;
    this.portfolioUI.setQualityAndMotion(this.qualityLevel, this.reducedMotion.matches);
    this.renderer.setRippleParams(
      this.world.config.cellWidth,
      this.world.config.cellHeight,
      this.qualityLevel,
      this.reducedMotion.matches
    );
    this.portfolioUI.update(
      this.profileOpen,
      this.renderer.isLightMode,
      this.viewW,
      this.viewH,
      0,
      0,
      this.world.config.cellWidth,
      this.world.config.cellHeight,
      dt,
      this.world.time
    );

    const openProgress = this.portfolioUI.getOpenProgress();
    this.renderer.setRectProgress(openProgress);
    this.renderer.setProfileTargetOpen(this.profileOpen);
    this.renderer.setActiveColumnRects(this.portfolioUI.getColumnScreenRects());
  }

  private getEffectiveDpr(): number {
    return Math.min(window.devicePixelRatio || 1, this.dprCap);
  }

  private updateCanvasResolution(): boolean {
    if (this.viewW < 1 || this.viewH < 1) return false;
    const dpr = this.getEffectiveDpr();
    const physW = Math.max(1, Math.round(this.viewW * dpr));
    const physH = Math.max(1, Math.round(this.viewH * dpr));
    let changed = false;
    if (this.canvas.width !== physW || this.canvas.height !== physH) {
      this.canvas.width = physW;
      this.canvas.height = physH;
      changed = true;
    }
    this.getCtx()?.setTransform(dpr, 0, 0, dpr, 0, 0);
    return changed;
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    this.viewW = rect.width;
    this.viewH = rect.height;
    this.updateCanvasResolution();

    const pondRect = this.renderer.getActivePondRect(rect.width, rect.height);
    this.world.resize(pondRect.w / pondRect.scale, pondRect.h / pondRect.scale);
    this.updateControlsUI();
    this.syncPortfolioUI(0);
    if (this.reducedMotion.matches) {
      this.drawStill();
    } else {
      this.renderFrame();
    }
  }

  private schedule() {
    cancelAnimationFrame(this.raf);
    const needsAnim = this.renderer.isTransitioning || this.portfolioUI.isAnimating;
    if (
      this.disposed ||
      !this.visible ||
      document.hidden ||
      this.paused ||
      (this.reducedMotion.matches && !needsAnim)
    )
      return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  public renderFrame() {
    const ctx = this.getCtx();
    if (!ctx || this.viewW < 1 || this.viewH < 1) return;
    this.renderer.setActiveColumnRects(this.portfolioUI.getColumnScreenRects());
    this.renderer.render(
      ctx,
      this.viewW,
      this.viewH,
      this.world,
      this.world.time,
      this.world.config
    );
    this.syncFlashlightDomVeil();
  }

  /**
   * Keeps the 4-column Profile UI (`.bp-portfolio-root`) and the top-right control buttons
   * (`.ms-floating-controls`) hidden in darkness in Dark Mode until illuminated by the flashlight
   * (either moved by the cursor or via the calm off-screen auto-drift), or until the viewer
   * manually clicks the Lantern button to toggle the flashlight off.
   */
  private syncFlashlightDomVeil(): void {
    const fl = this.renderer.getFlashlightVeilMetrics(this.viewW, this.viewH);
    const portfolioRoot = this.portfolioUI.getRootElement();

    if (!fl.active) {
      if (portfolioRoot.style.maskImage || portfolioRoot.style.webkitMaskImage) {
        portfolioRoot.style.webkitMaskImage = "";
        portfolioRoot.style.maskImage = "";
      }
      if (this.controlsEl.style.maskImage || this.controlsEl.style.webkitMaskImage) {
        this.controlsEl.style.webkitMaskImage = "";
        this.controlsEl.style.maskImage = "";
      }
      return;
    }

    const s22 = Math.max(0, 1 - fl.maxVeilAlpha * 0.08).toFixed(3);
    const s45 = Math.max(0, 1 - fl.maxVeilAlpha * 0.32).toFixed(3);
    const s68 = Math.max(0, 1 - fl.maxVeilAlpha * 0.68).toFixed(3);
    const s86 = Math.max(0, 1 - fl.maxVeilAlpha * 0.91).toFixed(3);
    // Outside the beam, completely hide DOM controls & columns (0.008) so user must discover them with the light
    const sOut = Math.max(0.005, 1 - fl.maxVeilAlpha * 0.995).toFixed(3);
    const rad = fl.outerR.toFixed(1);

    const { left: pLeft, top: pTop } = this.portfolioUI.getContainerOffset();
    const stageLocalX = fl.x - pLeft;
    const stageLocalY = fl.y - pTop;
    const stageMask = `radial-gradient(circle ${rad}px at ${stageLocalX.toFixed(1)}px ${stageLocalY.toFixed(1)}px, rgba(0,0,0,1) 0%, rgba(0,0,0,${s22}) 22%, rgba(0,0,0,${s45}) 45%, rgba(0,0,0,${s68}) 68%, rgba(0,0,0,${s86}) 86%, rgba(0,0,0,${sOut}) 100%)`;
    portfolioRoot.style.webkitMaskImage = stageMask;
    portfolioRoot.style.maskImage = stageMask;

    const ctrlOriginX = this.controlsEl.offsetLeft || this.viewW - 75;
    const ctrlOriginY = this.controlsEl.offsetTop || 24;
    const ctrlLocalX = fl.x - ctrlOriginX;
    const ctrlLocalY = fl.y - ctrlOriginY;
    const ctrlMask = `radial-gradient(circle ${rad}px at ${ctrlLocalX.toFixed(1)}px ${ctrlLocalY.toFixed(1)}px, rgba(0,0,0,1) 0%, rgba(0,0,0,${s22}) 22%, rgba(0,0,0,${s45}) 45%, rgba(0,0,0,${s68}) 68%, rgba(0,0,0,${s86}) 86%, rgba(0,0,0,${sOut}) 100%)`;
    this.controlsEl.style.webkitMaskImage = ctrlMask;
    this.controlsEl.style.maskImage = ctrlMask;
  }

  private applyQualityLevel(level: number) {
    this.qualityLevel = level;
    const config = this.world.config;
    config.detailQuality =
      level >= 2 ? "low" : level === 1 && this.baseDetail === "high" ? "medium" : this.baseDetail;
  }

  private govern(dt: number, costMs: number, now: number) {
    this.costEma += (costMs - this.costEma) * Math.min(1, dt / 0.4);

    if (this.costEma > COST_HIGH_MS) {
      this.underBudgetS = 0;
      this.overBudgetS += dt;
      if (this.overBudgetS > GOVERNOR_DOWN_AFTER_S && this.qualityLevel < MAX_QUALITY_LEVEL) {
        if (now - this.lastUpgradeAt < 15000) {
          this.upgradeDelayS = Math.min(60, this.upgradeDelayS * 2);
        }
        this.overBudgetS = 0;
        this.applyQualityLevel(this.qualityLevel + 1);
      }
    } else if (this.costEma < COST_LOW_MS) {
      this.overBudgetS = 0;
      this.underBudgetS += dt;
      if (this.underBudgetS > this.upgradeDelayS && this.qualityLevel > 0) {
        this.underBudgetS = 0;
        this.lastUpgradeAt = now;
        this.applyQualityLevel(this.qualityLevel - 1);
      }
    } else {
      this.overBudgetS = Math.max(0, this.overBudgetS - dt);
      this.underBudgetS = Math.max(0, this.underBudgetS - dt);
    }
  }

  private frame = (now: number) => {
    const t0 = performance.now();
    const rawDeltaMs = now - this.last;
    const dt = Math.min(0.05, Math.max(0.001, rawDeltaMs / 1000));
    this.last = now;

    if (this.isActiveLayer) {
      this.syncTimeWithSystemClock(now, false);
    }

    if (this.profileOpen || this.portfolioUI.isAnimating) {
      this.syncPortfolioUI(dt);
    }

    if (!this.reducedMotion.matches && this.isActiveLayer) {
      const stepDelta = Math.abs(dt - STEP) < 0.0025 ? STEP : dt;
      this.accumulator = Math.min(this.accumulator + stepDelta, STEP * 1.95);
      if (this.accumulator >= STEP) {
        this.world.step(STEP);
        this.accumulator -= STEP;
      }
      const alpha = clamp(this.accumulator / STEP, 0, 1);
      this.world.applyInterpolation(alpha);
    }

    this.renderTick++;
    const skipRender =
      this.qualityLevel >= MAX_QUALITY_LEVEL &&
      (this.renderTick & 1) === 1 &&
      !this.renderer.isTransitioning &&
      !this.portfolioUI.isAnimating;
    if (!skipRender) {
      this.renderFrame();
      if (this.isActiveLayer && this.onAfterActiveRender) {
        this.onAfterActiveRender(dt);
      }
    }

    if (!this.reducedMotion.matches && this.isActiveLayer) {
      this.world.restoreSimulationState();
    }

    if (this.lastControlsLightMode !== this.renderer.isLightMode) {
      this.updateControlsUI();
    }

    if (!skipRender && !this.reducedMotion.matches && !this.renderer.isTransitioning) {
      const mainCostMs = performance.now() - t0;
      this.govern(dt, mainCostMs, now);
    }

    const needsAnim = this.renderer.isTransitioning || this.portfolioUI.isAnimating;
    if (!this.paused && (!this.reducedMotion.matches || needsAnim)) {
      this.raf = requestAnimationFrame(this.frame);
    }
  };

  private drawStill() {
    if (this.viewW < 1) this.resize();
    if (this.world.time < 4) {
      for (let i = 0; i < 240; i++) this.world.step(STEP);
    }
    this.syncPortfolioUI(STEP);
    this.renderFrame();
  }

  private onMotionPreference = () => {
    if (this.reducedMotion.matches) {
      cancelAnimationFrame(this.raf);
      this.drawStill();
    } else {
      this.schedule();
    }
  };

  private toLocal(e: PointerEvent | MouseEvent) {
    const targetEl = e.target instanceof Element ? e.target : null;
    const overUI = !!(
      targetEl &&
      (targetEl.closest(".ms-floating-controls") || targetEl.closest(".bp-col"))
    );

    const rect = this.canvas.getBoundingClientRect();
    const rawX = e.clientX - rect.left;
    const rawY = e.clientY - rect.top;
    const pondRect = this.renderer.getActivePondRect(this.viewW, this.viewH);

    const x = (rawX - pondRect.x) / pondRect.scale;
    const y = (rawY - pondRect.y) / pondRect.scale;
    const inside =
      !overUI &&
      rawX >= pondRect.x &&
      rawY >= pondRect.y &&
      rawX <= pondRect.x + pondRect.w &&
      rawY <= pondRect.y + pondRect.h;
    return { x, y, inside };
  }

  private isPointInPortraitFrame(rawX: number, rawY: number): boolean {
    if (!this.profileOpen || this.renderer.getRectProgress() < 0.35) return false;
    const fr = this.renderer.computeLeftFrameRect(
      this.viewW,
      this.viewH,
      this.renderer.getRectProgress()
    );
    return rawX >= fr.x && rawX <= fr.x + fr.w && rawY >= fr.y && rawY <= fr.y + fr.h;
  }

  public isClientPointInPortraitFrame(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    return this.isPointInPortraitFrame(clientX - rect.left, clientY - rect.top);
  }

  private onPointerMove = (e: PointerEvent) => {
    if (!this.isActiveLayer) return;
    const rect = this.canvas.getBoundingClientRect();
    const rawX = e.clientX - rect.left;
    const rawY = e.clientY - rect.top;
    const inViewport = rawX >= 0 && rawY >= 0 && rawX <= rect.width && rawY <= rect.height;
    this.renderer.setFlashlightPointer(rawX, rawY, inViewport);

    const targetEl = e.target instanceof Element ? e.target : null;
    const overUI = !!(
      targetEl &&
      (targetEl.closest(".ms-floating-controls") || targetEl.closest(".bp-col"))
    );
    const overPortrait = !overUI && this.isPointInPortraitFrame(rawX, rawY);
    this.canvas.style.cursor = overPortrait ? "pointer" : "";

    const { x, y, inside } = this.toLocal(e);
    const p = this.world.pointer;
    p.x = x;
    p.y = y;
    p.active = inside && e.pointerType !== "touch";
  };

  private onPointerDown = (_e: PointerEvent) => {
    // Stationary clicks vs WebGL fluid drags are disambiguated on click (onWindowClick)
  };

  private onWindowClick = (e: MouseEvent) => {
    if (!this.isActiveLayer || e.button !== 0) return;
    const targetEl = e.target instanceof Element ? e.target : null;
    if (
      targetEl &&
      (targetEl.closest(".ms-floating-controls") || targetEl.closest(".bp-col"))
    ) {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const rawX = e.clientX - rect.left;
    const rawY = e.clientY - rect.top;
    if (this.isPointInPortraitFrame(rawX, rawY)) {
      this.renderer.togglePortraitPhoto();
      this.schedule();
      if (this.reducedMotion.matches) this.drawStill();
      return;
    }
    const { x, y, inside } = this.toLocal(e);
    if (!inside) return;
    const pondRect = this.renderer.getActivePondRect(this.viewW, this.viewH);
    const effW = pondRect.w / pondRect.scale;
    const effH = pondRect.h / pondRect.scale;
    this.renderer.triggerPondClick(x, y, effW, effH);
    if (!this.reducedMotion.matches) this.world.splash(x, y);
    this.schedule();
  };

  private onPointerLeave = () => {
    this.world.pointer.active = false;
    this.renderer.setFlashlightPointer(-1, -1, false);
  };
}
