/**
 * Unfolded Archive Scroll Gallery UI (`src/koi/galleryScroll.ts`).
 *
 * - Spans the exact combined viewport footprint of the left portrait frame + 4 profile
 *   columns (leaving the right-side Mizuhiki coin chain unobstructed).
 * - Animates open and closed using the exact same shared Cube-Grid Shockwave Ripple Field
 *   (`src/koi/rippleField.ts`) as the 4 Profile Columns (`src/koi/portfolioColumns.ts`).
 * - Matches the Profile Columns visual grammar across Mokkotsu (crimson brocade mount,
 *   gold filigree rules, antique washi parchment, floral scroll watermark) and Sumi-e
 *   (monochrome ink wash in both Day and Night modes).
 * - Supports internal vertical scrolling with dual-layer scrollTop synchronization.
 * - Groups related certificates & event photos into single tiles; clicking any tile opens
 *   a focused Zoom Lightbox where `<` and `>` step through the similar images in that group.
 */

import { FLOWER_COL_1_URI, RED_CARD_TEXTURE_URI } from "./columnArtData";
import { clamp } from "../math";
import {
  COLUMN_TEXT_FADE_SECONDS,
  COLUMN_TEXT_TRANSLATE_Y_PX,
  FLIP_CLOSE_DURATION,
  FLIP_OPEN_DURATION,
  REDUCED_MOTION_FADE_DURATION,
  RIM_WIDTH_TILES,
  TILE_MAX_EXTRUDE_PX,
  buildRippleFieldConfig,
  clamp01,
  computeAlignedTileSize,
  computeVirtualCenter,
  easeOutCubic,
  evaluateRippleTile,
  getFlipProgressAtDistance,
  type RippleCompositionBounds,
  type RippleFieldConfig,
  type RippleOrigin,
} from "./rippleField";
import {
  GALLERY_SCROLL_ITEMS,
  getGalleryCoverImageUri,
  type GalleryScrollItem,
} from "./galleryData";

const GALLERY_STYLE_ID = "hijutsu-gallery-scroll-styles";

export interface GalleryScrollCallbacks {
  onRequestClose: () => void;
  onStateChange: () => void;
}

export class GalleryScrollUI {
  private readonly root: HTMLElement;
  private readonly panelStageEl: HTMLElement;
  private readonly scrollInnerEl: HTMLElement;
  private readonly rippleCanvas: HTMLCanvasElement;
  private readonly rippleCtx: CanvasRenderingContext2D | null;
  private readonly bodyScrollEl: HTMLElement;
  private readonly lightboxEl: HTMLElement;
  private readonly lbPrevBtn: HTMLButtonElement;
  private readonly lbNextBtn: HTMLButtonElement;
  private readonly lbImgEl: HTMLImageElement;
  private readonly lbCategoryEl: HTMLElement;
  private readonly lbTitleEl: HTMLElement;
  private readonly lbSlideLabelEl: HTMLElement;
  private readonly lbMetaEl: HTMLElement;
  private readonly lbNoteEl: HTMLElement;
  private readonly lbCounterEl: HTMLElement;
  private readonly lbDotsEl: HTMLElement;

  private brocadeImg: HTMLImageElement | null = null;
  private brocadeBitmap: ImageBitmap | null = null;
  private brocadeLoaded = false;

  private readonly items: readonly GalleryScrollItem[] = GALLERY_SCROLL_ITEMS;
  private targetOpen = false;
  private flipProgress = 0;
  private readonly flipOpenDuration = FLIP_OPEN_DURATION;
  private readonly flipCloseDuration = FLIP_CLOSE_DURATION;

  private rippleOrigin: RippleOrigin = { x: 640, y: 400 };
  private currentCellW = 8;
  private currentCellH = 8;
  private currentQualityLevel = 0;
  private reducedMotion = false;
  private domSettled = false;
  private lastUpdateNow = 0;

  private activeItemIndex: number | null = null;
  private activeSlideIndex = 0;
  private slideTransitionDir: -1 | 0 | 1 = 0;
  private artStyle: "mokkotsu" | "sumie" = "mokkotsu";
  private isLightMode = true;

  private canvasW = 0;
  private canvasH = 0;
  private cachedLeftPx = 24;
  private cachedRightClearance = 124;
  private cachedTopPx = 24;
  private cachedHeightPx = 800;

  constructor(
    parent: HTMLElement,
    private readonly callbacks: GalleryScrollCallbacks
  ) {
    this.injectStyles();

    const root = document.createElement("div");
    root.className = "gs-root";
    root.setAttribute("data-art-style", "mokkotsu");
    root.setAttribute("aria-hidden", "true");
    root.style.opacity = "0";
    root.style.visibility = "hidden";

    // Stage wrapper that receives the shockwave radial reveal mask
    // (kept separate from .gs-root, which owns the Dark Mode flashlight veil mask)
    const panelStage = document.createElement("div");
    panelStage.className = "gs-panel-stage";

    // 1. Unfolded scroll frame spanning portrait + 4 columns
    const panel = document.createElement("section");
    panel.className = "gs-scroll-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Archive Scroll");

    const scrollInner = document.createElement("div");
    scrollInner.className = "gs-scroll-inner";

    // Integrated parchment header matching expanded profile column (.bp-title-zone)
    const header = document.createElement("header");
    header.className = "gs-header";
    header.innerHTML = `
      <div class="gs-kicker-row">
        <span class="gs-kicker">ARCHIVE SCROLL</span>
        <span class="gs-entry-count">${String(this.items.length).padStart(2, "0")} ENTRIES</span>
      </div>
      <h2 class="gs-title">Certificates, Awards &amp; Moments</h2>
      <div class="gs-subtitle">Selected national hackathons, honors, internships &amp; talks</div>
    `;

    // Scrollable interior parchment body
    const bodyScroll = document.createElement("div");
    bodyScroll.className = "gs-body-scroll";

    const grid = document.createElement("div");
    grid.className = "gs-grid";

    this.items.forEach((item, idx) => {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "gs-tile";
      tile.setAttribute("data-gs-idx", String(idx));
      tile.setAttribute(
        "aria-label",
        item.slides.length > 1
          ? `Inspect ${item.title} (${item.slides.length} images)`
          : `Inspect ${item.title}`
      );

      const thumbWrap = document.createElement("div");
      thumbWrap.className = "gs-tile-thumb-wrap";

      const img = document.createElement("img");
      img.className = "gs-tile-img";
      img.alt = item.title;
      img.draggable = false;
      img.src = getGalleryCoverImageUri(item);
      thumbWrap.appendChild(img);

      const meta = document.createElement("div");
      meta.className = "gs-tile-meta";
      meta.innerHTML = `
        <div class="gs-tile-top-row">
          <span class="gs-tile-idx">${String(idx + 1).padStart(2, "0")}</span>
          <span class="gs-tile-year">${item.year}</span>
        </div>
        <div class="gs-tile-title">${item.title}</div>
        <div class="gs-tile-sub">${item.issuerOrMedium}</div>
      `;

      tile.appendChild(thumbWrap);
      tile.appendChild(meta);

      tile.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openLightbox(idx, 0);
      });

