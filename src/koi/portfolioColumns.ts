/**
 * 4-Column Imperial Red Brocade & Floral Scroll Portfolio UI (`src/portfolioColumns.ts`).
 *
 * Implements:
 * 1. Closed Columns (when not clicked): Rich crimson-red dragon/cloud brocade card texture
 *    (`image_7b8641.jpg` / `RED_CARD_TEXTURE_URI`) with all closed-state text rendered in a
 *    gleaming metallic golden foil texture (`--bp-gold-foil`) and gold filigree borders.
 *    Text elements are positioned across the full vertical height of each red column following
 *    the spatial layout of the reference columns (vertical top-right KanjiBrutalist column titles
 *    above the horizontal Folio band, vertical side-by-side Subject & Provenance stacks in Folio 01,
 *    and full-height vertical distribution across Folios 01–04 with zero unused space).
 * 2. Open Column (when clicked / `.bp-col--is-expanded`): Opens to its dedicated vertical
 *    flower scroll painting (`image_7b8e66.jpg`, `image_7b8dcc.jpg`, `image_7b8d8a.jpg`,
 *    `image_7b8d6a.jpg`), with all text written strictly inside the blank left paper region
 *    (`width: 58%`) so the painted flowers on the right remain completely unobstructed.
 * 3. Custom Font (`KanjiBrutalist`): Embedded via `@font-face` (`src/kanjiFontData.ts`) and used
 *    generously across column titles, folio headers, subject name, age numerals, skill/project
 *    headings, vertical spine bookmarks, and interactive controls.
 */

import {
  FLOWER_COL_1_URI,
  FLOWER_COL_2_URI,
  FLOWER_COL_3_URI,
  FLOWER_COL_4_URI,
  RED_CARD_TEXTURE_URI,
  WB_MAP_URI,
} from "./columnArtData";
import { clamp, smoothstep } from "../math";
import {
  COLUMN_TEXT_FADE_SECONDS,
  COLUMN_TEXT_TRANSLATE_Y_PX,
  CRATER_WIDTH_TILES,
  FLIP_CLOSE_DURATION,
  FLIP_OPEN_DURATION,
  RIM_WIDTH_TILES,
  REDUCED_MOTION_FADE_DURATION,
  TILE_MAX_EXTRUDE_PX,
  buildRippleFieldConfig,
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
  CONTACT_CHANNELS,
  EDUCATION_ITEMS,
  EXPERIENCE_ITEMS,
  PROJECT_TOPICS,
  SKILL_CATEGORIES,
  SUBJECT_PROFILE,
  computeDynamicAgeBreakdown,
  type DynamicAgeBreakdown,
} from "./portfolioData";

export { computeDynamicAgeBreakdown, type DynamicAgeBreakdown };

export interface InteractiveElementBounds {
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  intensity: number;
}

const STYLE_ELEMENT_ID = "brocade-floral-portfolio-columns-styles";

