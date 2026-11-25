import {
  ICON_FLASHLIGHT_OFF_URI,
  ICON_FLASHLIGHT_URI,
  ICON_GITHUB_URI,
  ICON_LINKEDIN_URI,
  ICON_MOON_URI,
  ICON_PROFILE_COIN_URI,
  ICON_SUN_URI,
} from "./columnArtData";
import { clamp } from "../math";
import type { SharedPortfolioState } from "../sharedState";
import { BrutalistPortfolioUI } from "./portfolioColumns";
import { GalleryScrollUI } from "./galleryScroll";
import {
  KoiPondRenderer,
  type KoiArtStyle,
  type KoiArtStyleMeta,
} from "./koiRenderer";
import { DEFAULT_KOI_CONFIG, PondWorld } from "./pondWorld";
import { bakeMizuhikiCoinDataUrl, bakeMizuhikiPortraitCoinDataUrl, bakeMizuhikiScrollCoinDataUrl, MizuhikiCoinChain, type MizuhikiCoinVariant } from "./mizuhikiCoins";
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
  private renderer: KoiPondRenderer;
  private portfolioUI: BrutalistPortfolioUI;
  private galleryUI: GalleryScrollUI;
  private controlsEl: HTMLElement;
  private toggleBtn!: HTMLButtonElement;
  private toggleSunIconEl!: HTMLImageElement;
  private toggleMoonIconEl!: HTMLImageElement;
  private profileIconEl!: HTMLImageElement;
  private scrollIconEl!: HTMLImageElement;
  private githubIconEl!: HTMLImageElement;
  private linkedinIconEl!: HTMLImageElement;
  private flashlightIconEl!: HTMLImageElement;
  private flashlightOffIconEl!: HTMLImageElement;
  private coinUris: Record<MizuhikiCoinVariant, Partial<Record<"sun" | "moon" | "oni" | "scroll" | "github" | "linkedin" | "flash" | "flashOff", string>>> = {
    brass: {},
    "sumie-day": {},
    "sumie-night": {},
  };
  private mizuhikiChain: MizuhikiCoinChain | null = null;
  private profileBtn!: HTMLButtonElement;
  private scrollBtn!: HTMLButtonElement;
  private flashlightBtn!: HTMLButtonElement;

  private profileOpen = false;
  private galleryOpen = false;
  private manualThemeOverride: boolean | null = null;
  private themeToggleAnchorLight: boolean | null = null;
  private simulatedSystemHours: number | null = null;
  private lastSystemSyncMs = 0;

  private lastControlsLightMode: boolean | null = null;
  private lastControlsOpen: boolean | null = null;
  private lastControlsGalleryOpen: boolean | null = null;
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
    this.renderer = new KoiPondRenderer();
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

    this.galleryUI = new GalleryScrollUI(
      this.canvas.parentElement ?? document.body,
      {
        onRequestClose: () => {
          this.setGalleryOpen(false);
        },
        onStateChange: () => {
          this.emitStateChange();
        },
      }
    );

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
    window.addEventListener("keydown", this.onWindowKeyDown);

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
      return KoiPondRenderer.normalizeHours(this.simulatedSystemHours);
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
    const b = this.galleryUI.getViewportBounds() ?? this.portfolioUI.getColumnsViewportBounds();
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
      isGalleryOpen: this.galleryOpen,
      galleryScrollTop: this.galleryUI.getScrollTop(),
      activeGalleryItemIndex: this.galleryUI.getActiveItemIndex(),
      activeGallerySlideIndex: this.galleryUI.getActiveSlideIndex(),
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
        this.renderer.transitionToTimeOfDayHours(state.timeOfDayHours, !this.isActiveLayer);
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
      this.galleryOpen = Boolean(state.isGalleryOpen);
      this.galleryUI.syncState(
        this.galleryOpen,
        state.galleryScrollTop,
        state.activeGalleryItemIndex,
        state.activeGallerySlideIndex
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
    this.themeToggleAnchorLight = other.themeToggleAnchorLight;
    this.simulatedSystemHours = other.simulatedSystemHours;
    this.renderer.syncDynamicStateFrom(other.renderer);
    const openProg = other.portfolioUI.getOpenProgress();
    this.portfolioUI.syncLayoutFrom(other.portfolioUI);
    this.portfolioUI.syncFlipProgress(openProg);
    this.renderer.setRectProgress(openProg);
    this.galleryOpen = other.galleryOpen;
    this.galleryUI.syncVisualStateFrom(other.galleryUI);
    this.renderer.setActiveColumnRects([
      ...other.portfolioUI.getColumnScreenRects(),
      ...other.galleryUI.getScreenRects(),
    ]);
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
    this.galleryUI.destroy();
    this.mizuhikiChain?.destroy();
    this.mizuhikiChain = null;
    this.controlsEl.remove();
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    this.reducedMotion.removeEventListener("change", this.onMotionPreference);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("click", this.onWindowClick);
    window.removeEventListener("keydown", this.onWindowKeyDown);
    document.documentElement.removeEventListener("pointerleave", this.onPointerLeave);
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
        top: 0;
        right: -10px;
        z-index: 50;
        width: 173px;
        padding-top: 42px;
        padding-bottom: 76px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 15px;
        user-select: none;
        box-sizing: border-box;
        pointer-events: none;
      }

      #layer-koi .ms-mizuhiki-svg {
        position: absolute;
        top: 0;
        left: 0;
        z-index: 3;
        pointer-events: none;
        overflow: visible;
        filter: drop-shadow(0 6px 10px rgba(0, 0, 0, 0.34));
      }

      #layer-koi .ms-ctrl-btn {
        appearance: none;
        position: relative;
        z-index: 2;
        width: var(--ctrl-btn-size, 79px);
        height: var(--ctrl-btn-size, 79px);
        padding: 0;
        margin: 0;
        background: transparent;
        border: none;
        outline: none;
        text-decoration: none;
        border-radius: 50%;
        box-shadow: none;
        cursor: pointer;
        pointer-events: auto;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: visible;
        box-sizing: border-box;
        transform-origin: 50% 50%;
        transform-style: preserve-3d;
        will-change: transform;
        transition: filter 160ms ease, opacity 160ms ease;
      }

      #layer-koi .ms-ctrl-btn:hover,
      #layer-koi .ms-ctrl-btn:focus-visible {
        border: none;
        outline: none;
        filter: brightness(1.08);
      }

      #layer-koi .ms-ctrl-btn--active {
        border: none;
      }

      /* True double-sided 3D coin flipper (180deg sideways rotateY) */
      #layer-koi .ms-coin-flipper {
        position: relative;
        width: 100%;
        height: 100%;
        transform-style: preserve-3d;
        transition: transform 540ms cubic-bezier(0.30, 0.08, 0.22, 1);
        pointer-events: none;
      }

      #layer-koi .ms-ctrl-btn--flipped .ms-coin-flipper {
        transform: rotateY(180deg);
      }

      #layer-koi .ms-coin-face {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        backface-visibility: hidden;
        -webkit-backface-visibility: hidden;
        pointer-events: none;
        transition: opacity 0ms linear 250ms;
      }

      #layer-koi .ms-coin-face--front {
        opacity: 1;
      }

      #layer-koi .ms-coin-face--back {
        transform: rotateY(180deg);
        opacity: 0;
      }

      #layer-koi .ms-ctrl-btn--flipped .ms-coin-face--front {
        opacity: 0;
      }

      #layer-koi .ms-ctrl-btn--flipped .ms-coin-face--back {
        opacity: 1;
      }

      #layer-koi .ms-ctrl-icon {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
        border-radius: 50%;
        pointer-events: none;
        user-select: none;
        filter:
          drop-shadow(0 8px 12px rgba(0, 0, 0, 0.40))
          drop-shadow(0 2px 4px rgba(0, 0, 0, 0.26));
      }

      #layer-koi .ms-coin-sheen {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        pointer-events: none;
        mix-blend-mode: screen;
        opacity: 0.9;
        transform: translateZ(1px);
      }

      #layer-koi .ms-ctrl-btn--sys-time::after {
        content: "";
        position: absolute;
        bottom: 6px;
        right: 6px;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: radial-gradient(circle, #fff3c4 0%, #e6b44c 65%, #a8741c 100%);
        box-shadow: 0 0 7px rgba(242, 196, 86, 0.88);
        pointer-events: none;
        z-index: 4;
        transform: translateZ(2px);
      }

      #layer-koi .ms-ctrl-btn--flashlight {
        z-index: 1;
      }

      #layer-koi .ms-ctrl-btn--flashlight-off {
        opacity: 1;
        filter: none;
      }

      #layer-koi .ms-floating-controls[data-art-style="sumie"] .ms-ctrl-btn:hover,
      #layer-koi .ms-floating-controls[data-art-style="sumie"] .ms-ctrl-btn:focus-visible {
        filter: brightness(1.10);
      }

      #layer-koi .ms-floating-controls[data-art-style="sumie"] .ms-ctrl-btn--sys-time::after {
        background: #c4281c;
        box-shadow: 0 0 6px rgba(196, 40, 28, 0.65);
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

    const toggleFlipper = document.createElement("div");
    toggleFlipper.className = "ms-coin-flipper";

    const sunFace = document.createElement("div");
    sunFace.className = "ms-coin-face ms-coin-face--front";
    const sunIcon = document.createElement("img");
    sunIcon.className = "ms-ctrl-icon";
    sunIcon.alt = "";
    sunIcon.draggable = false;
    sunIcon.src = ICON_SUN_URI;
    sunFace.appendChild(sunIcon);

    const moonFace = document.createElement("div");
    moonFace.className = "ms-coin-face ms-coin-face--back";
    const moonIcon = document.createElement("img");
    moonIcon.className = "ms-ctrl-icon";
    moonIcon.alt = "";
    moonIcon.draggable = false;
    moonIcon.src = ICON_MOON_URI;
    moonFace.appendChild(moonIcon);

    toggleFlipper.appendChild(sunFace);
    toggleFlipper.appendChild(moonFace);
    toggleBtn.appendChild(toggleFlipper);

    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      // 3-state cycle: System Time (null) -> opposite manual mode -> other manual mode -> back to System Time (null)
      if (this.manualThemeOverride === null) {
        const anchorLight = this.renderer.isLightMode;
        this.themeToggleAnchorLight = anchorLight;
        const firstManual = !anchorLight;
        this.manualThemeOverride = firstManual;
        this.renderer.setLightMode(firstManual, false);
      } else if (
        this.themeToggleAnchorLight !== null &&
        this.manualThemeOverride !== this.themeToggleAnchorLight
      ) {
        const secondManual = this.themeToggleAnchorLight;
        this.manualThemeOverride = secondManual;
        this.renderer.setLightMode(secondManual, false);
      } else {
        this.manualThemeOverride = null;
        this.themeToggleAnchorLight = null;
        this.lastSystemSyncMs = performance.now();
        this.renderer.transitionToTimeOfDayHours(this.getCurrentSystemHours(), false);
      }
      this.mizuhikiChain?.nudgeByElement(toggleBtn, this.renderer.isLightMode ? 1 : -1);
      this.updateControlsUI();
      this.syncPortfolioUI(0);
      this.renderFrame();
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
    profileIcon.src = ICON_PROFILE_COIN_URI;
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
        if (this.galleryOpen) {
          this.galleryOpen = false;
          this.galleryUI.setOpen(false, true);
        }
        this.portfolioUI.resetExpandedState();
        this.renderer.setPortraitPhotoRevealed(false, true);
        // Pond reaction at t=0 on open: convert button position to pond-local coordinates
        // the exact same way toLocal() does (via getActivePondRect)
        const pondRect = this.renderer.getActivePondRect(this.viewW, this.viewH);
        const localX = (btnX - pondRect.x) / pondRect.scale;
        const localY = (btnY - pondRect.y) / pondRect.scale;
        this.renderer.triggerPondClick(localX, localY, this.viewW, this.viewH);
        this.mizuhikiChain?.nudgeByElement(profileBtn, 1);
      }
      this.renderer.setProfileTargetOpen(this.profileOpen);
      this.updateControlsUI();
      this.syncPortfolioUI(0);
      this.renderFrame();
      this.schedule();
      this.emitStateChange();
    });

    // 2b. 秘術 Archive Scroll Toggle Button (Below Profile Coin)
    const scrollBtn = document.createElement("button");
    scrollBtn.type = "button";
    scrollBtn.className = "ms-ctrl-btn";
    scrollBtn.setAttribute("aria-label", "Toggle archive scroll gallery");
    scrollBtn.setAttribute("aria-expanded", "false");
    scrollBtn.title = "秘術 Archive Scroll";

    const scrollIcon = document.createElement("img");
    scrollIcon.className = "ms-ctrl-icon";
    scrollIcon.alt = "";
    scrollIcon.draggable = false;
    scrollBtn.appendChild(scrollIcon);

    scrollBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const btnRect = scrollBtn.getBoundingClientRect();
      const canvasRect = this.canvas.getBoundingClientRect();
      const btnX =
        btnRect.width > 0
          ? btnRect.left + btnRect.width * 0.5 - canvasRect.left
          : Math.max(40, this.viewW - 46);
      const btnY =
        btnRect.height > 0
          ? btnRect.top + btnRect.height * 0.5 - canvasRect.top
          : 205;

      const nextOpen = !this.galleryOpen;
      if (nextOpen) {
        const pondRect = this.renderer.getActivePondRect(this.viewW, this.viewH);
        const localX = (btnX - pondRect.x) / pondRect.scale;
        const localY = (btnY - pondRect.y) / pondRect.scale;
        this.renderer.triggerPondClick(localX, localY, this.viewW, this.viewH);
      }
      this.mizuhikiChain?.nudgeByElement(scrollBtn, nextOpen ? 1 : -1);
      this.setGalleryOpen(nextOpen);
    });

    // 3. Lamp / Flashlight Toggle Button (Shown in Night Mode)
    const flashlightBtn = document.createElement("button");
    flashlightBtn.type = "button";
    flashlightBtn.className = "ms-ctrl-btn ms-ctrl-btn--flashlight ms-ctrl-btn--active";
    flashlightBtn.setAttribute("role", "switch");
    flashlightBtn.setAttribute("aria-checked", "true");
    flashlightBtn.setAttribute("aria-label", "Toggle dark mode flashlight");
    flashlightBtn.title = "Toggle Flashlight On / Off";

    const flashFlipper = document.createElement("div");
    flashFlipper.className = "ms-coin-flipper";

    const flashFront = document.createElement("div");
    flashFront.className = "ms-coin-face ms-coin-face--front";
    const flashlightIcon = document.createElement("img");
    flashlightIcon.className = "ms-ctrl-icon";
    flashlightIcon.alt = "";
    flashlightIcon.draggable = false;
    flashlightIcon.src = ICON_FLASHLIGHT_OFF_URI;
    flashFront.appendChild(flashlightIcon);

    const flashBack = document.createElement("div");
    flashBack.className = "ms-coin-face ms-coin-face--back";
    const flashlightOffIcon = document.createElement("img");
    flashlightOffIcon.className = "ms-ctrl-icon";
    flashlightOffIcon.alt = "";
    flashlightOffIcon.draggable = false;
    flashlightOffIcon.src = ICON_FLASHLIGHT_URI;
    flashBack.appendChild(flashlightOffIcon);

    flashFlipper.appendChild(flashFront);
    flashFlipper.appendChild(flashBack);
    flashlightBtn.appendChild(flashFlipper);

    flashlightBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.renderer.toggleFlashlightEnabled();
      this.mizuhikiChain?.nudgeByElement(flashlightBtn, this.renderer.isFlashlightEnabled ? 1 : -1);
      this.updateControlsUI();
      this.schedule();
      if (this.reducedMotion.matches) this.drawStill();
      this.emitStateChange();
    });

    // 3. GitHub Repository Link Button
    const githubLink = document.createElement("a");
    githubLink.className = "ms-ctrl-btn";
    githubLink.href = "https://github.com/Saayan-Chowdhury-2004/Dual_KOI_Portfolio";
    githubLink.target = "_blank";
    githubLink.rel = "noopener noreferrer";
    githubLink.setAttribute("aria-label", "Open Dual KOI Portfolio on GitHub");
    githubLink.title = "GitHub — Dual KOI Portfolio";

    const githubIcon = document.createElement("img");
    githubIcon.className = "ms-ctrl-icon";
    githubIcon.alt = "";
    githubIcon.draggable = false;
    githubIcon.src = ICON_GITHUB_URI;
    githubLink.appendChild(githubIcon);
    githubLink.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    // 4. LinkedIn Profile Link Button
    const linkedinLink = document.createElement("a");
    linkedinLink.className = "ms-ctrl-btn";
    linkedinLink.href = "https://www.linkedin.com/in/saayan-chowdhury-pop2004/";
    linkedinLink.target = "_blank";
    linkedinLink.rel = "noopener noreferrer";
    linkedinLink.setAttribute("aria-label", "Open Saayan Chowdhury on LinkedIn");
    linkedinLink.title = "LinkedIn — Saayan Chowdhury";

    const linkedinIcon = document.createElement("img");
    linkedinIcon.className = "ms-ctrl-icon";
    linkedinIcon.alt = "";
    linkedinIcon.draggable = false;
    linkedinIcon.src = ICON_LINKEDIN_URI;
    linkedinLink.appendChild(linkedinIcon);
    linkedinLink.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    this.toggleBtn = toggleBtn;
    this.toggleSunIconEl = sunIcon;
    this.toggleMoonIconEl = moonIcon;
    this.profileBtn = profileBtn;
    this.profileIconEl = profileIcon;
    this.scrollBtn = scrollBtn;
    this.scrollIconEl = scrollIcon;
    this.githubIconEl = githubIcon;
    this.linkedinIconEl = linkedinIcon;
    this.flashlightBtn = flashlightBtn;
    this.flashlightIconEl = flashlightIcon;
    this.flashlightOffIconEl = flashlightOffIcon;

    // Bake sculpted 3D cast-metal Japanese coins for Mokkotsu (brass) & Sumi-e (ink-black day/night)
    const iconEntries: Array<["sun" | "moon" | "github" | "linkedin" | "flash" | "flashOff", string, boolean]> = [
      ["sun", ICON_SUN_URI, false],
      ["moon", ICON_MOON_URI, false],
      ["github", ICON_GITHUB_URI, false],
      ["linkedin", ICON_LINKEDIN_URI, false],
      ["flash", ICON_FLASHLIGHT_URI, false],
      ["flashOff", ICON_FLASHLIGHT_OFF_URI, false],
    ];
    const variants: readonly MizuhikiCoinVariant[] =
      this.renderer.getArtStyle() === "sumie" ? ["sumie-day", "sumie-night"] : ["brass"];
    for (const variant of variants) {
      for (const [key, srcUri, isOni] of iconEntries) {
        bakeMizuhikiCoinDataUrl(srcUri, variant, isOni, (bakedUri) => {
          this.coinUris[variant][key] = bakedUri;
          this.applyCoinArtForCurrentState();
        });
      }
      // Bake sculpted profile silhouette coin medallion for both Mokkotsu (brass) and Sumi-e (ink-black)
      bakeMizuhikiPortraitCoinDataUrl(ICON_PROFILE_COIN_URI, variant, (bakedUri) => {
        this.coinUris[variant].oni = bakedUri;
        this.applyCoinArtForCurrentState();
      });
      // Bake sculpted 秘術 scroll coin medallion for Mokkotsu (brass) and Sumi-e (ink-black / silver patina)
      bakeMizuhikiScrollCoinDataUrl(variant, (bakedUri) => {
        this.coinUris[variant].scroll = bakedUri;
        this.applyCoinArtForCurrentState();
      });
    }

    // Order top-to-bottom: Sun/Moon, Profile, 秘術 Scroll, GitHub, LinkedIn, Flashlight (bottommost)
    container.appendChild(toggleBtn);
    container.appendChild(profileBtn);
    container.appendChild(scrollBtn);
    container.appendChild(githubLink);
    container.appendChild(linkedinLink);
    container.appendChild(flashlightBtn);

    this.mizuhikiChain = new MizuhikiCoinChain(container, [
      toggleBtn,
      profileBtn,
      scrollBtn,
      githubLink,
      linkedinLink,
      flashlightBtn,
    ]);

    (this.canvas.parentElement ?? document.body).appendChild(container);
    return container;
  }

  private applyCoinArtForCurrentState(): void {
    const isSumie = this.renderer.getArtStyleMeta().id === "sumie";
    const variant: MizuhikiCoinVariant = isSumie
      ? this.renderer.isLightMode
        ? "sumie-day"
        : "sumie-night"
      : "brass";
    const map = this.coinUris[variant];
    if (map.sun && this.toggleSunIconEl.src !== map.sun) this.toggleSunIconEl.src = map.sun;
    if (map.moon && this.toggleMoonIconEl.src !== map.moon) this.toggleMoonIconEl.src = map.moon;
    if (map.oni && this.profileIconEl.src !== map.oni) this.profileIconEl.src = map.oni;
    if (map.scroll && this.scrollIconEl.src !== map.scroll) this.scrollIconEl.src = map.scroll;
    if (map.github && this.githubIconEl.src !== map.github) this.githubIconEl.src = map.github;
    if (map.linkedin && this.linkedinIconEl.src !== map.linkedin) this.linkedinIconEl.src = map.linkedin;
    // Swapped: front (ON) shows flashOff art, back (OFF) shows flash art
    if (map.flashOff && this.flashlightIconEl.src !== map.flashOff) this.flashlightIconEl.src = map.flashOff;
    if (map.flash && this.flashlightOffIconEl.src !== map.flash) this.flashlightOffIconEl.src = map.flash;
  }

  private updateControlsUI(): void {
    const isLight = this.renderer.isLightMode;
    const isOpen = this.profileOpen;
    const styleMeta = this.renderer.getArtStyleMeta();

    if (this.lastControlsLightMode !== isLight) {
      const wasInitial = this.lastControlsLightMode === null;
      this.lastControlsLightMode = isLight;
      this.controlsEl.classList.toggle("ms-controls--night", !isLight);
      this.toggleBtn.setAttribute("aria-checked", isLight ? "true" : "false");
      this.mizuhikiChain?.setFlashlightVisible(!isLight, wasInitial);
    }
    const isSystemSync = this.manualThemeOverride === null;
    this.toggleBtn.classList.toggle("ms-ctrl-btn--sys-time", isSystemSync);
    if (isSystemSync) {
      this.toggleBtn.title = "Lighting: Current Time of Day (Live) — Click to switch";
      this.toggleBtn.setAttribute("aria-label", "Lighting synced to current time of day. Click to switch.");
    } else if (this.manualThemeOverride) {
      this.toggleBtn.title = "Lighting: Day Mode — Click to switch";
      this.toggleBtn.setAttribute("aria-label", "Day mode active. Click to switch.");
    } else {
      this.toggleBtn.title = "Lighting: Night Mode — Click to switch";
      this.toggleBtn.setAttribute("aria-label", "Night mode active. Click to switch.");
    }
    this.syncCelestialToggleArc();

    if (this.lastControlsOpen !== isOpen) {
      this.lastControlsOpen = isOpen;
      this.profileBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
      this.profileBtn.classList.toggle("ms-ctrl-btn--active", isOpen);
    }

    const isGalleryOpen = this.galleryOpen;
    if (this.lastControlsGalleryOpen !== isGalleryOpen) {
      this.lastControlsGalleryOpen = isGalleryOpen;
      this.scrollBtn.setAttribute("aria-expanded", isGalleryOpen ? "true" : "false");
      this.scrollBtn.classList.toggle("ms-ctrl-btn--active", isGalleryOpen);
    }

    const styleChanged = this.lastControlsStyle !== styleMeta.id;
    if (styleChanged) {
      this.lastControlsStyle = styleMeta.id;
      this.controlsEl.setAttribute("data-art-style", styleMeta.id);
      this.portfolioUI.setArtStyle(styleMeta.id);
      this.galleryUI.setArtStyle(styleMeta.id);
      this.mizuhikiChain?.setArtStyle(styleMeta.id);
    }

    this.applyCoinArtForCurrentState();
    this.mizuhikiChain?.refreshLayout();

    const flashOn = this.renderer.isFlashlightEnabled;
    if (this.lastControlsFlashlight !== flashOn) {
      this.lastControlsFlashlight = flashOn;
      this.flashlightBtn.setAttribute("aria-checked", flashOn ? "true" : "false");
      this.flashlightBtn.classList.toggle("ms-ctrl-btn--active", flashOn);
      this.flashlightBtn.classList.toggle("ms-ctrl-btn--flashlight-off", !flashOn);
      this.flashlightBtn.classList.toggle("ms-ctrl-btn--flipped", !flashOn);
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
    this.galleryUI.setQualityAndMotion(this.qualityLevel, this.reducedMotion.matches);
    this.galleryUI.update(
      this.galleryOpen,
      this.renderer.isLightMode,
      this.viewW,
      this.viewH,
      this.world.config.cellWidth,
      this.world.config.cellHeight,
      dt
    );
    this.renderer.setActiveColumnRects([
      ...this.portfolioUI.getColumnScreenRects(),
      ...this.galleryUI.getScreenRects(),
    ]);
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
    const needsAnim = this.renderer.isTransitioning || this.portfolioUI.isAnimating || this.galleryUI.isAnimating;
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
    this.renderer.setActiveColumnRects([
      ...this.portfolioUI.getColumnScreenRects(),
      ...this.galleryUI.getScreenRects(),
    ]);
    this.renderer.render(
      ctx,
      this.viewW,
      this.viewH,
      this.world,
      this.world.time,
      this.world.config
    );
    this.syncCelestialToggleArc();
    this.syncFlashlightDomVeil();
  }

  private syncCelestialToggleArc(): void {
    if (!this.toggleBtn) return;
    // Flip coin sideways 180deg: Sun on front (Light/Day), Moon on back (Dark/Night)
    this.toggleBtn.classList.toggle("ms-ctrl-btn--flipped", !this.renderer.isLightMode);
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
    const galleryRoot = this.galleryUI.getRootElement();

    if (!fl.active) {
      if (portfolioRoot.style.maskImage || portfolioRoot.style.webkitMaskImage) {
        portfolioRoot.style.webkitMaskImage = "";
        portfolioRoot.style.maskImage = "";
      }
      if (galleryRoot.style.maskImage || galleryRoot.style.webkitMaskImage) {
        galleryRoot.style.webkitMaskImage = "";
        galleryRoot.style.maskImage = "";
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

    const galleryMask = `radial-gradient(circle ${rad}px at ${fl.x.toFixed(1)}px ${fl.y.toFixed(1)}px, rgba(0,0,0,1) 0%, rgba(0,0,0,${s22}) 22%, rgba(0,0,0,${s45}) 45%, rgba(0,0,0,${s68}) 68%, rgba(0,0,0,${s86}) 86%, rgba(0,0,0,${sOut}) 100%)`;
    galleryRoot.style.webkitMaskImage = galleryMask;
    galleryRoot.style.maskImage = galleryMask;

    const ctrlOriginX = this.controlsEl.offsetWidth > 0 ? this.controlsEl.offsetLeft : this.viewW - 163;
    const ctrlOriginY = this.controlsEl.offsetWidth > 0 ? this.controlsEl.offsetTop : 0;
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

    if (this.profileOpen || this.portfolioUI.isAnimating || this.galleryOpen || this.galleryUI.isAnimating) {
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
      !this.portfolioUI.isAnimating &&
      !this.galleryUI.isAnimating;
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

    const needsAnim = this.renderer.isTransitioning || this.portfolioUI.isAnimating || this.galleryUI.isAnimating;
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
      (targetEl.closest(".ms-floating-controls") || targetEl.closest(".bp-col") || targetEl.closest(".gs-scroll-panel") || targetEl.closest(".gs-lightbox"))
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
      (targetEl.closest(".ms-floating-controls") || targetEl.closest(".bp-col") || targetEl.closest(".gs-scroll-panel") || targetEl.closest(".gs-lightbox"))
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
      (targetEl.closest(".ms-floating-controls") ||
        targetEl.closest(".bp-col") ||
        targetEl.closest(".gs-scroll-panel") ||
        targetEl.closest(".gs-lightbox"))
    ) {
      return;
    }
    if (this.galleryOpen) {
      this.setGalleryOpen(false);
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
    this.schedule();
  };

  private setGalleryOpen(open: boolean): void {
    if (this.galleryOpen === open) return;
    this.galleryOpen = open;
    if (open && this.profileOpen) {
      this.profileOpen = false;
      this.portfolioUI.resetExpandedState();
      this.renderer.setProfileTargetOpen(false);
    }
    this.galleryUI.setOpen(open, true);
    this.updateControlsUI();
    this.syncPortfolioUI(0);
    this.renderFrame();
    this.schedule();
    this.emitStateChange();
  }

  private onWindowKeyDown = (e: KeyboardEvent) => {
    if (!this.isActiveLayer || !this.galleryOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (this.galleryUI.isLightboxOpen()) {
        this.galleryUI.closeLightbox();
      } else {
        this.setGalleryOpen(false);
      }
    } else if (this.galleryUI.isLightboxOpen()) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        this.galleryUI.stepLightbox(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        this.galleryUI.stepLightbox(1);
      }
    }
  };

  private onPointerLeave = () => {
    this.world.pointer.active = false;
    this.renderer.setFlashlightPointer(-1, -1, false);
  };
}