      grid.appendChild(tile);
    });

    bodyScroll.appendChild(grid);

    // Keep scroll isolated to the active layer; cross-layer scrollTop is synced
    // lazily in syncVisualStateFrom() before ink-wipe reveals to avoid scroll jitter.

    const footer = document.createElement("footer");
    footer.className = "gs-footer";
    footer.innerHTML = `
      <button type="button" class="gs-footer-close">[ FOLD SCROLL ]</button>
      <span class="gs-footer-folio">ARCHIVE</span>
    `;
    footer.querySelector<HTMLButtonElement>(".gs-footer-close")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.callbacks.onRequestClose();
    });

    scrollInner.appendChild(header);
    scrollInner.appendChild(bodyScroll);
    scrollInner.appendChild(footer);
    panel.appendChild(scrollInner);

    // Prevent clicks inside the unfolded scroll from bubbling to pond outside-click close
    panel.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    panelStage.appendChild(panel);

    // 2.5D Cube-Grid Shockwave Tile Canvas (matches Profile Columns animation)
    const rippleCanvas = document.createElement("canvas");
    rippleCanvas.className = "gs-ripple-canvas";
    rippleCanvas.setAttribute("aria-hidden", "true");

    // 2. Focused Zoom-Focus Lightbox Overlay (navigates within the clicked group's slides)
    const lightbox = document.createElement("div");
    lightbox.className = "gs-lightbox";
    lightbox.setAttribute("role", "dialog");
    lightbox.setAttribute("aria-modal", "true");
    lightbox.setAttribute("aria-hidden", "true");

    lightbox.innerHTML = `
      <div class="gs-lb-stage">
        <div class="gs-lb-card">
          <div class="gs-lb-media-wrap">
            <button type="button" class="gs-lb-nav gs-lb-prev" aria-label="Previous image">
              <svg class="gs-lb-nav-icon" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M10.25 3.25L5.5 8l4.75 4.75" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"/>
              </svg>
            </button>
            <img class="gs-lb-img" alt="" draggable="false" />
            <button type="button" class="gs-lb-nav gs-lb-next" aria-label="Next image">
              <svg class="gs-lb-nav-icon" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M5.75 3.25L10.5 8l-4.75 4.75" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"/>
              </svg>
            </button>
          </div>
          <div class="gs-lb-info">
            <div class="gs-lb-info-top">
              <span class="gs-lb-cat"></span>
              <span class="gs-lb-counter"></span>
            </div>
            <h3 class="gs-lb-title"></h3>
            <div class="gs-lb-slide-label"></div>
            <div class="gs-lb-meta"></div>
            <p class="gs-lb-note"></p>
            <div class="gs-lb-dots" role="tablist" aria-label="Related images in this group"></div>
          </div>
        </div>
      </div>
    `;

    this.lbPrevBtn = lightbox.querySelector<HTMLButtonElement>(".gs-lb-prev")!;
    this.lbNextBtn = lightbox.querySelector<HTMLButtonElement>(".gs-lb-next")!;
    this.lbImgEl = lightbox.querySelector<HTMLImageElement>(".gs-lb-img")!;
    this.lbCategoryEl = lightbox.querySelector<HTMLElement>(".gs-lb-cat")!;
    this.lbTitleEl = lightbox.querySelector<HTMLElement>(".gs-lb-title")!;
    this.lbSlideLabelEl = lightbox.querySelector<HTMLElement>(".gs-lb-slide-label")!;
    this.lbMetaEl = lightbox.querySelector<HTMLElement>(".gs-lb-meta")!;
    this.lbNoteEl = lightbox.querySelector<HTMLElement>(".gs-lb-note")!;
    this.lbCounterEl = lightbox.querySelector<HTMLElement>(".gs-lb-counter")!;
    this.lbDotsEl = lightbox.querySelector<HTMLElement>(".gs-lb-dots")!;

    const lbCard = lightbox.querySelector<HTMLElement>(".gs-lb-card")!;
    lbCard.addEventListener("click", (e) => e.stopPropagation());

    this.lbPrevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.stepLightbox(-1);
    });
    this.lbNextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.stepLightbox(1);
    });

    // Clicking outside the lightbox card dismisses the lightbox
    lightbox.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeLightbox();
    });

    root.appendChild(panelStage);
    root.appendChild(rippleCanvas);
    root.appendChild(lightbox);
    parent.appendChild(root);

    this.root = root;
    this.panelStageEl = panelStage;
    this.scrollInnerEl = scrollInner;
    this.rippleCanvas = rippleCanvas;
    this.rippleCtx = rippleCanvas.getContext("2d");
    this.bodyScrollEl = bodyScroll;
    this.lightboxEl = lightbox;

    this.initBrocadeTextureOnce();
  }

  private initBrocadeTextureOnce(): void {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      this.brocadeLoaded = true;
      if (typeof createImageBitmap === "function") {
        createImageBitmap(img)
          .then((bmp) => {
            this.brocadeBitmap = bmp;
          })
          .catch(() => {
            // Fallback uses this.brocadeImg directly
          });
      }
    };
    img.src = RED_CARD_TEXTURE_URI;
    this.brocadeImg = img;
  }

  public getRootElement(): HTMLElement {
    return this.root;
  }

  public getContainerOffset(): { left: number; top: number } {
    return { left: 0, top: 0 };
  }

  public isGalleryOpen(): boolean {
    return this.targetOpen;
  }

  public get isAnimating(): boolean {
    return this.targetOpen ? this.flipProgress < 1 : this.flipProgress > 0;
  }

  public getOpenProgress(): number {
    return this.flipProgress;
  }

  public syncFlipProgress(p: number): void {
    this.flipProgress = clamp01(p);
    this.domSettled = false;
  }

  public setQualityAndMotion(qualityLevel: number, reducedMotion: boolean): void {
    this.currentQualityLevel = qualityLevel;
    this.reducedMotion = reducedMotion;
  }

  private getCompositionBounds(): RippleCompositionBounds {
    const viewW = Math.max(320, this.canvasW || 1280);
    const panelRight = Math.max(this.cachedLeftPx + 120, viewW - this.cachedRightClearance);
    const panelBottom = this.cachedTopPx + this.cachedHeightPx;
    return {
      minX: this.cachedLeftPx,
      minY: this.cachedTopPx,
      maxX: panelRight,
      maxY: panelBottom,
    };
  }

  public getScreenRects(): Array<{ x: number; y: number; w: number; h: number }> {
    if (this.flipProgress <= 0.002 || this.canvasW < 1 || this.canvasH < 1) return [];
    const x = this.cachedLeftPx;
    const y = this.cachedTopPx;
    const w = Math.max(120, this.canvasW - this.cachedLeftPx - this.cachedRightClearance);
    const h = this.cachedHeightPx;
    return [{ x, y, w, h }];
  }

  public isLightboxOpen(): boolean {
    return this.targetOpen && this.activeItemIndex !== null;
  }

  public getScrollTop(): number {
    return this.bodyScrollEl.scrollTop;
  }

  public getActiveItemIndex(): number | null {
    return this.activeItemIndex;
  }

  public getActiveSlideIndex(): number {
    return this.activeSlideIndex;
  }

  public getViewportBounds(): { left: number; top: number; right: number; bottom: number } | null {
    if (this.flipProgress <= 0.01 || this.canvasW < 1 || this.canvasH < 1) return null;
    return {
      left: this.cachedLeftPx,
      top: this.cachedTopPx,
      right: Math.max(this.cachedLeftPx + 1, this.canvasW - this.cachedRightClearance),
      bottom: this.cachedTopPx + this.cachedHeightPx,
    };
  }

  public setArtStyle(style: "mokkotsu" | "sumie"): void {
    if (this.artStyle === style) return;
    this.artStyle = style;
    this.root.setAttribute("data-art-style", style);
    this.domSettled = false;
  }

  public setLightMode(isLight: boolean): void {
    if (this.isLightMode === isLight) return;
    this.isLightMode = isLight;
    this.root.classList.toggle("gs-theme-light", isLight);
    this.domSettled = false;
  }

  private updateLayout(viewportW: number, viewportH: number): boolean {
    if (viewportW < 1 || viewportH < 1) return false;
    const isNarrow = viewportW < 820;
    const leftPx = isNarrow ? 16 : Math.round(clamp(24, 38, viewportW * 0.022));
    const rightClearance = isNarrow ? 16 : 124;
    const topPx = isNarrow ? 16 : 24;
    const heightPx = isNarrow
      ? Math.max(240, viewportH - 32)
      : Math.max(260, viewportH - 48);

    if (
      this.canvasW === viewportW &&
      this.canvasH === viewportH &&
      this.cachedLeftPx === leftPx &&
      this.cachedRightClearance === rightClearance &&
      this.cachedTopPx === topPx &&
      this.cachedHeightPx === heightPx
    ) {
      return false;
    }

    this.canvasW = viewportW;
    this.canvasH = viewportH;
    this.cachedLeftPx = leftPx;
    this.cachedRightClearance = rightClearance;
    this.cachedTopPx = topPx;
    this.cachedHeightPx = heightPx;

    const stageW = Math.max(120, viewportW - leftPx - rightClearance);
    this.panelStageEl.style.left = `${leftPx}px`;
    this.panelStageEl.style.right = `${rightClearance}px`;
    this.panelStageEl.style.top = `${topPx}px`;
    this.panelStageEl.style.height = `${heightPx}px`;

    this.rippleCanvas.style.left = `${leftPx}px`;
    this.rippleCanvas.style.top = `${topPx}px`;
    this.rippleCanvas.style.width = `${stageW}px`;
    this.rippleCanvas.style.height = `${heightPx}px`;
    return true;
  }

  public setOpen(open: boolean, silent = false): void {
    if (this.targetOpen === open) return;
    this.targetOpen = open;
    this.domSettled = false;
    if (!open) {
      this.activeItemIndex = null;
      this.activeSlideIndex = 0;
      this.renderLightboxDOM();
    }
    this.root.setAttribute("aria-hidden", open ? "false" : "true");
    if (!silent) {
      this.callbacks.onStateChange();
    }
  }

  public update(
    isOpen: boolean,
    isLightMode: boolean,
    viewportW: number,
    viewportH: number,
    cellW: number,
    cellH: number,
    dt: number
  ): void {
    const nowMs = performance.now();
    const realDt =
      this.lastUpdateNow > 0
        ? Math.min(0.05, Math.max(0.001, (nowMs - this.lastUpdateNow) / 1000))
        : Math.max(0.001, Math.min(0.05, dt || 1 / 60));
    this.lastUpdateNow = nowMs;

    this.currentCellW = Math.max(4, cellW || 8);
    this.currentCellH = Math.max(4, cellH || 8);
    this.setLightMode(isLightMode);

    if (this.targetOpen !== isOpen) {
      this.targetOpen = isOpen;
      this.domSettled = false;
      if (!isOpen) {
        this.activeItemIndex = null;
        this.activeSlideIndex = 0;
        this.renderLightboxDOM();
      }
      this.root.setAttribute("aria-hidden", isOpen ? "false" : "true");
    }

    const openDur = this.reducedMotion ? REDUCED_MOTION_FADE_DURATION : this.flipOpenDuration;
    const closeDur = this.reducedMotion ? REDUCED_MOTION_FADE_DURATION : this.flipCloseDuration;

    if (this.targetOpen) {
      if (this.flipProgress < 1) {
        this.flipProgress = Math.min(1, this.flipProgress + realDt / openDur);
      }
    } else {
      if (this.flipProgress > 0) {
        this.flipProgress = Math.max(0, this.flipProgress - realDt / closeDur);
      }
    }

    const geomDirty = this.updateLayout(viewportW, viewportH);
    this.rippleOrigin = computeVirtualCenter(this.getCompositionBounds());

    if (this.flipProgress <= 0.002) {
      if (this.root.style.visibility !== "hidden") {
        this.root.style.opacity = "0";
        this.root.style.visibility = "hidden";
        this.root.classList.remove("gs-interactive");
        this.panelStageEl.style.webkitMaskImage = "";
        this.panelStageEl.style.maskImage = "";
        this.rippleCanvas.style.display = "none";
      }
      this.domSettled = false;
      return;
    }

    this.root.style.visibility = "visible";
    this.root.style.opacity = this.reducedMotion ? this.flipProgress.toFixed(3) : "1";
    this.root.classList.toggle("gs-interactive", this.flipProgress > 0.45);

    const isFlipFullySettled = this.flipProgress >= 0.999;
    if (this.domSettled && isFlipFullySettled && !geomDirty) {
      return;
    }

    if (this.reducedMotion) {
      this.panelStageEl.style.webkitMaskImage = "";
      this.panelStageEl.style.maskImage = "";
      this.rippleCanvas.style.display = "none";
      this.scrollInnerEl.style.opacity = "1";
      this.scrollInnerEl.style.transform = "none";
      this.domSettled = isFlipFullySettled;
      return;
    }

    if (isFlipFullySettled) {
      this.panelStageEl.style.webkitMaskImage = "";
      this.panelStageEl.style.maskImage = "";
      this.rippleCanvas.style.display = "none";
      this.scrollInnerEl.style.opacity = "1";
      this.scrollInnerEl.style.transform = "none";
      this.domSettled = true;
      return;
    }

    const compBounds = this.getCompositionBounds();
    const stageLeft = this.cachedLeftPx;
    const stageTop = this.cachedTopPx;
    const stageW = Math.max(120, viewportW - this.cachedLeftPx - this.cachedRightClearance);
    const stageH = this.cachedHeightPx;

    const tileSize = computeAlignedTileSize(
      this.currentCellW,
      this.currentCellH,
      viewportW,
      viewportH,
      this.currentQualityLevel
    );
    const rippleCfg = buildRippleFieldConfig(
      this.flipProgress,
      this.rippleOrigin,
      compBounds,
      tileSize,
      false
    );

    const localOx = this.rippleOrigin.x - stageLeft;
    const localOy = this.rippleOrigin.y - stageTop;
    const domRevealR = Math.max(0, rippleCfg.ringRadiusPx - RIM_WIDTH_TILES * 0.55 * tileSize);
    const featherPx = tileSize * 0.65;
    const maskCss = `radial-gradient(circle at ${localOx.toFixed(1)}px ${localOy.toFixed(1)}px, #000 ${Math.max(0, domRevealR - featherPx).toFixed(1)}px, transparent ${(domRevealR + featherPx * 0.35).toFixed(1)}px)`;
    this.panelStageEl.style.webkitMaskImage = maskCss;
    this.panelStageEl.style.maskImage = maskCss;

    const textFadeProgressSpan = COLUMN_TEXT_FADE_SECONDS / FLIP_OPEN_DURATION;
    const pCross = getFlipProgressAtDistance(
      Math.min(stageW, stageH) * 0.16,
      rippleCfg.maxCornerDist,
      rippleCfg.totalWaveSpanPx
    );
    const rawTextT = clamp01((this.flipProgress - pCross) / textFadeProgressSpan);
    const textEase = easeOutCubic(rawTextT);
    const ty = (1 - textEase) * COLUMN_TEXT_TRANSLATE_Y_PX;
    this.scrollInnerEl.style.opacity = textEase.toFixed(3);
    this.scrollInnerEl.style.transform =
      textEase >= 0.999 ? "none" : `translate3d(0, ${ty.toFixed(2)}px, 0)`;

    this.renderRippleCanvas(stageLeft, stageTop, stageW, stageH, isLightMode, rippleCfg);
    this.domSettled = false;
  }

  private renderRippleCanvas(
    stageLeft: number,
    stageTop: number,
    stageW: number,
    stageH: number,
    isLightMode: boolean,
    rippleCfg: RippleFieldConfig
  ): void {
    const ctx = this.rippleCtx;
    if (!ctx) return;

    const rw = Math.max(1, Math.round(stageW));
    const rh = Math.max(1, Math.round(stageH));
    if (this.rippleCanvas.width !== rw || this.rippleCanvas.height !== rh) {
      this.rippleCanvas.width = rw;
      this.rippleCanvas.height = rh;
    }
    if (this.rippleCanvas.style.display !== "block") {
      this.rippleCanvas.style.display = "block";
    }

    ctx.clearRect(0, 0, rw, rh);

    const tileSize = rippleCfg.tileSize;
    const isSumie = this.artStyle === "sumie";
    const brocadeSource = this.brocadeBitmap ?? (this.brocadeLoaded ? this.brocadeImg : null);

    const startCol = Math.floor(stageLeft / tileSize);
    const endCol = Math.ceil((stageLeft + stageW) / tileSize);
    const startRow = Math.floor(stageTop / tileSize);
    const endRow = Math.ceil((stageTop + stageH) / tileSize);

    for (let c = startCol; c < endCol; c++) {
      const worldX = c * tileSize;
      const localX = worldX - stageLeft;
      const tileCenterX = worldX + tileSize * 0.5;
      if (localX + tileSize < 0 || localX > stageW) continue;
      const isBorderX = localX < tileSize * 0.9 || stageW - (localX + tileSize) < tileSize * 0.9;

      for (let r = startRow; r < endRow; r++) {
        const worldY = r * tileSize;
        const localY = worldY - stageTop;
        const tileCenterY = worldY + tileSize * 0.5;
        if (localY + tileSize < 0 || localY > stageH) continue;

        const sample = evaluateRippleTile(
          tileCenterX,
          tileCenterY,
          this.flipProgress,
          this.rippleOrigin,
          rippleCfg
        );
        if (sample.reveal <= 0.001 || sample.settled) continue;

        const waveActivity = clamp01(sample.gridAlpha * 2.4);
        if (waveActivity <= 0.005) continue;

        const isBorderY = localY < tileSize * 0.9 || stageH - (localY + tileSize) < tileSize * 0.9;
        const isBorderTile = isBorderX || isBorderY;

        const shiftX = -sample.height * TILE_MAX_EXTRUDE_PX * 0.62;
        const shiftY = -sample.height * TILE_MAX_EXTRUDE_PX * 0.92;
        const drawX = localX + shiftX;
        const drawY = localY + shiftY;

        ctx.save();
        ctx.globalAlpha = waveActivity;

        if (sample.height > 0.03) {
          const depthPx = Math.max(1.5, sample.height * TILE_MAX_EXTRUDE_PX * 0.85);
          ctx.fillStyle = isSumie
            ? isLightMode
              ? "rgba(28, 24, 18, 0.52)"
              : "rgba(0, 0, 0, 0.78)"
            : "rgba(22, 3, 2, 0.68)";
          ctx.fillRect(drawX + 2, drawY + 2, tileSize + depthPx * 0.55, tileSize + depthPx * 0.82);

          ctx.fillStyle = isSumie ? (isLightMode ? "#aba08e" : "#0c0b09") : "#3e0604";
          ctx.fillRect(drawX + tileSize - 1, drawY + 1, depthPx * 0.55, tileSize);

          ctx.fillStyle = isSumie ? (isLightMode ? "#948978" : "#080706") : "#2b0403";
          ctx.fillRect(drawX + 1, drawY + tileSize - 1, tileSize + depthPx * 0.45, depthPx * 0.82);
        }

        if (!isSumie) {
          ctx.fillStyle = "#6e0e0a";
          ctx.fillRect(drawX, drawY, tileSize, tileSize);
          if (brocadeSource) {
            const bw =
              (brocadeSource as HTMLImageElement).naturalWidth ||
              brocadeSource.width ||
              512;
            const bh =
              (brocadeSource as HTMLImageElement).naturalHeight ||
              brocadeSource.height ||
              1024;
            const u0 = clamp01(localX / Math.max(1, stageW));
            const v0 = clamp01(localY / Math.max(1, stageH));
            const sw = Math.max(8, (tileSize / Math.max(1, stageW)) * bw);
            const sh = Math.max(8, (tileSize / Math.max(1, stageH)) * bh);
            const sx = clamp(u0 * (bw - sw), 0, Math.max(0, bw - sw));
            const sy = clamp(v0 * (bh - sh), 0, Math.max(0, bh - sh));
            ctx.drawImage(brocadeSource, sx, sy, sw, sh, drawX, drawY, tileSize, tileSize);
          }
          ctx.fillStyle = "rgba(20, 3, 2, 0.28)";
          ctx.fillRect(drawX, drawY, tileSize, tileSize);
        } else {
          ctx.fillStyle = isLightMode ? "#efe8d8" : "#181614";
          ctx.fillRect(drawX, drawY, tileSize, tileSize);
        }

        if (sample.craterFactor > 0.01) {
          const cAlpha = clamp01(sample.craterFactor * 0.64);
          ctx.fillStyle = isSumie
            ? isLightMode
              ? `rgba(32, 26, 20, ${(cAlpha * 0.55).toFixed(3)})`
              : `rgba(2, 2, 2, ${(cAlpha * 0.78).toFixed(3)})`
            : `rgba(18, 1, 1, ${cAlpha.toFixed(3)})`;
          ctx.fillRect(drawX, drawY, tileSize, tileSize);
          ctx.fillStyle = "rgba(0, 0, 0, 0.38)";
          ctx.fillRect(drawX, drawY, tileSize, 2);
          ctx.fillRect(drawX, drawY, 2, tileSize);
        }

        const goldStrength = clamp01(
          sample.rimFactor * 0.92 + (isBorderTile ? 0.32 * sample.gridAlpha : 0)
        );
        if (goldStrength > 0.01) {
          const gGrad = ctx.createLinearGradient(drawX, drawY, drawX + tileSize, drawY + tileSize);
          if (!isSumie) {
            gGrad.addColorStop(0.0, `rgba(255, 247, 196, ${(goldStrength * 0.88).toFixed(3)})`);
            gGrad.addColorStop(0.45, `rgba(230, 190, 83, ${(goldStrength * 0.76).toFixed(3)})`);
            gGrad.addColorStop(1.0, `rgba(196, 142, 32, ${(goldStrength * 0.84).toFixed(3)})`);
          } else if (isLightMode) {
            gGrad.addColorStop(0.0, `rgba(44, 39, 35, ${(goldStrength * 0.68).toFixed(3)})`);
            gGrad.addColorStop(1.0, `rgba(20, 18, 16, ${(goldStrength * 0.78).toFixed(3)})`);
          } else {
            gGrad.addColorStop(0.0, `rgba(250, 246, 238, ${(goldStrength * 0.82).toFixed(3)})`);
            gGrad.addColorStop(1.0, `rgba(184, 174, 156, ${(goldStrength * 0.72).toFixed(3)})`);
          }
          ctx.fillStyle = gGrad;
          ctx.fillRect(drawX, drawY, tileSize, tileSize);
        }

        if (sample.gridAlpha > 0.01) {
          ctx.strokeStyle = !isSumie
            ? `rgba(243, 214, 130, ${(sample.gridAlpha * 0.72).toFixed(3)})`
            : isLightMode
              ? `rgba(36, 32, 28, ${(sample.gridAlpha * 0.52).toFixed(3)})`
              : `rgba(226, 217, 200, ${(sample.gridAlpha * 0.56).toFixed(3)})`;
          ctx.lineWidth = 1;
          ctx.strokeRect(drawX + 0.5, drawY + 0.5, tileSize - 1, tileSize - 1);
        }

        ctx.restore();
      }
    }
  }

  public openLightbox(
    index: number,
    slideIndex = 0,
    silent = false,
    transitionDir: -1 | 0 | 1 = 0
  ): void {
    if (index < 0 || index >= this.items.length) return;
    const item = this.items[index];
    const safeSlide =
      item && item.slides.length > 0
        ? ((slideIndex % item.slides.length) + item.slides.length) % item.slides.length
        : 0;
    this.slideTransitionDir = transitionDir;
    this.activeItemIndex = index;
    this.activeSlideIndex = safeSlide;
    this.renderLightboxDOM();
    this.slideTransitionDir = 0;
    if (!silent) {
      this.callbacks.onStateChange();
    }
  }

  public closeLightbox(silent = false): void {
    if (this.activeItemIndex === null) return;
    this.slideTransitionDir = 0;
    this.activeItemIndex = null;
    this.activeSlideIndex = 0;
    this.renderLightboxDOM();
    if (!silent) {
      this.callbacks.onStateChange();
    }
  }

  public stepLightbox(delta: number): void {
    if (this.activeItemIndex === null) return;
    const item = this.items[this.activeItemIndex];
    if (!item || item.slides.length <= 1) return;
    const nextSlide = (this.activeSlideIndex + delta + item.slides.length) % item.slides.length;
    const dir: -1 | 1 = delta >= 0 ? 1 : -1;
    this.openLightbox(this.activeItemIndex, nextSlide, false, dir);
  }

  public syncState(
    isOpen: boolean,
    scrollTop?: number,
    activeItemIndex?: number | null,
    activeSlideIndex?: number
  ): void {
    this.targetOpen = isOpen;
    this.flipProgress = isOpen ? 1 : 0;
    this.domSettled = false;
    this.root.setAttribute("aria-hidden", isOpen ? "false" : "true");

    const nextIdx =
      isOpen &&
      typeof activeItemIndex === "number" &&
      activeItemIndex >= 0 &&
      activeItemIndex < this.items.length
        ? activeItemIndex
        : null;
    const item = nextIdx !== null ? this.items[nextIdx] : null;
    const nextSlide =
      item && typeof activeSlideIndex === "number" && item.slides.length > 0
        ? ((activeSlideIndex % item.slides.length) + item.slides.length) % item.slides.length
        : 0;

    if (this.activeItemIndex !== nextIdx || this.activeSlideIndex !== nextSlide) {
      this.activeItemIndex = nextIdx;
      this.activeSlideIndex = nextSlide;
      this.renderLightboxDOM();
    }

    if (typeof scrollTop === "number" && Number.isFinite(scrollTop)) {
      if (Math.abs(this.bodyScrollEl.scrollTop - scrollTop) > 0.5) {
        this.bodyScrollEl.scrollTop = scrollTop;
      }
    }
  }

  public syncVisualStateFrom(other: GalleryScrollUI): void {
    this.targetOpen = other.targetOpen;
    this.flipProgress = other.flipProgress;
    this.rippleOrigin = { x: other.rippleOrigin.x, y: other.rippleOrigin.y };
    this.domSettled = false;
    this.root.setAttribute("aria-hidden", this.targetOpen ? "false" : "true");

    if (
      this.activeItemIndex !== other.activeItemIndex ||
      this.activeSlideIndex !== other.activeSlideIndex
    ) {
      this.activeItemIndex = other.activeItemIndex;
      this.activeSlideIndex = other.activeSlideIndex;
      this.renderLightboxDOM();
    }

    if (Math.abs(this.bodyScrollEl.scrollTop - other.bodyScrollEl.scrollTop) > 0.5) {
      this.bodyScrollEl.scrollTop = other.bodyScrollEl.scrollTop;
    }
  }

  private renderLightboxDOM(): void {
    const hasItem = this.targetOpen && this.activeItemIndex !== null;
    this.lightboxEl.classList.toggle("gs-lightbox--open", hasItem);
    this.lightboxEl.setAttribute("aria-hidden", hasItem ? "false" : "true");
    if (!hasItem || this.activeItemIndex === null) return;

    const item = this.items[this.activeItemIndex];
    if (!item || item.slides.length === 0) return;

    const slideIdx = Math.min(Math.max(0, this.activeSlideIndex), item.slides.length - 1);
    const slide = item.slides[slideIdx];
    const hasMultiple = item.slides.length > 1;

    this.lbPrevBtn.style.display = hasMultiple ? "inline-flex" : "none";
    this.lbNextBtn.style.display = hasMultiple ? "inline-flex" : "none";
    this.lbPrevBtn.disabled = !hasMultiple;
    this.lbNextBtn.disabled = !hasMultiple;

    this.lbImgEl.src = slide.imageUri;
    this.lbImgEl.alt = `${item.title} — ${slide.label}`;
    if (this.slideTransitionDir !== 0 && !this.reducedMotion) {
      const animClass =
        this.slideTransitionDir > 0 ? "gs-lb-slide-in-next" : "gs-lb-slide-in-prev";
      this.lbImgEl.classList.remove("gs-lb-slide-in-next", "gs-lb-slide-in-prev");
      this.lbSlideLabelEl.classList.remove("gs-lb-text-fade");
      this.lbNoteEl.classList.remove("gs-lb-text-fade");
      void this.lbImgEl.offsetWidth;
      this.lbImgEl.classList.add(animClass);
      this.lbSlideLabelEl.classList.add("gs-lb-text-fade");
      this.lbNoteEl.classList.add("gs-lb-text-fade");
    } else {
      this.lbImgEl.classList.remove("gs-lb-slide-in-next", "gs-lb-slide-in-prev");
      this.lbSlideLabelEl.classList.remove("gs-lb-text-fade");
      this.lbNoteEl.classList.remove("gs-lb-text-fade");
    }
    this.lbCategoryEl.textContent = `${item.category.toUpperCase()} · ${item.year}`;
    this.lbCounterEl.textContent = hasMultiple
      ? `${slideIdx + 1} / ${item.slides.length}`
      : "";
    this.lbTitleEl.textContent = item.title;
    this.lbSlideLabelEl.textContent = slide.label;
    this.lbMetaEl.textContent = item.issuerOrMedium;
    this.lbNoteEl.textContent = slide.caption || item.contextNote;

    // Render clickable dots when a group has multiple similar images
    this.lbDotsEl.innerHTML = "";
    this.lbDotsEl.style.display = hasMultiple ? "flex" : "none";
    if (hasMultiple) {
      item.slides.forEach((s, idx) => {
        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = `gs-lb-dot${idx === slideIdx ? " gs-lb-dot--active" : ""}`;
        dot.setAttribute("role", "tab");
        dot.setAttribute("aria-selected", idx === slideIdx ? "true" : "false");
        dot.setAttribute("aria-label", `View ${s.label} (${idx + 1} of ${item.slides.length})`);
        dot.title = s.label;
        dot.addEventListener("click", (e) => {
          e.stopPropagation();
          if (this.activeItemIndex !== null) {
            const dir: -1 | 0 | 1 = idx > slideIdx ? 1 : idx < slideIdx ? -1 : 0;
            this.openLightbox(this.activeItemIndex, idx, false, dir);
          }
        });
        this.lbDotsEl.appendChild(dot);
      });
    }
  }

  public destroy(): void {
    this.root.remove();
  }

  private injectStyles(): void {
    if (document.getElementById(GALLERY_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = GALLERY_STYLE_ID;
    style.textContent = `
      #layer-koi .gs-root {
        --gs-heading: "Cormorant Garamond", Georgia, serif;
        --gs-subject: "EB Garamond", Georgia, serif;
        --gs-body: "Libre Baskerville", Georgia, serif;

        --gs-fg: #241a12;
        --gs-muted: #52402e;
        --gs-faint: #7c644c;
        --gs-accent: #9e2a1c;
        --gs-rule: rgba(104, 80, 52, 0.22);
        --gs-rule-strong: rgba(72, 52, 32, 0.48);
        --gs-paper: #f3eadb;
        --gs-thumb-bg: rgba(36, 26, 18, 0.045);

        position: absolute;
        inset: 0;
        z-index: 32;
        pointer-events: none;
        box-sizing: border-box;
        font-family: var(--gs-body);
        font-variant-numeric: tabular-nums;
      }

      #layer-koi .gs-root *,
      #layer-koi .gs-root *::before,
      #layer-koi .gs-root *::after {
        box-sizing: border-box;
      }

      #layer-koi .gs-panel-stage {
        position: absolute;
        z-index: 10;
        pointer-events: none;
      }

      #layer-koi .gs-ripple-canvas {
        position: absolute;
        z-index: 25;
        pointer-events: none;
        display: none;
      }

      /* Unfolded archive scroll matching Expanded Profile Column (.bp-col--col1.bp-col--is-expanded) */
      #layer-koi .gs-scroll-panel {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        pointer-events: none;
        background-color: #f3eadb;
        background-image: url("${FLOWER_COL_1_URI}");
        background-size: auto 100%;
        background-position: right center;
        background-repeat: no-repeat;
        border: 1.5px solid #8c6e4e;
        box-shadow:
          inset 0 0 0 4px rgba(243, 234, 219, 0.85),
          inset 0 0 0 5px rgba(140, 110, 78, 0.38),
          0 12px 30px rgba(38, 24, 12, 0.24);
        color: var(--gs-fg);
        overflow: hidden;
      }

      #layer-koi .gs-root.gs-interactive .gs-scroll-panel {
        pointer-events: auto;
      }

      /* Editorial container spanning the full available parchment region with comfortable border clearance */
      #layer-koi .gs-scroll-inner {
        position: relative;
        z-index: 2;
        display: flex;
        flex-direction: column;
        width: calc(100% - 205px);
        max-width: calc(100% - 205px);
        height: 100%;
        min-height: 0;
        padding: 26px 32px 20px 36px;
      }

      /* Integrated parchment header matching expanded profile column (.bp-title-zone) */
      #layer-koi .gs-header {
        flex: 0 0 auto;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 5px;
        padding: 0 0 12px 0;
        margin-bottom: 14px;
        border-bottom: 1.5px solid var(--gs-rule-strong);
      }

      #layer-koi .gs-kicker-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      #layer-koi .gs-kicker {
        font-family: var(--gs-heading);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--gs-accent);
      }

      #layer-koi .gs-entry-count {
        font-family: var(--gs-heading);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--gs-faint);
      }

      #layer-koi .gs-title {
        margin: 0;
        font-family: var(--gs-heading);
        font-size: clamp(24px, 2.2vw, 31px);
        font-weight: 700;
        line-height: 1.12;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--gs-fg);
      }

      #layer-koi .gs-subtitle {
        font-family: var(--gs-heading);
        font-style: italic;
        font-size: 13.5px;
        line-height: 1.4;
        color: var(--gs-muted);
        margin-top: 1px;
      }

      /* Scrollable interior matching .bp-body */
      #layer-koi .gs-body-scroll {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
        will-change: scroll-position;
        contain: layout style;
        padding: 2px 4px 12px 0;
        scrollbar-width: none;
      }

      #layer-koi .gs-body-scroll::-webkit-scrollbar {
        display: none;
      }

      /* Center-aligned responsive tile layout spanning the full available parchment region */
      #layer-koi .gs-grid {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        align-items: flex-start;
        gap: 32px 28px;
        width: 100%;
        padding-bottom: 10px;
      }

      /* Airy editorial tiles without bottom hairlines */
      #layer-koi .gs-tile {
        appearance: none;
        flex: 0 1 calc((100% - 84px) / 4);
        min-width: 215px;
        max-width: 270px;
        text-align: left;
        display: flex;
        flex-direction: column;
        padding: 0;
        background: transparent;
        border: none;
        color: inherit;
        cursor: pointer;
        transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
      }

      #layer-koi .gs-tile:hover,
      #layer-koi .gs-tile:focus-visible {
        transform: translateY(-2px);
        outline: none;
      }

      #layer-koi .gs-tile-thumb-wrap {
        position: relative;
        width: 100%;
        aspect-ratio: 4 / 3;
        background: var(--gs-thumb-bg);
        border: 1px solid var(--gs-rule-strong);
        box-shadow: inset 0 0 0 3px rgba(243, 234, 219, 0.65);
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 7px;
        transition: border-color 180ms ease, background-color 180ms ease;
      }

      #layer-koi .gs-tile:hover .gs-tile-thumb-wrap,
      #layer-koi .gs-tile:focus-visible .gs-tile-thumb-wrap {
        border-color: var(--gs-accent);
        background: rgba(158, 42, 28, 0.05);
      }

      #layer-koi .gs-tile-img {
        max-width: 100%;
        max-height: 100%;
        width: auto;
        height: auto;
        object-fit: contain;
        display: block;
      }

      #layer-koi .gs-tile-meta {
        padding: 9px 2px 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }

      #layer-koi .gs-tile-top-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-family: var(--gs-heading);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.1em;
      }

      #layer-koi .gs-tile-idx {
        color: var(--gs-accent);
      }

      #layer-koi .gs-tile-year {
        color: var(--gs-faint);
        font-variant-numeric: tabular-nums;
      }

      #layer-koi .gs-tile-title {
        font-family: var(--gs-heading);
        font-size: 17px;
        font-weight: 700;
        line-height: 1.22;
        color: var(--gs-fg);
      }

      #layer-koi .gs-tile:hover .gs-tile-title {
        color: var(--gs-accent);
      }

      #layer-koi .gs-tile-sub {
        font-family: var(--gs-subject);
        font-size: 12.5px;
        font-style: italic;
        line-height: 1.35;
        color: var(--gs-muted);
      }

      /* Pinned editorial footer matching .bp-col--is-expanded .bp-col-footer */
      #layer-koi .gs-footer {
        flex-shrink: 0;
        padding-top: 8px;
        margin-top: 6px;
        border-top: 1px solid var(--gs-rule-strong);
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-family: var(--gs-heading);
        font-size: 10.5px;
        font-weight: 700;
        letter-spacing: 0.12em;
        color: var(--gs-accent);
      }

      #layer-koi .gs-footer-close {
        appearance: none;
        border: none;
        background: transparent;
        padding: 0;
        margin: 0;
        font: inherit;
        letter-spacing: inherit;
        color: var(--gs-accent);
        cursor: pointer;
        transition: opacity 150ms ease;
      }

      #layer-koi .gs-footer-close:hover {
        opacity: 0.72;
      }

      #layer-koi .gs-footer-folio {
        color: var(--gs-faint);
      }

      /* Focused Zoom-Focus Lightbox Overlay */
      #layer-koi .gs-lightbox {
        position: absolute;
        inset: 0;
        z-index: 60;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 28px 132px 28px 28px;
        background: rgba(14, 10, 8, 0.78);
        backdrop-filter: blur(6px);
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        transition: opacity 210ms cubic-bezier(0.22, 1, 0.36, 1), visibility 210ms ease;
      }

      #layer-koi .gs-lightbox.gs-lightbox--open {
        opacity: 1;
        visibility: visible;
        pointer-events: auto;
      }

      #layer-koi .gs-lb-stage {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        max-width: 1120px;
        max-height: 100%;
      }

      #layer-koi .gs-lb-card {
        position: relative;
        flex: 0 0 auto;
        width: min(1040px, calc(100vw - 184px));
        height: min(620px, calc(100vh - 84px));
        display: grid;
        grid-template-columns: minmax(0, 1fr) 340px;
        grid-template-rows: minmax(0, 1fr);
        background: var(--gs-paper);
        border: 1.5px solid #8c6e4e;
        box-shadow:
          inset 0 0 0 4px rgba(243, 234, 219, 0.9),
          inset 0 0 0 5px rgba(140, 110, 78, 0.42),
          0 22px 54px rgba(0, 0, 0, 0.56);
        overflow: visible;
      }

      #layer-koi .gs-lightbox.gs-lightbox--open .gs-lb-card {
        opacity: 1;
        transform: translate3d(0, 0, 0) scale(1);
      }

      @keyframes gsSlideInNext {
        0% {
          opacity: 0;
          transform: translate3d(20px, 0, 0) scale(0.985);
        }
        100% {
          opacity: 1;
          transform: translate3d(0, 0, 0) scale(1);
        }
      }

      @keyframes gsSlideInPrev {
        0% {
          opacity: 0;
          transform: translate3d(-20px, 0, 0) scale(0.985);
        }
        100% {
          opacity: 1;
          transform: translate3d(0, 0, 0) scale(1);
        }
      }

      @keyframes gsTextFadeIn {
        0% {
          opacity: 0;
          transform: translate3d(0, 4px, 0);
        }
        100% {
          opacity: 1;
          transform: translate3d(0, 0, 0);
        }
      }

      #layer-koi .gs-lb-img.gs-lb-slide-in-next {
        animation: gsSlideInNext 200ms cubic-bezier(0.22, 1, 0.36, 1) both;
      }

      #layer-koi .gs-lb-img.gs-lb-slide-in-prev {
        animation: gsSlideInPrev 200ms cubic-bezier(0.22, 1, 0.36, 1) both;
      }

      #layer-koi .gs-lb-text-fade {
        animation: gsTextFadeIn 190ms cubic-bezier(0.22, 1, 0.36, 1) both;
      }

      #layer-koi .gs-lb-media-wrap {
        position: relative;
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px 30px;
        background: rgba(36, 26, 18, 0.055);
        border-right: 1px solid var(--gs-rule);
        overflow: visible;
      }

      #layer-koi .gs-lb-img {
        max-width: 100%;
        max-height: 100%;
        width: auto;
        height: auto;
        object-fit: contain;
        display: block;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
      }

      #layer-koi .gs-lb-info {
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        padding: 24px 24px 20px;
        overflow-y: auto;
        color: var(--gs-fg);
      }

      #layer-koi .gs-lb-info-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-family: var(--gs-heading);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.14em;
        color: var(--gs-accent);
        border-bottom: 1.5px solid var(--gs-rule-strong);
        padding-bottom: 8px;
        margin-bottom: 14px;
      }

      #layer-koi .gs-lb-title {
        margin: 0 0 6px;
        font-family: var(--gs-heading);
        font-size: 25px;
        font-weight: 700;
        line-height: 1.15;
        color: var(--gs-fg);
      }

      #layer-koi .gs-lb-slide-label {
        font-family: var(--gs-subject);
        font-size: 13.5px;
        font-weight: 600;
        letter-spacing: 0.04em;
        color: var(--gs-accent);
        margin-bottom: 6px;
      }

      #layer-koi .gs-lb-meta {
        font-family: var(--gs-subject);
        font-style: italic;
        font-size: 14px;
        color: var(--gs-faint);
        margin-bottom: 14px;
      }

      #layer-koi .gs-lb-note {
        margin: 0 0 18px;
        font-family: var(--gs-body);
        font-size: 12.5px;
        line-height: 1.68;
        color: var(--gs-muted);
        flex: 1 1 auto;
      }

      /* Circular editorial Prev / Next medallions anchored on left & right edges of media pane */
      #layer-koi .gs-lb-nav {
        appearance: none;
        position: absolute;
        top: 50%;
        z-index: 12;
        width: 36px;
        height: 36px;
        padding: 0;
        border-radius: 50%;
        border: 1.5px solid #8c6e4e;
        background: var(--gs-paper);
        color: var(--gs-fg);
        box-shadow:
          inset 0 0 0 2px rgba(243, 234, 219, 0.85),
          0 4px 14px rgba(34, 18, 8, 0.24);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, transform 150ms ease;
      }

      #layer-koi .gs-lb-prev {
        left: 0;
        transform: translate(-50%, -50%);
      }

      #layer-koi .gs-lb-next {
        right: 0;
        transform: translate(50%, -50%);
      }

      #layer-koi .gs-lb-prev:hover:not(:disabled),
      #layer-koi .gs-lb-prev:focus-visible:not(:disabled) {
        background: var(--gs-accent);
        border-color: var(--gs-accent);
        color: var(--gs-paper);
        box-shadow: 0 6px 16px rgba(34, 18, 8, 0.32);
        transform: translate(-50%, -50%) scale(1.06);
        outline: none;
      }

      #layer-koi .gs-lb-next:hover:not(:disabled),
      #layer-koi .gs-lb-next:focus-visible:not(:disabled) {
        background: var(--gs-accent);
        border-color: var(--gs-accent);
        color: var(--gs-paper);
        box-shadow: 0 6px 16px rgba(34, 18, 8, 0.32);
        transform: translate(50%, -50%) scale(1.06);
        outline: none;
      }

      #layer-koi .gs-lb-nav-icon {
        width: 15px;
        height: 15px;
        display: block;
        flex-shrink: 0;
      }

      #layer-koi .gs-lb-dots {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding-top: 12px;
        border-top: 1px solid var(--gs-rule);
      }

      #layer-koi .gs-lb-dot {
        appearance: none;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        padding: 0;
        border: 1.5px solid var(--gs-rule-strong);
        background: transparent;
        cursor: pointer;
        transition: background-color 150ms ease, transform 150ms ease, border-color 150ms ease;
      }

      #layer-koi .gs-lb-dot:hover {
        transform: scale(1.18);
        border-color: var(--gs-accent);
      }

      #layer-koi .gs-lb-dot.gs-lb-dot--active {
        background: var(--gs-accent);
        border-color: var(--gs-accent);
      }

      /* ===================== SUMI-E THEMING (DAY & NIGHT MATCH EXPANDED COLUMNS) ===================== */
      #layer-koi .gs-root[data-art-style="sumie"] {
        --gs-fg: #181512;
        --gs-muted: #38322c;
        --gs-faint: #5e554c;
        --gs-accent: #1c1916;
        --gs-rule: rgba(48, 42, 36, 0.22);
        --gs-rule-strong: rgba(28, 24, 20, 0.52);
        --gs-paper: #ebe3d3;
        --gs-thumb-bg: rgba(24, 21, 18, 0.05);
      }

      #layer-koi .gs-root[data-art-style="sumie"] .gs-scroll-panel {
        background-color: #ebe3d3;
        background-image:
          linear-gradient(90deg, #ebe3d3 0%, #ebe3d3 64%, rgba(235, 227, 211, 0) 78%),
          url("${FLOWER_COL_1_URI}");
        background-size: 100% 100%, auto 100%;
        background-position: left center, right center;
        background-repeat: no-repeat, no-repeat;
        background-blend-mode: normal, luminosity;
        border-color: #36302a;
        box-shadow:
          inset 0 0 0 4px rgba(235, 227, 211, 0.88),
          inset 0 0 0 5px rgba(54, 48, 42, 0.44),
          0 12px 30px rgba(18, 16, 14, 0.36);
      }

      #layer-koi .gs-root[data-art-style="sumie"] .gs-tile-thumb-wrap {
        box-shadow: inset 0 0 0 3px rgba(235, 227, 211, 0.72);
      }

      #layer-koi .gs-root[data-art-style="sumie"] .gs-tile:hover .gs-tile-thumb-wrap,
      #layer-koi .gs-root[data-art-style="sumie"] .gs-tile:focus-visible .gs-tile-thumb-wrap {
        background: rgba(28, 24, 20, 0.06);
      }

      #layer-koi .gs-root[data-art-style="sumie"] .gs-tile-img,
      #layer-koi .gs-root[data-art-style="sumie"] .gs-lb-img {
        filter: grayscale(0.88) contrast(1.06);
      }

      #layer-koi .gs-root[data-art-style="sumie"] .gs-lb-card {
        background: #ebe3d3;
        border-color: #36302a;
        box-shadow:
          inset 0 0 0 4px rgba(235, 227, 211, 0.90),
          inset 0 0 0 5px rgba(54, 48, 42, 0.42),
          0 22px 54px rgba(0, 0, 0, 0.62);
      }

      #layer-koi .gs-root[data-art-style="sumie"] .gs-lb-nav {
        background: #ebe3d3;
        border-color: #36302a;
        color: #181512;
        box-shadow:
          inset 0 0 0 2px rgba(235, 227, 211, 0.88),
          0 4px 14px rgba(14, 12, 10, 0.30);
      }

      @media (max-width: 1080px) {
        #layer-koi .gs-scroll-inner {
          width: calc(100% - 175px);
          max-width: calc(100% - 175px);
          padding: 22px 24px 18px 26px;
        }
        #layer-koi .gs-tile {
          flex: 0 1 calc((100% - 56px) / 3);
        }
      }

      @media (max-width: 860px) {
        #layer-koi .gs-scroll-inner {
          width: 100%;
          max-width: 100%;
          background: linear-gradient(90deg, rgba(243, 234, 219, 0.94) 0%, rgba(243, 234, 219, 0.84) 100%);
        }
        #layer-koi .gs-root[data-art-style="sumie"] .gs-scroll-inner {
          background: linear-gradient(90deg, rgba(235, 227, 211, 0.95) 0%, rgba(235, 227, 211, 0.86) 100%);
        }
        #layer-koi .gs-lightbox {
          padding: 16px;
        }
        #layer-koi .gs-lb-card {
          width: calc(100vw - 32px);
          height: min(740px, calc(100vh - 32px));
          grid-template-columns: 1fr;
          grid-template-rows: 54% 46%;
        }
        #layer-koi .gs-lb-media-wrap {
          border-right: none;
          border-bottom: 1px solid var(--gs-rule);
        }
      }
    `;
    document.head.appendChild(style);
  }
}