const SHRUNK_COL_WEIGHT = 0.11;
const EXPANDED_COL_WEIGHT = 4 - 3 * SHRUNK_COL_WEIGHT;
const SHRUNK_GAP_MULTIPLIER = 0.55;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function easeColumnTransition(t: number): number {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function buildVerticalCharStackHTML(text: string, extraClass = ""): string {
  const chars = Array.from(text);
  const spans = chars
    .map((ch) => {
      if (ch === " ") {
        return `<span class="bp-vchar bp-vchar--space" aria-hidden="true">&nbsp;</span>`;
      }
      return `<span class="bp-vchar">${ch}</span>`;
    })
    .join("");
  return `<span class="bp-vstack ${extraClass}" aria-label="${text}">${spans}</span>`;
}

export class BrutalistPortfolioUI {
  private readonly root: HTMLElement;
  private colsStageEl!: HTMLElement;
  private rippleCanvas!: HTMLCanvasElement;
  private rippleCtx: CanvasRenderingContext2D | null = null;
  private brocadeImg: HTMLImageElement | null = null;
  private brocadeBitmap: ImageBitmap | null = null;
  private brocadeLoaded = false;

  private colElements: HTMLElement[] = [];
  private colInnerWrappers: HTMLElement[] = [];

  private yearsValueEls: HTMLElement[] = [];
  private monthsValueEls: HTMLElement[] = [];
  private daysValueEls: HTMLElement[] = [];

  private lastSecond = -1;
  private lastLightMode: boolean | null = null;
  private lastUpdateNow = 0;

  private targetOpen = false;
  private flipProgress = 0;
  private readonly flipOpenDuration = FLIP_OPEN_DURATION;
  private readonly flipCloseDuration = FLIP_CLOSE_DURATION;

  private rippleOrigin: RippleOrigin = { x: 1200, y: 120 };
  private currentCellW = 8;
  private currentCellH = 8;
  private currentQualityLevel = 0;
  private reducedMotion = false;

  private expandedColIdx: number | null = null;
  private colWeights: [number, number, number, number] = [1, 1, 1, 1];
  private startColWeights: [number, number, number, number] = [1, 1, 1, 1];
  private targetColWeights: [number, number, number, number] = [1, 1, 1, 1];

  private gapMultipliers: [number, number, number] = [1, 1, 1];
  private startGapMultipliers: [number, number, number] = [1, 1, 1];
  private targetGapMultipliers: [number, number, number] = [1, 1, 1];

  private expandAnimProgress = 1;
  private readonly expandAnimDuration = 0.40;

  private activeProjectIdx: number | null = 0;
  private domSettled = false;

  private canvasW = 0;
  private canvasH = 0;
  private cachedLeftPx = 0;
  private cachedRightClearance = 0;
  private cachedTopPx = 24;
  private cachedHeightPx = 800;
  private cachedGapPx = 12;
  private baseColWidth = 100;
  private colLefts: [number, number, number, number] = [0, 0, 0, 0];
  private colWidths: [number, number, number, number] = [100, 100, 100, 100];

  private currentArtStyle: "mokkotsu" | "sumie" = "mokkotsu";

  constructor(parent: HTMLElement, private onStateChange?: () => void) {
    this.injectStyles();
    this.root = this.buildDOM();
    this.root.setAttribute("data-art-style", "mokkotsu");
    this.root.setAttribute("data-sumi-seal", "mono");
    this.root.style.setProperty("--bp-col1-title-size", "63px");
    this.root.style.setProperty("--bp-col2-title-size", "57px");
    this.root.style.setProperty("--bp-col3-title-size", "63px");
    this.root.style.setProperty("--bp-col4-title-size", "64px");
    parent.appendChild(this.root);
    this.initBrocadeTextureOnce();
    this.updateAgeDOM(new Date());
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

  public setRippleOrigin(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.rippleOrigin = { x, y };
    this.domSettled = false;
  }

  public getRippleOrigin(): RippleOrigin {
    return { x: this.rippleOrigin.x, y: this.rippleOrigin.y };
  }

  public setQualityAndMotion(qualityLevel: number, reducedMotion: boolean): void {
    this.currentQualityLevel = qualityLevel;
    this.reducedMotion = reducedMotion;
  }

  public getCompositionBounds(): RippleCompositionBounds {
    const viewW = Math.max(320, this.canvasW || 1280);
    const colsRight = Math.max(this.cachedLeftPx + 120, viewW - this.cachedRightClearance);
    const colsBottom = this.cachedTopPx + this.cachedHeightPx;

    return {
      minX: this.cachedLeftPx,
      minY: this.cachedTopPx,
      maxX: colsRight,
      maxY: colsBottom,
    };
  }

  public setArtStyle(style: "mokkotsu" | "sumie"): void {
    if (this.currentArtStyle === style) return;
    this.currentArtStyle = style;
    this.root.setAttribute("data-art-style", style);
  }

  public getRootElement(): HTMLElement {
    return this.root;
  }

  public getContainerOffset(): { left: number; top: number } {
    return { left: this.cachedLeftPx, top: this.cachedTopPx };
  }

  public getColumnsViewportBounds(): { left: number; top: number; right: number; bottom: number } | null {
    if (this.flipProgress <= 0.01 || this.canvasW < 1 || this.canvasH < 1) return null;
    return {
      left: this.cachedLeftPx,
      top: this.cachedTopPx,
      right: Math.max(this.cachedLeftPx + 1, this.canvasW - this.cachedRightClearance),
      bottom: this.cachedTopPx + this.cachedHeightPx,
    };
  }

  public syncFlipProgress(p: number): void {
    this.flipProgress = clamp01(p);
  }

  public getColumnScreenRects(): { x: number; y: number; w: number; h: number }[] {
    if (this.flipProgress <= 0.002) return [];
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    if (this.flipProgress >= 0.999 || this.reducedMotion) {
      for (let i = 0; i < 4; i++) {
        rects.push({
          x: this.colLefts[i],
          y: this.cachedTopPx,
          w: this.colWidths[i],
          h: this.cachedHeightPx,
        });
      }
      return rects;
    }

    const bounds = this.getCompositionBounds();
    this.rippleOrigin = computeVirtualCenter(bounds);
    const tileSize = computeAlignedTileSize(
      this.currentCellW,
      this.currentCellH,
      this.canvasW || 1280,
      this.canvasH || 800,
      this.currentQualityLevel
    );
    const cfg = buildRippleFieldConfig(
      this.flipProgress,
      this.rippleOrigin,
      bounds,
      tileSize,
      this.reducedMotion
    );

    for (let i = 0; i < 4; i++) {
      const x = this.colLefts[i];
      const y = this.cachedTopPx;
      const w = this.colWidths[i];
      const h = this.cachedHeightPx;
      // Closest point on column i's bounding box to rippleOrigin
      const nearX = clamp(this.rippleOrigin.x, x, x + w);
      const nearY = clamp(this.rippleOrigin.y, y, y + h);
      const minDist = Math.hypot(this.rippleOrigin.x - nearX, this.rippleOrigin.y - nearY);
      if (cfg.ringRadiusPx >= minDist - tileSize * 0.5) {
        rects.push({ x, y, w, h });
      }
    }
    return rects;
  }

  public get isAnimating(): boolean {
    const flipAnim = this.targetOpen ? this.flipProgress < 1 : this.flipProgress > 0;
    if (flipAnim) return true;
    if (this.expandAnimProgress < 1) return true;
    return false;
  }

  public onUserInteraction?: () => void;

  public getOpenProgress(): number {
    return this.flipProgress;
  }

  public getExpandedColumn(): number | null {
    return this.expandedColIdx;
  }

  public getActiveProjectTopic(): number | null {
    return this.activeProjectIdx;
  }

  public syncState(
    isOpen: boolean,
    expandedColIdx: number | null,
    activeProjectIdx: number | null
  ): void {
    this.targetOpen = isOpen;
    this.flipProgress = isOpen ? 1 : 0;
    const nextIdx = isOpen ? expandedColIdx : null;
    this.expandedColIdx = nextIdx;

    const weights: [number, number, number, number] =
      nextIdx === null
        ? [1, 1, 1, 1]
        : [
            nextIdx === 0 ? EXPANDED_COL_WEIGHT : SHRUNK_COL_WEIGHT,
            nextIdx === 1 ? EXPANDED_COL_WEIGHT : SHRUNK_COL_WEIGHT,
            nextIdx === 2 ? EXPANDED_COL_WEIGHT : SHRUNK_COL_WEIGHT,
            nextIdx === 3 ? EXPANDED_COL_WEIGHT : SHRUNK_COL_WEIGHT,
          ];
    this.colWeights = [...weights] as [number, number, number, number];
    this.startColWeights = [...weights] as [number, number, number, number];
    this.targetColWeights = [...weights] as [number, number, number, number];

    const gaps: [number, number, number] =
      nextIdx === null
        ? [1, 1, 1]
        : [SHRUNK_GAP_MULTIPLIER, SHRUNK_GAP_MULTIPLIER, SHRUNK_GAP_MULTIPLIER];
    this.gapMultipliers = [...gaps] as [number, number, number];
    this.startGapMultipliers = [...gaps] as [number, number, number];
    this.targetGapMultipliers = [...gaps] as [number, number, number];
    this.expandAnimProgress = 1;

    for (let i = 0; i < 4; i++) {
      const colEl = this.colElements[i];
      if (!colEl) continue;
      const isExp = nextIdx === i;
      colEl.classList.toggle("bp-col--is-expanded", isExp);
      colEl.classList.toggle("bp-col--is-shrunk", nextIdx !== null && !isExp);
      const cue = colEl.querySelector<HTMLElement>("[data-bp-footer-cue]");
      if (cue) {
        cue.textContent = isExp ? "[ FOLD SCROLL // 閉 ]" : "[ UNFOLD SCROLL // 開 ]";
      }
    }
    this.root.classList.toggle("bp-has-expanded-col", nextIdx !== null);

    this.activeProjectIdx = activeProjectIdx;
    const projCol = this.colElements[3];
    if (projCol) {
      const items = Array.from(projCol.querySelectorAll<HTMLElement>("[data-bp-project-item]"));
      for (const itemEl of items) {
        const pIdx = Number(itemEl.getAttribute("data-bp-project-item"));
        const isProjOpen = activeProjectIdx !== null && pIdx === activeProjectIdx;
        itemEl.classList.toggle("bp-project-item--active", isProjOpen);
        itemEl.setAttribute("aria-expanded", isProjOpen ? "true" : "false");
      }
    }
    if (this.canvasW > 0 && this.canvasH > 0) {
      this.updateColumnGeometry();
      if (this.flipProgress > 0.002 && this.flipProgress < 0.999) {
        this.domSettled = false;
        this.update(this.targetOpen, this.lastLightMode ?? true, this.canvasW, this.canvasH, 0, 0, this.currentCellW, this.currentCellH, 0);
      }
    }
    this.domSettled = false;
  }

  public syncLayoutFrom(other: BrutalistPortfolioUI): void {
    this.targetOpen = other.targetOpen;
    this.flipProgress = other.flipProgress;
    this.rippleOrigin = { x: other.rippleOrigin.x, y: other.rippleOrigin.y };
    this.reducedMotion = other.reducedMotion;
    this.currentQualityLevel = other.currentQualityLevel;
    this.currentCellW = other.currentCellW;
    this.currentCellH = other.currentCellH;
    const expandedChanged = this.expandedColIdx !== other.expandedColIdx;
    const projChanged = this.activeProjectIdx !== other.activeProjectIdx;
    if (expandedChanged || projChanged) {
      this.syncState(other.targetOpen, other.expandedColIdx, other.activeProjectIdx);
    }
    this.colWeights = [...other.colWeights] as [number, number, number, number];
    this.gapMultipliers = [...other.gapMultipliers] as [number, number, number];
    this.expandAnimProgress = other.expandAnimProgress;
    if (this.canvasW > 0 && this.canvasH > 0) {
      this.updateColumnGeometry();
    }
    for (let i = 0; i < 4; i++) {
      const myScroll = this.colElements[i]?.querySelector<HTMLElement>(".bp-col-body-scroll");
      const otherScroll = other.colElements[i]?.querySelector<HTMLElement>(".bp-col-body-scroll");
      if (myScroll && otherScroll && myScroll.scrollTop !== otherScroll.scrollTop) {
        myScroll.scrollTop = otherScroll.scrollTop;
      }
    }
  }

  public destroy(): void {
    this.root.remove();
  }

  public setExpandedColumn(idx: number | null): void {
    if (this.flipProgress < 0.75) return;
    const nextIdx = this.expandedColIdx === idx ? null : idx;
    this.expandedColIdx = nextIdx;

    this.startColWeights = [
      this.colWeights[0],
      this.colWeights[1],
      this.colWeights[2],
      this.colWeights[3],
    ];
    this.startGapMultipliers = [
      this.gapMultipliers[0],
      this.gapMultipliers[1],
      this.gapMultipliers[2],
    ];

    this.targetColWeights =
      nextIdx === null
        ? [1, 1, 1, 1]
        : [
            nextIdx === 0 ? EXPANDED_COL_WEIGHT : SHRUNK_COL_WEIGHT,
            nextIdx === 1 ? EXPANDED_COL_WEIGHT : SHRUNK_COL_WEIGHT,
            nextIdx === 2 ? EXPANDED_COL_WEIGHT : SHRUNK_COL_WEIGHT,
            nextIdx === 3 ? EXPANDED_COL_WEIGHT : SHRUNK_COL_WEIGHT,
          ];

    this.targetGapMultipliers =
      nextIdx === null
        ? [1, 1, 1]
        : [SHRUNK_GAP_MULTIPLIER, SHRUNK_GAP_MULTIPLIER, SHRUNK_GAP_MULTIPLIER];

    this.expandAnimProgress = 0;

    for (let i = 0; i < 4; i++) {
      const colEl = this.colElements[i];
      const isExp = nextIdx === i;
      colEl.classList.toggle("bp-col--is-expanded", isExp);
      colEl.classList.toggle("bp-col--is-shrunk", nextIdx !== null && !isExp);
      const cue = colEl.querySelector<HTMLElement>("[data-bp-footer-cue]");
      if (cue) {
        cue.textContent = isExp ? "[ FOLD SCROLL // 閉 ]" : "[ UNFOLD SCROLL // 開 ]";
      }
    }

    this.root.classList.toggle("bp-has-expanded-col", nextIdx !== null);

    if (nextIdx === 3 && this.activeProjectIdx === null) {
      this.setActiveProjectTopic(0, false);
    }

    this.domSettled = false;
    this.onStateChange?.();
    this.onUserInteraction?.();
  }

  private setActiveProjectTopic(projIdx: number, toggleIfSame = true): void {
    const nextProj = toggleIfSame && this.activeProjectIdx === projIdx ? null : projIdx;
    this.activeProjectIdx = nextProj;

    const projCol = this.colElements[3];
    if (!projCol) return;

    const items = Array.from(projCol.querySelectorAll<HTMLElement>("[data-bp-project-item]"));
    for (const itemEl of items) {
      const pIdx = Number(itemEl.getAttribute("data-bp-project-item"));
      const isOpen = nextProj !== null && pIdx === nextProj;
      itemEl.classList.toggle("bp-project-item--active", isOpen);
      itemEl.setAttribute("aria-expanded", isOpen ? "true" : "false");
    }

    this.onStateChange?.();
    this.onUserInteraction?.();
  }

  private injectStyles(): void {
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    style.textContent = `

      @import url("https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@500;700;800&family=Shippori+Mincho+B1:wght@500;700;800&display=swap");

      #layer-koi .bp-portfolio-root {
        --bp-kanji: "Shippori Mincho", "Shippori Mincho B1", Georgia, serif;
        --bp-serif: Georgia, "Times New Roman", serif;
        --bp-sans: "Geist Mono", system-ui, -apple-system, sans-serif;

        
        --bp-gold-foil: linear-gradient(
          135deg,
          #fff7c4 0%,
          #e6be53 22%,
          #fff3b8 46%,
          #c48e20 72%,
          #fae28c 100%
        );
        --bp-gold-solid: #f3d682;
        --bp-gold-muted: #dfbc64;
        --bp-gold-faint: rgba(242, 210, 124, 0.72);
        --bp-gold-rule: rgba(236, 198, 104, 0.34);
        --bp-gold-rule-strong: rgba(246, 216, 128, 0.68);

        position: absolute;
        inset: 0;
        z-index: 30;
        pointer-events: none;
        user-select: none;
        box-sizing: border-box;
        font-family: var(--bp-serif);
        font-variant-numeric: tabular-nums;
      }

      #layer-koi .bp-portfolio-root.bp-interactive {
        pointer-events: auto;
      }

      #layer-koi .bp-cols-stage {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        z-index: 10;
        pointer-events: inherit;
      }

      #layer-koi .bp-ripple-canvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        z-index: 25;
        pointer-events: none;
        display: none;
      }

      #layer-koi .bp-portfolio-root *,
      #layer-koi .bp-portfolio-root *::before,
      #layer-koi .bp-portfolio-root *::after {
        box-sizing: border-box;
      }

      
      #layer-koi .bp-col {
        position: absolute;
        top: 0;
        bottom: 0;
        display: flex;
        flex-direction: column;
        height: 100%;
        background-color: #6e0e0a;
        background-image:
          linear-gradient(180deg, rgba(24, 3, 2, 0.22) 0%, rgba(18, 2, 2, 0.44) 100%),
          url("${RED_CARD_TEXTURE_URI}");
        background-size: cover;
        background-position: center center;
        background-repeat: no-repeat;
        border: 1.5px solid #dcb658;
        box-shadow:
          inset 0 0 0 4px rgba(96, 12, 9, 0.85),
          inset 0 0 0 5px rgba(226, 188, 92, 0.42),
          0 8px 24px rgba(34, 14, 6, 0.28);
        color: var(--bp-gold-solid);
        overflow: hidden;
        cursor: pointer;
        transition:
          box-shadow 0.28s ease,
          border-color 0.28s ease,
          background-color 0.28s ease;
      }

      #layer-koi .bp-col:not(.bp-col--is-expanded):hover {
        border-color: #fff0a8;
        box-shadow:
          inset 0 0 0 4px rgba(108, 14, 10, 0.85),
          inset 0 0 0 5.5px rgba(255, 232, 148, 0.68),
          0 12px 28px rgba(34, 14, 6, 0.36);
      }

      
      #layer-koi .bp-col--col1.bp-col--is-expanded {
        background-color: #f3e9db;
        background-image: url("${FLOWER_COL_1_URI}");
        background-size: cover;
        background-position: right center;
        border-color: #8c6e4e;
        box-shadow:
          inset 0 0 0 4px rgba(243, 233, 219, 0.85),
          inset 0 0 0 5px rgba(140, 110, 78, 0.38),
          0 12px 30px rgba(38, 24, 12, 0.24);
        --bp-open-fg: #241a12;
        --bp-open-muted: #52402e;
        --bp-open-faint: #7c644c;
        --bp-open-accent: #9e2a1c;
        --bp-open-rule: rgba(104, 80, 52, 0.22);
        --bp-open-rule-strong: rgba(72, 52, 32, 0.48);
      }

      #layer-koi .bp-col--col2.bp-col--is-expanded {
        background-color: #fef8d9;
        background-image: url("${FLOWER_COL_2_URI}");
        background-size: cover;
        background-position: right center;
        border-color: #6a8470;
        box-shadow:
          inset 0 0 0 4px rgba(254, 248, 217, 0.85),
          inset 0 0 0 5px rgba(106, 132, 112, 0.38),
          0 12px 30px rgba(38, 24, 12, 0.24);
        --bp-open-fg: #1c261e;
        --bp-open-muted: #3e5042;
        --bp-open-faint: #647868;
        --bp-open-accent: #9a3022;
        --bp-open-rule: rgba(74, 98, 78, 0.22);
        --bp-open-rule-strong: rgba(48, 68, 52, 0.46);
      }

      #layer-koi .bp-col--col3.bp-col--is-expanded {
        background-color: #f3ebee;
        background-image: url("${FLOWER_COL_3_URI}");
        background-size: cover;
        background-position: right center;
        border-color: #968252;
        box-shadow:
          inset 0 0 0 4px rgba(243, 235, 238, 0.85),
          inset 0 0 0 5px rgba(150, 130, 82, 0.38),
          0 12px 30px rgba(38, 24, 12, 0.24);
        --bp-open-fg: #241c20;
        --bp-open-muted: #4e4046;
        --bp-open-faint: #76646c;
        --bp-open-accent: #8c521a;
        --bp-open-rule: rgba(108, 88, 96, 0.22);
        --bp-open-rule-strong: rgba(78, 60, 68, 0.46);
      }

      #layer-koi .bp-col--col4.bp-col--is-expanded {
        background-color: #b7c0c8;
        background-image: url("${FLOWER_COL_4_URI}");
        background-size: cover;
        background-position: right center;
        border-color: #586874;
        box-shadow:
          inset 0 0 0 4px rgba(183, 192, 200, 0.85),
          inset 0 0 0 5px rgba(72, 88, 100, 0.42),
          0 12px 30px rgba(24, 30, 36, 0.26);
        --bp-open-fg: #141c24;
        --bp-open-muted: #283440;
        --bp-open-faint: #465462;
        --bp-open-accent: #8c2016;
        --bp-open-rule: rgba(44, 58, 70, 0.24);
        --bp-open-rule-strong: rgba(28, 40, 52, 0.48);
      }

      
      #layer-koi .bp-col.bp-col--is-shrunk {
        box-shadow:
          inset 0 0 0 2px rgba(96, 12, 9, 0.88),
          inset 0 0 0 3px rgba(226, 188, 92, 0.40),
          0 6px 18px rgba(34, 14, 6, 0.26);
      }

      #layer-koi .bp-shrunk-spine {
        display: none;
        position: absolute;
        inset: 0;
        z-index: 5;
        flex-direction: column;
        align-items: center;
        justify-content: space-between;
        padding: 16px 1px;
        overflow: hidden;
        pointer-events: none;
      }

      #layer-koi .bp-col--is-shrunk .bp-shrunk-spine {
        display: flex;
      }

      #layer-koi .bp-shrunk-spine-num {
        font-family: var(--bp-sans);
        font-size: 9.5px;
        font-weight: 700;
        letter-spacing: 0.02em;
        line-height: 1;
        text-align: center;
        white-space: nowrap;
        background: var(--bp-gold-foil);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        filter: drop-shadow(0 1px 1px rgba(20, 3, 2, 0.8));
      }

      #layer-koi .bp-shrunk-spine-seal {
        font-family: var(--bp-kanji);
        font-size: 10.5px;
        font-weight: 700;
        line-height: 1;
        text-align: center;
        background: var(--bp-gold-foil);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        filter: drop-shadow(0 1px 1px rgba(20, 3, 2, 0.8));
      }

      #layer-koi .bp-shrunk-spine-title {
        font-family: var(--bp-serif);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.18em;
        line-height: 1;
        writing-mode: vertical-rl;
        text-orientation: mixed;
        white-space: nowrap;
        background: var(--bp-gold-foil);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        filter: drop-shadow(0 1px 2px rgba(20, 3, 2, 0.8));
      }

      #layer-koi .bp-col-inner {
        position: relative;
        z-index: 2;
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        padding: 14px 14px 10px 14px;
        transform-origin: left center;
      }

      
      #layer-koi .bp-col--is-expanded .bp-col-inner {
        width: 54% !important;
        max-width: 54% !important;
        padding: 22px 16px 18px 26px;
      }

      
      #layer-koi .bp-vstack {
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-start;
      }

      #layer-koi .bp-vchar {
        display: block;
        text-align: center;
        line-height: 0.91;
        background: var(--bp-gold-foil);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        filter: drop-shadow(0 1.5px 2px rgba(24, 3, 2, 0.82));
      }

      #layer-koi .bp-vchar--space {
        height: 0.36em;
      }

      
      #layer-koi .bp-title-zone {
        position: relative;
        flex-shrink: 0;
        height: clamp(114px, 18.2vh, 156px);
        padding: 2px 2px 8px 2px;
        display: flex;
        align-items: center;
        justify-content: flex-end;
      }

      #layer-koi .bp-col--is-expanded .bp-title-zone {
        height: auto;
        padding: 0 0 12px 0;
        margin-bottom: 10px;
        border-bottom: 1.5px solid var(--bp-open-rule-strong);
        flex-direction: column;
        align-items: stretch;
        justify-content: flex-start;
        gap: 5px;
      }

      #layer-koi .bp-folio-kicker-row {
        position: absolute;
        top: 2px;
        left: 2px;
        bottom: 6px;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        justify-content: space-between;
        pointer-events: none;
      }

      #layer-koi .bp-col--is-expanded .bp-folio-kicker-row {
        position: static;
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      #layer-koi .bp-folio-seal {
        font-family: var(--bp-kanji);
        font-size: 11px;
        padding: 1px 5px;
        border: 1px solid var(--bp-gold-rule-strong);
        color: var(--bp-gold-solid);
        order: 1;
      }

      #layer-koi .bp-col--is-expanded .bp-folio-seal {
        border-color: var(--bp-open-accent);
        color: var(--bp-open-accent);
        order: 2;
      }

      #layer-koi .bp-folio-numeral {
        font-family: var(--bp-kanji);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        writing-mode: vertical-rl;
        text-orientation: mixed;
        background: var(--bp-gold-foil);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        filter: drop-shadow(0 1px 1px rgba(20, 3, 2, 0.75));
        order: 2;
      }

      #layer-koi .bp-col--is-expanded .bp-folio-numeral {
        writing-mode: horizontal-tb;
        font-size: 12px;
        letter-spacing: 0.14em;
        background: none;
        -webkit-text-fill-color: var(--bp-open-accent);
        color: var(--bp-open-accent);
        filter: none;
        order: 1;
      }

      #layer-koi .bp-col-title {
        font-family: var(--bp-kanji);
        font-size: clamp(14.5px, 1.95vh, 19.5px);
        font-weight: 700;
        letter-spacing: 0.06em;
        line-height: 1.0;
        margin: 0 4px 0 auto;
        text-transform: uppercase;
        background: var(--bp-gold-foil);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        filter: drop-shadow(0 1.5px 2px rgba(24, 3, 2, 0.82));
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: flex-end;
        gap: 9px;
      }

      #layer-koi .bp-col-title-horiz-text {
        display: none;
      }

      #layer-koi .bp-col-title--identity .bp-vchar,
      #layer-koi .bp-col-title--projects .bp-vchar {
        font-size: clamp(14.5px, 1.96vh, 19.5px);
        line-height: 0.90;
      }

      #layer-koi .bp-col-title--education .bp-vchar {
        font-size: clamp(13px, 1.76vh, 17.5px);
        line-height: 0.89;
      }

      #layer-koi .bp-col-title--capabilities .bp-vchar {
        font-size: clamp(15.5px, 2.08vh, 21px);
        line-height: 0.90;
      }

      #layer-koi .bp-col--is-expanded .bp-col-title {
        margin: 0;
        font-size: clamp(24px, 2.1vw, 30px);
        line-height: 1.12;
        background: none;
        -webkit-text-fill-color: var(--bp-open-fg);
        color: var(--bp-open-fg);
        filter: none;
        display: block;
      }

      #layer-koi .bp-col--is-expanded .bp-col-title .bp-vstack {
        display: none;
      }

      #layer-koi .bp-col--is-expanded .bp-col-title-horiz-text {
        display: inline;
      }

      
      #layer-koi .bp-folio-band {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 4px;
        padding: 6px 2px;
        margin-bottom: 4px;
        border-top: 1.5px solid var(--bp-gold-rule-strong);
        border-bottom: 1.5px solid var(--bp-gold-rule-strong);
      }

      #layer-koi .bp-col--is-expanded .bp-folio-band {
        display: none;
      }

      #layer-koi .bp-folio-band-code {
        font-family: var(--bp-kanji);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        white-space: nowrap;
        flex-shrink: 0;
        background: var(--bp-gold-foil);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        filter: drop-shadow(0 1px 2px rgba(20, 3, 2, 0.78));
      }

      #layer-koi .bp-col-subtitle {
        font-family: var(--bp-kanji);
        font-size: 8.2px;
        font-weight: 700;
        letter-spacing: 0.045em;
        text-transform: uppercase;
        color: var(--bp-gold-muted);
        text-align: right;
        white-space: nowrap;
      }

      #layer-koi .bp-col-subtitle--expanded-only {
        display: none;
      }

      #layer-koi .bp-col--is-expanded .bp-col-subtitle--expanded-only {
        display: block;
        text-align: left;
        font-size: 10.5px;
        letter-spacing: 0.12em;
        color: var(--bp-open-faint);
      }

      #layer-koi .bp-expanded-title-sub {
        display: none;
        font-family: var(--bp-serif);
        font-style: italic;
        font-size: 13px;
        color: var(--bp-open-muted);
        line-height: 1.4;
        margin-top: 2px;
      }

      #layer-koi .bp-col--is-expanded .bp-expanded-title-sub {
        display: block;
      }

      
      #layer-koi .bp-body {
        flex: 1 1 auto;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        overflow-x: hidden;
        padding-right: 2px;
        scrollbar-width: none;
      }

      #layer-koi .bp-body::-webkit-scrollbar {
        display: none;
      }

      #layer-koi .bp-content {
        flex: 1 1 auto;
        min-height: 100%;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        padding-bottom: 2px;
      }

      #layer-koi .bp-col--is-expanded .bp-content {
        min-height: 0;
        justify-content: flex-start;
        padding-bottom: 10px;
      }

      
      #layer-koi .bp-block,
      #layer-koi .bp-edu-item,
      #layer-koi .bp-skill-item,
      #layer-koi .bp-project-item {
        position: relative;
        width: 100%;
        background: transparent;
        border: none;
        border-bottom: 1px solid var(--bp-gold-rule);
        padding: 8px 2px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 4px;
      }

      #layer-koi .bp-col:not(.bp-col--is-expanded) .bp-edu-item,
      #layer-koi .bp-col:not(.bp-col--is-expanded) .bp-skill-item,
      #layer-koi .bp-col:not(.bp-col--is-expanded) .bp-project-item {
        flex: 1 0 auto;
        justify-content: flex-end;
        padding: 6px 2px 9px 2px;
      }

      #layer-koi .bp-col--is-expanded .bp-block,
      #layer-koi .bp-col--is-expanded .bp-edu-item,
      #layer-koi .bp-col--is-expanded .bp-skill-item,
      #layer-koi .bp-col--is-expanded .bp-project-item {
        flex: 0 0 auto;
        justify-content: flex-start;
        padding: 12px 2px;
        gap: 5px;
        border-bottom-color: var(--bp-open-rule);
      }

      #layer-koi .bp-block:last-child,
      #layer-koi .bp-edu-item:last-child,
      #layer-koi .bp-skill-item:last-child,
      #layer-koi .bp-project-item:last-child {
        border-bottom: none;
      }

      
      #layer-koi .bp-col--col1:not(.bp-col--is-expanded) .bp-block--age {
        border-bottom: none;
        padding-bottom: 4px;
      }

      #layer-koi .bp-field-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        font-family: var(--bp-kanji);
        font-size: 10.5px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        background: var(--bp-gold-foil);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        filter: drop-shadow(0 1px 1px rgba(20, 3, 2, 0.7));
      }

      #layer-koi .bp-col--is-expanded .bp-field-meta {
        background: none;
        -webkit-text-fill-color: var(--bp-open-accent);
        color: var(--bp-open-accent);
        filter: none;
      }

      #layer-koi .bp-col--is-expanded .bp-meta-closed-only {
        display: none;
      }

      #layer-koi .bp-expanded-extra {
        display: none;
      }

      #layer-koi .bp-col--is-expanded .bp-expanded-extra {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 4px;
      }

      
      #layer-koi .bp-col--col1:not(.bp-col--is-expanded) .bp-block--identity-stage {
        flex: 1.4 0 auto;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        padding-top: 6px;
        padding-bottom: 10px;
      }

      #layer-koi .bp-col--col1:not(.bp-col--is-expanded) .bp-block--dob {
        flex: 0.5 0 auto;
        justify-content: center;
      }

      #layer-koi .bp-col--col1:not(.bp-col--is-expanded) .bp-block--age {
        flex: 0.65 0 auto;
        justify-content: flex-end;
      }

      #layer-koi .bp-identity-vertical-stage {
        display: flex;
        flex-direction: row;
        align-items: flex-start;
        justify-content: space-between;
        gap: 6px;
        padding: 8px 4px 6px 4px;
        flex: 1 1 auto;
        min-height: 0;
      }

      #layer-koi .bp-col--is-expanded .bp-identity-vertical-stage {
        display: none;
      }

      #layer-koi .bp-identity-vgroup {
        display: flex;
        flex-direction: row;
        align-items: flex-start;
        gap: clamp(7px, 0.65vw, 12px);
      }

      #layer-koi .bp-vstack--subject .bp-vchar {
        font-family: var(--bp-kanji);
        font-size: clamp(14.5px, 1.98vh, 20px);
        font-weight: 700;
        line-height: 1.04;
      }

      #layer-koi .bp-vstack--prov .bp-vchar {
        font-family: var(--bp-kanji);
        font-size: clamp(11px, 1.54vh, 15px);
        font-weight: 700;
        line-height: 1.04;
      }

      #layer-koi .bp-vstack--prov-muted .bp-vchar {
        font-family: var(--bp-kanji);
        font-size: clamp(10.5px, 1.46vh, 14px);
        font-weight: 700;
        line-height: 1.04;
        opacity: 0.84;
      }

      #layer-koi .bp-identity-vdivider {
        width: 1px;
        align-self: stretch;
        background: linear-gradient(
          180deg,
          var(--bp-gold-rule-strong) 0%,
          var(--bp-gold-rule) 78%,
          transparent 100%
        );
        margin: 0 2px;
        flex-shrink: 0;
      }

      #layer-koi .bp-identity-stage-footer {
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding-top: 8px;
        border-top: 1px dashed var(--bp-gold-rule);
      }

      #layer-koi .bp-col--is-expanded .bp-identity-stage-footer {
        display: none;
      }

      #layer-koi .bp-identity-pin-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      #layer-koi .bp-identity-pin-meta {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      #layer-koi .bp-identity-pin-code {
        font-family: var(--bp-kanji);
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.08em;
        background: var(--bp-gold-foil);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }

      #layer-koi .bp-identity-coords {
        font-size: 10.5px;
        color: var(--bp-gold-muted);
        opacity: 0.9;
      }

      
      #layer-koi .bp-identity-expanded-horiz {
        display: none;
      }

      #layer-koi .bp-col--is-expanded .bp-identity-expanded-horiz {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }

      
      #layer-koi .bp-subject-headline {
        font-family: var(--bp-kanji);
        font-size: clamp(18px, 1.55vw, 23px);
        font-weight: 700;
        letter-spacing: 0.05em;
        line-height: 1.2;
        background: var(--bp-gold-foil);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        filter: drop-shadow(0 1px 2px rgba(20, 3, 2, 0.78));
      }

      #layer-koi .bp-col--is-expanded .bp-subject-headline {
        background: none;
        -webkit-text-fill-color: var(--bp-open-fg);
        color: var(--bp-open-fg);
        filter: none;
      }

      #layer-koi .bp-subject-role {
        font-family: var(--bp-serif);
        font-style: italic;
        font-size: 12px;
        color: var(--bp-gold-muted);
        line-height: 1.36;
        text-shadow: 0 1px 2px rgba(20, 3, 2, 0.75);
      }

      #layer-koi .bp-col--is-expanded .bp-subject-role {
        font-size: 12.5px;
        color: var(--bp-open-muted);
        text-shadow: none;
      }

      #layer-koi .bp-location-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-top: 2px;
      }

      #layer-koi .bp-location-text {
        font-size: 12px;
        line-height: 1.48;
        color: var(--bp-gold-muted);
        text-shadow: 0 1px 2px rgba(20, 3, 2, 0.75);
      }

      #layer-koi .bp-col--is-expanded .bp-location-text {
        color: var(--bp-open-muted);
        text-shadow: none;
      }

      #layer-koi .bp-location-city {
        font-family: var(--bp-kanji);
        font-weight: 700;
        letter-spacing: 0.04em;
        color: var(--bp-gold-solid);
        display: block;
      }

      #layer-koi .bp-col--is-expanded .bp-location-city {
        color: var(--bp-open-fg);
      }

      #layer-koi .bp-wb-map-img {
        width: 34px;
        height: 52px;
        object-fit: contain;
        filter: sepia(1) saturate(3.2) hue-rotate(5deg) brightness(0.95);
        opacity: 0.9;
        flex-shrink: 0;
      }

      #layer-koi .bp-col--is-expanded .bp-wb-map-img {
        width: 38px;
        height: 58px;
        filter: invert(0.82) sepia(0.65) contrast(1.25);
        opacity: 0.78;
      }

      #layer-koi .bp-primary-value {
        font-family: var(--bp-kanji);
        font-size: 15px;
        font-weight: 700;
        letter-spacing: 0.06em;
        background: var(--bp-gold-foil);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        filter: drop-shadow(0 1px 2px rgba(20, 3, 2, 0.75));
      }

      #layer-koi .bp-col--is-expanded .bp-primary-value {
        background: none;
        -webkit-text-fill-color: var(--bp-open-fg);
        color: var(--bp-open-fg);
        filter: none;
      }

      
      #layer-koi .bp-age-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
        margin-top: 3px;
      }

      #layer-koi .bp-age-cell {
        border-left: 1.5px solid var(--bp-gold-rule-strong);
        padding: 2px 0 2px 8px;
        display: flex;
        flex-direction: column;
      }

      #layer-koi .bp-col--is-expanded .bp-age-cell {
        border-left-color: var(--bp-open-rule-strong);
      }

      #layer-koi .bp-age-num {
        font-family: var(--bp-kanji);
        font-size: clamp(20px, 1.7vw, 26px);
        font-weight: 700;
        line-height: 1.1;
        background: var(--bp-gold-foil);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        filter: drop-shadow(0 1px 2px rgba(20, 3, 2, 0.78));
      }

      #layer-koi .bp-col--is-expanded .bp-age-num {
        background: none;
        -webkit-text-fill-color: var(--bp-open-fg);
        color: var(--bp-open-fg);
        filter: none;
      }

      #layer-koi .bp-age-unit {
        font-family: var(--bp-kanji);
        font-size: 9.5px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--bp-gold-faint);
        margin-top: 2px;
      }

      #layer-koi .bp-col--is-expanded .bp-age-unit {
        color: var(--bp-open-faint);
      }

      
      #layer-koi .bp-contact-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px 14px;
        margin-top: 4px;
      }

      #layer-koi .bp-contact-card {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      #layer-koi .bp-contact-label {
        font-family: var(--bp-kanji);
        font-size: 9.5px;
        font-weight: 700;
        letter-spacing: 0.1em;
        color: var(--bp-open-accent);
      }

      #layer-koi .bp-contact-link {
        font-size: 11.5px;
        color: var(--bp-open-fg);
        text-decoration: underline;
        text-decoration-color: var(--bp-open-rule-strong);
        text-underline-offset: 3px;
        word-break: break-all;
      }

      #layer-koi .bp-exp-role {
        font-family: var(--bp-kanji);
        font-size: 15px;
        font-weight: 700;
        color: var(--bp-open-fg);
      }

      #layer-koi .bp-exp-grade {
        font-family: var(--bp-kanji);
        font-size: 10px;
        letter-spacing: 0.08em;
        color: var(--bp-open-accent);
        text-transform: uppercase;
      }

      #layer-koi .bp-exp-bullets,
      #layer-koi .bp-project-bullets {
        margin: 4px 0 0 0;
        padding-left: 15px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 12px;
        line-height: 1.48;
        color: var(--bp-open-muted);
      }

      
      #layer-koi .bp-edu-top-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
      }

      #layer-koi .bp-edu-idx {
        font-family: var(--bp-kanji);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        color: var(--bp-gold-faint);
        white-space: nowrap;
        flex-shrink: 0;
      }

      #layer-koi .bp-col--is-expanded .bp-edu-idx {
        color: var(--bp-open-faint);
      }

      #layer-koi .bp-edu-date {
        font-family: var(--bp-kanji);
        font-size: 9.5px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        white-space: nowrap;
        background: var(--bp-gold-foil);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        filter: drop-shadow(0 1px 1px rgba(20, 3, 2, 0.7));
      }

      #layer-koi .bp-col--is-expanded .bp-edu-date {
        font-size: 10px;
        background: none;
        -webkit-text-fill-color: var(--bp-open-accent);
        color: var(--bp-open-accent);
        filter: none;
      }

      #layer-koi .bp-edu-school {
        font-family: var(--bp-kanji);
        font-size: 13.8px;
        font-weight: 700;
        letter-spacing: 0.02em;
        line-height: 1.2;
        background: var(--bp-gold-foil);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        filter: drop-shadow(0 1px 2px rgba(20, 3, 2, 0.78));
      }

      #layer-koi .bp-col--is-expanded .bp-edu-school {
        font-size: 15px;
        line-height: 1.25;
        background: none;
        -webkit-text-fill-color: var(--bp-open-fg);
        color: var(--bp-open-fg);
        filter: none;
      }

      #layer-koi .bp-edu-degree {
        font-size: 11.5px;
        color: var(--bp-gold-muted);
        line-height: 1.3;
        text-shadow: 0 1px 2px rgba(20, 3, 2, 0.75);
      }

      #layer-koi .bp-col--is-expanded .bp-edu-degree {
        font-size: 12px;
        line-height: 1.38;
        color: var(--bp-open-muted);
        text-shadow: none;
      }

      #layer-koi .bp-edu-focus {
        font-family: var(--bp-serif);
        font-style: italic;
        font-size: 12.5px;
        color: var(--bp-open-accent);
      }

      #layer-koi .bp-edu-desc {
        font-size: 12px;
        line-height: 1.46;
        color: var(--bp-open-muted);
      }

      
      #layer-koi .bp-skill-head-row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 6px;
      }

      #layer-koi .bp-skill-cat {
        font-family: var(--bp-kanji);
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        background: var(--bp-gold-foil);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        filter: drop-shadow(0 1px 2px rgba(20, 3, 2, 0.78));
      }

      #layer-koi .bp-col--is-expanded .bp-skill-cat {
        font-size: 15px;
        background: none;
        -webkit-text-fill-color: var(--bp-open-fg);
        color: var(--bp-open-fg);
        filter: none;
      }

      #layer-koi .bp-skill-idx {
        font-family: var(--bp-kanji);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        color: var(--bp-gold-faint);
        white-space: nowrap;
        flex-shrink: 0;
      }

      #layer-koi .bp-col--is-expanded .bp-skill-idx {
        color: var(--bp-open-accent);
      }

      #layer-koi .bp-skill-entries {
        font-size: 11.5px;
        line-height: 1.34;
        color: var(--bp-gold-muted);
        text-shadow: 0 1px 2px rgba(20, 3, 2, 0.75);
      }

      #layer-koi .bp-col--is-expanded .bp-skill-entries {
        font-size: 12px;
        line-height: 1.42;
        color: var(--bp-open-muted);
        text-shadow: none;
      }

      #layer-koi .bp-skill-tags,
      #layer-koi .bp-project-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 2px;
      }

      #layer-koi .bp-skill-tag,
      #layer-koi .bp-project-tag {
        font-family: var(--bp-kanji);
        font-size: 9.5px;
        letter-spacing: 0.06em;
        padding: 1px 6px;
        border-bottom: 1px solid var(--bp-open-rule-strong);
        color: var(--bp-open-fg);
      }

      #layer-koi .bp-skill-summary {
        font-size: 12px;
        line-height: 1.46;
        color: var(--bp-open-muted);
      }

      
      #layer-koi .bp-project-meta-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
      }

      #layer-koi .bp-project-idx-pill {
        font-family: var(--bp-kanji);
        font-size: 10.5px;
        font-weight: 700;
        letter-spacing: 0.06em;
        white-space: nowrap;
        flex-shrink: 0;
        background: var(--bp-gold-foil);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }

      #layer-koi .bp-col--is-expanded .bp-project-idx-pill {
        font-size: 11px;
        background: none;
        -webkit-text-fill-color: var(--bp-open-accent);
        color: var(--bp-open-accent);
      }

      #layer-koi .bp-project-badge {
        font-family: var(--bp-kanji);
        font-size: 8.5px;
        font-weight: 700;
        letter-spacing: 0.06em;
        color: var(--bp-gold-faint);
        text-transform: uppercase;
        white-space: nowrap;
        text-align: right;
      }

      #layer-koi .bp-col--is-expanded .bp-project-badge {
        font-size: 9px;
        color: var(--bp-open-faint);
      }

      #layer-koi .bp-project-title {
        font-family: var(--bp-kanji);
        font-size: 13.6px;
        font-weight: 700;
        letter-spacing: 0.02em;
        line-height: 1.22;
        background: var(--bp-gold-foil);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        filter: drop-shadow(0 1px 2px rgba(20, 3, 2, 0.78));
      }

      #layer-koi .bp-col--is-expanded .bp-project-title {
        font-size: 14.5px;
        line-height: 1.28;
        background: none;
        -webkit-text-fill-color: var(--bp-open-fg);
        color: var(--bp-open-fg);
        filter: none;
      }

      #layer-koi .bp-project-drawer {
        display: none;
        flex-direction: column;
        gap: 6px;
        margin-top: 6px;
        padding-top: 6px;
        border-top: 1px dashed var(--bp-open-rule);
      }

      #layer-koi .bp-col--is-expanded .bp-project-item--active .bp-project-drawer {
        display: flex;
      }

      #layer-koi .bp-project-subtitle {
        font-family: var(--bp-serif);
        font-style: italic;
        font-size: 12.5px;
        color: var(--bp-open-accent);
      }

      #layer-koi .bp-project-pipeline {
        font-family: var(--bp-sans);
        font-size: 10.5px;
        line-height: 1.45;
        padding: 4px 0 4px 10px;
        border-left: 2px solid var(--bp-open-accent);
        color: var(--bp-open-fg);
      }

      
      #layer-koi .bp-col-footer {
        flex-shrink: 0;
        padding-top: 7px;
        margin-top: 4px;
        border-top: 1px solid var(--bp-gold-rule);
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-family: var(--bp-kanji);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.12em;
        color: var(--bp-gold-muted);
      }

      #layer-koi .bp-col--is-expanded .bp-col-footer {
        border-top-color: var(--bp-open-rule-strong);
        color: var(--bp-open-accent);
      }

      @media (max-width: 820px) {

        #layer-koi .bp-col--is-expanded .bp-col-inner {
          width: 64% !important;
          max-width: 64% !important;
        }
        #layer-koi .bp-contact-grid {
          grid-template-columns: 1fr;
        }
      }

      /* =====================================================================
       * REDESIGNED DEFAULT 4-COLUMN PROFILE MENU:
       * - Remove all text except the Heading and Kanji numeral of each column
       * - Center Kanji + Heading together in the column, with Kanji over Heading
       * - Enlarge both to comfortably fit the column
       * - Keep the full expanded view when a column is clicked!
       * ===================================================================== */
      #layer-koi .bp-col:not(.bp-col--is-expanded) .bp-folio-band,
      #layer-koi .bp-col:not(.bp-col--is-expanded) .bp-body,
      #layer-koi .bp-col:not(.bp-col--is-expanded) .bp-col-footer,
      #layer-koi .bp-col:not(.bp-col--is-expanded) .bp-col-subtitle,
      #layer-koi .bp-col:not(.bp-col--is-expanded) .bp-expanded-title-sub {
        display: none !important;
      }

      #layer-koi .bp-col:not(.bp-col--is-expanded) .bp-col-inner {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-start;
        padding: clamp(28px, 6.2vh, 64px) 10px 20px 10px;
        height: 100%;
      }

      #layer-koi .bp-col:not(.bp-col--is-expanded) .bp-title-zone {
        position: relative;
        flex: 1;
        width: 100%;
        height: 100%;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-start;
        gap: clamp(22px, 3.4vh, 36px);
      }

      #layer-koi .bp-col:not(.bp-col--is-expanded) .bp-folio-kicker-row {
        position: static;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        margin: 0;
        flex-shrink: 0;
      }

      #layer-koi .bp-col:not(.bp-col--is-expanded) .bp-folio-seal {
        font-family: var(--bp-kanji);
        font-size: clamp(38px, 5.2vh, 62px);
        line-height: 1;
        width: clamp(64px, 8.4vh, 96px);
        height: clamp(64px, 8.4vh, 96px);
        aspect-ratio: 1 / 1;
        padding: 0;
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 2px solid var(--bp-gold-rule-strong);
        color: var(--bp-gold-solid);
        background: rgba(0, 0, 0, 0.14);
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
        box-sizing: border-box;
      }

      #layer-koi .bp-col:not(.bp-col--is-expanded) .bp-col-title {
        margin: 0;
        flex-shrink: 0;
        display: flex;
        flex-direction: row;
        align-items: flex-start;
        justify-content: center;
        gap: clamp(10px, 1.1vw, 18px);
      }

      #layer-koi .bp-col:not(.bp-col--is-expanded) .bp-col-title--identity .bp-vchar {
        font-size: var(--bp-col1-title-size, 63px);
        line-height: 0.94;
      }

      #layer-koi .bp-col:not(.bp-col--is-expanded) .bp-col-title--education .bp-vchar {
        font-size: var(--bp-col2-title-size, 57px);
        line-height: 0.93;
      }

      #layer-koi .bp-col:not(.bp-col--is-expanded) .bp-col-title--capabilities .bp-vchar {
        font-size: var(--bp-col3-title-size, 63px);
        line-height: 0.94;
      }

      #layer-koi .bp-col:not(.bp-col--is-expanded) .bp-col-title--projects .bp-vchar {
        font-size: var(--bp-col4-title-size, 64px);
        line-height: 0.94;
      }

      /* Shrunk spine (when another column is expanded): center Kanji over Heading, hide 01..04 */
      #layer-koi .bp-shrunk-spine {
        justify-content: center;
        gap: 18px;
      }
      #layer-koi .bp-shrunk-spine-num {
        display: none !important;
      }
      #layer-koi .bp-shrunk-spine-seal {
        order: 1;
        font-size: clamp(18px, 2.4vh, 26px);
      }
      #layer-koi .bp-shrunk-spine-title {
        order: 2;
        font-size: clamp(12px, 1.65vh, 16px);
        letter-spacing: 0.20em;
      }

      /* =====================================================================
       * SUMI-E (INK STYLE) AESTHETIC FOR COLUMNS (DARK & LIGHT MODES)
       * ===================================================================== */
      #layer-koi .bp-portfolio-root[data-art-style="sumie"] {
        --bp-gold-foil: linear-gradient(
          180deg,
          #faf6ee 0%,
          #e2d9c8 48%,
          #b8ae9c 100%
        );
        --bp-gold-solid: #ece4d4;
        --bp-gold-muted: #c8bfb0;
        --bp-gold-faint: rgba(232, 224, 210, 0.72);
        --bp-gold-rule: rgba(216, 207, 192, 0.28);
        --bp-gold-rule-strong: rgba(232, 224, 210, 0.62);
      }

      #layer-koi .bp-portfolio-root.bp-theme-light[data-art-style="sumie"] {
        --bp-gold-foil: linear-gradient(
          180deg,
          #141210 0%,
          #2c2723 52%,
          #181512 100%
        );
        --bp-gold-solid: #1c1916;
        --bp-gold-muted: #3c3630;
        --bp-gold-faint: rgba(36, 32, 28, 0.72);
        --bp-gold-rule: rgba(36, 32, 28, 0.24);
        --bp-gold-rule-strong: rgba(28, 24, 20, 0.62);
      }

      #layer-koi .bp-portfolio-root[data-art-style="sumie"] .bp-col:not(.bp-col--is-expanded) {
        background-color: #181614;
        background-image:
          radial-gradient(circle at 50% 35%, rgba(44, 40, 36, 0.42) 0%, rgba(14, 13, 11, 0.85) 100%),
          linear-gradient(180deg, rgba(28, 25, 22, 0.96) 0%, rgba(16, 14, 12, 0.98) 100%);
        border-color: #c8bfb0;
        box-shadow:
          inset 0 0 0 4px rgba(14, 13, 11, 0.92),
          inset 0 0 0 5px rgba(212, 204, 190, 0.36),
          0 10px 26px rgba(0, 0, 0, 0.48);
      }

      #layer-koi .bp-portfolio-root.bp-theme-light[data-art-style="sumie"] .bp-col:not(.bp-col--is-expanded) {
        background-color: #efe8d8;
        background-image:
          radial-gradient(circle at 50% 35%, rgba(252, 248, 238, 0.65) 0%, rgba(224, 214, 196, 0.85) 100%),
          linear-gradient(180deg, rgba(245, 239, 226, 0.97) 0%, rgba(228, 218, 200, 0.99) 100%);
        border-color: #2c2723;
        box-shadow:
          inset 0 0 0 4px rgba(242, 235, 220, 0.92),
          inset 0 0 0 5px rgba(44, 39, 35, 0.44),
          0 10px 24px rgba(28, 24, 18, 0.20);
      }

      #layer-koi .bp-portfolio-root[data-art-style="sumie"] .bp-col:not(.bp-col--is-expanded):hover {
        border-color: #f4eee2;
        box-shadow:
          inset 0 0 0 4px rgba(20, 18, 16, 0.92),
          inset 0 0 0 5.5px rgba(244, 238, 226, 0.65),
          0 12px 30px rgba(0, 0, 0, 0.58);
      }

      #layer-koi .bp-portfolio-root.bp-theme-light[data-art-style="sumie"] .bp-col:not(.bp-col--is-expanded):hover {
        border-color: #12100e;
        box-shadow:
          inset 0 0 0 4px rgba(246, 240, 228, 0.94),
          inset 0 0 0 5.5px rgba(20, 18, 16, 0.72),
          0 12px 28px rgba(28, 24, 18, 0.28);
      }

      #layer-koi .bp-portfolio-root.bp-theme-light[data-art-style="sumie"] .bp-vchar,
      #layer-koi .bp-portfolio-root.bp-theme-light[data-art-style="sumie"] .bp-col-title,
      #layer-koi .bp-portfolio-root.bp-theme-light[data-art-style="sumie"] .bp-shrunk-spine-title,
      #layer-koi .bp-portfolio-root.bp-theme-light[data-art-style="sumie"] .bp-shrunk-spine-seal {
        filter: drop-shadow(0 1px 1px rgba(255, 250, 240, 0.65));
      }

      /* Sumi-e Vermilion Hanko Seal Accent vs. Pure Monochrome Ink on Kanji Numerals */
      #layer-koi .bp-portfolio-root[data-art-style="sumie"][data-sumi-seal="hanko"] .bp-col:not(.bp-col--is-expanded) .bp-folio-seal {
        color: #d83424;
        border-color: rgba(216, 52, 36, 0.78);
        background: rgba(186, 34, 20, 0.10);
      }
      #layer-koi .bp-portfolio-root[data-art-style="sumie"][data-sumi-seal="mono"] .bp-col:not(.bp-col--is-expanded) .bp-folio-seal {
        color: var(--bp-gold-solid);
        border-color: var(--bp-gold-rule-strong);
        background: rgba(128, 120, 110, 0.08);
      }

      /* Sumi-e Expanded Column Styling */
      #layer-koi .bp-portfolio-root[data-art-style="sumie"] .bp-col.bp-col--is-expanded {
        background-color: #ebe3d3 !important;
        background-blend-mode: luminosity;
        border-color: #36302a !important;
        box-shadow:
          inset 0 0 0 4px rgba(235, 227, 211, 0.88),
          inset 0 0 0 5px rgba(54, 48, 42, 0.44),
          0 12px 30px rgba(18, 16, 14, 0.36) !important;
        --bp-open-fg: #181512 !important;
        --bp-open-muted: #38322c !important;
        --bp-open-faint: #5e554c !important;
        --bp-open-accent: #b8281a !important;
        --bp-open-rule: rgba(48, 42, 36, 0.22) !important;
        --bp-open-rule-strong: rgba(28, 24, 20, 0.52) !important;
      }

      #layer-koi .bp-portfolio-root[data-art-style="sumie"][data-sumi-seal="mono"] .bp-col.bp-col--is-expanded {
        --bp-open-accent: #1c1916 !important;
      }

      /* Temporary Per-Column Heading Text Size Sliders */
      .bp-temp-compare-bar {
        position: fixed;
        left: 24px;
        bottom: 18px;
        z-index: 9999;
        display: none;
        flex-direction: column;
        gap: 8px;
        padding: 10px 14px;
        min-width: 310px;
        background: rgba(14, 13, 12, 0.94);
        border: 1.5px solid rgba(236, 198, 104, 0.72);
        box-shadow: 0 8px 26px rgba(0, 0, 0, 0.65);
        backdrop-filter: blur(8px);
        font-family: "Geist Mono", ui-monospace, monospace;
        font-size: 11px;
        color: #f3e6c8;
        pointer-events: auto;
        user-select: none;
      }

      .bp-temp-compare-header {
        font-weight: 700;
        font-size: 10.5px;
        letter-spacing: 0.10em;
        color: #e6be53;
        border-bottom: 1px solid rgba(236, 198, 104, 0.28);
        padding-bottom: 5px;
      }

      .bp-temp-sliders-grid {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .bp-temp-slider-row {
        display: grid;
        grid-template-columns: 118px 1fr 32px;
        align-items: center;
        gap: 8px;
        cursor: pointer;
      }

      .bp-temp-slider-name {
        font-size: 10.5px;
        font-weight: 700;
        letter-spacing: 0.05em;
        color: #fff6dc;
      }

      .bp-temp-slider-input {
        width: 100%;
        accent-color: #e6be53;
        cursor: pointer;
        margin: 0;
      }

      .bp-temp-slider-val {
        font-size: 11.5px;
        font-weight: 700;
        color: #ffd970;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
    `;
    document.head.appendChild(style);
  }

  private buildDOM(): HTMLElement {
    const root = document.createElement("section");
    root.className = "bp-portfolio-root bp-theme-light";
    root.setAttribute("aria-label", "Portfolio Information Columns");
    root.style.opacity = "0";
    root.style.visibility = "hidden";

    root.addEventListener("dragstart", (e) => {
      e.preventDefault();
    });
    root.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    const colsStage = document.createElement("div");
    colsStage.className = "bp-cols-stage";
    this.colsStageEl = colsStage;

    const rippleCanvas = document.createElement("canvas");
    rippleCanvas.className = "bp-ripple-canvas";
    rippleCanvas.setAttribute("aria-hidden", "true");
    this.rippleCanvas = rippleCanvas;
    this.rippleCtx = rippleCanvas.getContext("2d");

    const col1 = this.buildIdentityColumn();
    const col2 = this.buildEducationColumn();
    const col3 = this.buildSkillsColumn();
    const col4 = this.buildProjectsColumn();

    this.colElements = [col1, col2, col3, col4];
    this.colInnerWrappers = this.colElements.map(
      (col) => col.querySelector(".bp-col-inner") as HTMLElement
    );

    for (let i = 0; i < this.colElements.length; i++) {
      const col = this.colElements[i];
      col.addEventListener("click", (e) => {
        e.stopPropagation();
        const target = e.target as HTMLElement | null;
        if (target?.closest("a")) return;

        if (this.expandedColIdx === i && i === 3) {
          const projCard = target?.closest<HTMLElement>("[data-bp-project-item]");
          if (projCard) {
            const pIdx = Number(projCard.getAttribute("data-bp-project-item"));
            if (!Number.isNaN(pIdx)) {
              this.setActiveProjectTopic(pIdx, true);
              return;
            }
          }
        }

        this.setExpandedColumn(i);
      });
      colsStage.appendChild(col);
    }

    root.appendChild(colsStage);
    root.appendChild(rippleCanvas);

    return root;
  }

  private buildIdentityColumn(): HTMLElement {
    const col = document.createElement("article");
    col.className = "bp-col bp-col--col1";
    col.setAttribute("aria-label", "Identity — Folio I");

    const contactsHtml = CONTACT_CHANNELS.map(
      (ch) => `
        <div class="bp-contact-card">
          <span class="bp-contact-label">${ch.label}</span>
          <a class="bp-contact-link" href="${ch.href}" ${ch.external ? 'target="_blank" rel="noopener noreferrer"' : ""}>${ch.value}</a>
        </div>
      `
    ).join("");

    const expHtml = EXPERIENCE_ITEMS.map(
      (exp) => `
        <div class="bp-block bp-expanded-extra">
          <div class="bp-field-meta">
            <span>EXPERIENCE · ${exp.organization}</span>
            <span>${exp.period}</span>
          </div>
          <div class="bp-exp-role">${exp.organization} — ${exp.role}</div>
          <div class="bp-exp-grade">${exp.badge}</div>
          <div class="bp-project-tags">
            ${exp.tags.map((t) => `<span class="bp-project-tag">${t}</span>`).join("")}
          </div>
          <ul class="bp-exp-bullets">
            ${exp.bullets.map((b) => `<li>${b}</li>`).join("")}
          </ul>
        </div>
      `
    ).join("");

    col.innerHTML = `
      <div class="bp-shrunk-spine" aria-hidden="true">
        <span class="bp-shrunk-spine-num">01</span>
        <span class="bp-shrunk-spine-title">IDENTITY</span>
        <span class="bp-shrunk-spine-seal">壱</span>
      </div>
      <div class="bp-col-inner">
        <header class="bp-title-zone">
          <div class="bp-folio-kicker-row">
            <span class="bp-folio-seal" aria-hidden="true">壱</span>
          </div>
          <h2 class="bp-col-title bp-col-title--identity" aria-label="IDENTITY">
            ${buildVerticalCharStackHTML("IDENTITY")}
            <span class="bp-col-title-horiz-text">IDENTITY</span>
          </h2>
          <div class="bp-col-subtitle bp-col-subtitle--expanded-only">DOSSIER &amp; LINEAGE</div>
          <div class="bp-expanded-title-sub">${SUBJECT_PROFILE.role}</div>
        </header>
        <div class="bp-folio-band">
          <span class="bp-folio-band-code">FOLIO 01</span>
          <span class="bp-col-subtitle">DOSSIER &amp; LINEAGE</span>
        </div>
        <div class="bp-body">
          <div class="bp-content">
            <div class="bp-block bp-block--identity-stage">
              <div class="bp-field-meta">
                <span>SUBJECT</span>
                <span class="bp-meta-closed-only">PROVENANCE</span>
              </div>
              <div class="bp-identity-vertical-stage" role="group" aria-label="SAAYAN CHOWDHURY — PANAGARH, WEST BENGAL, INDIA">
                <div class="bp-identity-vgroup" aria-label="SAAYAN CHOWDHURY">
                  ${buildVerticalCharStackHTML("SAAYAN", "bp-vstack--subject")}
                  ${buildVerticalCharStackHTML("CHOWDHURY", "bp-vstack--subject")}
                </div>
                <span class="bp-identity-vdivider" aria-hidden="true"></span>
                <div class="bp-identity-vgroup" aria-label="PANAGARH, WEST BENGAL, INDIA">
                  ${buildVerticalCharStackHTML("PANAGARH", "bp-vstack--prov")}
                  ${buildVerticalCharStackHTML("WEST BENGAL", "bp-vstack--prov")}
                  ${buildVerticalCharStackHTML("INDIA", "bp-vstack--prov-muted")}
                </div>
              </div>
              <div class="bp-identity-stage-footer">
                <div class="bp-subject-role">Computer Science, Data Analytics &amp; Edge Vision</div>
                <div class="bp-identity-pin-row">
                  <div class="bp-identity-pin-meta">
                    <span class="bp-identity-pin-code">PIN 713148</span>
                  </div>
                  <img
                    class="bp-wb-map-img"
                    src="${WB_MAP_URI}"
                    alt="Cartographic silhouette of West Bengal"
                    decoding="async"
                    onerror="if(!this.dataset.fb1){this.dataset.fb1='1';this.src='./images/WB.png';}"
                  />
                </div>
              </div>
              <div class="bp-identity-expanded-horiz">
                <div class="bp-subject-headline">SAAYAN CHOWDHURY</div>
                <div class="bp-subject-role">Computer Science, Data Analytics &amp; Edge Vision</div>
                <div class="bp-field-meta" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--bp-open-rule);">
                  <span>PROVENANCE</span>
                </div>
                <div class="bp-location-row">
                  <div class="bp-location-text">
                    <span class="bp-location-city">PANAGARH, WEST BENGAL</span>
                    <span>India · PIN 713148</span>
                  </div>
                  <img
                    class="bp-wb-map-img"
                    src="${WB_MAP_URI}"
                    alt="Cartographic silhouette of West Bengal"
                    decoding="async"
                    onerror="if(!this.dataset.fb1){this.dataset.fb1='1';this.src='./images/WB.png';}"
                  />
                </div>
              </div>
            </div>
            <div class="bp-block bp-block--dob">
              <div class="bp-field-meta">
                <span>DATE OF BIRTH</span>
              </div>
              <div class="bp-primary-value">18 FEBRUARY 2004</div>
            </div>
            <div class="bp-block bp-block--age">
              <div class="bp-field-meta">
                <span>ELAPSED AGE</span>
              </div>
              <div class="bp-age-grid" role="group" aria-label="Elapsed years, months, and days">
                <div class="bp-age-cell">
                  <span class="bp-age-num" data-age-part="years">--</span>
                  <span class="bp-age-unit">YEARS · 年</span>
                </div>
                <div class="bp-age-cell">
                  <span class="bp-age-num" data-age-part="months">--</span>
                  <span class="bp-age-unit">MONTHS · 月</span>
                </div>
                <div class="bp-age-cell">
                  <span class="bp-age-num" data-age-part="days">--</span>
                  <span class="bp-age-unit">DAYS · 日</span>
                </div>
              </div>
            </div>
            <div class="bp-block bp-expanded-extra">
              <div class="bp-field-meta">
                <span>CORRESPONDENCE &amp; LINKS</span>
              </div>
              <div class="bp-contact-grid">
                ${contactsHtml}
              </div>
            </div>
            ${expHtml}
          </div>
        </div>
        <footer class="bp-col-footer">
          <span data-bp-footer-cue>[ UNFOLD SCROLL // 開 ]</span>
          <span>I</span>
        </footer>
      </div>
    `;

    this.yearsValueEls = Array.from(col.querySelectorAll('[data-age-part="years"]'));
    this.monthsValueEls = Array.from(col.querySelectorAll('[data-age-part="months"]'));
    this.daysValueEls = Array.from(col.querySelectorAll('[data-age-part="days"]'));

    return col;
  }

  private buildEducationColumn(): HTMLElement {
    const col = document.createElement("article");
    col.className = "bp-col bp-col--col2";
    col.setAttribute("aria-label", "Education — Folio II");

    const itemsHtml = EDUCATION_ITEMS.map(
      (item) => `
        <div class="bp-edu-item">
          <div class="bp-edu-top-row">
            <span class="bp-edu-idx">${item.index}</span>
            <div class="bp-edu-date">${item.dateLabel}</div>
          </div>
          <div class="bp-edu-school">${item.institution}</div>
          <div class="bp-edu-degree">${item.qualification}</div>
          <div class="bp-expanded-extra">
            <div class="bp-edu-focus">${item.focusAreas}</div>
            <div class="bp-edu-desc">${item.highlights}</div>
          </div>
        </div>
      `
    ).join("");

    col.innerHTML = `
      <div class="bp-shrunk-spine" aria-hidden="true">
        <span class="bp-shrunk-spine-num">02</span>
        <span class="bp-shrunk-spine-title">EDUCATION</span>
        <span class="bp-shrunk-spine-seal">弐</span>
      </div>
      <div class="bp-col-inner">
        <header class="bp-title-zone">
          <div class="bp-folio-kicker-row">
            <span class="bp-folio-seal" aria-hidden="true">弐</span>
          </div>
          <h2 class="bp-col-title bp-col-title--education" aria-label="EDUCATION">
            ${buildVerticalCharStackHTML("EDUCATION")}
            <span class="bp-col-title-horiz-text">EDUCATION</span>
          </h2>
          <div class="bp-col-subtitle bp-col-subtitle--expanded-only">ACADEMIC LINEAGE</div>
          <div class="bp-expanded-title-sub">Dual-degree foundation in Data Analytics at IIT Patna and Computer Science Engineering</div>
        </header>
        <div class="bp-folio-band">
          <span class="bp-folio-band-code">FOLIO 02</span>
          <span class="bp-col-subtitle">ACADEMIC LINEAGE</span>
        </div>
        <div class="bp-body">
          <div class="bp-content">
            ${itemsHtml}
          </div>
        </div>
        <footer class="bp-col-footer">
          <span data-bp-footer-cue>[ UNFOLD SCROLL // 開 ]</span>
          <span>II</span>
        </footer>
      </div>
    `;
    return col;
  }

  private buildSkillsColumn(): HTMLElement {
    const col = document.createElement("article");
    col.className = "bp-col bp-col--col3";
    col.setAttribute("aria-label", "Skills — Folio III");

    const skillsHtml = SKILL_CATEGORIES.map(
      (sk) => `
        <div class="bp-skill-item">
          <div class="bp-skill-head-row">
            <div class="bp-skill-cat">${sk.category}</div>
            <span class="bp-skill-idx">${sk.index}</span>
          </div>
          <div class="bp-skill-entries">${sk.items}</div>
          <div class="bp-expanded-extra">
            <div class="bp-skill-tags">
              ${sk.tags.map((t) => `<span class="bp-skill-tag">${t}</span>`).join("")}
            </div>
            <div class="bp-skill-summary">${sk.expandedSummary}</div>
          </div>
        </div>
      `
    ).join("");

    col.innerHTML = `
      <div class="bp-shrunk-spine" aria-hidden="true">
        <span class="bp-shrunk-spine-num">03</span>
        <span class="bp-shrunk-spine-title">SKILLS</span>
        <span class="bp-shrunk-spine-seal">参</span>
      </div>
      <div class="bp-col-inner">
        <header class="bp-title-zone">
          <div class="bp-folio-kicker-row">
            <span class="bp-folio-seal" aria-hidden="true">参</span>
          </div>
          <h2 class="bp-col-title bp-col-title--capabilities" aria-label="SKILLS">
            ${buildVerticalCharStackHTML("SKILLS")}
            <span class="bp-col-title-horiz-text">SKILLS</span>
          </h2>
          <div class="bp-col-subtitle bp-col-subtitle--expanded-only">DISCIPLINES &amp; CRAFT</div>
          <div class="bp-expanded-title-sub">Applied machine learning, edge computer vision, vector retrieval &amp; distributed systems</div>
        </header>
        <div class="bp-folio-band">
          <span class="bp-folio-band-code">FOLIO 03</span>
          <span class="bp-col-subtitle">DISCIPLINES &amp; CRAFT</span>
        </div>
        <div class="bp-body">
          <div class="bp-content">
            ${skillsHtml}
          </div>
        </div>
        <footer class="bp-col-footer">
          <span data-bp-footer-cue>[ UNFOLD SCROLL // 開 ]</span>
          <span>III</span>
        </footer>
      </div>
    `;
    return col;
  }

  private buildProjectsColumn(): HTMLElement {
    const col = document.createElement("article");
    col.className = "bp-col bp-col--col4";
    col.setAttribute("aria-label", "Projects — Folio IV");

    const projectsHtml = PROJECT_TOPICS.map((proj, idx) => {
      const isInitialOpen = idx === 0;
      return `
        <div class="bp-project-item ${isInitialOpen ? "bp-project-item--active" : ""}" data-bp-project-item="${idx}" role="button" tabindex="0" aria-expanded="${isInitialOpen ? "true" : "false"}">
          <div class="bp-project-meta-top">
            <span class="bp-project-idx-pill">NO. ${proj.index}</span>
            <span class="bp-project-badge">${proj.badge}</span>
          </div>
          <div class="bp-project-title">${proj.heading}</div>
          <div class="bp-project-drawer">
            <div class="bp-project-subtitle">${proj.subtitle}</div>
            <div class="bp-project-pipeline">${proj.pipeline}</div>
            <div class="bp-project-tags">
              ${proj.techStack.map((tag) => `<span class="bp-project-tag">${tag}</span>`).join("")}
            </div>
            <ul class="bp-project-bullets">
              ${proj.bullets.map((b) => `<li>${b}</li>`).join("")}
            </ul>
          </div>
        </div>
      `;
    }).join("");

    col.innerHTML = `
      <div class="bp-shrunk-spine" aria-hidden="true">
        <span class="bp-shrunk-spine-num">04</span>
        <span class="bp-shrunk-spine-title">PROJECTS</span>
        <span class="bp-shrunk-spine-seal">肆</span>
      </div>
      <div class="bp-col-inner">
        <header class="bp-title-zone">
          <div class="bp-folio-kicker-row">
            <span class="bp-folio-seal" aria-hidden="true">肆</span>
          </div>
          <h2 class="bp-col-title bp-col-title--projects" aria-label="PROJECTS">
            ${buildVerticalCharStackHTML("PROJECTS")}
            <span class="bp-col-title-horiz-text">PROJECTS</span>
          </h2>
          <div class="bp-col-subtitle bp-col-subtitle--expanded-only">SYSTEMS &amp; RESEARCH</div>
          <div class="bp-expanded-title-sub">Autonomous UAV telemetry, local LLM orchestration, semantic RAG &amp; satellite ET modeling</div>
        </header>
        <div class="bp-folio-band">
          <span class="bp-folio-band-code">FOLIO 04</span>
          <span class="bp-col-subtitle">SYSTEMS &amp; RESEARCH</span>
        </div>
        <div class="bp-body">
          <div class="bp-content">
            ${projectsHtml}
          </div>
        </div>
        <footer class="bp-col-footer">
          <span data-bp-footer-cue>[ UNFOLD SCROLL // 開 ]</span>
          <span>IV</span>
        </footer>
      </div>
    `;
    return col;
  }

  private updateAgeDOM(now: Date): void {
    const sec = now.getSeconds();
    if (sec === this.lastSecond) return;
    this.lastSecond = sec;

    const { years, months, days } = computeDynamicAgeBreakdown(now);
    const yStr = pad2(years);
    const mStr = pad2(months);
    const dStr = pad2(days);

    for (const el of this.yearsValueEls) el.textContent = yStr;
    for (const el of this.monthsValueEls) el.textContent = mStr;
    for (const el of this.daysValueEls) el.textContent = dStr;
  }

  private updateColumnGeometry(): void {
    const {
      canvasW: viewportW,
      cachedLeftPx: leftPx,
      cachedRightClearance: rightClearance,
      cachedGapPx: gapPx,
    } = this;

    const totalAvailW = Math.max(220, viewportW - leftPx - rightClearance);
    const defaultColsW = Math.max(120, totalAvailW - gapPx * 3);
    this.baseColWidth = defaultColsW / 4;

    const g0 = gapPx * this.gapMultipliers[0];
    const g1 = gapPx * this.gapMultipliers[1];
    const g2 = gapPx * this.gapMultipliers[2];
    const currentGapsSum = g0 + g1 + g2;
    const currentColsAvailW = Math.max(120, totalAvailW - currentGapsSum);

    const wSum =
      this.colWeights[0] + this.colWeights[1] + this.colWeights[2] + this.colWeights[3] || 4;

    const gaps = [g0, g1, g2, 0];
    let cursorLeft = leftPx;
    for (let i = 0; i < 4; i++) {
      const wPx = (this.colWeights[i] / wSum) * currentColsAvailW;
      this.colLefts[i] = cursorLeft;
      this.colWidths[i] = wPx;
      cursorLeft += wPx + gaps[i];

      const colEl = this.colElements[i];
      if (colEl) {
        colEl.style.left = `${(this.colLefts[i] - leftPx).toFixed(1)}px`;
        colEl.style.width = `${wPx.toFixed(1)}px`;
      }

      const inner = this.colInnerWrappers[i];
      if (inner) {
        const isExpandedTarget = this.expandedColIdx === i;
        if (!isExpandedTarget) {
          inner.style.width = `${this.colWidths[i].toFixed(1)}px`;
        } else {
          inner.style.width = "";
        }

        const shrinkRatio = clamp01(
          (this.colWeights[i] - SHRUNK_COL_WEIGHT) / (1.0 - SHRUNK_COL_WEIGHT)
        );
        const textAlpha = smoothstep(0.18, 0.85, shrinkRatio);

        inner.style.opacity = textAlpha.toFixed(3);
        inner.style.pointerEvents = shrinkRatio < 0.45 ? "none" : "auto";
      }
    }
  }

  public update(
    portraitTarget: boolean,
    isLightMode: boolean,
    viewportW: number,
    viewportH: number,
    _pondOffsetX: number,
    _pondOffsetY: number,
    cellW: number,
    cellH: number,
    dt: number,
    _pondTime = 0
  ): void {
    this.currentCellW = cellW || 8;
    this.currentCellH = cellH || 8;

    const nowMs = performance.now();
    const elapsedSinceLast =
      this.lastUpdateNow > 0 ? (nowMs - this.lastUpdateNow) / 1000 : dt;
    this.lastUpdateNow = nowMs;
    const realDt =
      dt <= 0
        ? 0
        : clamp(elapsedSinceLast > 0.12 ? dt : Math.max(dt, elapsedSinceLast), 0.001, 0.05);

    if (this.lastLightMode !== isLightMode) {
      this.lastLightMode = isLightMode;
      this.root.classList.toggle("bp-theme-light", isLightMode);
      this.domSettled = false;
    }

    if (!portraitTarget && this.targetOpen && this.expandedColIdx !== null) {
      this.expandedColIdx = null;
      this.colWeights = [1, 1, 1, 1];
      this.startColWeights = [1, 1, 1, 1];
      this.targetColWeights = [1, 1, 1, 1];
      this.gapMultipliers = [1, 1, 1];
      this.startGapMultipliers = [1, 1, 1];
      this.targetGapMultipliers = [1, 1, 1];
      this.expandAnimProgress = 1;
      for (const colEl of this.colElements) {
        colEl.classList.remove("bp-col--is-expanded", "bp-col--is-shrunk");
        const cue = colEl.querySelector<HTMLElement>("[data-bp-footer-cue]");
        if (cue) cue.textContent = "[ UNFOLD SCROLL // 開 ]";
      }
      this.root.classList.remove("bp-has-expanded-col");
    }

    if (this.targetOpen !== portraitTarget) {
      this.targetOpen = portraitTarget;
      this.domSettled = false;
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

    let weightsChanged = false;
    if (this.expandAnimProgress < 1) {
      this.expandAnimProgress = Math.min(
        1,
        this.expandAnimProgress + realDt / this.expandAnimDuration
      );
      const ease = easeColumnTransition(this.expandAnimProgress);
      for (let i = 0; i < 4; i++) {
        this.colWeights[i] =
          this.startColWeights[i] + (this.targetColWeights[i] - this.startColWeights[i]) * ease;
      }
      for (let g = 0; g < 3; g++) {
        this.gapMultipliers[g] =
          this.startGapMultipliers[g] +
          (this.targetGapMultipliers[g] - this.startGapMultipliers[g]) * ease;
      }
      weightsChanged = true;
    }

    if (this.flipProgress > 0.005) {
      this.updateAgeDOM(new Date());
    }

    const isNarrow = viewportW < 820;
    const pondLeftX = isNarrow ? 16 : Math.round(clamp(24, 38, viewportW * 0.022));
    const pondBoxW = isNarrow
      ? Math.max(260, viewportW - 88)
      : Math.round(clamp(290, 460, viewportW * 0.295));
    const pondBoxH = isNarrow
      ? Math.round(clamp(190, 250, viewportH * 0.27))
      : Math.max(260, viewportH - 48);

    const leftPx = isNarrow ? 16 : pondLeftX + pondBoxW + 22;
    const rightClearance = isNarrow ? 16 : 80;
    const topPx = isNarrow ? 16 + pondBoxH + 16 : 24;
    const heightPx = isNarrow
      ? Math.max(240, viewportH - topPx - 16)
      : Math.max(260, viewportH - 48);
    const gapPx = Math.min(12, Math.max(8, Math.round(viewportW * 0.0075)));

    const geomDirty =
      this.canvasW !== viewportW ||
      this.canvasH !== viewportH ||
      this.cachedLeftPx !== leftPx ||
      this.cachedRightClearance !== rightClearance ||
      this.cachedTopPx !== topPx ||
      this.cachedHeightPx !== heightPx ||
      this.cachedGapPx !== gapPx;

    if (geomDirty) {
      this.canvasW = viewportW;
      this.canvasH = viewportH;
      this.cachedLeftPx = leftPx;
      this.cachedRightClearance = rightClearance;
      this.cachedTopPx = topPx;
      this.cachedHeightPx = heightPx;
      this.cachedGapPx = gapPx;

      this.root.style.left = `${leftPx}px`;
      this.root.style.right = `${rightClearance}px`;
      this.root.style.top = `${topPx}px`;
      this.root.style.height = `${heightPx}px`;
    }
    this.rippleOrigin = computeVirtualCenter(this.getCompositionBounds());

    if (geomDirty || weightsChanged) {
      this.updateColumnGeometry();
    }

    if (this.flipProgress <= 0.002) {
      if (this.root.style.visibility !== "hidden") {
        this.root.style.opacity = "0";
        this.root.style.visibility = "hidden";
        this.root.classList.remove("bp-interactive");
        this.colsStageEl.style.webkitMaskImage = "";
        this.colsStageEl.style.maskImage = "";
        this.rippleCanvas.style.display = "none";
      }
      this.domSettled = false;
      return;
    }

    this.root.style.visibility = "visible";
    this.root.style.opacity = this.reducedMotion ? this.flipProgress.toFixed(3) : "1";
    this.root.classList.toggle("bp-interactive", this.flipProgress > 0.45);

    const isFlipFullySettled = this.flipProgress >= 0.999;

    if (this.domSettled && isFlipFullySettled && !weightsChanged && !geomDirty) {
      return;
    }

    // Keep columns stationary in their layout slots (zero old slideX/slideY/scaleY wobble)
    for (let i = 0; i < 4; i++) {
      const colEl = this.colElements[i];
      if (!colEl) continue;
      colEl.style.opacity = "1";
      colEl.style.transform = "none";
      colEl.style.transformOrigin = "";
    }

    // Reduced-motion fallback: simple 0.25s opacity fade
    if (this.reducedMotion) {
      this.colsStageEl.style.webkitMaskImage = "";
      this.colsStageEl.style.maskImage = "";
      this.rippleCanvas.style.display = "none";
      for (let i = 0; i < 4; i++) {
        const inner = this.colInnerWrappers[i];
        if (!inner) continue;
        const shrinkRatio = clamp01(
          (this.colWeights[i] - SHRUNK_COL_WEIGHT) / (1.0 - SHRUNK_COL_WEIGHT)
        );
        const textAlpha = smoothstep(0.18, 0.85, shrinkRatio);
        inner.style.opacity = textAlpha.toFixed(3);
        inner.style.transform = "none";
      }
      this.domSettled = isFlipFullySettled && !weightsChanged;
      return;
    }

    // When fully settled (flipProgress >= 0.999), remove stage mask and hide tile overlay canvas
    // so the real column DOM is 100% visible with zero seam, zero pop, and zero idle cost.
    if (isFlipFullySettled) {
      this.colsStageEl.style.webkitMaskImage = "";
      this.colsStageEl.style.maskImage = "";
      this.rippleCanvas.style.display = "none";
      for (let i = 0; i < 4; i++) {
        const inner = this.colInnerWrappers[i];
        if (!inner) continue;
        const shrinkRatio = clamp01(
          (this.colWeights[i] - SHRUNK_COL_WEIGHT) / (1.0 - SHRUNK_COL_WEIGHT)
        );
        const textAlpha = smoothstep(0.18, 0.85, shrinkRatio);
        inner.style.opacity = textAlpha.toFixed(3);
        inner.style.transform = "none";
      }
      this.domSettled = !weightsChanged;
      return;
    }

    // Active Cube-Grid Shockwave Reveal (0.002 < flipProgress < 0.999)
    const compBounds = this.getCompositionBounds();
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

    // 1. Mask `this.colsStageEl` (child wrapper, NEVER `.bp-portfolio-root` which owns the Dark Mode flashlight veil!)
    //    to the shockwave disk tucked just inside the opaque 3.5-tile-wide raised rim.
    const localOx = this.rippleOrigin.x - leftPx;
    const localOy = this.rippleOrigin.y - topPx;
    // Tuck the flat DOM reveal boundary inside the crater/tail transition so the leading raised rim
    // and depressed crater have a true 3D stepped-cube silhouette with zero flat DOM border peeking behind!
    // Place the DOM reveal boundary right inside the opaque raised rim so the underlying
    // column DOM is already 100% unmasked before the noisy tail tiles fade out on rippleCanvas
    const domRevealR = Math.max(
      0,
      rippleCfg.ringRadiusPx - RIM_WIDTH_TILES * 0.55 * tileSize
    );
    const featherPx = tileSize * 0.65;
    const maskCss = `radial-gradient(circle at ${localOx.toFixed(1)}px ${localOy.toFixed(1)}px, #000 ${Math.max(0, domRevealR - featherPx).toFixed(1)}px, transparent ${(domRevealR + featherPx * 0.35).toFixed(1)}px)`;
    this.colsStageEl.style.webkitMaskImage = maskCss;
    this.colsStageEl.style.maskImage = maskCss;

    // 2. Column text (.bp-col-inner) fades in per column after the ring crosses that column's centre
    //    (0.25s duration, 6px upward translate, transform and opacity only).
    const textFadeProgressSpan = COLUMN_TEXT_FADE_SECONDS / FLIP_OPEN_DURATION;
    for (let i = 0; i < 4; i++) {
      const inner = this.colInnerWrappers[i];
      if (!inner) continue;

      const shrinkRatio = clamp01(
        (this.colWeights[i] - SHRUNK_COL_WEIGHT) / (1.0 - SHRUNK_COL_WEIGHT)
      );
      const baseShrinkAlpha = smoothstep(0.18, 0.85, shrinkRatio);

      const colCenterX = this.colLefts[i] + this.colWidths[i] * 0.5;
      const colCenterY = topPx + heightPx * 0.5;
      const distToCenter = Math.hypot(colCenterX - this.rippleOrigin.x, colCenterY - this.rippleOrigin.y);
      const pCross = getFlipProgressAtDistance(distToCenter, rippleCfg.maxCornerDist, rippleCfg.totalWaveSpanPx);

      const rawTextT = clamp01((this.flipProgress - pCross) / textFadeProgressSpan);
      const textEase = easeOutCubic(rawTextT);

      const finalAlpha = baseShrinkAlpha * textEase;
      const ty = (1 - textEase) * COLUMN_TEXT_TRANSLATE_Y_PX;
      inner.style.opacity = finalAlpha.toFixed(3);
      inner.style.transform =
        textEase >= 0.999 ? "none" : `translate3d(0, ${ty.toFixed(2)}px, 0)`;
    }

    // 3. Render the 2.5D Cube-Grid Shockwave Tiles over the 4 columns on `this.rippleCanvas`
    this.renderColumnsRippleCanvas(
      leftPx,
      topPx,
      Math.max(120, viewportW - leftPx - rightClearance),
      heightPx,
      isLightMode,
      rippleCfg
    );

    this.domSettled = false;
  }

  private renderColumnsRippleCanvas(
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
    const isSumie = this.currentArtStyle === "sumie";
    const brocadeSource: CanvasImageSource | null =
      this.brocadeBitmap ?? (this.brocadeLoaded ? this.brocadeImg : null);

    // Align tile grid to global viewport coordinates so columns and left portrait frame share ONE continuous grid
    const startCol = Math.floor(stageLeft / tileSize);
    const endCol = Math.ceil((stageLeft + stageW) / tileSize);
    const startRow = Math.floor(stageTop / tileSize);
    const endRow = Math.ceil((stageTop + stageH) / tileSize);

    for (let c = startCol; c < endCol; c++) {
      const worldX = c * tileSize;
      const localX = worldX - stageLeft;
      const tileCenterX = worldX + tileSize * 0.5;

      // Determine which of the 4 columns this tile column intersects
      let colIdx = -1;
      for (let i = 0; i < 4; i++) {
        const cx0 = this.colLefts[i];
        const cx1 = cx0 + this.colWidths[i];
        if (tileCenterX >= cx0 && tileCenterX <= cx1) {
          colIdx = i;
          break;
        }
      }
      if (colIdx === -1) continue;

      const colLeftWorld = this.colLefts[colIdx];
      const colW = this.colWidths[colIdx];
      const isColBorderX =
        tileCenterX - colLeftWorld < tileSize * 0.9 ||
        colLeftWorld + colW - tileCenterX < tileSize * 0.9;

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

        // Ahead of ring or already flat & settled (real column DOM underneath is already visible!)
        if (sample.reveal <= 0.001 || sample.settled) continue;

        // Keep 100% solid 3D cube opacity across the entire Rim, Crater, and main Tail,
        // and smoothly feather out only at the very end of the tail where the flat DOM is already 100% revealed underneath
        const waveActivity = clamp01(sample.gridAlpha * 2.4);
        if (waveActivity <= 0.005) continue;

        const isColBorderY =
          localY < tileSize * 0.9 || stageH - (localY + tileSize) < tileSize * 0.9;
        const isBorderTile = isColBorderX || isColBorderY;

        // 2.5D Cube Extrusion Shift (raised tiles shift up-left, crater tiles sink down-right)
        const shiftX = -sample.height * TILE_MAX_EXTRUDE_PX * 0.62;
        const shiftY = -sample.height * TILE_MAX_EXTRUDE_PX * 0.92;
        const drawX = localX + shiftX;
        const drawY = localY + shiftY;

        ctx.save();
        ctx.globalAlpha = waveActivity;

        // 1. 3D Extruded Side Walls & Drop Shadow when tile is raised (height > 0.03)
        if (sample.height > 0.03) {
          const depthPx = Math.max(1.5, sample.height * TILE_MAX_EXTRUDE_PX * 0.85);
          ctx.fillStyle = isSumie
            ? isLightMode
              ? "rgba(28, 24, 18, 0.52)"
              : "rgba(0, 0, 0, 0.78)"
            : "rgba(22, 3, 2, 0.68)";
          ctx.fillRect(drawX + 2, drawY + 2, tileSize + depthPx * 0.55, tileSize + depthPx * 0.82);

          // Right & bottom 3D bevel walls of the raised cube
          ctx.fillStyle = isSumie
            ? isLightMode
              ? "#aba08e"
              : "#0c0b09"
            : "#3e0604";
          ctx.fillRect(drawX + tileSize - 1, drawY + 1, depthPx * 0.55, tileSize);
          ctx.fillStyle = isSumie
            ? isLightMode
              ? "#948978"
              : "#080706"
            : "#2b0403";
          ctx.fillRect(drawX + 1, drawY + tileSize - 1, tileSize + depthPx * 0.45, depthPx * 0.82);
        }

        // 2. Top Cube Face: Red Brocade Texture (or Sumi-e card surface)
        if (!isSumie) {
          ctx.fillStyle = "#6e0e0a";
          ctx.fillRect(drawX, drawY, tileSize, tileSize);
          if (brocadeSource) {
            const bw = (brocadeSource as HTMLImageElement).naturalWidth || (brocadeSource as ImageBitmap).width || 512;
            const bh = (brocadeSource as HTMLImageElement).naturalHeight || (brocadeSource as ImageBitmap).height || 1024;
            const u0 = clamp01((tileCenterX - colLeftWorld) / Math.max(1, colW));
            const v0 = clamp01(localY / Math.max(1, stageH));
            const sw = Math.max(8, (tileSize / Math.max(1, colW)) * bw);
            const sh = Math.max(8, (tileSize / Math.max(1, stageH)) * bh);
            const sx = clamp(u0 * (bw - sw), 0, Math.max(0, bw - sw));
            const sy = clamp(v0 * (bh - sh), 0, Math.max(0, bh - sh));
            ctx.drawImage(brocadeSource, sx, sy, sw, sh, drawX, drawY, tileSize, tileSize);
          }
          // Subtle vertical vignette matching .bp-col background-image
          ctx.fillStyle = "rgba(20, 3, 2, 0.28)";
          ctx.fillRect(drawX, drawY, tileSize, tileSize);
        } else {
          ctx.fillStyle = isLightMode ? "#efe8d8" : "#181614";
          ctx.fillRect(drawX, drawY, tileSize, tileSize);
        }

        // 3. Crater Darkening (darker crimson-red / deep sumi shade + recessed inner shadow)
        if (sample.craterFactor > 0.01) {
          const cAlpha = clamp01(sample.craterFactor * 0.64);
          ctx.fillStyle = isSumie
            ? isLightMode
              ? `rgba(32, 26, 20, ${(cAlpha * 0.55).toFixed(3)})`
              : `rgba(2, 2, 2, ${(cAlpha * 0.78).toFixed(3)})`
            : `rgba(18, 1, 1, ${cAlpha.toFixed(3)})`;
          ctx.fillRect(drawX, drawY, tileSize, tileSize);

          // Recessed top/left inner crater wall shadow
          ctx.fillStyle = "rgba(0, 0, 0, 0.38)";
          ctx.fillRect(drawX, drawY, tileSize, 2);
          ctx.fillRect(drawX, drawY, 2, tileSize);
        }

        // 4. Raised Rim & Border Gold Foil Highlight (--bp-gold-foil)
        const goldStrength = clamp01(
          sample.rimFactor * 0.92 + (isBorderTile ? 0.32 * sample.gridAlpha : 0)
        );
        if (goldStrength > 0.01) {
          const gGrad = ctx.createLinearGradient(
            drawX,
            drawY,
            drawX + tileSize,
            drawY + tileSize
          );
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

        // 5. Hairline Gold / Ink Grid Lines (fade out to 0 as tiles settle)
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
}

export { BrutalistPortfolioUI as PortfolioColumns, BrutalistPortfolioUI as TerminalPortfolioUI };
