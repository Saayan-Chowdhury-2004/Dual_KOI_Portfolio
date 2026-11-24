/**
 * Multi-Style Artistic Koi Pond & Ornate Crimson Lattice Frame Renderer (`src/koiRenderer.ts`).
 *
 * Supports 3 live-switchable traditional Japanese artistic rendering styles:
 * 1. `mokkotsu` — Boneless (*Mokkotsu*) Nihonga Watercolor on Torinoko Washi Parchment (Default)
 * 2. `sumie`    — Zen Ink Wash (*Sumi-e*) with dry-brush *kasure* strokes, stationary paper ink blossoms & vermilion *hanko* accent
 * 3. `ukiyoe`   — Edo-Period Woodblock Print (*Ukiyo-e*) with bold keyblock outlines, *Ai-bokashi* indigo wash & *Ryusui* flowing water curves
 */

import { RED_CARD_TEXTURE_URI, RED_KOI_BORDER_URI, KOI_PORTRAIT_DEFAULT_URI, KOI_PORTRAIT_INK_URI, KOI_PORTRAIT_REAL_URI } from "./columnArtData";
import {
  FLIP_OPEN_DURATION,
  REDUCED_MOTION_FADE_DURATION,
  TILE_MAX_EXTRUDE_PX,
  buildRippleFieldConfig,
  computeAlignedTileSize,
  computeVirtualCenter,
  evaluateRippleTile,
  type RippleCompositionBounds,
  type RippleOrigin,
} from "./rippleField";
import {
  CAUDAL_FIN_CONFIG,
  computeCaudalFin,
  strokeCaudalFinRays,
  traceCaudalFinPath,
} from "./caudalFin";
import { koiBodyHalfWidth, SPINE_NODE_COUNT } from "./koiGeometry";
import { fbm2D, hash2D, koiClamp, koiLerp, koiSmoothstep } from "./koiMath";
import { POND_PALETTES } from "./koiPond";
import {
  bakeSumieParchment,
  bakeSumieWashMosaic,
  bakeSumieForegroundPadSprite,
  paintSumieWaterLily,
  bakeSumieMapleSprite,
  bakeSumieWashBackingSprite,
  bakeSumieSingleFlowerSprite,
  type SumiePaperBundle,
} from "./sumieWash";
import type {
  KoiFish,
  KoiPondConfig,
  OrganicPatch,
  PondFish,
  PondFoodPellet,
  PondPalette,
  PondThemeName,
} from "./koiTypes";
import type { PondWorld } from "./pondWorld";

export type KoiArtStyle = "mokkotsu" | "sumie";

export interface KoiArtStyleMeta {
  id: KoiArtStyle;
  fullLabel: string;
}

export const KOI_ART_STYLES: readonly KoiArtStyleMeta[] = [
  { id: "mokkotsu", fullLabel: "Mokkotsu Watercolor" },
  { id: "sumie", fullLabel: "Sumi-e Zen Ink Wash" },
];

const THEME_TRANSITION_MS = 850;
const MAX_RENDERED_MINNOWS = 16;

export interface PondViewportRect {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
  progress: number;
}

function rgbToRgba(rgb: [number, number, number], alpha: number): string {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.toFixed(3)})`;
}

function darkenRgb(rgb: [number, number, number], factor: number): [number, number, number] {
  return [
    Math.max(0, Math.min(255, Math.round(rgb[0] * factor))),
    Math.max(0, Math.min(255, Math.round(rgb[1] * factor))),
    Math.max(0, Math.min(255, Math.round(rgb[2] * factor))),
  ];
}

function mixRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number
): [number, number, number] {
  const u = koiClamp(t, 0, 1);
  return [
    Math.round(a[0] + (b[0] - a[0]) * u),
    Math.round(a[1] + (b[1] - a[1]) * u),
    Math.round(a[2] + (b[2] - a[2]) * u),
  ];
}

export class KoiPondRenderer {
  private fontFamily = '"KanjiBrutalist", Georgia, "Times New Roman", serif';
  private configuredTheme: PondThemeName = "light-pond";
  private currentPalette: PondPalette = POND_PALETTES["light-pond"];
  private previousPalette: PondPalette | null = null;
  private themeTransitionStart = 0;
  private transitioning = false;
  private themeProgress = 1;
  private sunCycleTargetLight = true;
  private sunCycleStartHour = 12.0;
  private sunCycleEndHour = 12.0;
  private readonly sunCycleDurationMs = 2400;
  private darkModeToggleAt = -1;
  private causticTileCache: Map<string, HTMLCanvasElement> = new Map();
  private canopyShadowCache: Map<string, HTMLCanvasElement> = new Map();
  private botanicalSpriteCacheMap: Map<
    string,
    {
      lotus: HTMLCanvasElement[];
      companion: HTMLCanvasElement[];
      pinkLotus: HTMLCanvasElement[];
    }
  > = new Map();
  private sakuraSpriteCacheMap: Map<
    string,
    {
      floatingFlower: HTMLCanvasElement[];
      sunkenFlower: HTMLCanvasElement[];
      floatingPetal: HTMLCanvasElement[];
      sunkenPetal: HTMLCanvasElement[];
    }
  > = new Map();

  private artStyle: KoiArtStyle = "mokkotsu";

  private timeOfDayHours = 12.0;

  private parchmentCanvas: HTMLCanvasElement | null = null;
  private parchmentKey = "";
  private parchmentCache: Map<string, HTMLCanvasElement> = new Map();
  private sumiePaperCache: Map<string, SumiePaperBundle> = new Map();
  private sumieMapleCache: Map<string, HTMLCanvasElement[]> = new Map();
  private sumieClusterCache: Map<string, HTMLCanvasElement[]> = new Map();
  private sumieSingleFlowerCache: Map<string, HTMLCanvasElement[]> = new Map();
  private sumieCornerPadCache: Map<string, HTMLCanvasElement[]> = new Map();
  private dofSakuraCache: Map<string, Array<{ near: HTMLCanvasElement; far: HTMLCanvasElement }>> = new Map();
  private sumieFlowers: Array<{
    fx: number;
    fy: number;
    ox: number;
    oy: number;
    vx: number;
    vy: number;
    rot: number;
    vrot: number;
    sizeIdx: number;
    phase: number;
  }> = [];
  private sumieFlowersLastTime = -1;

  private pebbleBedCanvas: HTMLCanvasElement | null = null;
  private pebbleBedKey = "";
  private pebbleBedCache: Map<string, HTMLCanvasElement> = new Map();

  private causticTileCanvas: HTMLCanvasElement | null = null;
  private causticTileKey = "";
  private causticWorkCanvas: HTMLCanvasElement | null = null;
  private shadowWorkCanvas: HTMLCanvasElement | null = null;
  private shadowBlurCanvas: HTMLCanvasElement | null = null;
  private canopyShadowCanvas: HTMLCanvasElement | null = null;
  private canopyShadowKey = "";
  private sakuraDeepCanvas: HTMLCanvasElement | null = null;
  private sakuraMidCanvas: HTMLCanvasElement | null = null;
  private sakuraNearCanvas: HTMLCanvasElement | null = null;
  private sakuraCanopyKey = "";
  private kumikoLanternCanvas: HTMLCanvasElement | null = null;
  private kumikoLanternKey = "";
  private causticMaskCanvas: HTMLCanvasElement | null = null;
  private botanicalSpriteKey = "";
  private lotusLeafSprites: HTMLCanvasElement[] = [];
  private companionLeafSprites: HTMLCanvasElement[] = [];
  private pinkLotusSprites: HTMLCanvasElement[] = [];
  private mapleLeafSprites: HTMLCanvasElement[] = [];
  private readonly stemLockedEdges: ("left" | "right" | "top" | "bottom")[] = [];

  // Asynchronous per-pad sway state + secondary phase lag + click-ripple sway for all 9 lotus leaves
  private readonly lotusPadStates: {
    leafPhase: number;
    flowerPhase: number;
    excite: number;
    baseFreq: number;
    swayX: number;
    swayY: number;
    swayVx: number;
    swayVy: number;
    rotOffset: number;
    rotVel: number;
    dispX: number;
    dispY: number;
    dispVx: number;
    dispVy: number;
    bowX: number;
    bowY: number;
  }[] = [
    { leafPhase: 0.0, flowerPhase: -0.65, excite: 0, baseFreq: 0.26, swayX: 0, swayY: 0, swayVx: 0, swayVy: 0, rotOffset: 0, rotVel: 0, dispX: 0, dispY: 0, dispVx: 0, dispVy: 0, bowX: 0, bowY: 0 },
    { leafPhase: 1.4, flowerPhase: 0.75, excite: 0, baseFreq: 0.35, swayX: 0, swayY: 0, swayVx: 0, swayVy: 0, rotOffset: 0, rotVel: 0, dispX: 0, dispY: 0, dispVx: 0, dispVy: 0, bowX: 0, bowY: 0 },
    { leafPhase: 2.8, flowerPhase: 2.15, excite: 0, baseFreq: 0.39, swayX: 0, swayY: 0, swayVx: 0, swayVy: 0, rotOffset: 0, rotVel: 0, dispX: 0, dispY: 0, dispVx: 0, dispVy: 0, bowX: 0, bowY: 0 },
    { leafPhase: 4.2, flowerPhase: 3.55, excite: 0, baseFreq: 0.44, swayX: 0, swayY: 0, swayVx: 0, swayVy: 0, rotOffset: 0, rotVel: 0, dispX: 0, dispY: 0, dispVx: 0, dispVy: 0, bowX: 0, bowY: 0 },
    { leafPhase: 5.5, flowerPhase: 4.85, excite: 0, baseFreq: 0.32, swayX: 0, swayY: 0, swayVx: 0, swayVy: 0, rotOffset: 0, rotVel: 0, dispX: 0, dispY: 0, dispVx: 0, dispVy: 0, bowX: 0, bowY: 0 },
    { leafPhase: 2.1, flowerPhase: 1.45, excite: 0, baseFreq: 0.24, swayX: 0, swayY: 0, swayVx: 0, swayVy: 0, rotOffset: 0, rotVel: 0, dispX: 0, dispY: 0, dispVx: 0, dispVy: 0, bowX: 0, bowY: 0 },
    { leafPhase: 3.7, flowerPhase: 3.05, excite: 0, baseFreq: 0.31, swayX: 0, swayY: 0, swayVx: 0, swayVy: 0, rotOffset: 0, rotVel: 0, dispX: 0, dispY: 0, dispVx: 0, dispVy: 0, bowX: 0, bowY: 0 },
    { leafPhase: 0.9, flowerPhase: 0.25, excite: 0, baseFreq: 0.37, swayX: 0, swayY: 0, swayVx: 0, swayVy: 0, rotOffset: 0, rotVel: 0, dispX: 0, dispY: 0, dispVx: 0, dispVy: 0, bowX: 0, bowY: 0 },
    { leafPhase: 4.9, flowerPhase: 4.25, excite: 0, baseFreq: 0.42, swayX: 0, swayY: 0, swayVx: 0, swayVy: 0, rotOffset: 0, rotVel: 0, dispX: 0, dispY: 0, dispVx: 0, dispVy: 0, bowX: 0, bowY: 0 },
  ];
  private readonly companionLeafStates: {
    dispX: number;
    dispY: number;
    dispVx: number;
    dispVy: number;
    bowX: number;
    bowY: number;
  }[] = Array.from({ length: 18 }, () => ({
    dispX: 0,
    dispY: 0,
    dispVx: 0,
    dispVy: 0,
    bowX: 0,
    bowY: 0,
  }));

  // Unbounded free-floating world position & velocity state for the 6 floating maple leaves (no region lock!)
  private readonly mapleLeafStates: {
    initialized: boolean;
    x: number;
    y: number;
    velX: number;
    velY: number;
    rot: number;
    rotVel: number;
  }[] = Array.from({ length: 20 }, () => ({
    initialized: false,
    x: 0,
    y: 0,
    velX: 0,
    velY: 0,
    rot: 0,
    rotVel: 0,
  }));
  private mapleLeafWorldW = 0;
  private mapleLeafWorldH = 0;

  private readonly dragonflyStates: {
    initialized: boolean;
    x: number;
    y: number;
    vx: number;
    vy: number;
    heading: number;
    mode: "hovering" | "darting" | "perched";
    modeTimer: number;
    flightTimeLeft: number;
    targetX: number;
    targetY: number;
    perchType: "none" | "lotus-leaf" | "lotus-flower" | "maple-leaf" | "companion-leaf";
    perchPadIdx: number;
    perchOffsetAngle: number;
    perchOffsetR: number;
    perchLocalHeading: number;
    wingPhase: number;
    variety: "akiakane" | "ruriboshi";
    scale: number;
    departed: boolean;
  }[] = Array.from({ length: 5 }, (_, idx) => ({
    initialized: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    heading: idx * 1.25,
    mode: idx % 2 === 0 ? "hovering" : "perched",
    modeTimer: 2.8 + idx * 1.1,
    flightTimeLeft: idx % 2 === 0 ? 9.5 + idx * 1.8 : 0,
    targetX: 0,
    targetY: 0,
    perchType: idx % 2 === 0 ? "none" : idx === 1 ? "lotus-flower" : idx === 3 ? "maple-leaf" : "lotus-leaf",
    perchPadIdx: idx === 1 ? 0 : idx === 3 ? 1 : (idx * 2) % 9,
    perchOffsetAngle: idx * 1.1,
    perchOffsetR: idx === 1 ? 0.34 : idx === 3 ? 0.25 : 0.52,
    perchLocalHeading: idx * 0.9 - 0.5,
    wingPhase: idx * 2.1,
    variety: idx % 2 === 0 ? "akiakane" : "ruriboshi",
    scale: 1.16 + (idx % 3) * 0.10,
    departed: false,
  }));
  private lastDragonflyUpdateAt = 0;

  // Interactive single-ring water ripples generated by clicking anywhere on the pond
  private readonly clickRipples: {
    x: number;
    y: number;
    radius: number;
    lastRadius: number;
    maxRadius: number;
    strength: number;
  }[] = [];
  private lastBotanicalUpdateAt = 0;
  private causticGLCanvas: HTMLCanvasElement | null = null;
  private causticGL: WebGLRenderingContext | null = null;
  private causticGLProg: WebGLProgram | null = null;
  private causticGLQuad: WebGLBuffer | null = null;
  private causticGLUniforms: Record<string, WebGLUniformLocation | null> = {};
  private causticGLFailed = false;

  // Dark Mode Flashlight state (smooth cursor follow, calm off-screen drift, and column dispersal)
  private flashX = -1;
  private flashY = -1;
  private rawPointerX = -1;
  private rawPointerY = -1;
  private rawPointerActive = false;
  private profileTargetOpen = false;
  private flashlightEnabled = true;
  private hasAutoActivatedFlashlightOnce = false;
  private flashlightDispersal = 1;
  private lastFlashUpdateAt = 0;

  // Continuous mouse-interaction water wavelets
  private readonly mouseWaves: {
    x: number;
    y: number;
    r: number;
    maxR: number;
    born: number;
  }[] = [];
  private lastWaveSpawnX = -9999;
  private lastWaveSpawnY = -9999;

  private redBorderImg: HTMLImageElement | null = null;
  private redBorderLoaded = false;
  private sumieBorderCanvas: HTMLCanvasElement | null = null;

  private portraitDefaultImg: HTMLImageElement | null = null;
  private portraitDefaultLoaded = false;
  private portraitInkImg: HTMLImageElement | null = null;
  private portraitInkLoaded = false;
  private portraitRealImg: HTMLImageElement | null = null;
  private portraitRealLoaded = false;
  private portraitRealBwCanvas: HTMLCanvasElement | null = null;
  private portraitPhotoRevealed = false;
  private portraitGlazeDismissed = false;
  private portraitTransFromKind: "default" | "ink" | "real" = "default";
  private portraitTransToKind: "default" | "ink" | "real" = "real";
  private portraitTransCanvas: HTMLCanvasElement | null = null;
  private portraitBufScratchCanvas: HTMLCanvasElement | null = null;
  private portraitBurnField: Float32Array | null = null;
  private portraitBurnFieldKey = "";
  private portraitPixelBuffers: Record<string, Uint8ClampedArray> = {};
  private portraitBurnOutImgData: ImageData | null = null;
  private portraitBurnOutKey = "";
  private portraitStyleTransActive = false;
  private portraitStyleTransMode: "ink" | "flame" = "ink";
  private portraitStyleTransStart = 0;
  private portraitStyleTransProgress = 1;
  private readonly portraitStyleTransDuration = 1480;
  private portraitNextClickAllowedAt = 0;
  private skipPhysicsStepOnce = false;

  private rectProgress = 0;
  private rippleOrigin: RippleOrigin = { x: 240, y: 420 };
  private rippleCellW = 8;
  private rippleCellH = 8;
  private rippleQualityLevel = 0;
  private rippleReducedMotion = false;
  private frameCompositeCanvas: HTMLCanvasElement | null = null;
  private redCardImg: HTMLImageElement | null = null;
  private redCardLoaded = false;
  private menuBlurPx = 8.0;
  private activeColumnRects: { x: number; y: number; w: number; h: number }[] = [];
  private blurScratchCanvas: HTMLCanvasElement | null = null;
  private activeRect: PondViewportRect = {
    x: 0,
    y: 0,
    w: 1440,
    h: 900,
    scale: 1,
    progress: 0,
  };

  private readonly leftX = new Float32Array(SPINE_NODE_COUNT);
  private readonly leftY = new Float32Array(SPINE_NODE_COUNT);
  private readonly rightX = new Float32Array(SPINE_NODE_COUNT);
  private readonly rightY = new Float32Array(SPINE_NODE_COUNT);
  private readonly ptScratch = { x: 0, y: 0, tx: 1, ty: 0, nx: 0, ny: 1 };

  constructor() {
    if (typeof Image !== "undefined") {
      const img = new Image();
      img.onload = () => {
        this.redBorderLoaded = true;
      };
      img.src = RED_KOI_BORDER_URI;
      this.redBorderImg = img;

      const cardImg = new Image();
      cardImg.decoding = "async";
      cardImg.onload = () => {
        this.redCardLoaded = true;
      };
      cardImg.src = RED_CARD_TEXTURE_URI;
      this.redCardImg = cardImg;

      const pDef = new Image();
      pDef.onload = () => {
        this.portraitDefaultLoaded = true;
      };
      pDef.src = KOI_PORTRAIT_DEFAULT_URI;
      this.portraitDefaultImg = pDef;

      const pInk = new Image();
      pInk.onload = () => {
        this.portraitInkLoaded = true;
      };
      pInk.src = KOI_PORTRAIT_INK_URI;
      this.portraitInkImg = pInk;

      const pReal = new Image();
      pReal.onload = () => {
        this.portraitRealLoaded = true;
      };
      pReal.src = KOI_PORTRAIT_REAL_URI;
      this.portraitRealImg = pReal;
    }
  }

  public destroy(): void {
    this.parchmentCanvas = null;
    this.parchmentCache.clear();
    this.pebbleBedCanvas = null;
    this.pebbleBedCache.clear();
    this.causticTileCanvas = null;
    this.causticWorkCanvas = null;
    this.shadowWorkCanvas = null;
    this.shadowBlurCanvas = null;
    this.canopyShadowCanvas = null;
    this.sakuraDeepCanvas = null;
    this.sakuraMidCanvas = null;
    this.sakuraNearCanvas = null;
    this.kumikoLanternCanvas = null;
    this.causticMaskCanvas = null;
    this.botanicalSpriteKey = "";
    this.causticGLCanvas = null;
    this.causticGL = null;
    this.causticGLProg = null;
    this.redBorderImg = null;
  }

  public setFontFamily(family: string): void {
    if (family && family !== this.fontFamily) {
      this.fontFamily = `"KanjiBrutalist", ${family}`;
    }
  }

  public getArtStyle(): KoiArtStyle {
    return this.artStyle;
  }

  public getArtStyleMeta(): KoiArtStyleMeta {
    return KOI_ART_STYLES.find((s) => s.id === this.artStyle) ?? KOI_ART_STYLES[0];
  }

  private getPortraitImageByKind(kind: "default" | "ink" | "real"): HTMLImageElement | null {
    if (kind === "real") {
      if (this.portraitRealImg && (this.portraitRealLoaded || this.portraitRealImg.width > 0)) {
        return this.portraitRealImg;
      }
    }
    if (kind === "ink") {
      if (this.portraitInkImg && (this.portraitInkLoaded || this.portraitInkImg.width > 0)) {
        return this.portraitInkImg;
      }
    }
    if (this.portraitDefaultImg && (this.portraitDefaultLoaded || this.portraitDefaultImg.width > 0)) {
      return this.portraitDefaultImg;
    }
    return this.portraitInkImg ?? this.portraitRealImg;
  }

  private getCurrentPaintingKind(): "default" | "ink" {
    return this.artStyle === "sumie" ? "ink" : "default";
  }

  private getTargetPortraitKind(): "default" | "ink" | "real" {
    return this.portraitPhotoRevealed ? "real" : this.getCurrentPaintingKind();
  }

  /**
   * Triggered when the user clicks the portrait inside the Profile Menu:
   * - In Default (`mokkotsu`) mode: runs the Burning Washi Flame transition (`"flame"`)
   *   converting the painting (`Saayan_artistic.png`) to the aligned real photo (`saayan_real.png`)
   *   (and back on subsequent click).
   * - In Ink (`sumie`) mode: runs the Organic Sumi Ink Splatter transition (`"ink"`)
   *   where ink splatters reveal the aligned real photo (`saayan_real.png`)
   *   (and back on subsequent click).
   */
  public canClickPortraitPhoto(now = typeof performance !== "undefined" ? performance.now() : 0): boolean {
    return !this.portraitStyleTransActive && now >= this.portraitNextClickAllowedAt;
  }

  public togglePortraitPhoto(): boolean {
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    // Ignore extra clicks while the transition is running AND for 1 full second (1000ms) after completion
    if (!this.canClickPortraitPhoto(now)) {
      return this.portraitPhotoRevealed;
    }
    const fromKind = this.getTargetPortraitKind();
    this.portraitPhotoRevealed = !this.portraitPhotoRevealed;
    this.portraitGlazeDismissed = true;
    const toKind = this.getTargetPortraitKind();
    this.portraitTransFromKind = fromKind;
    this.portraitTransToKind = toKind;
    this.portraitStyleTransMode = this.artStyle === "sumie" ? "ink" : "flame";
    this.portraitStyleTransStart = now;
    this.portraitStyleTransProgress = 0;
    this.portraitStyleTransActive = true;
    this.portraitNextClickAllowedAt = now + this.portraitStyleTransDuration + 1000;
    return this.portraitPhotoRevealed;
  }

  public isPortraitPhotoRevealed(): boolean {
    return this.portraitPhotoRevealed;
  }

  public setPortraitPhotoRevealed(revealed: boolean, immediate = true): void {
    this.portraitPhotoRevealed = revealed;
    if (immediate) {
      const k = this.getTargetPortraitKind();
      this.portraitTransFromKind = k;
      this.portraitTransToKind = k;
      this.portraitStyleTransActive = false;
      this.portraitStyleTransProgress = 1;
      this.portraitNextClickAllowedAt = 0;
    }
  }

  private startPortraitStyleTransition(toStyle: KoiArtStyle): void {
    const k = this.portraitPhotoRevealed ? "real" : (toStyle === "sumie" ? "ink" : "default");
    this.portraitTransFromKind = k;
    this.portraitTransToKind = k;
    this.portraitStyleTransMode = toStyle === "sumie" ? "ink" : "flame";
    this.portraitStyleTransActive = false;
    this.portraitStyleTransProgress = 1;
  }

  public setArtStyle(style: KoiArtStyle): KoiArtStyleMeta {
    if (KOI_ART_STYLES.some((s) => s.id === style) && this.artStyle !== style) {
      this.artStyle = style;
      this.startPortraitStyleTransition(style);
    }
    return this.getArtStyleMeta();
  }

  public cycleArtStyle(): KoiArtStyleMeta {
    const idx = KOI_ART_STYLES.findIndex((s) => s.id === this.artStyle);
    const next = KOI_ART_STYLES[(idx + 1) % KOI_ART_STYLES.length];
    if (this.artStyle !== next.id) {
      this.artStyle = next.id;
      this.startPortraitStyleTransition(next.id);
    }
    return next;
  }

  /** Allows setting an explicit transition progress [0..1] for deterministic testing/rendering. */
  public setPortraitTransitionDebug(mode: "ink" | "flame", progress: number): void {
    this.portraitStyleTransMode = mode;
    this.portraitTransFromKind = mode === "ink" ? "ink" : "default";
    this.portraitTransToKind = "real";
    this.portraitPhotoRevealed = true;
    this.portraitStyleTransProgress = koiClamp(progress, 0, 1);
    this.portraitStyleTransActive = progress > 0 && progress < 1;
    this.portraitStyleTransStart =
      (typeof performance !== "undefined" ? performance.now() : 0) -
      this.portraitStyleTransProgress * this.portraitStyleTransDuration;
  }

  public static normalizeHours(hours: number): number {
    const h = Number.isFinite(hours) ? hours : 12.0;
    return ((h % 24) + 24) % 24;
  }

  /**
   * Returns true when the time of day is at or past 1800 hrs (18:00 through 06:00 dawn),
   * when the pond is in Night Mode and the lamp button + lamplight activate automatically.
   */
  public static isNightLampTime(hours: number): boolean {
    const h = KoiPondRenderer.normalizeHours(hours);
    return h >= 18.0 || h < 6.0;
  }

  /**
   * Continuous daylight factor [0..1] across the 24-hour cycle:
   * - 09:00..15:00 -> 1.0 (full bright daylight)
   * - 15:00..18:00 -> smoothly darkens from 1.0 down to 0.0 right as time reaches 1800 hrs
   * - 18:00..05:00 -> 0.0 (full night darkness with lamp active)
   * - 05:00..09:00 -> dawn brightening from 0.0 to 1.0
   */
  public static computeDaylightFactor(hours: number): number {
    const h = KoiPondRenderer.normalizeHours(hours);
    if (h >= 9.0 && h < 15.0) return 1.0;
    if (h >= 15.0 && h < 16.2) {
      // 15:00..16:12 -> warm late afternoon (1.0 down to 0.76)
      return 1.0 - koiSmoothstep(15.0, 16.2, h) * 0.24;
    }
    if (h >= 16.2 && h < 17.15) {
      // 16:12..17:09 -> sunset transition into deep evening twilight (0.76 down to 0.10)
      return 0.76 - koiSmoothstep(16.2, 17.15, h) * 0.66;
    }
    if (h >= 17.15 && h < 18.0) {
      // 17:09..18:00 -> deep twilight settling into night (0.10 down to 0.0)
      return 0.10 * (1.0 - koiSmoothstep(17.15, 18.0, h));
    }
    if (h >= 18.0 || h < 5.0) return 0.0;
    return koiSmoothstep(5.0, 9.0, h);
  }

  /**
   * Evening firefly presence factor [0..1]:
   * Emerges as the sun sets (~16:20..16:50), glows at full strength throughout the evening
   * sunset and twilight (16:50..21:30), and lingers softly through the night until dawn (05:30).
   */
  public static computeEveningFireflyFactor(hours: number): number {
    const h = KoiPondRenderer.normalizeHours(hours);
    if (h >= 16.2 && h < 16.85) {
      return koiSmoothstep(16.2, 16.85, h);
    }
    if (h >= 16.85 && h < 21.5) {
      return 1.0;
    }
    if (h >= 21.5 || h < 4.8) {
      return 0.85;
    }
    if (h >= 4.8 && h < 5.8) {
      return 0.85 * (1.0 - koiSmoothstep(4.8, 5.8, h));
    }
    return 0.0;
  }

  public getTimeOfDayHours(): number {
    return this.timeOfDayHours;
  }

  public getDaylightFactor(): number {
    return KoiPondRenderer.computeDaylightFactor(this.timeOfDayHours);
  }

  public getEveningFireflyFactor(): number {
    return KoiPondRenderer.computeEveningFireflyFactor(this.timeOfDayHours);
  }

  /**
   * Daytime dragonfly presence factor [0..1] during the morning and noon (day half):
   * Fades in during the morning (05:45..06:45), stays at 1.0 across morning, noon, and early
   * afternoon (06:45..15:45), and fades out before sunset (15:45..16:25).
   */
  public static computeDaytimeDragonflyFactor(hours: number): number {
    const h = KoiPondRenderer.normalizeHours(hours);
    if (h >= 5.75 && h < 6.75) {
      return koiSmoothstep(5.75, 6.75, h);
    }
    if (h >= 6.75 && h < 15.75) {
      return 1.0;
    }
    if (h >= 15.75 && h < 16.42) {
      return 1.0 - koiSmoothstep(15.75, 16.42, h);
    }
    return 0.0;
  }

  public getDaytimeDragonflyFactor(): number {
    return KoiPondRenderer.computeDaytimeDragonflyFactor(this.timeOfDayHours);
  }

  /**
   * Unified solar/lunar lighting state for the entire pond:
   * - `sunNormX, sunNormY`: virtual sun arc (East/right sunrise -> High midday -> West/left sunset)
   * - `shadowX, shadowY`: dynamic shadow offset in px/unit opposite sun azimuth (stretches long West
   *   at sunrise, shortens to (+20, +26) at noon, stretches long East at sunset, diffuses at night)
   * - `shadowBlurScale`: sharper at noon (1.0), softer penumbra at low sun / twilight / night (up to 1.85)
   * - `lowSunWarmth`: [0..1] golden-hour / amber-vermilion intensity at sunrise & sunset
   */
  private getSolarLightingState(): {
    daylight: number;
    h: number;
    sunNormX: number;
    sunNormY: number;
    shadowX: number;
    shadowY: number;
    shadowBlurScale: number;
    lowSunWarmth: number;
    isSunriseWindow: boolean;
    isSunsetWindow: boolean;
  } {
    const daylight = this.getDaylightFactor();
    const h = KoiPondRenderer.normalizeHours(this.timeOfDayHours);

    let sunNormX = 0.50;
    let sunNormY = 0.36;
    let shadowX = 20.0;
    let shadowY = 26.0;
    let shadowBlurScale = 1.0;
    let lowSunWarmth = 0.0;
    let isSunriseWindow = false;
    let isSunsetWindow = false;

    if (h >= 4.8 && h < 9.2) {
      isSunriseWindow = true;
      const u = koiClamp((h - 4.8) / 4.4, 0, 1);
      const ease = koiSmoothstep(0, 1, u);
      sunNormX = koiLerp(0.90, 0.50, ease);
      sunNormY = koiLerp(0.20, 0.36, ease);
      shadowX = koiLerp(-52.0, 20.0, ease);
      shadowY = koiLerp(34.0, 26.0, ease);
      lowSunWarmth = Math.sin(u * Math.PI);
      shadowBlurScale = koiLerp(1.75, 1.0, ease);
    } else if (h >= 9.2 && h < 14.3) {
      const u = koiClamp((h - 9.2) / 5.1, 0, 1);
      sunNormX = koiLerp(0.50, 0.46, u);
      sunNormY = koiLerp(0.36, 0.40, u);
      shadowX = koiLerp(18.0, 22.0, u);
      shadowY = koiLerp(26.0, 25.0, u);
      lowSunWarmth = 0.0;
      shadowBlurScale = 1.0;
    } else if (h >= 14.3 && h < 18.4) {
      isSunsetWindow = true;
      const u = koiClamp((h - 14.3) / 4.1, 0, 1);
      const ease = koiSmoothstep(0, 1, u);
      sunNormX = koiLerp(0.46, 0.08, ease);
      sunNormY = koiLerp(0.40, 0.78, ease);
      const stretchPeak = Math.sin(Math.min(1, u * 1.15) * Math.PI * 0.5);
      const twilightDiffuse = koiSmoothstep(0.75, 1.0, u);
      shadowX = koiLerp(koiLerp(22.0, 64.0, stretchPeak), 12.0, twilightDiffuse);
      shadowY = koiLerp(koiLerp(25.0, 14.0, stretchPeak), 18.0, twilightDiffuse);
      lowSunWarmth = Math.sin(u * Math.PI);
      shadowBlurScale = koiLerp(1.0, 1.85, ease);
    } else {
      sunNormX = 0.34;
      sunNormY = 0.24;
      shadowX = 12.0;
      shadowY = 18.0;
      lowSunWarmth = 0.0;
      shadowBlurScale = 1.75;
    }

    return {
      daylight,
      h,
      sunNormX,
      sunNormY,
      shadowX,
      shadowY,
      shadowBlurScale,
      lowSunWarmth,
      isSunriseWindow,
      isSunsetWindow,
    };
  }

  public setTimeOfDayHours(hours: number, immediate = false): void {
    const prevNight = KoiPondRenderer.isNightLampTime(this.timeOfDayHours);
    const nextHours = KoiPondRenderer.normalizeHours(hours);
    const nextNight = KoiPondRenderer.isNightLampTime(nextHours);
    this.timeOfDayHours = nextHours;

    const nextTheme: PondThemeName = nextNight ? "black-pond" : "light-pond";
    this.configuredTheme = nextTheme;
    this.currentPalette = POND_PALETTES[nextTheme];

    if (nextNight && !this.hasAutoActivatedFlashlightOnce) {
      // Auto-enable the flashlight ONLY ONCE the first time the viewer experiences dark mode;
      // thereafter every time the viewer enters/toggles dark mode, it is normal dark mode
      // (`flashlightEnabled = false`) unless the user manually clicks the lamp button.
      this.flashlightEnabled = true;
      this.hasAutoActivatedFlashlightOnce = true;
    } else if (!prevNight && nextNight && this.hasAutoActivatedFlashlightOnce) {
      this.flashlightEnabled = false;
    }

    if (immediate) {
      this.previousPalette = null;
      this.transitioning = false;
      this.themeProgress = 1;
      this.sunCycleTargetLight = !nextNight;
      this.flashlightDispersal = !nextNight || !this.flashlightEnabled ? 1 : 0;
    }
  }

  public get isLightMode(): boolean {
    if (this.transitioning) {
      return this.sunCycleTargetLight;
    }
    return !KoiPondRenderer.isNightLampTime(this.timeOfDayHours);
  }

  public get isTransitioning(): boolean {
    const targetDisp = this.isLightMode || !this.flashlightEnabled ? 1 : 0;
    return (
      this.transitioning ||
      this.portraitStyleTransActive ||
      Math.abs(this.flashlightDispersal - targetDisp) > 0.002
    );
  }

  public get isFlashlightEnabled(): boolean {
    return this.flashlightEnabled;
  }

  public setFlashlightEnabled(enabled: boolean): boolean {
    this.flashlightEnabled = enabled;
    return this.flashlightEnabled;
  }

  public toggleFlashlightEnabled(): boolean {
    this.flashlightEnabled = !this.flashlightEnabled;
    return this.flashlightEnabled;
  }

  public getFlashlightVeilMetrics(width: number, height: number): {
    active: boolean;
    x: number;
    y: number;
    innerR: number;
    outerR: number;
    maxVeilAlpha: number;
  } {
    if (this.flashlightDispersal >= 0.998) {
      return { active: false, x: this.flashX, y: this.flashY, innerR: 0, outerR: 9999, maxVeilAlpha: 0 };
    }
    const easeDisp = koiSmoothstep(0, 1, this.flashlightDispersal);
    const baseRadius = this.getFlashlightBaseRadius(width, height);
    const maxDiag = Math.hypot(width, height) * 1.65;
    const outerR = koiLerp(baseRadius, maxDiag, easeDisp * easeDisp);
    const innerR = outerR * 0.10;
    const maxVeilAlpha = this.isLightMode
      ? 0.968 * (1 - easeDisp * 0.92)
      : koiLerp(0.968, 0.86, easeDisp);
    return {
      active: maxVeilAlpha > 0.005,
      x: this.flashX < 0 ? width * 0.5 : this.flashX,
      y: this.flashY < 0 ? height * 0.5 : this.flashY,
      innerR,
      outerR,
      maxVeilAlpha,
    };
  }

  public setFlashlightPointer(x: number, y: number, active: boolean): void {
    this.rawPointerX = x;
    this.rawPointerY = y;
    this.rawPointerActive = active;
  }

  public setProfileTargetOpen(open: boolean): void {
    this.profileTargetOpen = open;
  }

  /**
   * Spawns a single expanding water ripple at `(x, y)` in pond world coordinates and
   * imparts an immediate radial water-wave impulse:
   * - Displaces floating Sakura flowers & petals freely anywhere in the pond (region lock lifted)
   * - Displaces floating Maple leaves freely anywhere in the pond (region lock lifted)
   * - Sways Lotus leaves and blooming Pink Lotuses in place without relocating them
   */
  public triggerPondClick(x: number, y: number, worldW: number, worldH: number): void {
    const unit = koiClamp(Math.min(worldW, worldH) / 860, 0.48, 1.25);
    this.clickRipples.push({
      x,
      y,
      radius: 4 * unit,
      lastRadius: 0,
      maxRadius: 215 * unit,
      strength: 1.0,
    });
    if (this.clickRipples.length > 12) {
      this.clickRipples.shift();
    }

    // 0. Immediate individual ripple impulse on nearby Sumi-e 5-petal flowers
    if (this.artStyle === "sumie" && this.sumieFlowers.length > 0) {
      const flReach = 225 * unit;
      for (let i = 0; i < this.sumieFlowers.length; i++) {
        const fl = this.sumieFlowers[i];
        const curX = worldW * fl.fx + fl.ox;
        const curY = worldH * fl.fy + fl.oy;
        const dx = curX - x;
        const dy = curY - y;
        const dist = Math.hypot(dx, dy);
        if (dist < flReach) {
          const ux = dist > 0.5 ? dx / dist : Math.cos(i * 2.1);
          const uy = dist > 0.5 ? dy / dist : Math.sin(i * 2.1);
          const falloff = Math.pow(1 - dist / flReach, 1.25);
          const pushSpd = (58 + (i % 5) * 9) * falloff * unit;
          fl.vx += ux * pushSpd;
          fl.vy += uy * pushSpd;
          fl.vrot += ((i % 2 === 0 ? 1 : -1) * (1.8 + (i % 4) * 0.55)) * falloff;
        }
      }
    }

    // 1. Immediate ripple impulse on nearby Floating Sakura Flowers & Petals
    const sakuraReach = 175 * unit;
    for (let i = 0; i < this.floatingSakuraParticles.length; i++) {
      const p = this.floatingSakuraParticles[i];
      const dx = p.x - x;
      const dy = p.y - y;
      const dist = Math.hypot(dx, dy);
      if (dist < sakuraReach) {
        const ux = dist > 0.5 ? dx / dist : Math.cos(i * 1.9);
        const uy = dist > 0.5 ? dy / dist : Math.sin(i * 1.9);
        const falloff = Math.pow(1 - dist / sakuraReach, 1.35);
        const pushSpd = (p.kind === "flower" ? 28 : 34) * falloff * unit;
        p.vx += ux * pushSpd;
        p.vy += uy * pushSpd;
        p.calmCooldown = Math.max(p.calmCooldown, 1.0);
      }
    }

    // 2. Immediate ripple impulse on nearby Floating Maple Leaves (unbounded across pond)
    const specs = this.getLargeMapleLeafSpecs(worldW, worldH, unit, 0);
    const mapleReach = 185 * unit;
    for (let m = 0; m < specs.length; m++) {
      const mst = this.mapleLeafStates[m];
      if (!mst.initialized) {
        mst.x = specs[m].x;
        mst.y = specs[m].y;
        mst.rot = specs[m].rot;
        mst.initialized = true;
      }
      const dx = mst.x - x;
      const dy = mst.y - y;
      const dist = Math.hypot(dx, dy);
      if (dist < mapleReach) {
        const ux = dist > 0.5 ? dx / dist : Math.cos(m * 1.7);
        const uy = dist > 0.5 ? dy / dist : Math.sin(m * 1.7);
        const falloff = Math.pow(1 - dist / mapleReach, 1.25);
        const impulse = 195 * falloff * unit;
        mst.velX += ux * impulse;
        mst.velY += uy * impulse;
        mst.rotVel += (ux * Math.sin(mst.rot) - uy * Math.cos(mst.rot)) * 1.4 * falloff;
      }
    }

    // 3. Immediate ripple sway impulse on Lotus Leaves & Lotuses (sways in place only!)
    const resolvedPads = this.getResolvedLotusPads(worldW, worldH, unit);
    for (let i = 0; i < resolvedPads.length; i++) {
      const pad = resolvedPads[i];
      const st = this.lotusPadStates[i];
      const dx = pad.x - x;
      const dy = pad.y - y;
      const dist = Math.hypot(dx, dy);
      const lotusReach = pad.r * 1.45 + 145 * unit;
      if (dist < lotusReach) {
        const ux = dist > 0.5 ? dx / dist : Math.cos(i * 1.3);
        const uy = dist > 0.5 ? dy / dist : Math.sin(i * 1.3);
        const falloff = Math.pow(1 - dist / lotusReach, 1.2);
        st.excite = Math.min(1.5, st.excite + 1.15 * falloff);
        st.swayVx += ux * 58 * falloff * unit;
        st.swayVy += uy * 58 * falloff * unit;
        st.rotVel += (ux * -uy >= 0 ? 1 : -1) * 0.45 * falloff;
      }
    }

    // Dragonflies remain calm and are never startled or wobbled by cursor proximity or pond clicks
  }

  public get transitionProgress(): number {
    return this.themeProgress;
  }

  public setRectProgress(progress: number): void {
    this.rectProgress = koiClamp(progress, 0, 1);
  }

  public setRippleOrigin(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.rippleOrigin = { x, y };
  }

  public getRippleOrigin(): RippleOrigin {
    return { x: this.rippleOrigin.x, y: this.rippleOrigin.y };
  }

  public setRippleParams(cellW: number, cellH: number, qualityLevel: number, reducedMotion: boolean): void {
    this.rippleCellW = cellW || 8;
    this.rippleCellH = cellH || 8;
    this.rippleQualityLevel = qualityLevel;
    this.rippleReducedMotion = reducedMotion;
  }

  public computeColumnsStageBounds(viewW: number, viewH: number): RippleCompositionBounds {
    const isNarrow = viewW < 820;
    const frameX = isNarrow ? 16 : Math.round(koiClamp(24, 38, viewW * 0.022));
    const frameW = isNarrow
      ? Math.max(260, viewW - 88)
      : Math.round(koiClamp(290, 460, viewW * 0.295));
    const frameH = isNarrow
      ? Math.round(koiClamp(190, 250, viewportHOrDefault(viewH) * 0.27))
      : Math.max(260, viewH - 48);

    const leftPx = isNarrow ? 16 : frameX + frameW + 22;
    const rightClearance = isNarrow ? 16 : 80;
    const topPx = isNarrow ? 16 + frameH + 16 : 24;
    const heightPx = isNarrow
      ? Math.max(240, viewH - topPx - 16)
      : Math.max(260, viewH - 48);

    return {
      minX: leftPx,
      minY: topPx,
      maxX: Math.max(leftPx + 120, viewW - rightClearance),
      maxY: topPx + heightPx,
    };
  }

  public getRectProgress(): number {
    return this.rectProgress;
  }

  public setMenuBlurPx(px: number): void {
    this.menuBlurPx = koiClamp(Number.isFinite(px) ? px : 0, 0, 60);
  }

  public getMenuBlurPx(): number {
    return this.menuBlurPx;
  }

  public setActiveColumnRects(rects: { x: number; y: number; w: number; h: number }[]): void {
    this.activeColumnRects = rects;
  }

  public syncDynamicStateFrom(other: KoiPondRenderer): void {
    this.timeOfDayHours = other.timeOfDayHours;
    this.configuredTheme = other.configuredTheme;
    this.currentPalette = other.currentPalette;
    this.transitioning = other.transitioning;
    this.themeProgress = other.themeProgress;
    this.sunCycleTargetLight = other.sunCycleTargetLight;
    this.sunCycleStartHour = other.sunCycleStartHour;
    this.sunCycleEndHour = other.sunCycleEndHour;
    this.darkModeToggleAt = other.darkModeToggleAt;
    this.themeTransitionStart = other.themeTransitionStart;
    this.flashX = other.flashX;
    this.flashY = other.flashY;
    this.flashlightDispersal = other.flashlightDispersal;
    this.flashlightEnabled = other.flashlightEnabled;
    this.hasAutoActivatedFlashlightOnce = other.hasAutoActivatedFlashlightOnce;
    this.portraitGlazeDismissed = other.portraitGlazeDismissed;
    this.rawPointerX = other.rawPointerX;
    this.rawPointerY = other.rawPointerY;
    this.rawPointerActive = other.rawPointerActive;
    this.menuBlurPx = other.menuBlurPx;
    this.rippleOrigin = { x: other.rippleOrigin.x, y: other.rippleOrigin.y };
    this.rippleCellW = other.rippleCellW;
    this.rippleCellH = other.rippleCellH;
    this.rippleQualityLevel = other.rippleQualityLevel;
    this.rippleReducedMotion = other.rippleReducedMotion;
    for (let i = 0; i < this.lotusPadStates.length && i < other.lotusPadStates.length; i++) {
      Object.assign(this.lotusPadStates[i], other.lotusPadStates[i]);
    }
    for (let i = 0; i < this.companionLeafStates.length && i < other.companionLeafStates.length; i++) {
      Object.assign(this.companionLeafStates[i], other.companionLeafStates[i]);
    }
    this.mapleLeafWorldW = other.mapleLeafWorldW;
    this.mapleLeafWorldH = other.mapleLeafWorldH;
    for (let i = 0; i < this.mapleLeafStates.length && i < other.mapleLeafStates.length; i++) {
      Object.assign(this.mapleLeafStates[i], other.mapleLeafStates[i]);
    }
    this.floatingSakuraWorldW = other.floatingSakuraWorldW;
    this.floatingSakuraWorldH = other.floatingSakuraWorldH;
    if (other.floatingSakuraParticles.length > 0) {
      if (this.floatingSakuraParticles.length !== other.floatingSakuraParticles.length) {
        this.floatingSakuraParticles = other.floatingSakuraParticles.map((p) => ({ ...p }));
      } else {
        for (let i = 0; i < other.floatingSakuraParticles.length; i++) {
          Object.assign(this.floatingSakuraParticles[i], other.floatingSakuraParticles[i]);
        }
      }
    }
    this.clickRipples.length = 0;
    for (const r of other.clickRipples) {
      this.clickRipples.push({ ...r });
    }
    for (let i = 0; i < this.dragonflyStates.length && i < other.dragonflyStates.length; i++) {
      Object.assign(this.dragonflyStates[i], other.dragonflyStates[i]);
    }
    this.skipPhysicsStepOnce = true;
  }

  private applyPondBlurInPlace(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    blurPx: number
  ): void {
    if (blurPx <= 0.15) return;
    const scale = 0.5;
    const bw = Math.max(1, Math.round(width * scale));
    const bh = Math.max(1, Math.round(height * scale));
    const scratch = this.blurScratchCanvas ?? document.createElement("canvas");
    if (scratch.width !== bw || scratch.height !== bh) {
      scratch.width = bw;
      scratch.height = bh;
    }
    this.blurScratchCanvas = scratch;
    const sCtx = scratch.getContext("2d");
    if (!sCtx) return;

    sCtx.save();
    sCtx.setTransform(1, 0, 0, 1, 0, 0);
    sCtx.filter = "none";
    sCtx.clearRect(0, 0, bw, bh);
    sCtx.drawImage(ctx.canvas, 0, 0, bw, bh);
    sCtx.restore();

    const pad = Math.ceil(blurPx * 1.75);
    ctx.save();
    ctx.filter = `blur(${blurPx.toFixed(2)}px)`;
    ctx.drawImage(scratch, -pad, -pad, width + pad * 2, height + pad * 2);
    ctx.restore();
  }

  public getActivePondRect(viewW: number, viewH: number): PondViewportRect {
    return this.computePondRect(viewW, viewH, this.rectProgress);
  }

  public computePondRect(viewW: number, viewH: number, progress: number): PondViewportRect {
    const p = koiClamp(progress, 0, 1);
    const ease = p * p * p * (p * (p * 6 - 15) + 10);

    // Keep the pond at full viewport dimensions at all times (never shrink the pond into the frame,
    // eliminating all per-frame offscreen canvas re-bakes during Profile open/close!).
    this.activeRect.x = 0;
    this.activeRect.y = 0;
    this.activeRect.w = viewW;
    this.activeRect.h = viewH;
    this.activeRect.scale = 1.0;
    this.activeRect.progress = ease;
    return this.activeRect;
  }

  public computeLeftFrameRect(viewW: number, viewH: number, progress: number): PondViewportRect {
    const p = koiClamp(progress, 0, 1);
    const ease = p * p * p * (p * (p * 6 - 15) + 10);

    const isNarrow = viewW < 820;
    const targetX = isNarrow ? 16 : Math.round(koiClamp(24, 38, viewW * 0.022));
    const targetY = isNarrow ? 16 : 24;
    const targetW = isNarrow
      ? Math.max(260, viewW - 88)
      : Math.round(koiClamp(290, 460, viewW * 0.295));
    const targetH = isNarrow
      ? Math.round(koiClamp(190, 250, viewportHOrDefault(viewH) * 0.27))
      : Math.max(260, viewH - 48);

    return {
      x: targetX,
      y: targetY,
      w: targetW,
      h: targetH,
      scale: 1.0,
      progress: p,
    };
  }

  public setLightMode(isLight: boolean, immediate = false): void {
    const currentlyLight = this.isLightMode;
    if (immediate) {
      this.sunCycleTargetLight = isLight;
      this.darkModeToggleAt = -1;
      this.transitioning = false;
      this.themeProgress = 1;
      this.setTimeOfDayHours(isLight ? 12.0 : 18.5, true);
      return;
    }

    if (currentlyLight !== isLight) {
      const curDaylight = this.getDaylightFactor();
      this.sunCycleTargetLight = isLight;
      this.previousPalette = POND_PALETTES[currentlyLight ? "light-pond" : "black-pond"];
      this.configuredTheme = isLight ? "light-pond" : "black-pond";
      this.currentPalette = POND_PALETTES[this.configuredTheme];

      if (!isLight) {
        // Day -> Night: Sped-up Sunset (14.4h late afternoon -> 18.35h nightfall)
        // Record click timestamp so fireflies emerge in arithmetic progression 2.0s after toggle
        this.darkModeToggleAt = performance.now();
        this.sunCycleStartHour = 14.4 + (1.0 - curDaylight) * 3.6;
        this.sunCycleEndHour = 18.35;
        if (!this.hasAutoActivatedFlashlightOnce) {
          this.flashlightEnabled = true;
          this.hasAutoActivatedFlashlightOnce = true;
        } else {
          this.flashlightEnabled = false;
        }
      } else {
        this.darkModeToggleAt = -1;
        // Night -> Day: Sped-up Sunrise (04.85h pre-dawn -> 09.15h bright morning)
        // If clicked mid-sunset, match starting sunrise hour to current daylight level
        this.sunCycleStartHour = 4.85 + curDaylight * 4.15;
        this.sunCycleEndHour = 9.15;
      }

      this.timeOfDayHours = this.sunCycleStartHour;
      this.themeTransitionStart = performance.now();
      this.transitioning = true;
      this.themeProgress = 0;
    }
  }

  /**
   * Smoothly transitions the pond from its current time-of-day hour to a specific target hour
   * (used when cycling the lighting toggle back to live System Time).
   */
  public transitionToTimeOfDayHours(targetHours: number, immediate = false): void {
    const nextHours = KoiPondRenderer.normalizeHours(targetHours);
    if (immediate) {
      this.setTimeOfDayHours(nextHours, true);
      return;
    }

    const currentlyLight = this.isLightMode;
    const nextNight = KoiPondRenderer.isNightLampTime(nextHours);
    const nextLight = !nextNight;
    const startHours = this.timeOfDayHours;

    this.sunCycleTargetLight = nextLight;
    this.previousPalette = POND_PALETTES[currentlyLight ? "light-pond" : "black-pond"];
    this.configuredTheme = nextLight ? "light-pond" : "black-pond";
    this.currentPalette = POND_PALETTES[this.configuredTheme];

    if (nextNight) {
      this.darkModeToggleAt = performance.now();
      if (!this.hasAutoActivatedFlashlightOnce) {
        this.flashlightEnabled = true;
        this.hasAutoActivatedFlashlightOnce = true;
      } else if (currentlyLight) {
        this.flashlightEnabled = false;
      }
    } else {
      this.darkModeToggleAt = -1;
    }

    this.sunCycleStartHour = startHours;
    this.sunCycleEndHour = nextHours;
    this.themeTransitionStart = performance.now();
    this.transitioning = true;
    this.themeProgress = 0;
  }

  public toggleTheme(): boolean {
    const nextIsLight = !this.isLightMode;
    this.setLightMode(nextIsLight, false);
    return true;
  }

  private updateTransition(now: number): void {
    if (this.portraitStyleTransActive) {
      const elapsedStyle = Math.max(0, now - this.portraitStyleTransStart);
      this.portraitStyleTransProgress = koiClamp(
        elapsedStyle / this.portraitStyleTransDuration,
        0,
        1
      );
      if (this.portraitStyleTransProgress >= 1) {
        this.portraitStyleTransActive = false;
        this.portraitStyleTransProgress = 1;
        this.portraitNextClickAllowedAt = Math.max(this.portraitNextClickAllowedAt, now + 1000);
      }
    }
    if (!this.transitioning) return;
    const durMs = this.rippleReducedMotion ? 250 : this.sunCycleDurationMs;
    const elapsed = Math.max(0, now - this.themeTransitionStart);
    const rawT = koiClamp(elapsed / durMs, 0, 1);
    // Smooth sine-in-out / cubic progression of the sun across the sky
    const easeT = rawT * rawT * (3 - 2 * rawT);
    this.themeProgress = rawT;
    this.timeOfDayHours = KoiPondRenderer.normalizeHours(
      this.sunCycleStartHour + (this.sunCycleEndHour - this.sunCycleStartHour) * easeT
    );

    if (rawT >= 1) {
      this.transitioning = false;
      this.previousPalette = null;
      this.themeProgress = 1;
      this.timeOfDayHours = this.sunCycleTargetLight ? 12.0 : 18.5;
    }
  }

  /**
   * Bakes an authentic handmade Torinoko Washi / antique manuscript parchment sheet.
   */
  private ensureSumiePaperBundle(width: number, height: number, isLight: boolean): SumiePaperBundle {
    const w = Math.max(64, Math.round(width));
    const h = Math.max(64, Math.round(height));
    const key = `${w}x${h}:${isLight ? "sumie-paper-day-v1" : "sumie-paper-night-v1"}`;
    const cached = this.sumiePaperCache.get(key);
    if (cached) return cached;
    if (this.sumiePaperCache.size >= 4) this.sumiePaperCache.clear();
    const bundle = bakeSumieParchment(w, h, isLight);
    this.sumiePaperCache.set(key, bundle);
    return bundle;
  }

  private ensureParchmentCanvas(width: number, height: number, isLight: boolean): HTMLCanvasElement {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (this.artStyle === "sumie") {
      const bundle = this.ensureSumiePaperBundle(w, h, isLight);
      this.parchmentCanvas = bundle.canvas;
      this.parchmentKey = `${w}x${h}:sumie:${isLight ? "L" : "D"}`;
      return bundle.canvas;
    }
    const key = `${w}x${h}:${isLight ? "washi-day-v3" : "washi-night-v3"}`;
    const cached = this.parchmentCache.get(key);
    if (cached) {
      this.parchmentCanvas = cached;
      this.parchmentKey = key;
      return cached;
    }
    if (this.parchmentCache.size >= 4) {
      this.parchmentCache.clear();
    }

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    this.parchmentCache.set(key, canvas);
    this.parchmentCanvas = canvas;
    this.parchmentKey = key;

    const pCtx = canvas.getContext("2d");
    if (!pCtx) return canvas;

    // 1. Warm handmade Torinoko Washi base tone
    const cx = w * 0.46;
    const cy = h * 0.48;
    const maxR = Math.hypot(w, h) * 0.72;
    const baseGrad = pCtx.createRadialGradient(cx, cy, maxR * 0.05, cx, cy, maxR);
    if (isLight) {
      baseGrad.addColorStop(0.0, "#f6efe0");
      baseGrad.addColorStop(0.55, "#efe4ce");
      baseGrad.addColorStop(0.86, "#e4d4b5");
      baseGrad.addColorStop(1.0, "#d6c09a");
    } else {
      baseGrad.addColorStop(0.0, "#1d1814");
      baseGrad.addColorStop(0.58, "#16120f");
      baseGrad.addColorStop(0.88, "#110e0b");
      baseGrad.addColorStop(1.0, "#0b0907");
    }
    pCtx.fillStyle = baseGrad;
    pCtx.fillRect(0, 0, w, h);

    // 2. Soft organic watercolor cloud washes
    const cloudCount = 22;
    for (let i = 0; i < cloudCount; i++) {
      const sx = hash2D(i, 11, 101) * w;
      const sy = hash2D(i, 23, 101) * h;
      const sr = (0.15 + hash2D(i, 37, 101) * 0.28) * Math.min(w, h);
      const sg = pCtx.createRadialGradient(sx, sy, sr * 0.08, sx, sy, sr);
      if (isLight) {
        const tone = i % 2 === 0 ? "172, 142, 98" : "255, 250, 240";
        const alpha = i % 2 === 0 ? 0.038 : 0.045;
        sg.addColorStop(0.0, `rgba(${tone}, ${alpha})`);
        sg.addColorStop(0.6, `rgba(${tone}, ${alpha * 0.4})`);
        sg.addColorStop(1.0, `rgba(${tone}, 0)`);
      } else {
        const tone = i % 2 === 0 ? "84, 68, 46" : "38, 32, 24";
        sg.addColorStop(0.0, `rgba(${tone}, 0.048)`);
        sg.addColorStop(0.6, `rgba(${tone}, 0.02)`);
        sg.addColorStop(1.0, `rgba(${tone}, 0)`);
      }
      pCtx.fillStyle = sg;
      pCtx.beginPath();
      pCtx.arc(sx, sy, sr, 0, Math.PI * 2);
      pCtx.fill();
    }

    // 3. Tactile silk/kozo paper fibers
    pCtx.save();
    const fiberCount = Math.min(500, Math.round((w * h) / 2800));
    for (let i = 0; i < fiberCount; i++) {
      const fx = hash2D(i, 1, 307) * w;
      const fy = hash2D(i, 2, 307) * h;
      const flen = 8 + hash2D(i, 3, 307) * 18;
      const fang = hash2D(i, 4, 307) * Math.PI * 2;
      const fcurv = (hash2D(i, 5, 307) - 0.5) * 5;

      pCtx.beginPath();
      pCtx.moveTo(fx, fy);
      pCtx.quadraticCurveTo(
        fx + Math.cos(fang) * flen * 0.5 - Math.sin(fang) * fcurv,
        fy + Math.sin(fang) * flen * 0.5 + Math.cos(fang) * fcurv,
        fx + Math.cos(fang) * flen,
        fy + Math.sin(fang) * flen
      );
      pCtx.lineWidth = 0.5 + hash2D(i, 6, 307) * 0.45;
      pCtx.strokeStyle = isLight
        ? i % 2 === 0
          ? "rgba(255, 252, 244, 0.26)"
          : "rgba(138, 112, 78, 0.048)"
        : i % 2 === 0
          ? "rgba(214, 184, 128, 0.04)"
          : "rgba(0, 0, 0, 0.20)";
      pCtx.stroke();
    }
    pCtx.restore();

    // 4. Aged edge vignette
    pCtx.save();
    const vigGrad = pCtx.createRadialGradient(
      w * 0.5,
      h * 0.5,
      Math.min(w, h) * 0.38,
      w * 0.5,
      h * 0.5,
      Math.hypot(w, h) * 0.58
    );
    vigGrad.addColorStop(0.0, "rgba(0, 0, 0, 0)");
    vigGrad.addColorStop(
      1.0,
      isLight ? "rgba(96, 70, 38, 0.15)" : "rgba(0, 0, 0, 0.44)"
    );
    pCtx.fillStyle = vigGrad;
    pCtx.fillRect(0, 0, w, h);
    pCtx.restore();

    return canvas;
  }

  /**
   * Paints the pond floor and ambient water surface according to the active artistic style
   * (`mokkotsu`, `sumie`, or `ukiyoe`).
   */
  private paintSubmergedWaterWash(
    ctx: CanvasRenderingContext2D,
    worldW: number,
    worldH: number,
    time: number,
    isLight: boolean
  ): void {
    const style = this.artStyle;
    ctx.save();

    if (false) {
      // Harmonious Edo woodblock *Ai-bokashi* (soft indigo-celadon wash that lets warm washi breathe
      // at the borders so it never clashes with the crimson lattice frame)
      const cx = worldW * 0.5;
      const cy = worldH * 0.5;
      const maxR = Math.hypot(worldW, worldH) * 0.62;
      const bgGrad = ctx.createRadialGradient(cx, cy, maxR * 0.08, cx, cy, maxR);
      if (isLight) {
        bgGrad.addColorStop(0.0, "rgba(46, 92, 114, 0.42)");
        bgGrad.addColorStop(0.58, "rgba(54, 98, 116, 0.30)");
        bgGrad.addColorStop(0.88, "rgba(68, 104, 114, 0.16)");
        bgGrad.addColorStop(1.0, "rgba(82, 108, 110, 0.06)");
      } else {
        bgGrad.addColorStop(0.0, "rgba(22, 54, 76, 0.62)");
        bgGrad.addColorStop(0.65, "rgba(18, 42, 62, 0.45)");
        bgGrad.addColorStop(1.0, "rgba(12, 28, 42, 0.22)");
      }
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, worldW, worldH);

      // Traditional Japanese *Ryusui-mon* (flowing water scroll) woodblock curves:
      // staggered, finite-length S-curved brush ribbons rather than edge-to-edge oscilloscope waves
      const ribbonCount = 18;
      ctx.lineCap = "round";
      for (let i = 0; i < ribbonCount; i++) {
        const rx = (0.12 + hash2D(i, 3, 409) * 0.76) * worldW;
        const ry = ((i + 0.5) / ribbonCount) * worldH;
        const span = 75 + hash2D(i, 7, 409) * 115;
        const amp = (5 + hash2D(i, 11, 409) * 6) * (i % 2 === 0 ? 1 : -1);
        const drift = Math.sin(time * 0.35 + i * 0.9) * 8;
        const x0 = rx - span * 0.5 + drift;
        const x3 = rx + span * 0.5 + drift;

        ctx.beginPath();
        ctx.moveTo(x0, ry);
        ctx.bezierCurveTo(
          x0 + span * 0.33,
          ry - amp,
          x0 + span * 0.66,
          ry + amp,
          x3,
          ry
        );
        ctx.lineWidth = i % 3 === 0 ? 1.35 : 0.95;
        ctx.strokeStyle = isLight
          ? `rgba(34, 68, 88, ${(0.18 + (i % 3) * 0.05).toFixed(3)})`
          : `rgba(176, 206, 224, ${(0.15 + (i % 3) * 0.04).toFixed(3)})`;
        ctx.stroke();

        // Companion echo curve (classic woodblock double-line water motif)
        if (i % 2 === 0) {
          ctx.beginPath();
          ctx.moveTo(x0 + 10, ry + 4.5);
          ctx.bezierCurveTo(
            x0 + span * 0.33 + 6,
            ry - amp + 4.5,
            x0 + span * 0.66 - 6,
            ry + amp + 4.5,
            x3 - 10,
            ry + 4.5
          );
          ctx.lineWidth = 0.75;
          ctx.strokeStyle = isLight
            ? "rgba(34, 68, 88, 0.12)"
            : "rgba(176, 206, 224, 0.10)";
          ctx.stroke();
        }
      }
      ctx.restore();
      return;
    }

    // `mokkotsu` & `sumie`: Full-floor Voronoi cobblestone/pebble mosaic + mid-depth border boulders (blended smoothly by time of day)
    const daylight = this.getDaylightFactor();
    if (daylight >= 0.998) {
      const pebbleDay = this.ensurePebbleBedCanvas(worldW, worldH, true, style);
      ctx.drawImage(pebbleDay, 0, 0, worldW, worldH);
    } else if (daylight <= 0.002) {
      const pebbleNight = this.ensurePebbleBedCanvas(worldW, worldH, false, style);
      ctx.drawImage(pebbleNight, 0, 0, worldW, worldH);
    } else {
      const pebbleDay = this.ensurePebbleBedCanvas(worldW, worldH, true, style);
      ctx.drawImage(pebbleDay, 0, 0, worldW, worldH);
      const pebbleNight = this.ensurePebbleBedCanvas(worldW, worldH, false, style);
      ctx.save();
      ctx.globalAlpha = 1.0 - daylight;
      ctx.drawImage(pebbleNight, 0, 0, worldW, worldH);
      ctx.restore();
    }

    // Sumi-e wet-on-wet background mosaic is fully baked in ensurePebbleBedCanvas (no riverbed stones/pools)
    if ((style as KoiArtStyle) === "sumie") {
      ctx.restore();
      return;
    }

    // Default `mokkotsu` & `sumie` submerged water pools and riverbed stones
    const pools = [
      { x: 0.35, y: 0.34, r: 0.52 },
      { x: 0.64, y: 0.68, r: 0.56 },
    ];
    for (let i = 0; i < pools.length; i++) {
      const p = pools[i];
      const cx = worldW * p.x + Math.sin(time * 0.12 + i) * 16;
      const cy = worldH * p.y + Math.cos(time * 0.1 + i) * 12;
      const rad = Math.max(worldW, worldH) * p.r;
      const grad = ctx.createRadialGradient(cx, cy, rad * 0.05, cx, cy, rad);
      if (style === "sumie") {
        grad.addColorStop(0.0, isLight ? "rgba(42, 40, 38, 0.075)" : "rgba(180, 175, 168, 0.065)");
        grad.addColorStop(0.55, isLight ? "rgba(42, 40, 38, 0.028)" : "rgba(120, 116, 110, 0.025)");
        grad.addColorStop(1.0, "rgba(0, 0, 0, 0)");
      } else if (isLight) {
        grad.addColorStop(0.0, "rgba(84, 98, 82, 0.072)");
        grad.addColorStop(0.55, "rgba(92, 104, 84, 0.035)");
        grad.addColorStop(1.0, "rgba(92, 104, 84, 0)");
      } else {
        grad.addColorStop(0.0, "rgba(52, 62, 50, 0.095)");
        grad.addColorStop(0.55, "rgba(38, 46, 36, 0.045)");
        grad.addColorStop(1.0, "rgba(0, 0, 0, 0)");
      }
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, worldW, worldH);
    }



    // 2. Out-of-focus submerged riverbed stones (soft watercolor ovals on the pond bed)
    const stoneClusters = [
      { fx: 0.24, fy: 0.28, rx: 26, ry: 18, rot: 0.4 },
      { fx: 0.27, fy: 0.31, rx: 16, ry: 12, rot: -0.3 },
      { fx: 0.72, fy: 0.44, rx: 32, ry: 21, rot: 1.1 },
      { fx: 0.68, fy: 0.48, rx: 19, ry: 14, rot: 0.2 },
      { fx: 0.42, fy: 0.76, rx: 28, ry: 19, rot: -0.6 },
      { fx: 0.46, fy: 0.79, rx: 17, ry: 11, rot: 0.8 },
    ];
    for (let i = 0; i < stoneClusters.length; i++) {
      const st = stoneClusters[i];
      const sx = worldW * st.fx;
      const sy = worldH * st.fy;
      const rMax = Math.max(st.rx, st.ry) * 1.4;
      const sg = ctx.createRadialGradient(sx - 3, sy - 3, 2, sx, sy, rMax);
      if (isLight) {
        sg.addColorStop(0.0, "rgba(94, 84, 68, 0.068)");
        sg.addColorStop(0.65, "rgba(78, 70, 56, 0.042)");
        sg.addColorStop(1.0, "rgba(78, 70, 56, 0)");
      } else {
        sg.addColorStop(0.0, "rgba(148, 132, 104, 0.055)");
        sg.addColorStop(0.65, "rgba(96, 84, 66, 0.03)");
        sg.addColorStop(1.0, "rgba(0, 0, 0, 0)");
      }
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(st.rot);
      ctx.scale(1, st.ry / st.rx);
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.arc(0, 0, st.rx * 1.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 3. Stationary *Tobi-sumi* & *Tarashikomi* ink blossoms on the paper in Sumi-e mode
    //    (anchored to the pond canvas rather than orbiting rigidly with a turning fish)
    if (style === "sumie") {
      for (let i = 0; i < 18; i++) {
        const bx = (0.14 + hash2D(i, 5, 811) * 0.72) * worldW;
        const by = (0.14 + hash2D(i, 9, 811) * 0.72) * worldH;
        const br = 1.2 + hash2D(i, 13, 811) * 2.8;
        ctx.fillStyle = isLight
          ? `rgba(28, 24, 20, ${(0.12 + hash2D(i, 17, 811) * 0.14).toFixed(3)})`
          : `rgba(214, 206, 192, ${(0.10 + hash2D(i, 17, 811) * 0.12).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fill();
      }
    }



    ctx.restore();
  }

  /**
   * Paints floating koi food pellets dropped by clicking/tapping on the pond,
   * complete with delicate surface meniscus rings and style-matched pigments.
   */
  private paintPondFood(
    ctx: CanvasRenderingContext2D,
    food: PondFoodPellet[],
    time: number,
    isLight: boolean
  ): void {
    if (!food || food.length === 0) return;
    const style = this.artStyle;
    ctx.save();

    for (let i = 0; i < food.length; i++) {
      const p = food[i];
      if (!p.active) continue;

      const fadeIn = koiClamp(p.age / 0.18, 0.2, 1);
      const fadeOut = koiClamp((p.maxAge - p.age) / 2.5, 0, 1);
      const alpha = fadeIn * fadeOut;
      if (alpha <= 0.01) continue;

      const bobX = Math.sin(time * 2.4 + p.phase) * 0.8;
      const bobY = Math.cos(time * 2.1 + p.phase) * 0.8;
      const px = p.x + bobX;
      const py = p.y + bobY;

      // 1. Delicate concentric meniscus ring around the floating food grain
      const pulse = 0.5 + 0.5 * Math.sin(time * 3.8 + p.phase);
      const ringR = p.radius + 3.2 + pulse * 4.5;
      ctx.beginPath();
      ctx.arc(px, py, ringR, 0, Math.PI * 2);
      ctx.lineWidth = 0.85;
      ctx.strokeStyle =
        false
          ? `rgba(38, 72, 92, ${(0.34 * alpha * (1 - pulse * 0.4)).toFixed(3)})`
          : style === "sumie"
            ? isLight
              ? `rgba(32, 28, 24, ${(0.28 * alpha * (1 - pulse * 0.4)).toFixed(3)})`
              : `rgba(216, 208, 196, ${(0.28 * alpha * (1 - pulse * 0.4)).toFixed(3)})`
            : isLight
              ? `rgba(88, 102, 92, ${(0.28 * alpha * (1 - pulse * 0.4)).toFixed(3)})`
              : `rgba(214, 192, 148, ${(0.28 * alpha * (1 - pulse * 0.4)).toFixed(3)})`;
      ctx.stroke();

      // 2. Submerged shadow under the floating pellet
      ctx.beginPath();
      ctx.arc(px + 1.5, py + 2.2, p.radius * 1.15, 0, Math.PI * 2);
      ctx.fillStyle = isLight
        ? `rgba(52, 40, 26, ${(0.18 * alpha).toFixed(3)})`
        : `rgba(0, 0, 0, ${(0.42 * alpha).toFixed(3)})`;
      ctx.fill();

      // 3. Pellet body
      ctx.beginPath();
      ctx.arc(px, py, p.radius, 0, Math.PI * 2);
      if (false) {
        ctx.fillStyle = `rgba(226, 152, 54, ${(0.95 * alpha).toFixed(3)})`;
        ctx.fill();
        ctx.lineWidth = 1.0;
        ctx.strokeStyle = `rgba(24, 18, 14, ${(0.88 * alpha).toFixed(3)})`;
        ctx.stroke();
      } else if (style === "sumie") {
        ctx.fillStyle =
          i % 2 === 0
            ? `rgba(196, 48, 32, ${(0.90 * alpha).toFixed(3)})`
            : isLight
              ? `rgba(36, 30, 26, ${(0.88 * alpha).toFixed(3)})`
              : `rgba(224, 212, 192, ${(0.88 * alpha).toFixed(3)})`;
        ctx.fill();
        ctx.lineWidth = 1.1;
        ctx.strokeStyle = `rgba(8, 7, 7, ${(0.90 * alpha).toFixed(3)})`;
        ctx.stroke();
      } else {
        const g = ctx.createRadialGradient(
          px - p.radius * 0.3,
          py - p.radius * 0.3,
          0.3,
          px,
          py,
          p.radius * 1.1
        );
        g.addColorStop(0.0, `rgba(242, 188, 96, ${(0.95 * alpha).toFixed(3)})`);
        g.addColorStop(0.65, `rgba(198, 104, 44, ${(0.92 * alpha).toFixed(3)})`);
        g.addColorStop(1.0, `rgba(138, 58, 24, ${(0.88 * alpha).toFixed(3)})`);
        ctx.fillStyle = g;
        ctx.fill();
      }
    }

    ctx.restore();
  }

  /**
   * Paints natural botanical lotus leaves (*hasu*) adapted to the active artistic style.
   * Positioned clear of the corner fretwork and rendered with rich, opaque botanical pigments
   * and deep subsurface drop shadows so koi swimming underneath are naturally occluded.
   */
  /**
   * Returns the base specifications of the 9 Lotus Leaves of varied botanical sizes.
   */
  private getLotusPadSpecs(): {
    fx: number;
    fy: number;
    r: number;
    notch: number;
    hasLotus: boolean;
  }[] {
    return [
      // Upper-left / center-left botanical cluster (varied sizes: 88, 56, 46, 36, 42 — well-spaced so none intersect)
      { fx: 0.25, fy: 0.25, r: 88, notch: 0.65, hasLotus: true },
      { fx: 0.41, fy: 0.13, r: 56, notch: 2.20, hasLotus: false },
      { fx: 0.14, fy: 0.43, r: 46, notch: -1.15, hasLotus: false },
      { fx: 0.40, fy: 0.39, r: 36, notch: 1.45, hasLotus: false },
      { fx: 0.54, fy: 0.21, r: 42, notch: -0.45, hasLotus: false },
      // Lower-right / center-right botanical cluster (varied sizes: 92, 62, 50, 38 — well-spaced so none intersect)
      { fx: 0.72, fy: 0.71, r: 92, notch: -2.10, hasLotus: true },
      { fx: 0.54, fy: 0.85, r: 62, notch: -0.70, hasLotus: false },
      { fx: 0.86, fy: 0.53, r: 50, notch: 0.95, hasLotus: false },
      { fx: 0.55, fy: 0.60, r: 38, notch: 2.55, hasLotus: false },
    ];
  }

  /**
   * Computes world-space positions `(x, y, r)` for all 9 lotus leaves with an 8-pass mutual
   * non-intersection solver so no two lotus leaves ever touch or intersect each other even in
   * narrow viewports or Profile mode.
   */
  private getResolvedLotusPads(
    worldW: number,
    worldH: number,
    unit: number
  ): {
    x: number;
    y: number;
    r: number;
    notch: number;
    hasLotus: boolean;
  }[] {
    const specs = this.getLotusPadSpecs();
    const out = specs.map((p) => ({
      x: worldW * p.fx,
      y: worldH * p.fy,
      r: p.r * unit,
      notch: p.notch,
      hasLotus: p.hasLotus,
    }));

    // 8-pass mutual separation solver guaranteeing zero leaf-to-leaf intersection
    for (let pass = 0; pass < 8; pass++) {
      for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
          const a = out[i];
          const b = out[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy);
          // Include wavy margin lobes (1.06x) + maximum asynchronous sway margin (18 * unit)
          const minSep = (a.r + b.r) * 1.06 + 18 * unit;
          if (dist < minSep) {
            const ux = dist > 0.001 ? dx / dist : Math.cos(i * 1.7 + j);
            const uy = dist > 0.001 ? dy / dist : Math.sin(i * 1.7 + j);
            const overlap = minSep - dist;
            // Weight push inversely by radius so larger hero pads stay anchored while smaller pads yield
            const wA = b.r / (a.r + b.r);
            const wB = a.r / (a.r + b.r);
            a.x -= ux * overlap * wA;
            a.y -= uy * overlap * wA;
            b.x += ux * overlap * wB;
            b.y += uy * overlap * wB;
          }
        }
      }
      for (let i = 0; i < out.length; i++) {
        const p = out[i];
        const margin = p.r * 1.05 + 14 * unit;
        p.x = koiClamp(p.x, margin, Math.max(margin + 1, worldW - margin));
        p.y = koiClamp(p.y, margin, Math.max(margin + 1, worldH - margin));
      }
    }
    return out;
  }

  /**
   * Computes stationary rest-space specifications for all 18 companion leaves
   * (2 satellite companion leaves per large lotus pad = 18 total), solved for mutual
   * non-intersection with all 9 large lotus pads and each other.
   */
  private getResolvedCompanionLeaves(
    worldW: number,
    worldH: number,
    unit: number,
    resolvedPadsInput?: {
      x: number;
      y: number;
      r: number;
      notch: number;
      hasLotus: boolean;
    }[]
  ): {
    x: number;
    y: number;
    r: number;
    notch: number;
    parentIdx: number;
  }[] {
    const pads = resolvedPadsInput ?? this.getResolvedLotusPads(worldW, worldH, unit);
    const out: {
      x: number;
      y: number;
      r: number;
      notch: number;
      parentIdx: number;
    }[] = [];

    for (let pIdx = 0; pIdx < pads.length; pIdx++) {
      const pad = pads[pIdx];
      for (let sub = 0; sub < 2; sub++) {
        const compIdx = pIdx * 2 + sub;
        const r = (15.0 + hash2D(compIdx, 1, 601) * 8.5) * unit;
        const orbitAngle =
          pad.notch +
          (sub === 0 ? 1.72 : -1.84) +
          (hash2D(compIdx, 2, 607) - 0.5) * 0.42;
        const orbitDist =
          pad.r * 1.15 + r * 1.22 + (6.5 + hash2D(compIdx, 3, 613) * 11.5) * unit;
        const cx = pad.x + Math.cos(orbitAngle) * orbitDist;
        const cy = pad.y + Math.sin(orbitAngle) * orbitDist;
        // Orient the companion leaf margin notch cleft back toward the nearest edge / parent stem sweep
        const notch =
          orbitAngle + Math.PI + (hash2D(compIdx, 4, 619) - 0.5) * 0.55;
        out.push({
          x: cx,
          y: cy,
          r,
          notch,
          parentIdx: pIdx,
        });
      }
    }

    // 6-pass deterministic separation solver against large lotus pads and other companion leaves
    for (let pass = 0; pass < 6; pass++) {
      for (let i = 0; i < out.length; i++) {
        const c = out[i];
        // Separate from all 9 large lotus pads
        for (let pIdx = 0; pIdx < pads.length; pIdx++) {
          const p = pads[pIdx];
          const dx = c.x - p.x;
          const dy = c.y - p.y;
          const dist = Math.hypot(dx, dy);
          const minSep = (p.r + c.r) * 1.06 + 10 * unit;
          if (dist < minSep) {
            const ux = dist > 0.001 ? dx / dist : Math.cos(i * 1.3 + pIdx);
            const uy = dist > 0.001 ? dy / dist : Math.sin(i * 1.3 + pIdx);
            const push = minSep - dist;
            c.x += ux * push;
            c.y += uy * push;
          }
        }
        // Separate companion leaves from each other
        for (let j = i + 1; j < out.length; j++) {
          const b = out[j];
          const dx = b.x - c.x;
          const dy = b.y - c.y;
          const dist = Math.hypot(dx, dy);
          const minSep = (c.r + b.r) * 1.08 + 8 * unit;
          if (dist < minSep) {
            const ux = dist > 0.001 ? dx / dist : Math.cos(i * 1.9 + j);
            const uy = dist > 0.001 ? dy / dist : Math.sin(i * 1.9 + j);
            const overlap = (minSep - dist) * 0.5;
            c.x -= ux * overlap;
            c.y -= uy * overlap;
            b.x += ux * overlap;
            b.y += uy * overlap;
          }
        }
        const margin = c.r * 1.08 + 12 * unit;
        c.x = koiClamp(c.x, margin, Math.max(margin + 1, worldW - margin));
        c.y = koiClamp(c.y, margin, Math.max(margin + 1, worldH - margin));
      }
    }

    return out;
  }

  /**
   * 1. Anchoring to the Nearest Screen Edge:
   * Takes the leaf's attachment point and calculates distances to the four screen edges
   * (left, right, top, bottom). Chooses the closest edge to exit (locked to the leaf's
   * stable rest coordinates so stems NEVER snap to adjacent edges when the parent leaf moves)
   * and applies an oblique pseudo-random offset (using a deterministic hash) along that border
   * so stems enter the viewport at natural diagonal sweeps (30 to 60 degrees).
   */
  private computeNearestEdgeExit(
    restAttachX: number,
    restAttachY: number,
    worldW: number,
    worldH: number,
    unit: number,
    stemIdx: number
  ): { x: number; y: number; edge: "left" | "right" | "top" | "bottom" } {
    const dLeft = restAttachX;
    const dRight = Math.max(1, worldW - restAttachX);
    const dTop = restAttachY;
    const dBottom = Math.max(1, worldH - restAttachY);

    // Lock the edge choice per stemIdx so leaf sway or minor layout shifts never snap a stem to an adjacent edge
    let edge = this.stemLockedEdges[stemIdx];
    if (!edge) {
      const minD = Math.min(dLeft, dRight, dTop, dBottom);
      if (minD === dLeft) edge = "left";
      else if (minD === dRight) edge = "right";
      else if (minD === dTop) edge = "top";
      else edge = "bottom";
      this.stemLockedEdges[stemIdx] = edge;
    }

    // Diagonal sweep angle between 30 and 60 degrees from the border perpendicular
    const sweepDeg = 30.0 + hash2D(stemIdx, 2, 937) * 30.0;
    const tanSweep = Math.tan((sweepDeg * Math.PI) / 180.0);
    const rawSign = hash2D(stemIdx, 3, 941) < 0.5 ? -1 : 1;
    const bleed = 12 * unit;

    if (edge === "left" || edge === "right") {
      const perpDist = Math.max(70 * unit, edge === "left" ? dLeft : dRight);
      // Prefer sweeping toward the roomier vertical half if near a corner so exit stays along the chosen edge
      const sign =
        restAttachY < worldH * 0.22
          ? 1
          : restAttachY > worldH * 0.78
            ? -1
            : rawSign;
      const obliqueOffset = sign * perpDist * tanSweep * 0.68;
      const exitY = koiClamp(
        restAttachY + obliqueOffset,
        18 * unit,
        Math.max(19 * unit, worldH - 18 * unit)
      );
      const exitX = edge === "left" ? -bleed : worldW + bleed;
      return { x: exitX, y: exitY, edge };
    } else {
      const perpDist = Math.max(70 * unit, edge === "top" ? dTop : dBottom);
      const sign =
        restAttachX < worldW * 0.22
          ? 1
          : restAttachX > worldW * 0.78
            ? -1
            : rawSign;
      const obliqueOffset = sign * perpDist * tanSweep * 0.68;
      const exitX = koiClamp(
        restAttachX + obliqueOffset,
        18 * unit,
        Math.max(19 * unit, worldW - 18 * unit)
      );
      const exitY = edge === "top" ? -bleed : worldH + bleed;
      return { x: exitX, y: exitY, edge };
    }
  }

  /**
   * 2. Trajectory and Curvature (Gentle S-Bends):
   * Computes a cubic Bezier curve (p0, c1, c2, p3) from the screen edge root (p0) to the
   * leaf attachment point (p3). Control point c1 sits at 32% along the chord length and is
   * displaced along +n by 16% to 30% of the chord distance; c2 sits at 68% and is displaced
   * along -n by 16% to 30% of the chord distance, modulated by 7-to-9-second sine/cosine harmonics.
   */
  private computeStemBezierTrajectory(
    rootX: number,
    rootY: number,
    tipX: number,
    tipY: number,
    swayX: number,
    swayY: number,
    time: number,
    stemIdx: number
  ): {
    p0: { x: number; y: number };
    c1: { x: number; y: number };
    c2: { x: number; y: number };
    p3: { x: number; y: number };
  } {
    const dx = tipX - rootX;
    const dy = tipY - rootY;
    const chordDist = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / chordDist;
    const uy = dy / chordDist;
    // Unit perpendicular normal (+n)
    const orientSign = hash2D(stemIdx, 11, 929) < 0.5 ? 1 : -1;
    const nx = -uy * orientSign;
    const ny = ux * orientSign;

    // 16% to 30% of total chord distance for S-bend normal displacement
    const amp1Frac = 0.16 + hash2D(stemIdx, 4, 947) * 0.14;
    const amp2Frac = 0.16 + hash2D(stemIdx, 5, 953) * 0.14;

    // Low-frequency sine and cosine time harmonics (period of 7 to 9 seconds)
    const period = 7.0 + hash2D(stemIdx, 6, 967) * 2.0;
    const omega = (Math.PI * 2) / period;
    const phase = stemIdx * 1.37 + hash2D(stemIdx, 7, 971) * Math.PI * 2;

    const swayProj = swayX * nx + swayY * ny;
    const harm1 =
      Math.sin(time * omega + phase) * (chordDist * 0.028) + swayProj * 0.36;
    const harm2 =
      Math.cos(time * omega * 0.94 + phase * 1.13) * (chordDist * 0.028) -
      swayProj * 0.52;

    const d1 = chordDist * amp1Frac + harm1;
    const d2 = chordDist * amp2Frac + harm2;

    // c1 at 32% along chord displaced along +n; c2 at 68% along chord displaced along -n
    const c1 = {
      x: rootX + dx * 0.32 + nx * d1,
      y: rootY + dy * 0.32 + ny * d1,
    };
    const c2 = {
      x: rootX + dx * 0.68 - nx * d2,
      y: rootY + dy * 0.68 - ny * d2,
    };

    return {
      p0: { x: rootX, y: rootY },
      c1,
      c2,
      p3: { x: tipX, y: tipY },
    };
  }

  /**
   * Evaluates point and unit tangent/normal on a cubic Bezier curve at parameter t in [0, 1].
   */
  private evalCubicBezierPose(
    p0: { x: number; y: number },
    c1: { x: number; y: number },
    c2: { x: number; y: number },
    p3: { x: number; y: number },
    t: number
  ): { x: number; y: number; tx: number; ty: number; nx: number; ny: number } {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const t2 = t * t;

    const x =
      mt2 * mt * p0.x +
      3 * mt2 * t * c1.x +
      3 * mt * t2 * c2.x +
      t2 * t * p3.x;
    const y =
      mt2 * mt * p0.y +
      3 * mt2 * t * c1.y +
      3 * mt * t2 * c2.y +
      t2 * t * p3.y;

    const vx =
      3 * mt2 * (c1.x - p0.x) +
      6 * mt * t * (c2.x - c1.x) +
      3 * t2 * (p3.x - c2.x);
    const vy =
      3 * mt2 * (c1.y - p0.y) +
      6 * mt * t * (c2.y - c1.y) +
      3 * t2 * (p3.y - c2.y);
    const vLen = Math.max(0.0001, Math.hypot(vx, vy));
    const tx = vx / vLen;
    const ty = vy / vLen;
    const nx = -ty;
    const ny = tx;
    return { x, y, tx, ty, nx, ny };
  }

  /**
   * 3, 4 & 5. Variable Thickness Tapering (16-Segment Polygon Mesh), Muted Botanical Coloration & Shadow,
   * and Surface Texture (Stem Nodes at 35% & 72%, Clinging Algae, and Sunlit Crest on 58%..78%).
   */
  private renderSingleWiryStem(
    ctx: CanvasRenderingContext2D,
    p0: { x: number; y: number },
    c1: { x: number; y: number },
    c2: { x: number; y: number },
    p3: { x: number; y: number },
    isLargeLotus: boolean,
    isDeepStem: boolean,
    stemIdx: number,
    unit: number,
    isLight: boolean,
    style: KoiArtStyle,
    customBasePx?: number,
    customTipPx?: number
  ): void {
    if ((style as KoiArtStyle) === "sumie") {
      ctx.save();
      const solar = this.getSolarLightingState();
      const day = solar.daylight;
      const inkRgb = mixRgb([186, 178, 164], [24, 22, 19], day);
      const baseAlpha = isDeepStem ? 0.36 : 0.68;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const segs = 18;
      let prevX = p0.x;
      let prevY = p0.y;
      for (let sIdx = 1; sIdx <= segs; sIdx++) {
        const t = sIdx / segs;
        const pose = this.evalCubicBezierPose(p0, c1, c2, p3, t);
        // Slight dry-brush hand wobble
        const wobble = Math.sin(t * 14.0 + stemIdx * 2.1) * 1.15 * unit;
        const px = pose.x + pose.nx * wobble;
        const py = pose.y + pose.ny * wobble;
        // Fade into wash at the root end (t near 0) and taper gracefully
        const fade = Math.min(1, t * 2.4) * (1.0 - Math.max(0, (t - 0.85) / 0.15) * 0.25);
        const lw = (0.75 + (1.0 - t) * (isLargeLotus ? 1.25 : 0.85)) * unit;
        ctx.beginPath();
        ctx.moveTo(prevX, prevY);
        ctx.lineTo(px, py);
        ctx.lineWidth = Math.max(0.65, lw);
        ctx.strokeStyle = rgbToRgba(inkRgb, baseAlpha * fade);
        ctx.stroke();
        prevX = px;
        prevY = py;
      }
      // Small irregular dark wash leaf flick along mid-stem
      if (!isDeepStem && hash2D(stemIdx, 4, 919) < 0.58) {
        const lt = 0.42 + hash2D(stemIdx, 5, 919) * 0.24;
        const lp = this.evalCubicBezierPose(p0, c1, c2, p3, lt);
        const side = stemIdx % 2 === 0 ? 1 : -1;
        const ang = Math.atan2(lp.ty, lp.tx) + side * 0.68;
        const lLen = (8 + hash2D(stemIdx, 6, 919) * 7) * unit;
        ctx.save();
        ctx.translate(lp.x, lp.y);
        ctx.rotate(ang);
        ctx.fillStyle = rgbToRgba(inkRgb, baseAlpha * 0.72);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(lLen * 0.45, -lLen * 0.34, lLen, 0);
        ctx.quadraticCurveTo(lLen * 0.45, lLen * 0.30, 0, 0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
      return;
    }

    const steps = 16;
    const baseW = (customBasePx ?? (isLargeLotus ? 3.8 : 2.4)) * unit;
    const tipW = (customTipPx ?? (isLargeLotus ? 1.7 : 1.1)) * unit;

    const samples: {
      t: number;
      x: number;
      y: number;
      tx: number;
      ty: number;
      nx: number;
      ny: number;
      halfW: number;
    }[] = [];

    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const pose = this.evalCubicBezierPose(p0, c1, c2, p3, t);
      const w = baseW + (tipW - baseW) * t;
      samples.push({
        t,
        x: pose.x,
        y: pose.y,
        tx: pose.tx,
        ty: pose.ty,
        nx: pose.nx,
        ny: pose.ny,
        halfW: w * 0.5,
      });
    }

    // Helper to trace the 16-segment closed polygon contour (+n forward pass, -n return pass)
    const traceStemPolygon = (ox: number, oy: number, widthScale = 1.0) => {
      ctx.beginPath();
      for (let s = 0; s <= steps; s++) {
        const sp = samples[s];
        const px = sp.x + ox + sp.nx * sp.halfW * widthScale;
        const py = sp.y + oy + sp.ny * sp.halfW * widthScale;
        if (s === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      for (let s = steps; s >= 0; s--) {
        const sp = samples[s];
        const px = sp.x + ox - sp.nx * sp.halfW * widthScale;
        const py = sp.y + oy - sp.ny * sp.halfW * widthScale;
        ctx.lineTo(px, py);
      }
      ctx.closePath();
    };

    ctx.save();
    if (isDeepStem) {
      ctx.globalAlpha *= 0.62;
    }

    // 4B. Dynamic solar contact shadow projected onto the pond bed along the live sun vector
    const solar = this.getSolarLightingState();
    const stemDay = solar.daylight;
    const shOx = solar.shadowX * 0.17 * unit;
    const shOy = solar.shadowY * 0.16 * unit;
    traceStemPolygon(shOx, shOy, 1.16 + (solar.shadowBlurScale - 1.0) * 0.22);
    const shR = Math.round(koiLerp(0, 22, stemDay));
    const shG = Math.round(koiLerp(0, 16, stemDay));
    const shB = Math.round(koiLerp(0, 10, stemDay));
    const shA = koiLerp(0.46, 0.24, stemDay);
    ctx.fillStyle = `rgba(${shR}, ${shG}, ${shB}, ${shA.toFixed(3)})`;
    ctx.fill();

    // 4A. Stem body painted with multi-stop directional gradient along its length (continuous daylight blend)
    traceStemPolygon(0, 0, 1.0);
    const stemGrad = ctx.createLinearGradient(p0.x, p0.y, p3.x, p3.y);
    if (style === "sumie") {
      const s0 = mixRgb([36, 33, 30], [31, 28, 25], stemDay);
      const s1 = mixRgb([66, 61, 55], [58, 53, 48], stemDay);
      const s2 = mixRgb([90, 83, 75], [80, 74, 67], stemDay);
      const s3 = mixRgb([116, 107, 97], [104, 96, 88], stemDay);
      stemGrad.addColorStop(0.0, rgbToRgba(s0, 1));
      stemGrad.addColorStop(0.42, rgbToRgba(s1, 1));
      stemGrad.addColorStop(0.74, rgbToRgba(s2, 1));
      stemGrad.addColorStop(1.0, rgbToRgba(s3, 1));
    } else {
      // Root base: Dark earth brown with russet undertones (#2e2418)
      // Mid-stem: Muted olive green (#424c26 to #546430)
      // Tip: Fresh botanical green (#6a7c3a)
      stemGrad.addColorStop(0.0, "#2e2418");
      stemGrad.addColorStop(0.36, "#424c26");
      stemGrad.addColorStop(0.72, "#546430");
      stemGrad.addColorStop(1.0, "#6a7c3a");
    }
    ctx.fillStyle = stemGrad;
    ctx.fill();

    // Crisp Sumi-e deep black ink border on stems; subtle botanical contour in Mokkotsu
    ctx.lineWidth = style === "sumie" ? Math.max(1.0, 1.25 * unit) : Math.max(0.45, 0.55 * unit);
    ctx.strokeStyle =
      style === "sumie"
        ? "rgba(10, 9, 8, 0.92)"
        : "rgba(36, 42, 20, 0.52)";
    ctx.stroke();

    // 5B. Clinging Algae: On seeded stems, soft radial dark-green gradient patches blended onto middle body
    if (customBasePx === undefined && hash2D(stemIdx, 8, 977) < 0.68) {
      const algaeSpots = [0.44 + (hash2D(stemIdx, 9, 983) - 0.5) * 0.08, 0.60 + (hash2D(stemIdx, 10, 991) - 0.5) * 0.08];
      for (let aIdx = 0; aIdx < algaeSpots.length; aIdx++) {
        const at = algaeSpots[aIdx];
        const ap = this.evalCubicBezierPose(p0, c1, c2, p3, at);
        const ar = (baseW * (1 - at) + tipW * at) * (1.65 + aIdx * 0.35);
        const ag = ctx.createRadialGradient(ap.x, ap.y, ar * 0.1, ap.x, ap.y, ar);
        if (style === "sumie") {
          ag.addColorStop(0.0, "rgba(28, 25, 22, 0.42)");
          ag.addColorStop(0.65, "rgba(38, 34, 30, 0.18)");
          ag.addColorStop(1.0, "rgba(0, 0, 0, 0)");
        } else {
          ag.addColorStop(0.0, "rgba(34, 58, 22, 0.48)");
          ag.addColorStop(0.62, "rgba(48, 74, 28, 0.22)");
          ag.addColorStop(1.0, "rgba(48, 74, 28, 0)");
        }
        ctx.fillStyle = ag;
        ctx.beginPath();
        ctx.arc(ap.x, ap.y, ar, 0, Math.PI * 2);
        ctx.fill();
        if (style === "sumie") {
          ctx.lineWidth = Math.max(0.8, 0.95 * unit);
          ctx.strokeStyle = "rgba(10, 9, 8, 0.86)";
          ctx.stroke();
        }
      }
    }

    // 5A. Stem Nodes: Small elliptical joint thickenings stamped at 35% and 72% along the stem length,
    //     aligned to the local curve tangent
    if (customBasePx === undefined) {
      const nodeFracs = [0.35, 0.72];
      for (let nIdx = 0; nIdx < nodeFracs.length; nIdx++) {
        const nt = nodeFracs[nIdx];
        const np = this.evalCubicBezierPose(p0, c1, c2, p3, nt);
        const localHalfW = 0.5 * (baseW + (tipW - baseW) * nt);
        const tangAngle = Math.atan2(np.ty, np.tx);

        ctx.save();
        ctx.translate(np.x, np.y);
        ctx.rotate(tangAngle);
        ctx.beginPath();
        ctx.ellipse(0, 0, localHalfW * 1.45, localHalfW * 1.32, 0, 0, Math.PI * 2);
        ctx.fillStyle =
          style === "sumie"
            ? "rgba(34, 30, 26, 0.86)"
            : nIdx === 0
              ? "#353d1e"
              : "#485628";
        ctx.fill();

        // Subtle warm nodal ring highlight
        ctx.lineWidth = Math.max(0.4, 0.5 * unit);
        ctx.strokeStyle =
          style === "sumie"
            ? "rgba(168, 158, 144, 0.38)"
            : "rgba(156, 178, 86, 0.46)";
        ctx.stroke();
        ctx.restore();
      }
    }

    // 5C. Sunlit Crest: Surface stems feature a fine, pale chartreuse highlight along their upper ridge
    //     (between 58% and 78% of the curve) indicating light refraction near the surface
    if (!isDeepStem) {
      ctx.beginPath();
      const crestSteps = 8;
      for (let cs = 0; cs <= crestSteps; cs++) {
        const ct = 0.58 + (cs / crestSteps) * (0.78 - 0.58);
        const cp = this.evalCubicBezierPose(p0, c1, c2, p3, ct);
        const localHalfW = 0.5 * (baseW + (tipW - baseW) * ct);
        // Upper ridge offset toward directional sunlight (-Y / -X side)
        const upSign = cp.ny <= 0 ? 1 : -1;
        const hx = cp.x + cp.nx * upSign * (localHalfW * 0.52);
        const hy = cp.y + cp.ny * upSign * (localHalfW * 0.52);
        if (cs === 0) ctx.moveTo(hx, hy);
        else ctx.lineTo(hx, hy);
      }
      ctx.lineWidth = Math.max(0.55, 0.82 * unit);
      ctx.lineCap = "round";
      ctx.strokeStyle =
        style === "sumie"
          ? "rgba(214, 206, 192, 0.42)"
          : "rgba(198, 222, 110, 0.64)";
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Pass 3 (Lateral Buds): Branches a secondary curved pedicel from a specialized stem node
   * holding either a closed lotus flower bud or a young coiled leaf scroll.
   */
  private renderLateralStemBud(
    ctx: CanvasRenderingContext2D,
    parentCurve: {
      p0: { x: number; y: number };
      c1: { x: number; y: number };
      c2: { x: number; y: number };
      p3: { x: number; y: number };
    },
    stemIdx: number,
    time: number,
    unit: number,
    isLight: boolean,
    style: KoiArtStyle
  ): void {
    // Branch from either the 35% node or 72% node (or 54% mid-node)
    const branchT = stemIdx % 2 === 0 ? 0.72 : 0.35;
    const nodePose = this.evalCubicBezierPose(
      parentCurve.p0,
      parentCurve.c1,
      parentCurve.c2,
      parentCurve.p3,
      branchT
    );

    const sideSign = hash2D(stemIdx, 12, 997) < 0.5 ? 1 : -1;
    const baseAng = Math.atan2(nodePose.ty, nodePose.tx);
    const branchSway = Math.sin(time * 0.85 + stemIdx * 1.7) * 0.08;
    const branchAng = baseAng + sideSign * (0.52 + hash2D(stemIdx, 13, 1009) * 0.28) + branchSway;
    const pedicelLen = (26 + hash2D(stemIdx, 14, 1013) * 18) * unit;

    const bp0 = { x: nodePose.x, y: nodePose.y };
    const bp3 = {
      x: bp0.x + Math.cos(branchAng) * pedicelLen,
      y: bp0.y + Math.sin(branchAng) * pedicelLen,
    };
    const bnx = -Math.sin(branchAng) * sideSign;
    const bny = Math.cos(branchAng) * sideSign;
    const bc1 = {
      x: bp0.x + (bp3.x - bp0.x) * 0.34 + bnx * pedicelLen * 0.22,
      y: bp0.y + (bp3.y - bp0.y) * 0.34 + bny * pedicelLen * 0.22,
    };
    const bc2 = {
      x: bp0.x + (bp3.x - bp0.x) * 0.68 - bnx * pedicelLen * 0.14,
      y: bp0.y + (bp3.y - bp0.y) * 0.68 - bny * pedicelLen * 0.14,
    };

    // Draw the secondary curved pedicel using the 16-segment tapered mesh
    this.renderSingleWiryStem(
      ctx,
      bp0,
      bc1,
      bc2,
      bp3,
      false,
      false,
      stemIdx + 100,
      unit,
      isLight,
      style,
      1.9,
      1.05
    );

    const tipPose = this.evalCubicBezierPose(bp0, bc1, bc2, bp3, 1.0);
    const tipAng = Math.atan2(tipPose.ty, tipPose.tx);
    const isFlowerBud = stemIdx % 3 === 1;

    ctx.save();
    ctx.translate(tipPose.x, tipPose.y);
    ctx.rotate(tipAng);

    // Subtle pond-bed contact shadow under the bud/scroll
    ctx.save();
    ctx.translate(3.0 * unit, 3.8 * unit);
    ctx.fillStyle = isLight ? "rgba(20, 14, 8, 0.24)" : "rgba(0, 0, 0, 0.45)";
    ctx.beginPath();
    ctx.ellipse(4.5 * unit, 0, (isFlowerBud ? 7.5 : 9.0) * unit, (isFlowerBud ? 4.2 : 3.0) * unit, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (isFlowerBud) {
      // Closed Lotus Flower Bud (pointed teardrop with cupped olive calyx & rose-pink petals)
      const budLen = 13.5 * unit;
      const budW = 5.2 * unit;

      // Outer rose-pink pointed bud body
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(budLen * 0.28, -budW, budLen * 0.72, -budW * 0.68, budLen, 0);
      ctx.bezierCurveTo(budLen * 0.72, budW * 0.68, budLen * 0.28, budW, 0, 0);
      ctx.closePath();

      const bGrad = ctx.createLinearGradient(0, 0, budLen, 0);
      if (style === "sumie") {
        bGrad.addColorStop(0.0, "#4a443e");
        bGrad.addColorStop(0.55, "#c8beb0");
        bGrad.addColorStop(1.0, "#b83e2e");
      } else {
        bGrad.addColorStop(0.0, "#546430");
        bGrad.addColorStop(0.38, "#d46a8c");
        bGrad.addColorStop(0.78, "#f29cb8");
        bGrad.addColorStop(1.0, "#dc527c");
      }
      ctx.fillStyle = bGrad;
      ctx.fill();
      if (style === "sumie") {
        ctx.lineWidth = Math.max(0.95, 1.15 * unit);
        ctx.strokeStyle = "rgba(10, 9, 8, 0.92)";
        ctx.stroke();
      }

      // Cupped green calyx sepals cradling the bud base
      ctx.beginPath();
      ctx.moveTo(-1.0 * unit, 0);
      ctx.bezierCurveTo(budLen * 0.16, -budW * 0.92, budLen * 0.36, -budW * 0.55, budLen * 0.44, 0);
      ctx.bezierCurveTo(budLen * 0.36, budW * 0.55, budLen * 0.16, budW * 0.92, -1.0 * unit, 0);
      ctx.closePath();
      ctx.fillStyle = style === "sumie" ? "#3b3631" : "#4a5a28";
      ctx.fill();
      if (style === "sumie") {
        ctx.lineWidth = Math.max(0.85, 1.0 * unit);
        ctx.strokeStyle = "rgba(10, 9, 8, 0.90)";
        ctx.stroke();
      }

      // Delicate petal seam highlight
      ctx.beginPath();
      ctx.moveTo(budLen * 0.25, -budW * 0.18);
      ctx.quadraticCurveTo(budLen * 0.62, -budW * 0.28, budLen * 0.92, 0);
      ctx.lineWidth = Math.max(0.45, 0.6 * unit);
      ctx.strokeStyle = style === "sumie" ? "rgba(244, 236, 224, 0.5)" : "rgba(255, 228, 238, 0.68)";
      ctx.stroke();
    } else {
      // Young Coiled Leaf Scroll (furled tubular peltate leaf scroll with spiral vein ridges)
      const scrollLen = 15.5 * unit;
      const scrollW = 3.6 * unit;

      ctx.beginPath();
      ctx.moveTo(-1.5 * unit, 0);
      ctx.bezierCurveTo(scrollLen * 0.25, -scrollW, scrollLen * 0.75, -scrollW * 0.82, scrollLen, -scrollW * 0.15);
      ctx.bezierCurveTo(scrollLen * 0.78, scrollW * 0.85, scrollLen * 0.25, scrollW, -1.5 * unit, 0);
      ctx.closePath();

      const sGrad = ctx.createLinearGradient(0, -scrollW, 0, scrollW);
      if (style === "sumie") {
        sGrad.addColorStop(0.0, "#686058");
        sGrad.addColorStop(0.5, "#46403a");
        sGrad.addColorStop(1.0, "#2a2622");
      } else {
        sGrad.addColorStop(0.0, "#869c48");
        sGrad.addColorStop(0.5, "#566a2e");
        sGrad.addColorStop(1.0, "#36421c");
      }
      ctx.fillStyle = sGrad;
      ctx.fill();
      if (style === "sumie") {
        ctx.lineWidth = Math.max(0.95, 1.15 * unit);
        ctx.strokeStyle = "rgba(10, 9, 8, 0.92)";
        ctx.stroke();
      }

      // Coiled diagonal scroll ribs
      ctx.lineWidth = Math.max(0.45, 0.55 * unit);
      ctx.strokeStyle = style === "sumie" ? "rgba(212, 204, 190, 0.36)" : "rgba(196, 218, 108, 0.52)";
      for (let r = 0; r < 3; r++) {
        const rx = scrollLen * (0.24 + r * 0.22);
        ctx.beginPath();
        ctx.moveTo(rx - 1.8 * unit, -scrollW * 0.55);
        ctx.lineTo(rx + 1.8 * unit, scrollW * 0.55);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /**
   * Collects all 27 active leaf stems (9 large lotus pad stems + 18 companion leaf stems)
   * with their nearest-edge exits and live cubic Bezier trajectories.
   */
  private getAllActiveStemCurves(
    worldW: number,
    worldH: number,
    unit: number,
    time: number
  ): {
    stemIdx: number;
    isLargeLotus: boolean;
    isDeepStem: boolean;
    hasLateralBud: boolean;
    curve: {
      p0: { x: number; y: number };
      c1: { x: number; y: number };
      c2: { x: number; y: number };
      p3: { x: number; y: number };
    };
  }[] {
    const resolvedPads = this.getResolvedLotusPads(worldW, worldH, unit);
    const companionLeaves = this.getResolvedCompanionLeaves(worldW, worldH, unit, resolvedPads);
    const stems: {
      stemIdx: number;
      isLargeLotus: boolean;
      isDeepStem: boolean;
      hasLateralBud: boolean;
      curve: {
        p0: { x: number; y: number };
        c1: { x: number; y: number };
        c2: { x: number; y: number };
        p3: { x: number; y: number };
      };
    }[] = [];

    // 1. All 9 large lotus pad stems (anchored underneath the leaf near the central navel hub)
    for (let i = 0; i < resolvedPads.length; i++) {
      const pad = resolvedPads[i];
      const st = this.lotusPadStates[i];
      const ampBoost = 1.0 + st.excite * 0.22;
      const swayX = Math.sin(st.leafPhase) * 3.0 * unit * ampBoost + st.swayX + st.dispX;
      const swayY = Math.cos(st.leafPhase * 0.84 + i) * 2.4 * unit * ampBoost + st.swayY + st.dispY;
      const cx = pad.x + swayX;
      const cy = pad.y + swayY;
      const notchAngle =
        pad.notch +
        Math.sin(st.leafPhase * 0.58) * (0.025 + st.excite * 0.015) +
        st.rotOffset;

      const tipX = cx - Math.cos(notchAngle) * (pad.r * 0.06);
      const tipY = cy - Math.sin(notchAngle) * (pad.r * 0.06);
      const restTipX = pad.x - Math.cos(pad.notch) * (pad.r * 0.06);
      const restTipY = pad.y - Math.sin(pad.notch) * (pad.r * 0.06);

      const stemIdx = i;
      const exit = this.computeNearestEdgeExit(restTipX, restTipY, worldW, worldH, unit, stemIdx);
      const curve = this.computeStemBezierTrajectory(
        exit.x,
        exit.y,
        tipX,
        tipY,
        swayX,
        swayY,
        time,
        stemIdx
      );
      curve.c1.x += st.bowX * 0.26 + st.dispX * 0.10;
      curve.c1.y += st.bowY * 0.26 + st.dispY * 0.10;
      curve.c2.x += st.bowX * 0.38 + st.dispX * 0.20;
      curve.c2.y += st.bowY * 0.38 + st.dispY * 0.20;
      // 1/3 of stems marked as deep layers (every 3rd stem)
      const isDeepStem = stemIdx % 3 === 0;
      const hasLateralBud = !isDeepStem && (stemIdx % 2 === 1);
      stems.push({
        stemIdx,
        isLargeLotus: true,
        isDeepStem,
        hasLateralBud,
        curve,
      });
    }

    // 2. All 18 companion leaf stems (joining at the margin notch cleft)
    for (let cIdx = 0; cIdx < companionLeaves.length; cIdx++) {
      const comp = companionLeaves[cIdx];
      const st = this.lotusPadStates[comp.parentIdx];
      const cst = this.companionLeafStates[cIdx];
      const cPhase = st.leafPhase * 1.08 + cIdx * 0.85;
      const ampBoost = 1.0 + st.excite * 0.22;
      const swayX = Math.sin(cPhase) * 2.5 * unit * ampBoost + st.swayX * 0.90 + (cst ? cst.dispX : 0);
      const swayY = Math.cos(cPhase * 0.86 + cIdx) * 2.0 * unit * ampBoost + st.swayY * 0.90 + (cst ? cst.dispY : 0);
      const cx = comp.x + swayX;
      const cy = comp.y + swayY;
      const notchAngle =
        comp.notch +
        Math.sin(cPhase * 0.62) * (0.025 + st.excite * 0.015) +
        st.rotOffset * 0.92;

      const cleftR = comp.r * 0.20;
      const tipX = cx + Math.cos(notchAngle) * cleftR;
      const tipY = cy + Math.sin(notchAngle) * cleftR;
      const restTipX = comp.x + Math.cos(comp.notch) * cleftR;
      const restTipY = comp.y + Math.sin(comp.notch) * cleftR;

      const stemIdx = 9 + cIdx;
      const exit = this.computeNearestEdgeExit(restTipX, restTipY, worldW, worldH, unit, stemIdx);
      const curve = this.computeStemBezierTrajectory(
        exit.x,
        exit.y,
        tipX,
        tipY,
        swayX,
        swayY,
        time,
        stemIdx
      );
      if (cst) {
        curve.c1.x += cst.bowX * 0.26 + cst.dispX * 0.10;
        curve.c1.y += cst.bowY * 0.26 + cst.dispY * 0.10;
        curve.c2.x += cst.bowX * 0.38 + cst.dispX * 0.20;
        curve.c2.y += cst.bowY * 0.38 + cst.dispY * 0.20;
      }
      const isDeepStem = stemIdx % 3 === 0;
      const hasLateralBud = !isDeepStem && (cIdx % 4 === 1);
      stems.push({
        stemIdx,
        isLargeLotus: false,
        isDeepStem,
        hasLateralBud,
        curve,
      });
    }

    return stems;
  }

  /**
   * 6. Multi-Pass Depth Occlusion Stem Renderer:
   * - pass === "deep" (Pass 1): Draws the 1/3 deep stems first at reduced opacity (62%),
   *   before submerged riverbed stones and moss cushions are painted over them.
   * - pass === "surface-and-buds" (Pass 2 & Pass 3): Draws the remaining 2/3 surface stems
   *   over the stones, followed by Pass 3 lateral curved pedicels with closed flower buds
   *   and young coiled leaf scrolls.
   */
  private paintUnderwaterStemsPass(
    ctx: CanvasRenderingContext2D,
    worldW: number,
    worldH: number,
    time: number,
    isLight: boolean,
    style: KoiArtStyle,
    pass: "deep" | "surface-and-buds"
  ): void {
    const unit = koiClamp(Math.min(worldW, worldH) / 860, 0.48, 1.22);
    const allStems = this.getAllActiveStemCurves(worldW, worldH, unit, time);

    ctx.save();
    if (pass === "deep") {
      // Pass 1: Deep Stems (1/3 of stems drawn first at 62% opacity)
      for (let i = 0; i < allStems.length; i++) {
        const st = allStems[i];
        if (!st.isDeepStem) continue;
        this.renderSingleWiryStem(
          ctx,
          st.curve.p0,
          st.curve.c1,
          st.curve.c2,
          st.curve.p3,
          st.isLargeLotus,
          true,
          st.stemIdx,
          unit,
          isLight,
          style
        );
      }
    } else {
      // Pass 2: Surface Stems (remaining 2/3 of stems drawn over the riverbed stones and moss)
      for (let i = 0; i < allStems.length; i++) {
        const st = allStems[i];
        if (st.isDeepStem) continue;
        this.renderSingleWiryStem(
          ctx,
          st.curve.p0,
          st.curve.c1,
          st.curve.c2,
          st.curve.p3,
          st.isLargeLotus,
          false,
          st.stemIdx,
          unit,
          isLight,
          style
        );
      }
      if (style === "sumie") {
        ctx.restore();
        return;
      }
      // Pass 3: Lateral Buds (secondary curved pedicels holding closed flower buds or young coiled leaf scrolls)
      for (let i = 0; i < allStems.length; i++) {
        const st = allStems[i];
        if (!st.hasLateralBud) continue;
        this.renderLateralStemBud(
          ctx,
          st.curve,
          st.stemIdx,
          time,
          unit,
          isLight,
          style
        );
      }
    }
    ctx.restore();
  }

  /**
   * Traces and fills the exact 7-lobed palmate Japanese Maple (*Momiji*) leaf silhouette
   * at `(lx, ly)` with radius `size` and rotation `rot`. Used for both the maple leaf cast
   * shadow and caustic occlusion so shadows under maple leaves are never circles.
   */
  private fillMapleLeafSilhouette(
    targetCtx: CanvasRenderingContext2D,
    lx: number,
    ly: number,
    size: number,
    rot: number
  ): void {
    const lobes = [
      { ang: 0.0, len: 1.0, w: 0.23 },
      { ang: -0.58, len: 0.88, w: 0.21 },
      { ang: 0.58, len: 0.88, w: 0.21 },
      { ang: -1.16, len: 0.68, w: 0.17 },
      { ang: 1.16, len: 0.68, w: 0.17 },
      { ang: -1.72, len: 0.44, w: 0.13 },
      { ang: 1.72, len: 0.44, w: 0.13 },
    ];

    targetCtx.save();
    targetCtx.translate(lx, ly);
    targetCtx.rotate(rot);
    for (const lb of lobes) {
      const lLen = size * lb.len;
      const lW = size * lb.w;
      targetCtx.save();
      targetCtx.rotate(lb.ang);
      targetCtx.beginPath();
      targetCtx.moveTo(0, 0);
      targetCtx.bezierCurveTo(lLen * 0.28, -lW * 0.65, lLen * 0.62, -lW * 1.15, lLen, 0);
      targetCtx.bezierCurveTo(lLen * 0.62, lW * 1.15, lLen * 0.28, lW * 0.65, 0, 0);
      targetCtx.closePath();
      targetCtx.fill();
      targetCtx.restore();
    }
    targetCtx.restore();
  }

  /**
   * Pre-bakes all 9 Lotus Leaf sprites (including their unclipped Gaussian-blurred subsurface
   * shadows, peltate blades, and 19 natural veins) and both Blooming Pink Lotus sprites once
   * per `(unit, isLight, style)` so `paintLotusPads` executes zero `ctx.filter` blurs and zero
   * Bezier path strokes during the 60 FPS animation loop.
   */
  private ensureBotanicalSpriteCache(
    unit: number,
    isLight: boolean,
    style: KoiArtStyle
  ): void {
    const quantUnit = Math.round(unit * 40) / 40;
    const key = `${quantUnit}:${isLight ? "L" : "D"}:${style}:v7`;
    const cachedSet = this.botanicalSpriteCacheMap.get(key);
    if (cachedSet && cachedSet.lotus.length === 9 && cachedSet.companion.length === 18) {
      this.botanicalSpriteKey = key;
      this.lotusLeafSprites = cachedSet.lotus;
      this.companionLeafSprites = cachedSet.companion;
      this.pinkLotusSprites = cachedSet.pinkLotus;
      return;
    }
    if (this.botanicalSpriteCacheMap.size >= 6) {
      this.botanicalSpriteCacheMap.clear();
    }
    this.botanicalSpriteKey = key;

    const specs = this.getLotusPadSpecs();
    this.lotusLeafSprites = [];
    this.companionLeafSprites = [];
    this.pinkLotusSprites = [];

    if ((style as KoiArtStyle) === "sumie") {
      for (let i = 0; i < specs.length; i++) {
        const pad = specs[i];
        const r = pad.r * quantUnit;
        const sprite = bakeSumieForegroundPadSprite(r, i + 17, isLight, false);
        this.lotusLeafSprites.push(sprite);
        if (pad.hasLotus) {
          const flRad = r * 0.60;
          const flDim = Math.max(64, Math.ceil(flRad * 2.6));
          const flSprite = document.createElement("canvas");
          flSprite.width = flDim;
          flSprite.height = flDim;
          const fCtx = flSprite.getContext("2d");
          if (fCtx) {
            paintSumieWaterLily(fCtx, flDim * 0.5, flDim * 0.5, flRad, pad.notch + 0.42, isLight);
          }
          this.pinkLotusSprites.push(flSprite);
        }
      }
      for (let cIdx = 0; cIdx < 18; cIdx++) {
        const r = (15.0 + hash2D(cIdx, 1, 601) * 8.5) * quantUnit;
        const cSprite = bakeSumieForegroundPadSprite(r, cIdx + 109, isLight, true);
        this.companionLeafSprites.push(cSprite);
      }
      this.botanicalSpriteCacheMap.set(key, {
        lotus: this.lotusLeafSprites,
        companion: this.companionLeafSprites,
        pinkLotus: this.pinkLotusSprites,
      });
      return;
    }

    for (let i = 0; i < specs.length; i++) {
      const pad = specs[i];
      const r = pad.r * quantUnit;
      const padMargin = Math.ceil(42 * quantUnit);
      const dim = Math.max(64, Math.ceil((r + padMargin) * 2));
      const cx = dim * 0.5;
      const cy = dim * 0.5;

      const sprite = document.createElement("canvas");
      sprite.width = dim;
      sprite.height = dim;
      const sCtx = sprite.getContext("2d");
      if (sCtx) {
        // Bake at canonical notchAngle = 0 (rotated smoothly at draw time)
        const notchAngle = 0;
        const navelX = cx - Math.cos(notchAngle) * (r * 0.06);
        const navelY = cy - Math.sin(notchAngle) * (r * 0.06);

        // Reference-matched scalloped lotus leaf contour with deep V-cleft and 14 organic wavy lobes
        const traceLeaf = (ox: number, oy: number, radius: number) => {
          sCtx.beginPath();
          const steps = 96;
          const cleftHalf = 0.21;
          sCtx.moveTo(
            navelX + ox + Math.cos(notchAngle) * (radius * 0.06),
            navelY + oy + Math.sin(notchAngle) * (radius * 0.06)
          );
          for (let k = 0; k <= steps; k++) {
            const t = k / steps;
            const a = notchAngle + cleftHalf + t * (Math.PI * 2 - cleftHalf * 2);
            const lobeWave =
              1.0 +
              0.046 * Math.sin(t * Math.PI * 14 + i * 1.7) +
              0.024 * Math.cos(t * Math.PI * 22 - i * 1.3) -
              0.018 * Math.pow(Math.sin(t * Math.PI * 7 + i * 0.9), 4);
            // Taper smoothly at the two tips flanking the V-cleft
            const tipTaper =
              t < 0.035
                ? 0.90 + 0.10 * (t / 0.035)
                : t > 0.965
                  ? 0.90 + 0.10 * ((1 - t) / 0.035)
                  : 1.0;
            const rad = radius * lobeWave * tipTaper;
            const lx = cx + ox + Math.cos(a) * rad;
            const ly = cy + oy + Math.sin(a) * rad;
            sCtx.lineTo(lx, ly);
          }
          sCtx.closePath();
        };

        // 1. Pre-baked unclipped continuous Gaussian subsurface shadow
        sCtx.save();
        sCtx.filter = `blur(${Math.max(8, Math.round(14 * quantUnit))}px)`;
        traceLeaf(0, 0, r * 1.01);
        sCtx.fillStyle = isLight ? "rgba(18, 12, 6, 0.58)" : "rgba(0, 0, 0, 0.86)";
        sCtx.fill();
        sCtx.filter = "none";
        sCtx.restore();

        // 2. Opaque non-emissive botanical leaf fill (rich emerald-to-olive blade with golden-chartreuse rim)
        traceLeaf(0, 0, r);
        const leafGrad = sCtx.createRadialGradient(
          navelX,
          navelY,
          r * 0.02,
          cx,
          cy,
          r * 1.03
        );
        if (style === "sumie") {
          leafGrad.addColorStop(0.0, isLight ? "rgba(86, 82, 74, 0.98)" : "rgba(96, 92, 86, 0.98)");
          leafGrad.addColorStop(0.55, isLight ? "rgba(48, 44, 39, 0.98)" : "rgba(58, 54, 50, 0.98)");
          leafGrad.addColorStop(0.92, isLight ? "rgba(32, 29, 26, 0.98)" : "rgba(40, 36, 32, 0.98)");
          leafGrad.addColorStop(1.0, isLight ? "rgba(112, 102, 84, 0.98)" : "rgba(82, 76, 66, 0.98)");
        } else if (isLight) {
          leafGrad.addColorStop(0.0, "rgba(182, 198, 78, 0.99)");
          leafGrad.addColorStop(0.12, "rgba(94, 138, 46, 0.99)");
          leafGrad.addColorStop(0.54, "rgba(58, 104, 38, 0.99)");
          leafGrad.addColorStop(0.84, "rgba(74, 118, 40, 0.99)");
          leafGrad.addColorStop(0.95, "rgba(154, 158, 42, 0.99)");
          leafGrad.addColorStop(1.0, "rgba(212, 174, 38, 0.99)");
        } else {
          leafGrad.addColorStop(0.0, "rgba(114, 126, 52, 0.99)");
          leafGrad.addColorStop(0.12, "rgba(60, 90, 32, 0.99)");
          leafGrad.addColorStop(0.54, "rgba(38, 68, 26, 0.99)");
          leafGrad.addColorStop(0.84, "rgba(48, 78, 28, 0.99)");
          leafGrad.addColorStop(0.95, "rgba(98, 102, 28, 0.99)");
          leafGrad.addColorStop(1.0, "rgba(136, 112, 26, 0.99)");
        }
        sCtx.fillStyle = leafGrad;
        sCtx.fill();

        sCtx.save();
        traceLeaf(0, 0, r * 0.99);
        sCtx.clip();

        // 2B. Subtle organic mesophyll tonal mottling across the leaf blade
        if (style !== "sumie") {
          for (let m = 0; m < 6; m++) {
            const ma = (m / 6) * Math.PI * 2 + i * 0.85;
            const md = r * (0.32 + hash2D(i, m, 911) * 0.42);
            const mx = cx + Math.cos(ma) * md;
            const my = cy + Math.sin(ma) * md;
            const mr = r * (0.28 + hash2D(m, i, 919) * 0.22);
            const mg = sCtx.createRadialGradient(mx, my, 0, mx, my, mr);
            if (m % 2 === 0) {
              mg.addColorStop(0.0, isLight ? "rgba(38, 76, 24, 0.22)" : "rgba(22, 46, 14, 0.26)");
            } else {
              mg.addColorStop(0.0, isLight ? "rgba(128, 158, 48, 0.18)" : "rgba(82, 102, 32, 0.18)");
            }
            mg.addColorStop(1.0, "rgba(0, 0, 0, 0)");
            sCtx.fillStyle = mg;
            sCtx.beginPath();
            sCtx.arc(mx, my, mr, 0, Math.PI * 2);
            sCtx.fill();
          }
        }

        // 3. Natural Peltate Botanical Venation (*Nelumbo nucifera* — 21 yellow-green primary veins + forked veinlets)
        const veinStrokeCol =
          style === "sumie"
            ? "rgba(232, 224, 208, 0.36)"
            : isLight
              ? "rgba(196, 214, 92, 0.62)"
              : "rgba(128, 144, 64, 0.50)";
        const veinShadowCol =
          style === "sumie"
            ? "rgba(18, 16, 14, 0.24)"
            : isLight
              ? "rgba(34, 62, 22, 0.28)"
              : "rgba(16, 30, 12, 0.36)";

        sCtx.lineCap = "round";
        sCtx.lineJoin = "round";

        const primaryVeinCount = 21;
        const prevTipX = new Float32Array(primaryVeinCount);
        const prevTipY = new Float32Array(primaryVeinCount);

        for (let v = 0; v < primaryVeinCount; v++) {
          const uV = v / (primaryVeinCount - 1);
          const jitterA = (hash2D(i * 13 + v, 3, 941) - 0.5) * 0.055;
          const va = notchAngle + 0.25 + uV * (Math.PI * 2 - 0.50) + jitterA;

          const sBend1 = (hash2D(i * 17 + v, 7, 947) - 0.5) * 0.13;
          const sBend2 = -sBend1 * 0.65 + (hash2D(i * 23 + v, 11, 953) - 0.5) * 0.08;
          const reachR = r * (0.85 + hash2D(i * 29 + v, 19, 967) * 0.08);

          const r1 = reachR * 0.36;
          const r2 = reachR * 0.68;

          const p1x = navelX + Math.cos(va + sBend1) * r1;
          const p1y = navelY + Math.sin(va + sBend1) * r1;
          const p2x = navelX + Math.cos(va + sBend2) * r2;
          const p2y = navelY + Math.sin(va + sBend2) * r2;
          const p3x = navelX + Math.cos(va) * reachR;
          const p3y = navelY + Math.sin(va) * reachR;

          prevTipX[v] = p2x * 0.3 + p3x * 0.7;
          prevTipY[v] = p2y * 0.3 + p3y * 0.7;

          sCtx.strokeStyle = veinShadowCol;
          sCtx.lineWidth = 1.45 * quantUnit;
          sCtx.beginPath();
          sCtx.moveTo(navelX + 0.8, navelY + 0.8);
          sCtx.quadraticCurveTo(p1x + 0.8, p1y + 0.8, p2x + 0.8, p2y + 0.8);
          sCtx.stroke();

          sCtx.strokeStyle = veinStrokeCol;
          sCtx.lineWidth = (1.68 - 0.28 * Math.sin(uV * Math.PI)) * quantUnit;
          sCtx.beginPath();
          sCtx.moveTo(navelX, navelY);
          sCtx.quadraticCurveTo(
            navelX + Math.cos(va + sBend1 * 0.5) * (r1 * 0.5),
            navelY + Math.sin(va + sBend1 * 0.5) * (r1 * 0.5),
            p1x,
            p1y
          );
          sCtx.stroke();

          sCtx.lineWidth = 1.12 * quantUnit;
          sCtx.beginPath();
          sCtx.moveTo(p1x, p1y);
          sCtx.quadraticCurveTo(
            navelX + Math.cos(va + (sBend1 + sBend2) * 0.5) * ((r1 + r2) * 0.5),
            navelY + Math.sin(va + (sBend1 + sBend2) * 0.5) * ((r1 + r2) * 0.5),
            p2x,
            p2y
          );
          sCtx.stroke();

          sCtx.lineWidth = 0.58 * quantUnit;
          sCtx.beginPath();
          sCtx.moveTo(p2x, p2y);
          sCtx.quadraticCurveTo(
            navelX + Math.cos(va + sBend2 * 0.4) * ((r2 + reachR) * 0.5),
            navelY + Math.sin(va + sBend2 * 0.4) * ((r2 + reachR) * 0.5),
            p3x,
            p3y
          );
          sCtx.stroke();

          sCtx.lineWidth = 0.52 * quantUnit;
          const side1 = v % 2 === 0 ? 1 : -1;
          const fork1Ang = va + side1 * (0.17 + hash2D(v, i, 971) * 0.08);
          const fork1Len = r * (0.19 + hash2D(v, i, 977) * 0.06);
          const f1CtrlX = p1x + Math.cos(va + side1 * 0.07) * (fork1Len * 0.55);
          const f1CtrlY = p1y + Math.sin(va + side1 * 0.07) * (fork1Len * 0.55);
          const f1EndX = p1x + Math.cos(fork1Ang) * fork1Len;
          const f1EndY = p1y + Math.sin(fork1Ang) * fork1Len;
          sCtx.beginPath();
          sCtx.moveTo(p1x, p1y);
          sCtx.quadraticCurveTo(f1CtrlX, f1CtrlY, f1EndX, f1EndY);
          sCtx.stroke();

          for (const side2 of [-1, 1]) {
            const fork2Ang = va + side2 * (0.15 + hash2D(v + side2, i, 983) * 0.07);
            const fork2Len = r * (0.16 + hash2D(v, i + side2, 991) * 0.05);
            const f2CtrlX = p2x + Math.cos(va + side2 * 0.05) * (fork2Len * 0.5);
            const f2CtrlY = p2y + Math.sin(va + side2 * 0.05) * (fork2Len * 0.5);
            const f2EndX = p2x + Math.cos(fork2Ang) * fork2Len;
            const f2EndY = p2y + Math.sin(fork2Ang) * fork2Len;
            sCtx.lineWidth = 0.44 * quantUnit;
            sCtx.beginPath();
            sCtx.moveTo(p2x, p2y);
            sCtx.quadraticCurveTo(f2CtrlX, f2CtrlY, f2EndX, f2EndY);
            sCtx.stroke();
          }


        }

        // 4. Non-emissive Botanical Central Navel Hub (pale yellow-chartreuse pigment, never self-luminous)
        const navRad = r * 0.076;
        const navGrad = sCtx.createRadialGradient(navelX, navelY, navRad * 0.08, navelX, navelY, navRad);
        if (style === "sumie") {
          navGrad.addColorStop(0.0, isLight ? "rgba(218, 210, 194, 0.84)" : "rgba(154, 148, 136, 0.78)");
          navGrad.addColorStop(0.68, isLight ? "rgba(156, 148, 136, 0.48)" : "rgba(112, 106, 98, 0.44)");
          navGrad.addColorStop(1.0, "rgba(156, 148, 136, 0)");
        } else if (isLight) {
          navGrad.addColorStop(0.0, "rgba(226, 232, 128, 0.92)");
          navGrad.addColorStop(0.55, "rgba(168, 194, 82, 0.62)");
          navGrad.addColorStop(1.0, "rgba(112, 148, 52, 0)");
        } else {
          navGrad.addColorStop(0.0, "rgba(144, 152, 78, 0.86)");
          navGrad.addColorStop(0.55, "rgba(104, 122, 52, 0.56)");
          navGrad.addColorStop(1.0, "rgba(72, 96, 36, 0)");
        }
        sCtx.fillStyle = navGrad;
        sCtx.beginPath();
        sCtx.arc(navelX, navelY, navRad, 0, Math.PI * 2);
        sCtx.fill();

        // 5. Organic Russet-Brown Weathering Spots & Natural Specks on ALL 9 Lotus Leaves (referencing image_132ade.png)
        const spotCount = 7;
        for (let sp = 0; sp < spotCount; sp++) {
          const sa = notchAngle + 0.38 + ((sp + 0.35 * hash2D(i, sp, 821)) / spotCount) * (Math.PI * 2 - 0.76);
          const sd = r * (0.72 + hash2D(sp, i, 829) * 0.19);
          const sx = cx + Math.cos(sa) * sd;
          const sy = cy + Math.sin(sa) * sd;
          const srx = (1.6 + hash2D(i, sp, 839) * 2.4) * quantUnit;
          const sry = srx * (0.58 + hash2D(sp, i, 853) * 0.35);

          sCtx.save();
          sCtx.translate(sx, sy);
          sCtx.rotate(sa + hash2D(i, sp, 859));
          sCtx.fillStyle =
            style === "sumie"
              ? isLight
                ? "rgba(28, 24, 20, 0.38)"
                : "rgba(22, 18, 15, 0.44)"
              : isLight
                ? "rgba(116, 68, 22, 0.46)"
                : "rgba(76, 44, 14, 0.46)";
          sCtx.beginPath();
          sCtx.ellipse(0, 0, srx, sry, 0, 0, Math.PI * 2);
          sCtx.fill();
          sCtx.restore();
        }

        // 2 tiny natural weathered amber-tan mid-blade blemishes (referencing image_132ade.png)
        for (let pk = 0; pk < 2; pk++) {
          const pa = notchAngle + (pk === 0 ? 1.85 : 4.25) + (hash2D(i, pk, 863) - 0.5) * 0.45;
          const pd = r * (0.36 + hash2D(pk, i, 877) * 0.22);
          const px = cx + Math.cos(pa) * pd;
          const py = cy + Math.sin(pa) * pd;
          const pr = (1.15 + pk * 0.25) * quantUnit;
          sCtx.fillStyle =
            style === "sumie"
              ? isLight
                ? "rgba(164, 156, 142, 0.48)"
                : "rgba(116, 110, 100, 0.44)"
              : isLight
                ? "rgba(168, 138, 92, 0.56)"
                : "rgba(112, 92, 62, 0.48)";
          sCtx.beginPath();
          sCtx.ellipse(px, py, pr * 1.15, pr * 0.82, pa, 0, Math.PI * 2);
          sCtx.fill();
          sCtx.fillStyle = isLight ? "rgba(96, 64, 28, 0.46)" : "rgba(58, 38, 16, 0.46)";
          sCtx.beginPath();
          sCtx.arc(px, py, pr * 0.42, 0, Math.PI * 2);
          sCtx.fill();
        }

        // 6. Hydrophobic Beaded Water Dewdrops on ALL 9 Lotus Leaves (referencing image_132ade.png)
        const dewCount = 2 + (i % 2);
        for (let d = 0; d < dewCount; d++) {
          // First dewdrop sits near the cleft margin (like the lower-left droplet in image_132ade.png)
          const da =
            d === 0
              ? notchAngle + 0.30 + hash2D(i, 0, 881) * 0.18
              : notchAngle + 1.4 + d * 1.9 + (hash2D(i, d, 883) - 0.5) * 0.6;
          const dd =
            d === 0
              ? r * (0.64 + hash2D(i, 1, 887) * 0.14)
              : r * (0.42 + hash2D(d, i, 907) * 0.32);
          const dx = cx + Math.cos(da) * dd;
          const dy = cy + Math.sin(da) * dd;
          const dr = (d === 0 ? 3.2 + (i % 3) * 0.5 : 1.8 + (d % 2) * 0.5) * quantUnit;

          sCtx.save();
          sCtx.translate(dx, dy);
          sCtx.rotate(da * 0.3);

          // Contact shadow under the dewdrop
          sCtx.fillStyle = isLight ? "rgba(18, 38, 12, 0.42)" : "rgba(6, 14, 4, 0.58)";
          sCtx.beginPath();
          sCtx.ellipse(0.85 * quantUnit, 1.05 * quantUnit, dr * 1.02, dr * 0.82, 0.2, 0, Math.PI * 2);
          sCtx.fill();

          // Refractive translucent water droplet body
          const dg = sCtx.createRadialGradient(
            -dr * 0.28,
            -dr * 0.28,
            dr * 0.08,
            0,
            0,
            dr
          );
          if (style === "sumie") {
            dg.addColorStop(0.0, isLight ? "rgba(242, 238, 228, 0.78)" : "rgba(184, 178, 168, 0.68)");
            dg.addColorStop(0.55, isLight ? "rgba(138, 132, 122, 0.42)" : "rgba(96, 92, 84, 0.42)");
            dg.addColorStop(1.0, isLight ? "rgba(64, 60, 54, 0.55)" : "rgba(42, 38, 34, 0.55)");
          } else {
            dg.addColorStop(0.0, isLight ? "rgba(218, 238, 214, 0.76)" : "rgba(148, 168, 144, 0.68)");
            dg.addColorStop(0.58, isLight ? "rgba(116, 158, 118, 0.44)" : "rgba(74, 106, 76, 0.44)");
            dg.addColorStop(1.0, isLight ? "rgba(42, 78, 38, 0.58)" : "rgba(26, 52, 24, 0.58)");
          }
          sCtx.fillStyle = dg;
          sCtx.beginPath();
          sCtx.ellipse(0, 0, dr, dr * 0.84, 0.15, 0, Math.PI * 2);
          sCtx.fill();

          // Crisp upper-left specular reflection dot on the dewdrop
          sCtx.fillStyle = isLight ? "rgba(255, 254, 246, 0.88)" : "rgba(212, 208, 196, 0.75)";
          sCtx.beginPath();
          sCtx.ellipse(-dr * 0.34, -dr * 0.28, dr * 0.30, dr * 0.18, -0.45, 0, Math.PI * 2);
          sCtx.fill();

          sCtx.restore();
        }

        sCtx.restore();

        // 7. Signature Golden-Chartreuse Scalloped Rim & V-Cleft Outline (non-emissive pigment)
        traceLeaf(0, 0, r * 0.992);
        sCtx.lineWidth = 2.3 * quantUnit;
        sCtx.strokeStyle =
          style === "sumie"
            ? isLight
              ? "rgba(54, 50, 44, 0.55)"
              : "rgba(78, 72, 64, 0.48)"
            : isLight
              ? "rgba(158, 166, 44, 0.58)"
              : "rgba(98, 104, 28, 0.52)";
        sCtx.stroke();

        traceLeaf(0, 0, r);
        sCtx.lineWidth = style === "sumie" ? Math.max(1.8, 2.25 * quantUnit) : 1.35 * quantUnit;
        sCtx.strokeStyle =
          style === "sumie"
            ? "rgba(10, 9, 8, 0.94)"
            : isLight
              ? "rgba(218, 178, 42, 0.92)"
              : "rgba(142, 116, 28, 0.84)";
        sCtx.stroke();

        // Draw Sakura petals (and 1 whole Sakura flower on the 2 biggest lotus leaves) resting on the lotus leaf blade!
        if (true) {
          const drawLeafPetal = (px: number, py: number, pLen: number, pRot: number, isMono: boolean) => {
            const pW = pLen * 0.62;
            sCtx.save();
            sCtx.translate(px, py);
            sCtx.rotate(pRot);
            sCtx.shadowColor = isLight ? "rgba(20, 32, 16, 0.36)" : "rgba(0, 0, 0, 0.62)";
            sCtx.shadowBlur = 2.2 * quantUnit;
            sCtx.shadowOffsetX = 1.2 * quantUnit;
            sCtx.shadowOffsetY = 1.6 * quantUnit;

            sCtx.beginPath();
            sCtx.moveTo(0, 0);
            sCtx.bezierCurveTo(pLen * 0.26, -pW * 0.96, pLen * 0.78, -pW * 0.88, pLen, -pW * 0.17);
            sCtx.quadraticCurveTo(pLen * 0.90, -pW * 0.05, pLen * 0.84, 0);
            sCtx.quadraticCurveTo(pLen * 0.90, pW * 0.05, pLen, pW * 0.17);
            sCtx.bezierCurveTo(pLen * 0.78, pW * 0.88, pLen * 0.26, pW * 0.96, 0, 0);
            sCtx.closePath();

            const dimF = isLight ? 1.0 : 0.78;
            const pg = sCtx.createLinearGradient(0, 0, pLen, 0);
            if (isMono) {
              pg.addColorStop(0.0, `rgba(${Math.round(78 * dimF)}, ${Math.round(74 * dimF)}, ${Math.round(68 * dimF)}, 1.0)`);
              pg.addColorStop(0.52, `rgba(${Math.round(188 * dimF)}, ${Math.round(184 * dimF)}, ${Math.round(176 * dimF)}, 1.0)`);
              pg.addColorStop(1.0, `rgba(${Math.round(246 * dimF)}, ${Math.round(244 * dimF)}, ${Math.round(238 * dimF)}, 1.0)`);
            } else {
              pg.addColorStop(0.0, `rgba(${Math.round(212 * dimF)}, ${Math.round(68 * dimF)}, ${Math.round(108 * dimF)}, 1.0)`);
              pg.addColorStop(0.52, `rgba(${Math.round(246 * dimF)}, ${Math.round(152 * dimF)}, ${Math.round(182 * dimF)}, 1.0)`);
              pg.addColorStop(1.0, `rgba(${Math.round(255 * dimF)}, ${Math.round(236 * dimF)}, ${Math.round(244 * dimF)}, 1.0)`);
            }
            sCtx.fillStyle = pg;
            sCtx.fill();
            if (isMono) {
              sCtx.shadowBlur = 0;
              sCtx.shadowOffsetX = 0;
              sCtx.shadowOffsetY = 0;
              sCtx.lineWidth = Math.max(0.85, 1.0 * quantUnit);
              sCtx.strokeStyle = "rgba(10, 9, 8, 0.92)";
              sCtx.stroke();
            }
            sCtx.restore();
          };

          const drawLeafWholeFlower = (fx: number, fy: number, fRad: number, fRot: number, isMono: boolean) => {
            sCtx.save();
            sCtx.translate(fx, fy);
            sCtx.rotate(fRot);

            // Soft contact shadow on the lotus leaf blade
            const shG = sCtx.createRadialGradient(
              1.4 * quantUnit,
              2.0 * quantUnit,
              fRad * 0.1,
              1.4 * quantUnit,
              2.0 * quantUnit,
              fRad * 1.15
            );
            shG.addColorStop(0.0, isLight ? "rgba(20, 32, 16, 0.42)" : "rgba(0, 0, 0, 0.68)");
            shG.addColorStop(1.0, "rgba(0, 0, 0, 0)");
            sCtx.fillStyle = shG;
            sCtx.beginPath();
            sCtx.arc(1.4 * quantUnit, 2.0 * quantUnit, fRad * 1.15, 0, Math.PI * 2);
            sCtx.fill();

            const dimF = isLight ? 1.0 : 0.78;
            for (let p = 0; p < 5; p++) {
              const a = (p / 5) * Math.PI * 2;
              sCtx.save();
              sCtx.rotate(a);
              const pLen = fRad;
              const pW = fRad * 0.64;
              sCtx.beginPath();
              sCtx.moveTo(0, 0);
              sCtx.bezierCurveTo(pLen * 0.24, -pW * 0.98, pLen * 0.76, -pW * 0.90, pLen, -pW * 0.16);
              sCtx.quadraticCurveTo(pLen * 0.90, -pW * 0.05, pLen * 0.84, 0);
              sCtx.quadraticCurveTo(pLen * 0.90, pW * 0.05, pLen, pW * 0.16);
              sCtx.bezierCurveTo(pLen * 0.76, pW * 0.90, pLen * 0.24, pW * 0.98, 0, 0);
              sCtx.closePath();

              const pGrad = sCtx.createLinearGradient(0, 0, pLen, 0);
              if (isMono) {
                pGrad.addColorStop(0.0, `rgba(${Math.round(68 * dimF)}, ${Math.round(64 * dimF)}, ${Math.round(58 * dimF)}, 1.0)`);
                pGrad.addColorStop(0.42, `rgba(${Math.round(186 * dimF)}, ${Math.round(182 * dimF)}, ${Math.round(174 * dimF)}, 1.0)`);
                pGrad.addColorStop(0.86, `rgba(${Math.round(248 * dimF)}, ${Math.round(246 * dimF)}, ${Math.round(240 * dimF)}, 1.0)`);
                pGrad.addColorStop(1.0, `rgba(${Math.round(186 * dimF)}, ${Math.round(182 * dimF)}, ${Math.round(174 * dimF)}, 1.0)`);
                sCtx.fillStyle = pGrad;
                sCtx.fill();
                sCtx.strokeStyle = "rgba(10, 9, 8, 0.92)";
              } else {
                pGrad.addColorStop(0.0, `rgba(${Math.round(202 * dimF)}, ${Math.round(54 * dimF)}, ${Math.round(92 * dimF)}, 1.0)`);
                pGrad.addColorStop(0.42, `rgba(${Math.round(246 * dimF)}, ${Math.round(154 * dimF)}, ${Math.round(184 * dimF)}, 1.0)`);
                pGrad.addColorStop(0.86, `rgba(${Math.round(255 * dimF)}, ${Math.round(242 * dimF)}, ${Math.round(248 * dimF)}, 1.0)`);
                pGrad.addColorStop(1.0, `rgba(${Math.round(246 * dimF)}, ${Math.round(154 * dimF)}, ${Math.round(184 * dimF)}, 1.0)`);
                sCtx.fillStyle = pGrad;
                sCtx.fill();
                sCtx.strokeStyle = `rgba(${Math.round(176 * dimF)}, ${Math.round(72 * dimF)}, ${Math.round(104 * dimF)}, 0.38)`;
              }
              sCtx.lineWidth = isMono ? Math.max(0.9, 1.05 * quantUnit) : Math.max(0.4, fRad * 0.035);
              sCtx.stroke();
              sCtx.restore();
            }

            const heartG = sCtx.createRadialGradient(0, 0, 0, 0, 0, fRad * 0.28);
            if (isMono) {
              heartG.addColorStop(0.0, isLight ? "rgba(24, 22, 20, 1.0)" : "rgba(16, 15, 14, 1.0)");
              heartG.addColorStop(0.6, "rgba(58, 54, 48, 0.85)");
              heartG.addColorStop(1.0, "rgba(58, 54, 48, 0)");
            } else {
              heartG.addColorStop(0.0, isLight ? "rgba(142, 22, 52, 1.0)" : "rgba(98, 14, 36, 1.0)");
              heartG.addColorStop(0.6, "rgba(188, 42, 78, 0.85)");
              heartG.addColorStop(1.0, "rgba(188, 42, 78, 0)");
            }
            sCtx.fillStyle = heartG;
            sCtx.beginPath();
            sCtx.arc(0, 0, fRad * 0.28, 0, Math.PI * 2);
            sCtx.fill();

            sCtx.strokeStyle = isMono ? "rgba(38, 35, 32, 0.86)" : "rgba(176, 36, 68, 0.85)";
            sCtx.fillStyle = isMono
              ? isLight
                ? "rgba(238, 234, 226, 1.0)"
                : "rgba(202, 198, 190, 1.0)"
              : isLight
                ? "rgba(255, 238, 184, 1.0)"
                : "rgba(218, 198, 146, 1.0)";
            sCtx.lineWidth = Math.max(0.4, fRad * 0.036);
            for (let st = 0; st < 10; st++) {
              const sa = (st / 10) * Math.PI * 2;
              const sLen = fRad * (0.24 + (st % 2) * 0.05);
              const sx = Math.cos(sa) * sLen;
              const sy = Math.sin(sa) * sLen;
              sCtx.beginPath();
              sCtx.moveTo(0, 0);
              sCtx.lineTo(sx, sy);
              sCtx.stroke();
              sCtx.beginPath();
              sCtx.arc(sx, sy, Math.max(0.6, fRad * 0.045), 0, Math.PI * 2);
              sCtx.fill();
            }

            sCtx.restore();
          };

          const leafSakuraMono = style === "sumie";
          if (pad.r >= 88) {
            drawLeafWholeFlower(
              cx + Math.cos(3.08) * (r * 0.52),
              cy + Math.sin(3.08) * (r * 0.52),
              13.5 * quantUnit,
              0.42,
              leafSakuraMono
            );
            drawLeafPetal(
              cx + Math.cos(2.05) * (r * 0.64),
              cy + Math.sin(2.05) * (r * 0.64),
              8.2 * quantUnit,
              1.35,
              leafSakuraMono
            );
            drawLeafPetal(
              cx + Math.cos(4.22) * (r * 0.60),
              cy + Math.sin(4.22) * (r * 0.60),
              7.8 * quantUnit,
              -0.85,
              leafSakuraMono
            );
          } else if (pad.r <= 38) {
            drawLeafPetal(
              cx + Math.cos(2.65 + i * 0.4) * (r * 0.46),
              cy + Math.sin(2.65 + i * 0.4) * (r * 0.46),
              7.4 * quantUnit,
              0.95 + i,
              leafSakuraMono
            );
          } else {
            drawLeafPetal(
              cx + Math.cos(2.15 + i * 0.3) * (r * 0.54),
              cy + Math.sin(2.15 + i * 0.3) * (r * 0.54),
              7.8 * quantUnit,
              0.65 + i,
              leafSakuraMono
            );
            drawLeafPetal(
              cx + Math.cos(4.05 + i * 0.3) * (r * 0.50),
              cy + Math.sin(4.05 + i * 0.3) * (r * 0.50),
              7.4 * quantUnit,
              -1.15 + i,
              leafSakuraMono
            );
          }
        }
      }
      this.lotusLeafSprites.push(sprite);

      if (pad.hasLotus) {
        const flRad = r * 0.64;
        const flDim = Math.max(64, Math.ceil(flRad * 2.8));
        const flSprite = document.createElement("canvas");
        flSprite.width = flDim;
        flSprite.height = flDim;
        const fCtx = flSprite.getContext("2d");
        if (fCtx) {
          this.paintBloomingPinkLotus(fCtx, flDim * 0.5, flDim * 0.5, flRad, pad.notch + 0.42, isLight, style);
        }
        this.pinkLotusSprites.push(flSprite);
      }
    }

    // Pre-bake all 18 Companion Leaf sprites with margin notch clefts and subsurface shadows
    for (let cIdx = 0; cIdx < 18; cIdx++) {
      const r = (15.0 + hash2D(cIdx, 1, 601) * 8.5) * quantUnit;
      const padMargin = Math.ceil(18 * quantUnit);
      const dim = Math.max(40, Math.ceil((r + padMargin) * 2));
      const cx = dim * 0.5;
      const cy = dim * 0.5;

      const cSprite = document.createElement("canvas");
      cSprite.width = dim;
      cSprite.height = dim;
      const cCtx = cSprite.getContext("2d");
      if (cCtx) {
        const notchAngle = 0;
        const cleftVertexX = cx + Math.cos(notchAngle) * (r * 0.14);
        const cleftVertexY = cy + Math.sin(notchAngle) * (r * 0.14);

        const traceCompanion = (ox: number, oy: number, radius: number) => {
          cCtx.beginPath();
          const steps = 64;
          const cleftHalf = 0.24;
          // Start slightly inside the cleft so the blade conceals the stem attachment joint at the margin notch cleft
          cCtx.moveTo(
            cleftVertexX + ox,
            cleftVertexY + oy
          );
          for (let k = 0; k <= steps; k++) {
            const t = k / steps;
            const a = notchAngle + cleftHalf + t * (Math.PI * 2 - cleftHalf * 2);
            const lobeWave =
              1.0 +
              0.036 * Math.sin(t * Math.PI * 10 + cIdx * 1.3) +
              0.018 * Math.cos(t * Math.PI * 16 - cIdx * 0.9);
            const tipTaper =
              t < 0.045
                ? 0.88 + 0.12 * (t / 0.045)
                : t > 0.955
                  ? 0.88 + 0.12 * ((1 - t) / 0.045)
                  : 1.0;
            const rad = radius * lobeWave * tipTaper;
            cCtx.lineTo(cx + ox + Math.cos(a) * rad, cy + oy + Math.sin(a) * rad);
          }
          cCtx.closePath();
        };

        // 1. Soft subsurface shadow
        cCtx.save();
        cCtx.filter = `blur(${Math.max(4, Math.round(7 * quantUnit))}px)`;
        traceCompanion(0, 0, r * 1.01);
        cCtx.fillStyle = isLight ? "rgba(18, 12, 6, 0.52)" : "rgba(0, 0, 0, 0.82)";
        cCtx.fill();
        cCtx.filter = "none";
        cCtx.restore();

        // 2. Botanical companion leaf blade fill
        traceCompanion(0, 0, r);
        const cGrad = cCtx.createRadialGradient(
          cleftVertexX,
          cleftVertexY,
          r * 0.04,
          cx,
          cy,
          r * 1.02
        );
        if (style === "sumie") {
          cGrad.addColorStop(0.0, isLight ? "rgba(82, 78, 70, 0.98)" : "rgba(92, 88, 82, 0.98)");
          cGrad.addColorStop(0.6, isLight ? "rgba(46, 42, 37, 0.98)" : "rgba(54, 50, 46, 0.98)");
          cGrad.addColorStop(1.0, isLight ? "rgba(104, 94, 78, 0.98)" : "rgba(76, 70, 62, 0.98)");
        } else if (isLight) {
          cGrad.addColorStop(0.0, "rgba(168, 188, 74, 0.99)");
          cGrad.addColorStop(0.18, "rgba(88, 132, 44, 0.99)");
          cGrad.addColorStop(0.68, "rgba(54, 98, 36, 0.99)");
          cGrad.addColorStop(0.92, "rgba(132, 144, 40, 0.99)");
          cGrad.addColorStop(1.0, "rgba(196, 162, 38, 0.99)");
        } else {
          cGrad.addColorStop(0.0, "rgba(106, 120, 48, 0.99)");
          cGrad.addColorStop(0.18, "rgba(56, 86, 30, 0.99)");
          cGrad.addColorStop(0.68, "rgba(36, 64, 24, 0.99)");
          cGrad.addColorStop(0.92, "rgba(88, 96, 28, 0.99)");
          cGrad.addColorStop(1.0, "rgba(128, 106, 26, 0.99)");
        }
        cCtx.fillStyle = cGrad;
        cCtx.fill();

        // 3. Radiating veins from cleft hub
        cCtx.save();
        traceCompanion(0, 0, r * 0.98);
        cCtx.clip();
        cCtx.strokeStyle =
          style === "sumie"
            ? "rgba(186, 178, 164, 0.28)"
            : "rgba(192, 210, 98, 0.38)";
        cCtx.lineWidth = Math.max(0.45, 0.6 * quantUnit);
        const vCount = 9;
        for (let v = 0; v < vCount; v++) {
          const vt = (v + 0.5) / vCount;
          const va = notchAngle + 0.32 + vt * (Math.PI * 2 - 0.64);
          cCtx.beginPath();
          cCtx.moveTo(cleftVertexX, cleftVertexY);
          cCtx.lineTo(cx + Math.cos(va) * (r * 0.88), cy + Math.sin(va) * (r * 0.88));
          cCtx.stroke();
        }
        cCtx.restore();

        // 4. Warm botanical rim (bold deep sumi black ink border in Sumi-e)
        traceCompanion(0, 0, r);
        cCtx.lineWidth = style === "sumie" ? Math.max(1.45, 1.75 * quantUnit) : Math.max(0.6, 0.85 * quantUnit);
        cCtx.strokeStyle =
          style === "sumie"
            ? "rgba(10, 9, 8, 0.94)"
            : "rgba(168, 142, 36, 0.58)";
        cCtx.stroke();
      }
      this.companionLeafSprites.push(cSprite);
    }
    this.botanicalSpriteCacheMap.set(key, {
      lotus: this.lotusLeafSprites,
      companion: this.companionLeafSprites,
      pinkLotus: this.pinkLotusSprites,
    });
  }

  /**
   * Two-Pass Lotus Pad & Pink Lotus Renderer:
   * - Pass 1: Renders all 9 non-intersecting Lotus Leaves first.
   * - Pass 2: Renders the Blooming Pink Lotus flowers ON TOP of all lotus leaves so no lotus leaf
   *   ever covers or overlaps a pink lotus flower!
   */
  public paintLotusPads(
    ctx: CanvasRenderingContext2D,
    worldW: number,
    worldH: number,
    _time: number,
    isLight: boolean
  ): void {
    const style = this.artStyle;
    const unit = koiClamp(Math.min(worldW, worldH) / 860, 0.48, 1.22);
    const daylight = this.getDaylightFactor();
    const blendDayNight = daylight > 0.002 && daylight < 0.998;

    this.ensureBotanicalSpriteCache(unit, true, style);
    const dayLotus = this.lotusLeafSprites;
    const dayComp = this.companionLeafSprites;
    const dayPink = this.pinkLotusSprites;

    let nightLotus = dayLotus;
    let nightComp = dayComp;
    let nightPink = dayPink;
    if (!isLight || blendDayNight) {
      this.ensureBotanicalSpriteCache(unit, false, style);
      nightLotus = this.lotusLeafSprites;
      nightComp = this.companionLeafSprites;
      nightPink = this.pinkLotusSprites;
    }

    const resolvedPads = this.getResolvedLotusPads(worldW, worldH, unit);
    const companionLeaves = this.getResolvedCompanionLeaves(worldW, worldH, unit, resolvedPads);

    ctx.save();
    // In Sumi-e, draw 3 large cropped corner/edge dark foreground pads matching the reference composition
    if (style === "sumie") {
      const quantUnit = Math.round(unit * 40) / 40;
      const cornerSpecs = [
        { fx: 0.115, fy: 0.055, r: 96, rot: 2.35 },
        { fx: 0.005, fy: 0.195, r: 74, rot: -0.35 },
        { fx: 0.915, fy: 0.945, r: 82, rot: -2.15 },
      ];
      const getCornerSprites = (lightFlag: boolean) => {
        const ck = `${quantUnit}:${lightFlag ? "L" : "D"}:sumie-corner-v1`;
        let arr = this.sumieCornerPadCache.get(ck);
        if (!arr) {
          if (this.sumieCornerPadCache.size >= 4) this.sumieCornerPadCache.clear();
          arr = cornerSpecs.map((cs, idx) =>
            bakeSumieForegroundPadSprite(cs.r * quantUnit, 301 + idx * 19, lightFlag, false)
          );
          this.sumieCornerPadCache.set(ck, arr);
        }
        return arr;
      };
      const dayCorners = getCornerSprites(true);
      const nightCorners = (!isLight || blendDayNight) ? getCornerSprites(false) : dayCorners;
      for (let k = 0; k < cornerSpecs.length; k++) {
        const cs = cornerSpecs[k];
        const cx = worldW * cs.fx;
        const cy = worldH * cs.fy;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(cs.rot);
        if (blendDayNight) {
          ctx.drawImage(dayCorners[k], -dayCorners[k].width * 0.5, -dayCorners[k].height * 0.5);
          ctx.globalAlpha = 1.0 - daylight;
          ctx.drawImage(nightCorners[k], -nightCorners[k].width * 0.5, -nightCorners[k].height * 0.5);
        } else {
          const spr = daylight >= 0.5 ? dayCorners[k] : nightCorners[k];
          ctx.drawImage(spr, -spr.width * 0.5, -spr.height * 0.5);
        }
        ctx.restore();
      }
    }

    // PASS 4A: Draw all 18 Companion Leaf blades over their stem tips (concealing margin notch cleft joints)
    for (let cIdx = 0; cIdx < companionLeaves.length; cIdx++) {
      const comp = companionLeaves[cIdx];
      const st = this.lotusPadStates[comp.parentIdx];
      const cst = this.companionLeafStates[cIdx];
      const cPhase = st.leafPhase * 1.08 + cIdx * 0.85;
      const ampBoost = 1.0 + st.excite * 0.22;
      const swayX = Math.sin(cPhase) * 2.5 * unit * ampBoost + st.swayX * 0.90 + (cst ? cst.dispX : 0);
      const swayY = Math.cos(cPhase * 0.86 + cIdx) * 2.0 * unit * ampBoost + st.swayY * 0.90 + (cst ? cst.dispY : 0);
      const cx = comp.x + swayX;
      const cy = comp.y + swayY;
      const notchAngle =
        comp.notch +
        Math.sin(cPhase * 0.62) * (0.025 + st.excite * 0.015) +
        st.rotOffset * 0.92;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(notchAngle);
      if (blendDayNight) {
        const dSpr = dayComp[cIdx];
        const nSpr = nightComp[cIdx];
        if (dSpr) ctx.drawImage(dSpr, -dSpr.width * 0.5, -dSpr.height * 0.5);
        if (nSpr) {
          ctx.globalAlpha = 1.0 - daylight;
          ctx.drawImage(nSpr, -nSpr.width * 0.5, -nSpr.height * 0.5);
        }
      } else {
        const cSprite = (daylight >= 0.5 ? dayComp : nightComp)[cIdx];
        if (cSprite) {
          ctx.drawImage(cSprite, -cSprite.width * 0.5, -cSprite.height * 0.5);
        }
      }
      ctx.restore();
    }

    // PASS 4B: Draw all 9 Large Lotus Leaf blades over their stem tips (concealing central navel hub joints)
    for (let i = 0; i < resolvedPads.length; i++) {
      const pad = resolvedPads[i];
      const st = this.lotusPadStates[i];
      const ampBoost = 1.0 + st.excite * 0.22;
      const swayX = Math.sin(st.leafPhase) * 3.0 * unit * ampBoost + st.swayX + st.dispX;
      const swayY = Math.cos(st.leafPhase * 0.84 + i) * 2.4 * unit * ampBoost + st.swayY + st.dispY;
      const cx = pad.x + swayX;
      const cy = pad.y + swayY;
      const notchAngle =
        pad.notch +
        Math.sin(st.leafPhase * 0.58) * (0.025 + st.excite * 0.015) +
        st.rotOffset;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(notchAngle);
      if (blendDayNight) {
        const dSpr = dayLotus[i];
        const nSpr = nightLotus[i];
        if (dSpr) ctx.drawImage(dSpr, -dSpr.width * 0.5, -dSpr.height * 0.5);
        if (nSpr) {
          ctx.globalAlpha = 1.0 - daylight;
          ctx.drawImage(nSpr, -nSpr.width * 0.5, -nSpr.height * 0.5);
        }
      } else {
        const sprite = (daylight >= 0.5 ? dayLotus : nightLotus)[i];
        if (sprite) {
          ctx.drawImage(sprite, -sprite.width * 0.5, -sprite.height * 0.5);
        }
      }
      ctx.restore();
    }

    // PASS 2: Draw all Blooming Pink Lotuses ON TOP of all lotus leaves
    let flowerIdx = 0;
    for (let i = 0; i < resolvedPads.length; i++) {
      const pad = resolvedPads[i];
      if (!pad.hasLotus) continue;
      const st = this.lotusPadStates[i];
      const lagAmp = 1.0 + st.excite * 0.24;
      const flSwayX = Math.sin(st.flowerPhase) * 3.8 * unit * lagAmp + st.swayX * 1.18 + st.dispX;
      const flSwayY = Math.cos(st.flowerPhase * 0.84 + i) * 3.1 * unit * lagAmp + st.swayY * 1.18 + st.dispY;
      const baseNotch =
        pad.notch +
        Math.sin(st.flowerPhase * 0.58) * (0.025 + st.excite * 0.015) +
        st.rotOffset * 1.12;
      const flX = pad.x + flSwayX + Math.cos(baseNotch + 0.35) * (pad.r * 0.78);
      const flY = pad.y + flSwayY + Math.sin(baseNotch + 0.35) * (pad.r * 0.78);

      const curFlowerIdx = flowerIdx++;
      if (blendDayNight) {
        const dFl = dayPink[curFlowerIdx];
        const nFl = nightPink[curFlowerIdx];
        if (dFl) ctx.drawImage(dFl, flX - dFl.width * 0.5, flY - dFl.height * 0.5);
        if (nFl) {
          ctx.save();
          ctx.globalAlpha = 1.0 - daylight;
          ctx.drawImage(nFl, flX - nFl.width * 0.5, flY - nFl.height * 0.5);
          ctx.restore();
        }
      } else {
        const flSprite = (daylight >= 0.5 ? dayPink : nightPink)[curFlowerIdx];
        if (flSprite) {
          ctx.drawImage(flSprite, flX - flSprite.width * 0.5, flY - flSprite.height * 0.5);
        }
      }
    }
    ctx.restore();
  }

  /**
   * Paints a multi-layered top-down Blooming Pink Sacred Lotus (*Nelumbo nucifera*),
   * complete with soft cast shadow, 3 imbricated rings of cupped rose-pink & blush-tipped petals,
   * glowing golden stamen filaments, and a central chartreuse-gold seed receptacle.
   */
  private paintBloomingPinkLotus(
    ctx: CanvasRenderingContext2D,
    fx: number,
    fy: number,
    radius: number,
    rotBase: number,
    isLight: boolean,
    style: KoiArtStyle
  ): void {
    if ((style as KoiArtStyle) === "sumie") {
      paintSumieWaterLily(ctx, fx, fy, radius, rotBase, isLight);
      return;
    }
    ctx.save();
    ctx.translate(fx, fy);

    // 1. Darker, noticeable continuous radial drop shadow onto the lotus pad and water below
    const shGrad = ctx.createRadialGradient(5.5, 7.5, radius * 0.14, 6.5, 9.0, radius * 1.30);
    shGrad.addColorStop(0.0, isLight ? "rgba(18, 11, 5, 0.64)" : "rgba(0, 0, 0, 0.88)");
    shGrad.addColorStop(0.58, isLight ? "rgba(22, 14, 7, 0.38)" : "rgba(0, 0, 0, 0.54)");
    shGrad.addColorStop(0.85, isLight ? "rgba(22, 14, 7, 0.14)" : "rgba(0, 0, 0, 0.22)");
    shGrad.addColorStop(1.0, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = shGrad;
    ctx.beginPath();
    ctx.arc(6.5, 9.0, radius * 1.30, 0, Math.PI * 2);
    ctx.fill();

    // Helper to draw a single cupped lotus petal along +X
    const drawPetalRing = (
      count: number,
      angleOffset: number,
      pLen: number,
      pWidth: number,
      tier: number
    ) => {
      for (let p = 0; p < count; p++) {
        const a = rotBase + angleOffset + (p / count) * Math.PI * 2;
        ctx.save();
        ctx.rotate(a);

        // Subtle petal shadow on underlying layer
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.bezierCurveTo(pLen * 0.32, -pWidth * 0.95, pLen * 0.76, -pWidth * 0.72, pLen, 0);
        ctx.bezierCurveTo(pLen * 0.76, pWidth * 0.72, pLen * 0.32, pWidth * 0.95, 0, 0);
        ctx.closePath();

        const pGrad = ctx.createLinearGradient(0, 0, pLen, 0);
        if (style === "sumie") {
          pGrad.addColorStop(0.0, isLight ? "rgba(218, 208, 194, 0.96)" : "rgba(118, 120, 126, 0.95)");
          pGrad.addColorStop(0.68, isLight ? "rgba(244, 236, 224, 0.98)" : "rgba(166, 168, 174, 0.96)");
          pGrad.addColorStop(1.0, isLight ? "rgba(196, 62, 48, 0.92)" : "rgba(138, 66, 64, 0.88)");
        } else if (!isLight) {
          if (tier === 0) {
            pGrad.addColorStop(0.0, "rgba(112, 66, 102, 0.96)");
            pGrad.addColorStop(0.55, "rgba(148, 108, 146, 0.98)");
            pGrad.addColorStop(0.88, "rgba(182, 164, 196, 0.98)");
            pGrad.addColorStop(1.0, "rgba(138, 90, 128, 0.98)");
          } else if (tier === 1) {
            pGrad.addColorStop(0.0, "rgba(118, 58, 96, 0.98)");
            pGrad.addColorStop(0.52, "rgba(154, 102, 142, 0.99)");
            pGrad.addColorStop(0.86, "rgba(192, 174, 206, 0.99)");
            pGrad.addColorStop(1.0, "rgba(134, 78, 118, 0.99)");
          } else {
            pGrad.addColorStop(0.0, "rgba(136, 84, 96, 0.98)");
            pGrad.addColorStop(0.48, "rgba(156, 98, 138, 0.99)");
            pGrad.addColorStop(0.88, "rgba(198, 182, 212, 0.99)");
            pGrad.addColorStop(1.0, "rgba(132, 72, 114, 0.99)");
          }
        } else if (tier === 0) {
          pGrad.addColorStop(0.0, "rgba(208, 86, 122, 0.96)");
          pGrad.addColorStop(0.55, "rgba(242, 158, 184, 0.98)");
          pGrad.addColorStop(0.88, "rgba(252, 214, 226, 0.98)");
          pGrad.addColorStop(1.0, "rgba(232, 112, 148, 0.98)");
        } else if (tier === 1) {
          pGrad.addColorStop(0.0, "rgba(216, 72, 114, 0.98)");
          pGrad.addColorStop(0.52, "rgba(246, 138, 172, 0.99)");
          pGrad.addColorStop(0.86, "rgba(254, 222, 234, 0.99)");
          pGrad.addColorStop(1.0, "rgba(224, 88, 132, 0.99)");
        } else {
          pGrad.addColorStop(0.0, "rgba(236, 126, 98, 0.98)");
          pGrad.addColorStop(0.48, "rgba(244, 124, 162, 0.99)");
          pGrad.addColorStop(0.88, "rgba(255, 228, 238, 0.99)");
          pGrad.addColorStop(1.0, "rgba(218, 76, 122, 0.99)");
        }
        ctx.fillStyle = pGrad;
        ctx.fill();

        // Crisp Sumi-e deep black ink petal outline; delicate rose outline in Mokkotsu
        ctx.lineWidth = style === "sumie" ? 1.35 : 0.65;
        ctx.strokeStyle =
          style === "sumie"
            ? "rgba(10, 9, 8, 0.92)"
            : "rgba(182, 58, 94, 0.36)";
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(pLen * 0.18, 0);
        ctx.lineTo(pLen * 0.88, 0);
        ctx.lineWidth = 0.5;
        ctx.strokeStyle =
          style === "sumie"
            ? "rgba(164, 52, 38, 0.25)"
            : "rgba(255, 245, 248, 0.48)";
        ctx.stroke();

        ctx.restore();
      }
    };

    // Outer 10 petals, interleaved middle 10 petals, and inner 8 crown petals
    drawPetalRing(10, 0.0, radius * 1.0, radius * 0.34, 0);
    drawPetalRing(10, Math.PI / 10, radius * 0.84, radius * 0.31, 1);
    drawPetalRing(8, Math.PI / 8, radius * 0.64, radius * 0.27, 2);

    // 2. Glowing Golden Stamen Corona & Central Lotus Seed Receptacle (*Karyu*)
    const coreR = radius * 0.34;
    const glowGrad = ctx.createRadialGradient(0, 0, coreR * 0.1, 0, 0, coreR * 1.35);
    if (style === "sumie") {
      glowGrad.addColorStop(0.0, "rgba(212, 72, 44, 0.92)");
      glowGrad.addColorStop(0.65, "rgba(168, 52, 34, 0.65)");
      glowGrad.addColorStop(1.0, "rgba(168, 52, 34, 0)");
    } else {
      glowGrad.addColorStop(0.0, "rgba(255, 214, 68, 0.96)");
      glowGrad.addColorStop(0.58, "rgba(242, 148, 28, 0.82)");
      glowGrad.addColorStop(1.0, "rgba(242, 148, 28, 0)");
    }
    ctx.fillStyle = glowGrad;
    ctx.beginPath();
    ctx.arc(0, 0, coreR * 1.35, 0, Math.PI * 2);
    ctx.fill();

    // Radiating golden stamen filaments & anther tips
    const stamenCount = 16;
    ctx.lineCap = "round";
    for (let s = 0; s < stamenCount; s++) {
      const sa = rotBase * 0.5 + (s / stamenCount) * Math.PI * 2;
      const sLen = coreR * (0.95 + (s % 2) * 0.18);
      const sx = Math.cos(sa) * sLen;
      const sy = Math.sin(sa) * sLen;

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(sx, sy);
      ctx.lineWidth = 0.85;
      ctx.strokeStyle = style === "sumie" ? "rgba(228, 184, 128, 0.85)" : "rgba(245, 158, 18, 0.92)";
      ctx.stroke();

      ctx.fillStyle = style === "sumie" ? "rgba(246, 224, 186, 0.95)" : "rgba(255, 240, 122, 0.98)";
      ctx.beginPath();
      ctx.arc(sx, sy, 1.35, 0, Math.PI * 2);
      ctx.fill();
    }

    // Central golden-chartreuse lotus receptacle pod
    const podR = coreR * 0.48;
    const podGrad = ctx.createRadialGradient(-podR * 0.25, -podR * 0.25, 0.5, 0, 0, podR);
    if (style === "sumie") {
      podGrad.addColorStop(0.0, "rgba(224, 176, 112, 0.96)");
      podGrad.addColorStop(1.0, "rgba(148, 86, 44, 0.96)");
    } else {
      podGrad.addColorStop(0.0, "rgba(244, 222, 88, 0.98)");
      podGrad.addColorStop(1.0, "rgba(188, 154, 38, 0.98)");
    }
    ctx.fillStyle = podGrad;
    ctx.beginPath();
    ctx.arc(0, 0, podR, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /**
   * Paints expanding water ripples adapted to the active artistic style.
   */
  /**
   * Paints each interactive click's single expanding water ripple ring across the pond surface.
   */
  private paintHandBrushedRipples(
    ctx: CanvasRenderingContext2D,
    _world: PondWorld,
    isLight: boolean
  ): void {
    if (this.clickRipples.length === 0) return;

    const style = this.artStyle;
    ctx.save();
    for (let i = 0; i < this.clickRipples.length; i++) {
      const r = this.clickRipples[i];
      const progress = koiClamp(r.radius / Math.max(1, r.maxRadius), 0, 1);
      const fade = Math.pow(1 - progress, 1.35);
      const alpha = koiClamp(r.strength * fade * 0.68, 0, 0.72);
      if (alpha <= 0.008 || r.radius <= 2) continue;

      // 1. Subtle refractive shadow trough just inside the single expanding wave crest
      ctx.beginPath();
      ctx.arc(r.x, r.y, Math.max(1, r.radius - 2.2), 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.2, 4.2 * (1 - progress * 0.55));
      ctx.strokeStyle = isLight
        ? `rgba(28, 38, 32, ${(alpha * 0.28).toFixed(3)})`
        : `rgba(0, 0, 0, ${(alpha * 0.45).toFixed(3)})`;
      ctx.stroke();

      // 2. Single luminous water-surface wave crest ring
      const crestRgb: [number, number, number] =
        style === "sumie"
          ? isLight
            ? [42, 38, 34]
            : [232, 224, 210]
          : isLight
            ? [255, 250, 236]
            : [242, 222, 182];

      ctx.beginPath();
      ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.0, 2.4 * (1 - progress * 0.45));
      ctx.strokeStyle = rgbToRgba(crestRgb, alpha);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Paints a serene school of at most `MAX_RENDERED_MINNOWS = 16` graceful spindle-shaped
   * medaka silhouettes adapted to the active artistic style.
   */
  private paintBrushMinnows(
    _ctx: CanvasRenderingContext2D,
    _minnows: PondFish[],
    _isLight: boolean
  ): void {
    // Tiny background fishes/organisms removed per user request
  }

  /**
   * Paints a single Koi in the active artistic style (`mokkotsu`, `sumie`, or `ukiyoe`).
   */
  /**
   * Computes a smooth vertical swimming depth `z in [0.05, 0.92]` for each Koi (`0` = surface, `1` = deep):
   * - Stratified base depth per fish (`0.14`, `0.48`, `0.82`) + gentle slow diving/ascending wave
   * - Drives perspective scale, blue water-column tinting, and floor shadow separation distance.
   */
  private getKoiDepthFactor(fishIndex: number, time: number): number {
    const baseTiers = [0.14, 0.52, 0.82, 0.32, 0.68];
    const base = baseTiers[fishIndex % baseTiers.length];
    const wave = Math.sin(time * 0.26 + fishIndex * 2.15) * 0.12;
    return koiClamp(base + wave, 0.06, 0.92);
  }

  /**
   * Computes the opaque RGB luminance multiplier [0.36..1.0] for a Koi fish so that:
   * - In daytime (`daylight = 1`), Koi have full vibrant luminance (`1.0`).
   * - During dusk and in Dark Mode (`!isLight`), unlit Koi outside the flashlight beam
   *   are toned down to `~0.38` (matching the ambient darkness of the pond without any transparency).
   * - When the flashlight is enabled in Dark Mode and sweeps over a Koi, that Koi smoothly
   *   brightens up to `~0.84` inside the warm lantern beam.
   */
  private computeKoiExposure(fish: KoiFish, _isLight: boolean): number {
    const daylight = this.getDaylightFactor();
    if (daylight >= 0.995) {
      return 1.0;
    }
    const midNode = fish.spine[Math.min(8, fish.spine.length - 1)] ?? fish.spine[0];
    // Blend koi naturally into the night water when dark, brightening smoothly inside the flashlight beam
    const baseNightLuma = 0.24;
    const beamNightLuma = 0.46;
    const easeDisp = koiSmoothstep(0, 1, this.flashlightDispersal);
    let nightLuma = beamNightLuma;
    if (easeDisp < 0.99 && this.flashX >= 0 && this.flashY >= 0) {
      const baseR = this.getFlashlightBaseRadius(this.activeRect.w || 1440, this.activeRect.h || 900);
      const dist = Math.hypot(midNode.x - this.flashX, midNode.y - this.flashY);
      const normDist = koiClamp(dist / (baseR * 0.92), 0, 1);
      const spotFactor = Math.pow(1.0 - normDist, 1.55);
      const spotlightLuma = baseNightLuma + (beamNightLuma - baseNightLuma) * spotFactor;
      nightLuma = koiLerp(spotlightLuma, beamNightLuma, easeDisp);
    }
    if (daylight <= 0.005) {
      return nightLuma;
    }
    return koiLerp(nightLuma, 1.0, Math.pow(daylight, 0.78));
  }

  /**
   * Blends a koi pigment RGB smoothly with the dark night-water ambient tone
   * based on `koiExposure` so fish settle naturally into the night pond.
   */
  private applyNightWaterBlend(
    rgb: [number, number, number],
    koiExposure: number
  ): [number, number, number] {
    const nightWaterTint: [number, number, number] = [20, 24, 21];
    const lit = darkenRgb(rgb, koiClamp(koiExposure, 0.22, 1.0));
    const nightAmt = koiClamp((1.0 - koiExposure) * 0.55, 0, 0.55);
    return mixRgb(lit, nightWaterTint, nightAmt);
  }

  private sampleSpineFrame(
    fish: KoiFish,
    s: number
  ): { x: number; y: number; tx: number; ty: number; nx: number; ny: number } {
    const spine = fish.spine;
    const n = spine.length;
    const maxS = spine[n - 1]?.s || 0.83;
    const clamped = koiClamp(s, 0, maxS);
    const fIdx = (clamped / Math.max(0.001, maxS)) * (n - 1);
    const i0 = Math.min(n - 2, Math.max(0, Math.floor(fIdx)));
    const i1 = i0 + 1;
    const t = koiClamp(fIdx - i0, 0, 1);
    const a = spine[i0];
    const b = spine[i1];
    const txRaw = a.tx + (b.tx - a.tx) * t;
    const tyRaw = a.ty + (b.ty - a.ty) * t;
    const tLen = Math.hypot(txRaw, tyRaw) || 1;
    const tx = txRaw / tLen;
    const ty = tyRaw / tLen;
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      tx,
      ty,
      nx: -ty,
      ny: tx,
    };
  }

  /**
   * Continuous, fluid calligraphic Sumi-e brush ribbon helper.
   * Sweeps ONE unbroken, boldly pressure-modulated ink ribbon (0.45x to 1.85x) tapering smoothly
   * to sharp hairline ends — eliminating pinched sausage segments while preserving authentic sumi brushwork.
   */
  private strokeCalligraphicPolyline(
    ctx: CanvasRenderingContext2D,
    pts: Array<{ x: number; y: number }>,
    baseWidth: number,
    rgb: [number, number, number],
    alpha: number,
    seed: number,
    closed = false
  ): void {
    const count = pts.length;
    if (count < 3) return;

    const sub: Array<{ x: number; y: number }> = [];
    const lim = closed ? count : count - 1;
    for (let i = 0; i < lim; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % count];
      sub.push(a);
      sub.push({ x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 });
    }
    if (!closed) sub.push(pts[count - 1]);

    const m = sub.length;
    const leftSide: Array<{ x: number; y: number }> = [];
    const rightSide: Array<{ x: number; y: number }> = [];

    for (let i = 0; i < m; i++) {
      const prev = sub[closed ? (i - 1 + m) % m : Math.max(0, i - 1)];
      const cur = sub[i];
      const nxt = sub[closed ? (i + 1) % m : Math.min(m - 1, i + 1)];
      const dx1 = cur.x - prev.x;
      const dy1 = cur.y - prev.y;
      const dx2 = nxt.x - cur.x;
      const dy2 = nxt.y - cur.y;
      const l1 = Math.hypot(dx1, dy1) || 1;
      const l2 = Math.hypot(dx2, dy2) || 1;
      const tx = (dx1 / l1 + dx2 / l2) * 0.5;
      const ty = (dy1 / l1 + dy2 / l2) * 0.5;
      const tLen = Math.hypot(tx, ty) || 1;
      const nx = -ty / tLen;
      const ny = tx / tLen;

      const dot = koiClamp((dx1 * dx2 + dy1 * dy2) / (l1 * l2), -1, 1);
      const bend = Math.sqrt(Math.max(0, 1 - dot));
      const tGlob = i / Math.max(1, m - 1);
      const endEnv = closed ? 1.0 : Math.pow(Math.sin(Math.max(0.02, Math.min(0.98, tGlob)) * Math.PI), 0.45);
      const breath = 0.62 + 0.58 * (0.5 + 0.5 * Math.sin(tGlob * Math.PI * 3.4 + seed * 0.8));
      const pressure = Math.min(1.95, breath + bend * 2.6);
      const halfW = Math.max(0.45, baseWidth * 0.52 * pressure * (0.28 + 0.72 * endEnv));

      leftSide.push({ x: cur.x + nx * halfW, y: cur.y + ny * halfW });
      rightSide.push({ x: cur.x - nx * halfW, y: cur.y - ny * halfW });
    }

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(leftSide[0].x, leftSide[0].y);
    for (let i = 1; i < leftSide.length; i++) ctx.lineTo(leftSide[i].x, leftSide[i].y);
    if (closed) {
      ctx.closePath();
      ctx.moveTo(rightSide[rightSide.length - 1].x, rightSide[rightSide.length - 1].y);
      for (let i = rightSide.length - 2; i >= 0; i--) ctx.lineTo(rightSide[i].x, rightSide[i].y);
      ctx.closePath();
      ctx.fillStyle = rgbToRgba(rgb, alpha);
      ctx.fill("evenodd");
    } else {
      for (let i = rightSide.length - 1; i >= 0; i--) ctx.lineTo(rightSide[i].x, rightSide[i].y);
      ctx.closePath();
      ctx.fillStyle = rgbToRgba(rgb, alpha);
      ctx.fill();
    }
    ctx.restore();
  }

  private paintLivingKoi(
    ctx: CanvasRenderingContext2D,
    fish: KoiFish,
    isLight: boolean,
    showScales: boolean,
    _zDepth = 0.25
  ): void {
    const style = this.artStyle;
    const isSumie = style === "sumie";
    const spine = fish.spine;
    const n = spine.length;
    if (n < 10) return;

    for (let i = 0; i < n; i++) {
      const node = spine[i];
      const sEff = Math.max(0.012, node.s);
      const hw = koiBodyHalfWidth(sEff, fish.maxHalfWidth);
      this.leftX[i] = node.x - node.nx * hw;
      this.leftY[i] = node.y - node.ny * hw;
      this.rightX[i] = node.x + node.nx * hw;
      this.rightY[i] = node.y + node.ny * hw;
    }

    const head = spine[0];
    const n1 = spine[1];
    const hw1 = koiBodyHalfWidth(n1.s, fish.maxHalfWidth);
    // Protruding smooth rounded anterior nose lip dome (zero flat corners, fuller ovoid nose!)
    const domeRy = hw1 * 0.92;
    const snoutTipX = n1.x + head.tx * domeRy;
    const snoutTipY = n1.y + head.ty * domeRy;

    const tail = spine[n - 1];
    const tailHw = koiBodyHalfWidth(tail.s, fish.maxHalfWidth);
    const tailSway = Math.sin(fish.phase - 1.9) * fish.maxHalfWidth * 0.22;
    const peduncleTipX =
      tail.x - tail.tx * (tailHw * 0.28) + tail.nx * (tailSway * 0.12);
    const peduncleTipY =
      tail.y - tail.ty * (tailHw * 0.28) + tail.ny * (tailSway * 0.12);

    const buildRightFlankPts = (scaleWidth = 1.0): Array<{ x: number; y: number }> => {
      const pts: Array<{ x: number; y: number }> = [];
      for (let d = 0; d <= 5; d++) {
        const a = Math.PI * 0.5 * (1 - d / 5);
        const lx = Math.cos(a) * hw1 * scaleWidth;
        const fy = Math.sin(a) * domeRy;
        pts.push({
          x: n1.x + head.nx * lx + head.tx * fy,
          y: n1.y + head.ny * lx + head.ty * fy,
        });
      }
      for (let i = 2; i < n; i++) {
        const hw = koiBodyHalfWidth(Math.max(0.012, spine[i].s), fish.maxHalfWidth) * scaleWidth;
        pts.push({ x: spine[i].x + spine[i].nx * hw, y: spine[i].y + spine[i].ny * hw });
      }
      return pts;
    };

    const buildLeftFlankPts = (scaleWidth = 1.0): Array<{ x: number; y: number }> => {
      const pts: Array<{ x: number; y: number }> = [];
      for (let d = 0; d <= 5; d++) {
        const a = Math.PI * 0.5 * (1 - d / 5);
        const lx = Math.cos(a) * hw1 * scaleWidth;
        const fy = Math.sin(a) * domeRy;
        pts.push({
          x: n1.x - head.nx * lx + head.tx * fy,
          y: n1.y - head.ny * lx + head.ty * fy,
        });
      }
      for (let i = 2; i < n; i++) {
        const hw = koiBodyHalfWidth(Math.max(0.012, spine[i].s), fish.maxHalfWidth) * scaleWidth;
        pts.push({ x: spine[i].x - spine[i].nx * hw, y: spine[i].y - spine[i].ny * hw });
      }
      return pts;
    };

    const buildContourPts = (scaleWidth = 1.0): Array<{ x: number; y: number }> => {
      const rPts = buildRightFlankPts(scaleWidth);
      const lPts = buildLeftFlankPts(scaleWidth);
      const pts: Array<{ x: number; y: number }> = [...rPts, { x: peduncleTipX, y: peduncleTipY }];
      for (let i = lPts.length - 1; i >= 1; i--) pts.push(lPts[i]);
      return pts;
    };

    const traceBodyContour = (offsetX = 0, offsetY = 0, scaleWidth = 1.0) => {
      const pts = buildContourPts(scaleWidth);
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const cur = pts[i];
        const nxt = pts[(i + 1) % pts.length];
        const mx = (cur.x + nxt.x) * 0.5 + offsetX;
        const my = (cur.y + nxt.y) * 0.5 + offsetY;
        if (i === 0) {
          const prev = pts[pts.length - 1];
          ctx.moveTo((prev.x + cur.x) * 0.5 + offsetX, (prev.y + cur.y) * 0.5 + offsetY);
        }
        ctx.quadraticCurveTo(cur.x + offsetX, cur.y + offsetY, mx, my);
      }
      ctx.closePath();
    };

    const koiDaylight = this.getDaylightFactor();
    const koiNightFrac = 1.0 - koiDaylight;
    const exposure = this.computeKoiExposure(fish, isLight);
    const nightDepth = koiNightFrac * koiClamp(1 - (exposure - 0.55) / 0.8, 0.15, 1.0);
    const nightWaterTint: [number, number, number] = isSumie ? [22, 21, 19] : [14, 30, 48];
    const blendNight = (rgb: [number, number, number], strength = 0.34): [number, number, number] => {
      if (nightDepth <= 0.001) return rgb;
      const k = nightDepth * strength;
      return [
        Math.round(rgb[0] * (1 - k) + nightWaterTint[0] * k),
        Math.round(rgb[1] * (1 - k) + nightWaterTint[1] * k),
        Math.round(rgb[2] * (1 - k) + nightWaterTint[2] * k),
      ];
    };

    const shiroBase: [number, number, number] = isSumie ? [232, 224, 208] : [248, 238, 220];
    const hiBase: [number, number, number] = isSumie ? [44, 41, 37] : [244, 66, 8];
    const sumiBase: [number, number, number] = isSumie ? [18, 17, 15] : [14, 14, 16];

    const shiroPigment = blendNight(darkenRgb(shiroBase, koiLerp(isSumie ? 0.86 : 0.90, 1.0, koiDaylight)), isSumie ? 0.16 : 0.32);
    const hiPigment = blendNight(darkenRgb(hiBase, koiLerp(0.92, 1.0, koiDaylight)), isSumie ? 0.12 : 0.24);
    const sumiPigment = blendNight(sumiBase, isSumie ? 0.10 : 0.18);
    const dayOutlineRgb: [number, number, number] = isSumie ? [24, 22, 20] : [30, 20, 14];
    const outlineRgb: [number, number, number] = isSumie
      ? mixRgb([196, 188, 174], dayOutlineRgb, koiDaylight)
      : mixRgb([5, 10, 16], dayOutlineRgb, koiDaylight);
    const outlineWidth = Math.max(1.2, fish.maxHalfWidth * (isSumie ? 0.024 : 0.020));

    ctx.save();
    // Koi body stays 100% opaque across both Day and Night

    // 1. Paired fins, caudal tail, and fleshy mustache-curved barbels BEHIND body
    this.paintKoiPairedFins(ctx, fish, isLight, outlineRgb, nightDepth);
    this.paintKoiCaudalFin(ctx, fish, isLight, shiroPigment, exposure);
    this.paintKoiBarbels(ctx, fish, isLight, isSumie, shiroPigment, outlineRgb, nightDepth);

    // 2. Body silhouette clipped interior
    ctx.save();
    traceBodyContour(0, 0, 1.0);
    ctx.clip();

    const bodyGrad = ctx.createLinearGradient(snoutTipX, snoutTipY, peduncleTipX, peduncleTipY);
    bodyGrad.addColorStop(0.0, rgbToRgba(darkenRgb(shiroPigment, 1.02), 1.0));
    bodyGrad.addColorStop(0.30, rgbToRgba(shiroPigment, 1.0));
    bodyGrad.addColorStop(0.82, rgbToRgba(darkenRgb(shiroPigment, 0.92), 1.0));
    bodyGrad.addColorStop(1.0, rgbToRgba(darkenRgb(shiroPigment, 0.87), 1.0));
    ctx.fillStyle = bodyGrad;
    ctx.fillRect(
      fish.bbox.minX - 28,
      fish.bbox.minY - 28,
      fish.bbox.maxX - fish.bbox.minX + 56,
      fish.bbox.maxY - fish.bbox.minY + 56
    );

    // 2A. Scaleless Cranial Shield (sCenter < 0.24): black Sumi mark on black-and-white Shiro Utsuri (id % 4 === 2)
    const koiDesignId = ((fish.id % 4) + 4) % 4;
    const headShieldPigment = koiDesignId === 2 ? sumiPigment : hiPigment;
    for (let pIdx = 0; pIdx < fish.patches.length; pIdx++) {
      const patch = fish.patches[pIdx];
      if (patch.sCenter >= 0.24) continue;
      this.paintSpineOrganicPatch(ctx, fish, patch, headShieldPigment, isLight, isSumie, true);
    }

    // 2B. Curved posterior collar clip behind opercula
    ctx.save();
    const gCenter = this.sampleSpineFrame(fish, 0.268);
    const gSide = this.sampleSpineFrame(fish, 0.296);
    const gHw = koiBodyHalfWidth(0.296, fish.maxHalfWidth) * 1.45;
    ctx.beginPath();
    ctx.moveTo(gSide.x - gSide.nx * gHw, gSide.y - gSide.ny * gHw);
    ctx.quadraticCurveTo(
      gCenter.x + gCenter.tx * (fish.maxHalfWidth * 0.18),
      gCenter.y + gCenter.ty * (fish.maxHalfWidth * 0.18),
      gSide.x + gSide.nx * gHw,
      gSide.y + gSide.ny * gHw
    );
    ctx.lineTo(tail.x + tail.nx * gHw * 1.4 - tail.tx * fish.maxHalfWidth * 1.2, tail.y + tail.ny * gHw * 1.4 - tail.ty * fish.maxHalfWidth * 1.2);
    ctx.lineTo(tail.x - tail.nx * gHw * 1.4 - tail.tx * fish.maxHalfWidth * 1.2, tail.y - tail.ny * gHw * 1.4 - tail.ty * fish.maxHalfWidth * 1.2);
    ctx.closePath();
    ctx.clip();

    if (isSumie) {
      for (const targetLayer of ["hi", "sumi"] as const) {
        for (let pIdx = 0; pIdx < fish.patches.length; pIdx++) {
          const patch = fish.patches[pIdx];
          if (patch.sCenter < 0.24 || patch.layer !== targetLayer) continue;
          const col = koiDesignId === 2 ? sumiPigment : (targetLayer === "sumi" ? sumiPigment : hiPigment);
          this.paintSpineOrganicPatch(ctx, fish, patch, col, isLight, true, false);
        }
      }
    }

    // 2C. Uroko scales
    if (showScales) {
      this.paintCalligraphicScales(
        ctx,
        fish,
        isLight,
        isSumie,
        shiroPigment,
        hiPigment,
        sumiPigment,
        outlineRgb
      );
    }
    ctx.restore();

    // 2D. Warm Nihonga golden-taupe 3D cylindrical flank shading in S1; smoky charcoal edge in S2
    for (const side of [-1, 1] as const) {
      ctx.beginPath();
      for (let i = 2; i < n; i++) {
        const hw = koiBodyHalfWidth(Math.max(0.012, spine[i].s), fish.maxHalfWidth);
        const px = spine[i].x + spine[i].nx * side * hw * 0.99;
        const py = spine[i].y + spine[i].ny * side * hw * 0.99;
        if (i === 2) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      const flankDayRgb: [number, number, number] = isSumie ? [28, 22, 18] : [148, 114, 78];
      const flankRgb = mixRgb([4, 10, 18], flankDayRgb, koiDaylight);
      const flankAlpha = koiLerp(0.40, isSumie ? 0.24 : 0.34, koiDaylight);
      ctx.strokeStyle = rgbToRgba(flankRgb, flankAlpha);
      ctx.lineWidth = Math.max(2.4, fish.maxHalfWidth * 0.18);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
    }

    // Soft feathered moonlit dorsal wrap fading in continuously during twilight/night
    if (!isSumie && koiNightFrac > 0.01) {
      const sheenBands: Array<[number, number]> = [
        [0.85, 0.032],
        [0.62, 0.036],
        [0.40, 0.036],
        [0.22, 0.030],
      ];
      for (const [wFrac, aVal] of sheenBands) {
        ctx.beginPath();
        for (let i = 4; i < n - 2; i++) {
          const p = spine[i];
          if (i === 4) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.strokeStyle = `rgba(180, 222, 252, ${(aVal * koiNightFrac).toFixed(4)})`;
        ctx.lineWidth = Math.max(4, fish.maxHalfWidth * wFrac);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();
      }
    }

    // Subtle snout lip highlight (continuous daylight blend)
    ctx.beginPath();
    ctx.moveTo(n1.x - head.nx * (hw1 * 0.70) + head.tx * (domeRy * 0.34), n1.y - head.ny * (hw1 * 0.70) + head.ty * (domeRy * 0.34));
    ctx.quadraticCurveTo(snoutTipX, snoutTipY, n1.x + head.nx * (hw1 * 0.70) + head.tx * (domeRy * 0.34), n1.y + head.ny * (hw1 * 0.70) + head.ty * (domeRy * 0.34));
    const lipRgb = mixRgb([165, 212, 248], [155, 126, 94], koiDaylight);
    ctx.strokeStyle = rgbToRgba(lipRgb, koiLerp(0.28, 0.38, koiDaylight));
    ctx.lineWidth = Math.max(1.1, fish.maxHalfWidth * 0.024);
    ctx.stroke();

    ctx.restore(); // end body clip

    // 3. Body contour outline (continuous daylight blend)
    ctx.save();
    if (isSumie) {
      const sumieOutAlpha = koiLerp(0.54, 0.72, koiDaylight);
      this.strokeCalligraphicPolyline(ctx, buildRightFlankPts(1.0), outlineWidth, outlineRgb, sumieOutAlpha, fish.seed * 0.13, false);
      this.strokeCalligraphicPolyline(ctx, buildLeftFlankPts(1.0), outlineWidth, outlineRgb, sumieOutAlpha, fish.seed * 0.13 + 2.7, false);
    } else {
      traceBodyContour(0, 0, 1.0);
      ctx.strokeStyle = rgbToRgba(outlineRgb, koiLerp(0.74, 0.88, koiDaylight));
      ctx.lineWidth = outlineWidth;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    }
    ctx.restore();

    // 4. Head anatomical details (sculpted 3D cheek opercula, legible almond obsidian eyes, snout-margin nostrils)
    this.paintKoiHeadDetails(ctx, fish, isLight, isSumie, shiroPigment, outlineRgb, nightDepth);

    // 5. Wider translucent ivory dorsal ribbon with clear diagonal rays
    this.paintKoiDorsalFin(ctx, fish, isLight, isSumie, shiroPigment, outlineRgb, nightDepth);

    ctx.restore();
  }

  private paintKoiBarbels(
    ctx: CanvasRenderingContext2D,
    fish: KoiFish,
    isLight: boolean,
    isSumie: boolean,
    shiroRgb: [number, number, number],
    outlineRgb: [number, number, number],
    nightDepth: number
  ): void {
    const strokeCol = rgbToRgba(outlineRgb, isLight ? (isSumie ? 0.94 : 0.86) : 0.74);
    const lineW = Math.max(1.1, fish.maxHalfWidth * (isSumie ? 0.022 : 0.016));
    const bFrame = this.sampleSpineFrame(fish, 0.036);
    const bHw = koiBodyHalfWidth(0.036, fish.maxHalfWidth);
    const barbelLen = fish.maxHalfWidth * (isSumie ? 0.46 : 0.42);
    const barbelBaseW = Math.max(2.6, fish.maxHalfWidth * 0.088);

    for (const side of [-1, 1] as const) {
      const bx0 = bFrame.x + bFrame.nx * (side * bHw * 0.70);
      const by0 = bFrame.y + bFrame.ny * (side * bHw * 0.70);
      // Fleshy outward-curving mustache whiskers sweeping gracefully sideways & curving up at the tip
      const tipX = bx0 + bFrame.nx * (side * barbelLen * 1.02) + bFrame.tx * (barbelLen * 0.48);
      const tipY = by0 + bFrame.ny * (side * barbelLen * 1.02) + bFrame.ty * (barbelLen * 0.48);
      const cTopX = bx0 + bFrame.nx * (side * barbelLen * 0.72) - bFrame.tx * (barbelLen * 0.14);
      const cTopY = by0 + bFrame.ny * (side * barbelLen * 0.72) - bFrame.ty * (barbelLen * 0.14);
      const cBotX = bx0 + bFrame.nx * (side * barbelLen * 0.76) - bFrame.tx * (barbelLen * 0.32);
      const cBotY = by0 + bFrame.ny * (side * barbelLen * 0.76) - bFrame.ty * (barbelLen * 0.32);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(bx0 + bFrame.tx * (barbelBaseW * 0.50), by0 + bFrame.ty * (barbelBaseW * 0.50));
      ctx.quadraticCurveTo(cTopX, cTopY, tipX, tipY);
      ctx.quadraticCurveTo(cBotX, cBotY, bx0 - bFrame.tx * (barbelBaseW * 0.54), by0 - bFrame.ty * (barbelBaseW * 0.54));
      ctx.closePath();

      ctx.fillStyle = rgbToRgba(darkenRgb(shiroRgb, 1.02), nightDepth > 0.1 ? 0.88 : 0.98);
      ctx.fill();
      ctx.strokeStyle = strokeCol;
      ctx.lineWidth = lineW * 0.82;
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();
    }
  }

  private paintSpineOrganicPatch(
    ctx: CanvasRenderingContext2D,
    fish: KoiFish,
    patch: OrganicPatch,
    rgb: [number, number, number],
    isLight: boolean,
    isSumie: boolean,
    isHeadCap: boolean
  ): void {
    const samples = 64;
    const pts: Array<{ x: number; y: number }> = [];
    for (let k = 0; k < samples; k++) {
      const ang = (k / samples) * Math.PI * 2;
      let rMod =
        1.0 +
        patch.warpAmp * 0.45 * Math.sin(ang * patch.warpFreq + patch.phase) +
        patch.warpAmp * 0.24 * Math.cos(ang * (patch.warpFreq * 0.65) - patch.phase * 0.5);
      if (isHeadCap) {
        // Pronounced waisted 4-lobed cranial Hi shield: narrower rounded forehead dome between eyes,
        // clear inward lateral waist, fuller lower cheek lobes, and crisp bilobed M-shaped rear base!
        const ca = Math.cos(ang); // +1 = rear (gills), -1 = front (nose)
        const sa = Math.sin(ang); // ±1 = cheeks
        const frontNarrow = ca < -0.15 ? -0.14 * Math.abs(sa) * Math.pow(-ca, 0.7) : 0;
        const lowerLobeSwell = ca > 0.10 && ca < 0.78 ? 0.16 * Math.abs(sa) : 0;
        const waistPinch = -0.20 * Math.exp(-Math.pow((ca + 0.06) * 4.2, 2)) * Math.abs(sa);
        const bilobedMBase = ca > 0.55 ? -0.34 * Math.pow((ca - 0.55) / 0.45, 1.35) : 0;
        const gentleScallop = 0.045 * Math.cos(ang * 4) + 0.025 * Math.sin(ang * 6 + 0.4);
        rMod = 0.98 + frontNarrow + lowerLobeSwell + waistPinch + bilobedMBase + gentleScallop;
      }
      if (isSumie) {
        rMod +=
          0.042 * Math.sin(ang * 11.0 + patch.phase * 1.3) +
          0.028 * Math.cos(ang * 19.0 - patch.phase * 0.8) +
          0.018 * Math.sin(ang * 31.0 + patch.phase * 0.5);
      }
      const s = koiClamp(patch.sCenter + Math.cos(ang) * patch.sRadius * rMod, 0.042, 0.825);
      const u = koiClamp(patch.uCenter + Math.sin(ang) * patch.uRadius * rMod, -1.04, 1.04);
      const frame = this.sampleSpineFrame(fish, s);
      const hw = koiBodyHalfWidth(Math.max(0.012, s), fish.maxHalfWidth);
      pts.push({
        x: frame.x + frame.nx * (u * hw),
        y: frame.y + frame.ny * (u * hw),
      });
    }

    const tracePts = () => {
      ctx.beginPath();
      for (let k = 0; k < pts.length; k++) {
        const cur = pts[k];
        const nxt = pts[(k + 1) % pts.length];
        const mx = (cur.x + nxt.x) * 0.5;
        const my = (cur.y + nxt.y) * 0.5;
        if (k === 0) {
          const prev = pts[pts.length - 1];
          ctx.moveTo((prev.x + cur.x) * 0.5, (prev.y + cur.y) * 0.5);
        }
        ctx.quadraticCurveTo(cur.x, cur.y, mx, my);
      }
      ctx.closePath();
    };

    const centerFrame = this.sampleSpineFrame(fish, koiClamp(patch.sCenter, 0.05, 0.82));
    const centerHw = koiBodyHalfWidth(Math.max(0.012, patch.sCenter), fish.maxHalfWidth);
    const cx = centerFrame.x + centerFrame.nx * (patch.uCenter * centerHw);
    const cy = centerFrame.y + centerFrame.ny * (patch.uCenter * centerHw);
    const gradR = Math.max(14, patch.sRadius * fish.bodyLength * 1.42);

    ctx.save();
    const isSumiPatch = patch.layer === "sumi";
    tracePts();
    if (!isSumie) {
      const grad = ctx.createRadialGradient(
        cx - centerFrame.tx * (gradR * 0.14),
        cy - centerFrame.ty * (gradR * 0.14),
        gradR * 0.06,
        cx,
        cy,
        gradR
      );
      grad.addColorStop(0.0, rgbToRgba(darkenRgb(rgb, 1.07), 0.99));
      grad.addColorStop(0.62, rgbToRgba(rgb, 0.98));
      grad.addColorStop(1.0, rgbToRgba(darkenRgb(rgb, 0.86), 0.96));
      ctx.fillStyle = grad;
      ctx.fill();
    } else {
      // SUMI-E: Pure monochrome wet-on-wet ink washes with soft bleeding feathered edges (zero color)
      const coreRgb: [number, number, number] = isSumiPatch
        ? (isLight ? [22, 20, 18] : [30, 28, 25])
        : (isLight ? [46, 43, 39] : [54, 50, 46]);
      const midRgb: [number, number, number] = isSumiPatch
        ? (isLight ? [38, 35, 32] : [48, 45, 41])
        : (isLight ? [74, 69, 62] : [82, 77, 70]);

      // Outer wet bleed halo
      ctx.save();
      ctx.strokeStyle = rgbToRgba(midRgb, isLight ? 0.24 : 0.20);
      ctx.lineWidth = Math.max(2.6, fish.maxHalfWidth * 0.09);
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();

      const grad = ctx.createRadialGradient(
        cx - centerFrame.tx * (gradR * 0.10),
        cy - centerFrame.ty * (gradR * 0.10),
        gradR * 0.06,
        cx,
        cy,
        gradR
      );
      grad.addColorStop(0.0, rgbToRgba(coreRgb, isLight ? 0.84 : 0.78));
      grad.addColorStop(0.68, rgbToRgba(midRgb, isLight ? 0.74 : 0.68));
      grad.addColorStop(1.0, rgbToRgba(coreRgb, isLight ? 0.82 : 0.72));
      ctx.fillStyle = grad;
      ctx.fill();
    }
    ctx.restore();
  }

  private samplePatchLayerAt(fish: KoiFish, s: number, u: number): "shiro" | "hi" | "sumi" {
    let layer: "shiro" | "hi" | "sumi" = "shiro";
    for (let pIdx = 0; pIdx < fish.patches.length; pIdx++) {
      const p = fish.patches[pIdx];
      if (p.sCenter < 0.24) continue;
      const ds = (s - p.sCenter) / Math.max(0.015, p.sRadius);
      const du = (u - p.uCenter) / Math.max(0.08, p.uRadius);
      const ang = Math.atan2(du, ds);
      const warp =
        1.0 +
        p.warpAmp * 0.45 * Math.sin(ang * p.warpFreq + p.phase) +
        p.warpAmp * 0.24 * Math.cos(ang * (p.warpFreq * 0.65) - p.phase * 0.5);
      const distSq = (ds * ds + du * du) / (warp * warp);
      if (distSq <= 1.0) {
        if (p.layer === "sumi") return "sumi";
        layer = "hi";
      }
    }
    return layer;
  }

  private paintCalligraphicScales(
    ctx: CanvasRenderingContext2D,
    fish: KoiFish,
    isLight: boolean,
    isSumie: boolean,
    shiroRgb: [number, number, number],
    hiRgb: [number, number, number],
    sumiRgb: [number, number, number],
    _outlineRgb: [number, number, number]
  ): void {
    const sStart = 0.258;
    const sEnd = 0.812;
    const rowCount = isSumie ? 21 : 30;
    const ds = (sEnd - sStart) / (rowCount - 1);
    const scaleWorldStep = ds * fish.bodyLength;

    // 4 Classic Japanese Koi designs achieved purely by varying scale colors:
    // 0: Taisho Sanke (Ivory + Vermilion Hi + Sumi Black scales)
    // 1: Kohaku (Pure Snow-Ivory + Deep Crimson-Vermilion Hi scales, no Sumi scales)
    // 2: Shiro Utsuri (Crisp Black & White scales only)
    // 3: Black-Backed Hi-Flank (Deep Sumi-Black Reticulated Dorsal scales + Warm Vermilion Flank scales)
    const scaleDesign = ((fish.id % 4) + 4) % 4;
    const koiDay = this.getDaylightFactor();
    const nightDim = koiLerp(0.86, 1.0, koiDay);
    const tintNightScale = (rgb: [number, number, number]): [number, number, number] => {
      const d = darkenRgb(rgb, nightDim);
      return koiDay >= 0.995 ? d : mixRgb([14, 30, 48], d, koiLerp(0.72, 1.0, koiDay));
    };

    const kohakuShiro = tintNightScale([250, 242, 228]);
    const kohakuHi = tintNightScale([234, 42, 16]);
    const utsuriWhite = tintNightScale([248, 244, 236]);
    const utsuriBlack = tintNightScale([18, 18, 20]);
    const blackDorsal = tintNightScale([22, 22, 24]);
    const blackDorsalRim = tintNightScale([68, 68, 72]);
    const flankHi = tintNightScale([226, 68, 24]);
    const edgeIvory = tintNightScale([242, 236, 224]);

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (let r = rowCount - 1; r >= 0; r--) {
      const s = sStart + r * ds;
      const frame = this.sampleSpineFrame(fish, s);
      const hw = koiBodyHalfWidth(s, fish.maxHalfWidth);
      if (hw < 3) continue;

      const tBody = (s - sStart) / (sEnd - sStart);
      const scaleR = Math.max(
        scaleWorldStep * 1.14,
        fish.maxHalfWidth * ((isSumie ? 0.164 : 0.130) - 0.038 * tBody)
      );
      const colSpacing = scaleR * 1.54;
      const halfCols = Math.ceil((hw + scaleR) / colSpacing);
      const stagger = (r % 2) * 0.5;
      const angle = Math.atan2(-frame.ty, -frame.tx);

      for (let c = -halfCols; c <= halfCols; c++) {
        const latOffset = (c + stagger) * colSpacing;
        if (Math.abs(latOffset) > hw + scaleR * 0.42) continue;

        const u = koiClamp(latOffset / Math.max(1, hw), -1.0, 1.0);
        const cx = frame.x + frame.nx * latOffset;
        const cy = frame.y + frame.ny * latOffset;
        const layer = this.samplePatchLayerAt(fish, s, u);

        let sumieFade = 1.0;
        if (isSumie) {
          if (layer === "sumi") continue;
          const shoulderWeight = tBody < 0.36 ? 1.0 : Math.max(0.20, 1.0 - (tBody - 0.36) * 1.45);
          const flankWeight = Math.abs(u) > 0.36 ? 1.0 : 0.74;
          sumieFade = koiClamp(shoulderWeight * flankWeight, 0.20, 1.0);
          if (tBody > 0.62 && Math.abs(u) < 0.50) continue;
        }

        const edgeCos = Math.max(0.58, Math.sqrt(Math.max(0.08, 1 - u * u * 0.60)));
        const rx = scaleR * 1.16;
        const ry = scaleR * 1.06 * edgeCos;

        ctx.save();
        if (!isSumie) {
          ctx.translate(cx, cy);
          ctx.rotate(angle);

          let fillRgb = shiroRgb;
          let strokeCol = isLight ? "rgba(130, 102, 74, 0.62)" : "rgba(12, 22, 34, 0.48)";

          if (scaleDesign === 1) {
            // Classic Kohaku: pure snow-ivory & deep crimson-vermilion Hi scales (no Sumi)
            if (layer === "hi") {
              fillRgb = kohakuHi;
              strokeCol = isLight ? "rgba(148, 24, 10, 0.58)" : "rgba(42, 12, 8, 0.48)";
            } else {
              fillRgb = darkenRgb(kohakuShiro, 1.0 - 0.09 * Math.abs(u));
              strokeCol = isLight ? "rgba(136, 112, 86, 0.58)" : "rgba(14, 24, 38, 0.46)";
            }
          } else if (scaleDesign === 2) {
            // Classic Shiro Utsuri: pure black & white scales
            if (layer === "hi" || layer === "sumi") {
              fillRgb = utsuriBlack;
              strokeCol = isLight ? "rgba(58, 56, 56, 0.54)" : "rgba(38, 42, 48, 0.44)";
            } else {
              fillRgb = darkenRgb(utsuriWhite, 1.0 - 0.10 * Math.abs(u));
              strokeCol = isLight ? "rgba(92, 88, 82, 0.58)" : "rgba(24, 30, 38, 0.46)";
            }
          } else if (scaleDesign === 3) {
            // Classic Showa Sanshoku: organic diagonal sumi-black & vermilion-red wrapping saddles on ivory
            const waveBand = Math.sin(tBody * Math.PI * 2.6 + u * 2.1 + fish.seed * 0.37);
            const isSumiWrap = layer === "sumi" || (layer === "shiro" && waveBand > 0.38);
            const isHiWrap = !isSumiWrap && (layer === "hi" || waveBand < -0.52);
            if (isSumiWrap) {
              fillRgb = blackDorsal;
              strokeCol = isLight ? "rgba(76, 74, 72, 0.56)" : "rgba(48, 52, 58, 0.44)";
            } else if (isHiWrap) {
              fillRgb = flankHi;
              strokeCol = isLight ? "rgba(144, 36, 12, 0.58)" : "rgba(46, 16, 10, 0.46)";
            } else {
              fillRgb = darkenRgb(edgeIvory, 1.0 - 0.10 * Math.abs(u));
              strokeCol = isLight ? "rgba(126, 104, 82, 0.56)" : "rgba(18, 28, 42, 0.44)";
            }
          } else {
            // Classic Taisho Sanke: ivory Shiroji + vermilion Hi + lacquer Sumi scales
            if (layer === "hi") {
              fillRgb = hiRgb;
              strokeCol = isLight ? "rgba(148, 32, 6, 0.56)" : "rgba(42, 12, 8, 0.46)";
            } else if (layer === "sumi") {
              fillRgb = sumiRgb;
              strokeCol = isLight ? "rgba(46, 44, 46, 0.38)" : "rgba(28, 38, 52, 0.32)";
            } else {
              fillRgb = darkenRgb(shiroRgb, 1.0 - 0.11 * Math.abs(u));
            }
          }

          ctx.beginPath();
          ctx.moveTo(-rx * 0.85, -ry);
          ctx.lineTo(0, -ry);
          ctx.ellipse(0, 0, rx, ry, 0, -Math.PI * 0.5, Math.PI * 0.5, false);
          ctx.lineTo(-rx * 0.85, ry);
          ctx.closePath();

          const sg = ctx.createLinearGradient(-rx * 0.15, 0, rx, 0);
          if (scaleDesign === 3 && fillRgb === blackDorsal) {
            sg.addColorStop(0.0, rgbToRgba(darkenRgb(fillRgb, 0.82), 1.0));
            sg.addColorStop(0.58, rgbToRgba(fillRgb, 1.0));
            sg.addColorStop(1.0, rgbToRgba(blackDorsalRim, 1.0));
          } else {
            sg.addColorStop(0.0, rgbToRgba(darkenRgb(fillRgb, layer === "shiro" ? 0.90 : 0.93), 1.0));
            sg.addColorStop(0.58, rgbToRgba(fillRgb, 1.0));
            sg.addColorStop(1.0, rgbToRgba(darkenRgb(fillRgb, 1.04), 1.0));
          }
          ctx.fillStyle = sg;
          ctx.fill();

          ctx.beginPath();
          ctx.ellipse(0, 0, rx, ry, 0, -Math.PI * 0.47, Math.PI * 0.47, false);
          ctx.strokeStyle = strokeCol;
          ctx.lineWidth = Math.max(0.65, fish.maxHalfWidth * 0.009);
          ctx.stroke();
        } else {
          // SUMI-E: Classic scale-color variations rendered as delicate brushed dry-ink crescents
          const jx = Math.sin(r * 7.3 + c * 11.1 + fish.seed) * (scaleR * 0.16);
          const jy = Math.cos(r * 5.7 + c * 13.7 + fish.seed) * (scaleR * 0.14);
          const jAng = Math.sin(r * 4.1 + c * 9.3) * 0.16;
          ctx.translate(cx + jx, cy + jy);
          ctx.rotate(angle + jAng);

          const thick = Math.max(0.9, fish.maxHalfWidth * (0.012 + 0.012 * sumieFade));
          const spanA = Math.PI * (0.34 + 0.10 * Math.sin(r * 2.3 + c * 1.7));
          ctx.beginPath();
          ctx.ellipse(0, 0, rx, ry, 0, -spanA, spanA, false);
          ctx.ellipse(-thick, 0, Math.max(1, rx - thick * 0.45), Math.max(1, ry * 0.96), 0, spanA, -spanA, true);
          ctx.closePath();

          // Monochrome dry-ink crescents (zero red/cinnabar/blue)
          const sumieScaleCol =
            layer === "hi" || layer === "sumi"
              ? `rgba(28, 25, 22, ${(0.42 * sumieFade).toFixed(2)})`
              : `rgba(68, 63, 56, ${(0.28 * sumieFade).toFixed(2)})`;
          ctx.fillStyle = sumieScaleCol;
          ctx.fill();
        }
        ctx.restore();
      }
    }
    ctx.restore();
  }

  private paintKoiPairedFins(
    ctx: CanvasRenderingContext2D,
    fish: KoiFish,
    isLight: boolean,
    outlineRgb: [number, number, number],
    nightDepth: number
  ): void {
    const isSumie = this.artStyle === "sumie";
    const finStroke = rgbToRgba(outlineRgb, isLight ? (isSumie ? 0.44 : 0.86) : (isSumie ? 0.42 : 0.72));
    const finOutlineW = Math.max(0.85, fish.maxHalfWidth * (isSumie ? 0.016 : 0.017));

    const nightTint = (rgb: [number, number, number]): [number, number, number] => {
      if (nightDepth <= 0.001) return rgb;
      const k = nightDepth * (isSumie ? 0.18 : 0.34);
      const tR = isSumie ? 24 : 14;
      const tG = isSumie ? 22 : 30;
      const tB = isSumie ? 20 : 48;
      return [
        Math.round(rgb[0] * (1 - k) + tR * k),
        Math.round(rgb[1] * (1 - k) + tG * k),
        Math.round(rgb[2] * (1 - k) + tB * k),
      ];
    };

    const ivoryTip = nightTint(isSumie ? [232, 224, 208] : [250, 240, 226]);
    const warmBase = nightTint(isSumie ? [162, 154, 142] : [216, 172, 130]);
    const rayCol = isLight
      ? (isSumie ? "rgba(38, 34, 30, 0.38)" : "rgba(122, 84, 52, 0.64)")
      : (isSumie ? "rgba(206, 198, 184, 0.38)" : "rgba(165, 212, 248, 0.50)");

    // === 1. PECTORAL FINS (s = 0.276 .. 0.382) ===
    const pLead = this.sampleSpineFrame(fish, 0.276);
    const pTrail = this.sampleSpineFrame(fish, 0.382);
    const hwLead = koiBodyHalfWidth(0.276, fish.maxHalfWidth);
    const hwTrail = koiBodyHalfWidth(0.382, fish.maxHalfWidth);

    const sweepOsc = Math.sin(fish.phase * 0.85) * 0.04;
    // Compact rounded Mokkotsu teardrop paddles (1.24); swept-back pointed Sumi-e butterfly wings (1.50)
    const span = fish.maxHalfWidth * fish.finSpanFactor * (isSumie ? 1.50 : 1.24);

    for (const side of [-1, 1] as const) {
      const rootLx = pLead.x + pLead.nx * (side * hwLead * 0.90);
      const rootLy = pLead.y + pLead.ny * (side * hwLead * 0.90);
      const rootTx = pTrail.x + pTrail.nx * (side * hwTrail * 0.88);
      const rootTy = pTrail.y + pTrail.ny * (side * hwTrail * 0.88);

      // Mokkotsu: gently swept compact teardrop (0.30); Sumi-e: dramatic swept-back pointed butterfly wing (0.62)
      const backSweep = (isSumie ? 0.62 : 0.30) + sweepOsc * side;
      const outX = pLead.nx * side - pLead.tx * backSweep;
      const outY = pLead.ny * side - pLead.ty * backSweep;
      const outLen = Math.hypot(outX, outY) || 1;
      const ux = outX / outLen;
      const uy = outY / outLen;
      const fx = pLead.tx;
      const fy = pLead.ty;

      const leadPts: Array<{ x: number; y: number }> = [];
      const tracePectoral = () => {
        ctx.beginPath();
        ctx.moveTo(rootLx, rootLy);
        if (!isSumie) {
          // MOKKOTSU: Compact curved teardrop paddle with warm peach-to-ivory shading
          const tipX = rootLx + ux * span - fx * (span * 0.05);
          const tipY = rootLy + uy * span - fy * (span * 0.05);
          ctx.bezierCurveTo(
            rootLx + ux * (span * 0.50) + fx * (span * 0.24),
            rootLy + uy * (span * 0.50) + fy * (span * 0.24),
            rootLx + ux * (span * 1.02) + fx * (span * 0.14),
            rootLy + uy * (span * 1.02) + fy * (span * 0.14),
            tipX,
            tipY
          );
          const lobes = 7;
          let prevX = tipX;
          let prevY = tipY;
          for (let l = 1; l <= lobes; l++) {
            const t = l / lobes;
            const bx =
              (1 - t) * (1 - t) * tipX +
              2 * (1 - t) * t * (rootTx + ux * (span * 0.72) - fx * (span * 0.20)) +
              t * t * rootTx;
            const by =
              (1 - t) * (1 - t) * tipY +
              2 * (1 - t) * t * (rootTy + uy * (span * 0.72) - fy * (span * 0.20)) +
              t * t * rootTy;
            const mx = (prevX + bx) * 0.5 + ux * (span * 0.028) - fx * (span * 0.040);
            const my = (prevY + by) * 0.5 + uy * (span * 0.028) - fy * (span * 0.040);
            ctx.quadraticCurveTo(mx, my, bx, by);
            prevX = bx;
            prevY = by;
          }
          ctx.closePath();
        } else {
          // SUMI-E: Swept-back pointed butterfly wing with graceful concave-trailing profile
          const tipX = rootLx + ux * span - fx * (span * 0.22);
          const tipY = rootLy + uy * span - fy * (span * 0.22);
          const c1x = rootLx + ux * (span * 0.44) + fx * (span * 0.28);
          const c1y = rootLy + uy * (span * 0.44) + fy * (span * 0.28);
          const c2x = rootLx + ux * (span * 0.88) + fx * (span * 0.10);
          const c2y = rootLy + uy * (span * 0.88) + fy * (span * 0.10);
          ctx.bezierCurveTo(c1x, c1y, c2x, c2y, tipX, tipY);

          ctx.bezierCurveTo(
            tipX - ux * (span * 0.26) - fx * (span * 0.02),
            tipY - uy * (span * 0.26) - fy * (span * 0.02),
            rootTx + ux * (span * 0.52) - fx * (span * 0.34),
            rootTy + uy * (span * 0.52) - fy * (span * 0.34),
            rootTx,
            rootTy
          );
          ctx.closePath();

          if (leadPts.length === 0) {
            for (let k = 0; k <= 12; k++) {
              const t = k / 12;
              const mt = 1 - t;
              leadPts.push({
                x: mt*mt*mt*rootLx + 3*mt*mt*t*c1x + 3*mt*t*t*c2x + t*t*t*tipX,
                y: mt*mt*mt*rootLy + 3*mt*mt*t*c1y + 3*mt*t*t*c2y + t*t*t*tipY,
              });
            }
          }
        }
      };

      ctx.save();
      tracePectoral();
      if (!isSumie) {
        const grad = ctx.createLinearGradient(rootLx, rootLy, rootLx + ux * span, rootLy + uy * span);
        grad.addColorStop(0.0, rgbToRgba(warmBase, 0.90));
        grad.addColorStop(0.42, rgbToRgba(darkenRgb(warmBase, 1.12), 0.90));
        grad.addColorStop(0.84, rgbToRgba(ivoryTip, 0.90));
        grad.addColorStop(1.0, rgbToRgba(ivoryTip, 0.90));
        ctx.fillStyle = grad;
        ctx.fill();
      } else {
        ctx.fillStyle = rgbToRgba(ivoryTip, 0.68);
        ctx.fill();
      }

      ctx.save();
      tracePectoral();
      ctx.clip();
      const rootMidX = (rootLx + rootTx) * 0.5;
      const rootMidY = (rootLy + rootTy) * 0.5;
      if (isSumie) {
        const rootWash = ctx.createRadialGradient(rootMidX, rootMidY, span * 0.02, rootMidX, rootMidY, span * 0.48);
        rootWash.addColorStop(0.0, rgbToRgba(nightTint([36, 33, 29]), isLight ? 0.48 : 0.42));
        rootWash.addColorStop(0.5, rgbToRgba(nightTint([78, 72, 66]), isLight ? 0.22 : 0.18));
        rootWash.addColorStop(1.0, rgbToRgba(ivoryTip, 0.0));
        ctx.fillStyle = rootWash;
        ctx.fillRect(rootMidX - span * 1.4, rootMidY - span * 1.4, span * 2.8, span * 2.8);
      }

      const rayCount = isSumie ? 12 : 16;
      for (let r = 0; r < rayCount; r++) {
        const frac = r / (rayCount - 1);
        const rx0 = rootLx + (rootTx - rootLx) * frac;
        const ry0 = rootLy + (rootTy - rootLy) * frac;
        const spread = (0.18 - frac * 0.56) * (isSumie ? 1.02 : 0.94);
        const rLen = span * (isSumie ? (0.76 - frac * 0.28) : (1.02 - Math.abs(frac - 0.38) * 0.32));
        const rx1 = rx0 + (ux + fx * spread) * rLen;
        const ry1 = ry0 + (uy + fy * spread) * rLen;
        const cx1 = rx0 + (ux + fx * (spread + 0.22)) * (rLen * 0.52);
        const cy1 = ry0 + (uy + fy * (spread + 0.22)) * (rLen * 0.52);

        ctx.beginPath();
        ctx.moveTo(rx0, ry0);
        ctx.quadraticCurveTo(cx1, cy1, rx1, ry1);
        ctx.strokeStyle = rayCol;
        ctx.lineWidth = Math.max(0.65, fish.maxHalfWidth * (isSumie ? (0.015 * (1 - frac * 0.45)) : 0.010));
        ctx.stroke();

        if (isSumie && r < rayCount - 1) {
          const inkLen = rLen * (0.62 + 0.18 * Math.sin(r * 2.1));
          ctx.beginPath();
          ctx.moveTo(rootMidX, rootMidY);
          ctx.quadraticCurveTo(
            rx0 + (ux + fx * (spread + 0.18)) * (inkLen * 0.55),
            ry0 + (uy + fy * (spread + 0.18)) * (inkLen * 0.55),
            rx0 + (ux + fx * spread) * inkLen,
            ry0 + (uy + fy * spread) * inkLen
          );
          ctx.strokeStyle = isLight ? "rgba(12, 11, 11, 0.56)" : "rgba(6, 12, 20, 0.38)";
          ctx.lineWidth = Math.max(1.4, fish.maxHalfWidth * 0.034 * (1 - frac * 0.38));
          ctx.stroke();
        }
      }
      ctx.restore();

      if (isSumie) {
        this.strokeCalligraphicPolyline(ctx, leadPts, finOutlineW * 1.25, outlineRgb, isLight ? 0.96 : 0.80, fish.seed + side * 3.7, false);
        tracePectoral();
        ctx.strokeStyle = rgbToRgba(outlineRgb, isLight ? 0.34 : 0.28);
        ctx.lineWidth = finOutlineW * 0.36;
        ctx.stroke();
      } else {
        tracePectoral();
        ctx.strokeStyle = finStroke;
        ctx.lineWidth = finOutlineW;
        ctx.lineJoin = "round";
        ctx.stroke();
      }
      ctx.restore();
    }

    if (isSumie) {
      // === 2. PELVIC FINS (Sumi-e: untouched asymmetrically flared pointed ink-rooted brushes) ===
      const pelS0 = 0.48;
      const pelS1 = 0.58;
      const pelLead = this.sampleSpineFrame(fish, pelS0);
      const pelTrail = this.sampleSpineFrame(fish, pelS1);
      const pelHw0 = koiBodyHalfWidth(pelS0, fish.maxHalfWidth);
      const pelHw1 = koiBodyHalfWidth(pelS1, fish.maxHalfWidth);

      for (const side of [-1, 1] as const) {
        const asym = side < 0 ? 1.28 : 0.88;
        const pelSpan = fish.maxHalfWidth * 0.36 * asym;
        const r0x = pelLead.x + pelLead.nx * (side * pelHw0 * 0.86);
        const r0y = pelLead.y + pelLead.ny * (side * pelHw0 * 0.86);
        const r1x = pelTrail.x + pelTrail.nx * (side * pelHw1 * 0.84);
        const r1y = pelTrail.y + pelTrail.ny * (side * pelHw1 * 0.84);
        const tipX = r1x + pelTrail.nx * (side * pelSpan * 0.90) - pelTrail.tx * (pelSpan * 1.15);
        const tipY = r1y + pelTrail.ny * (side * pelSpan * 0.90) - pelTrail.ty * (pelSpan * 1.15);

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(r0x, r0y);
        ctx.bezierCurveTo(
          r0x + pelLead.nx * (side * pelSpan * 1.18) - pelLead.tx * (pelSpan * 0.04),
          r0y + pelLead.ny * (side * pelSpan * 1.18) - pelLead.ty * (pelSpan * 0.04),
          tipX + pelTrail.nx * (side * pelSpan * 0.42) + pelTrail.tx * (pelSpan * 0.44),
          tipY + pelTrail.ny * (side * pelSpan * 0.42) + pelTrail.ty * (pelSpan * 0.44),
          tipX,
          tipY
        );
        ctx.bezierCurveTo(
          tipX - pelTrail.nx * (side * pelSpan * 0.14) + pelTrail.tx * (pelSpan * 0.30),
          tipY - pelTrail.ny * (side * pelSpan * 0.14) + pelTrail.ty * (pelSpan * 0.30),
          r1x + pelTrail.nx * (side * pelSpan * 0.28) - pelTrail.tx * (pelSpan * 0.36),
          r1y + pelTrail.ny * (side * pelSpan * 0.28) - pelTrail.ty * (pelSpan * 0.36),
          r1x,
          r1y
        );
        ctx.closePath();

        const pg = ctx.createLinearGradient(r0x, r0y, tipX, tipY);
        pg.addColorStop(0.0, rgbToRgba(nightTint([24, 22, 22]), 0.94));
        pg.addColorStop(0.45, rgbToRgba(ivoryTip, 0.96));
        pg.addColorStop(1.0, rgbToRgba(ivoryTip, 0.98));
        ctx.fillStyle = pg;
        ctx.fill();

        for (let k = 1; k <= 4; k++) {
          const f = k / 5;
          const sx = r0x + (r1x - r0x) * f;
          const sy = r0y + (r1y - r0y) * f;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.quadraticCurveTo(
            sx + pelLead.nx * (side * pelSpan * 0.48),
            sy + pelLead.ny * (side * pelSpan * 0.48),
            sx + (tipX - r0x) * (0.70 - f * 0.18),
            sy + (tipY - r0y) * (0.70 - f * 0.18)
          );
          ctx.strokeStyle = rayCol;
          ctx.lineWidth = Math.max(0.65, fish.maxHalfWidth * 0.009);
          ctx.stroke();
        }
        ctx.strokeStyle = finStroke;
        ctx.lineWidth = finOutlineW * 0.56;
        ctx.stroke();
        ctx.restore();
      }

      // === 3. SINGLE TUCKED ANAL FIN (Sumi-e: untouched) ===
      const analSide: -1 | 1 = -1;
      const aLead = this.sampleSpineFrame(fish, 0.685);
      const aTrail = this.sampleSpineFrame(fish, 0.748);
      const aHw0 = koiBodyHalfWidth(0.685, fish.maxHalfWidth);
      const aHw1 = koiBodyHalfWidth(0.748, fish.maxHalfWidth);
      const aSpan = fish.maxHalfWidth * 0.24;
      const ar0x = aLead.x + aLead.nx * (analSide * aHw0 * 0.84);
      const ar0y = aLead.y + aLead.ny * (analSide * aHw0 * 0.84);
      const ar1x = aTrail.x + aTrail.nx * (analSide * aHw1 * 0.84);
      const ar1y = aTrail.y + aTrail.ny * (analSide * aHw1 * 0.84);
      const aTipX = ar1x + aTrail.nx * (analSide * aSpan * 0.86) - aTrail.tx * (aSpan * 1.10);
      const aTipY = ar1y + aTrail.ny * (analSide * aSpan * 0.86) - aTrail.ty * (aSpan * 1.10);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(ar0x, ar0y);
      ctx.quadraticCurveTo(
        ar0x + aLead.nx * (analSide * aSpan * 1.06) - aLead.tx * (aSpan * 0.18),
        ar0y + aLead.ny * (analSide * aSpan * 1.06) - aLead.ty * (aSpan * 0.18),
        aTipX,
        aTipY
      );
      ctx.quadraticCurveTo(
        ar1x + aTrail.nx * (analSide * aSpan * 0.28) - aTrail.tx * (aSpan * 0.42),
        ar1y + aTrail.ny * (analSide * aSpan * 0.28) - aTrail.ty * (aSpan * 0.42),
        ar1x,
        ar1y
      );
      ctx.closePath();
      ctx.fillStyle = rgbToRgba(ivoryTip, 0.94);
      ctx.fill();
      ctx.strokeStyle = finStroke;
      ctx.lineWidth = finOutlineW * 0.56;
      ctx.stroke();
      ctx.restore();
    } else {
      // === 2. MOKKOTSU PELVIC FINS (compact, tucked rounded petals matching reference koi anatomy) ===
      const pelS0 = 0.605;
      const pelS1 = 0.692;
      const pelLead = this.sampleSpineFrame(fish, pelS0);
      const pelTrail = this.sampleSpineFrame(fish, pelS1);
      const pelHw0 = koiBodyHalfWidth(pelS0, fish.maxHalfWidth);
      const pelHw1 = koiBodyHalfWidth(pelS1, fish.maxHalfWidth);
      const pelSway = Math.sin(fish.phase * 0.85 - 1.1) * 0.03;

      for (const side of [-1, 1] as const) {
        const pelSpan = fish.maxHalfWidth * 0.242 * fish.finSpanFactor;
        const r0x = pelLead.x + pelLead.nx * (side * pelHw0 * 0.82);
        const r0y = pelLead.y + pelLead.ny * (side * pelHw0 * 0.82);
        const r1x = pelTrail.x + pelTrail.nx * (side * pelHw1 * 0.78);
        const r1y = pelTrail.y + pelTrail.ny * (side * pelHw1 * 0.78);

        // Gently tucked backward petal direction along the tapering flank
        const outNx = pelTrail.nx * side;
        const outNy = pelTrail.ny * side;
        const backTx = -pelTrail.tx;
        const backTy = -pelTrail.ty;
        const leadNx = pelLead.nx * side;
        const leadNy = pelLead.ny * side;
        const leadBackTx = -pelLead.tx;
        const leadBackTy = -pelLead.ty;

        // Smooth rounded petal apex (tucked close to the flank, swept posteriorly)
        const apexX =
          r1x +
          outNx * (pelSpan * (0.98 + pelSway * side)) +
          backTx * (pelSpan * 0.72);
        const apexY =
          r1y +
          outNy * (pelSpan * (0.98 + pelSway * side)) +
          backTy * (pelSpan * 0.72);

        const tracePelvic = () => {
          ctx.beginPath();
          ctx.moveTo(r0x, r0y);
          // Outer convex leading edge: emerges cleanly from under flank and sweeps smoothly back
          ctx.bezierCurveTo(
            r0x + leadNx * (pelSpan * 0.78) + leadBackTx * (pelSpan * 0.36),
            r0y + leadNy * (pelSpan * 0.78) + leadBackTy * (pelSpan * 0.36),
            apexX + outNx * (pelSpan * 0.34) - backTx * (pelSpan * 0.52),
            apexY + outNy * (pelSpan * 0.34) - backTy * (pelSpan * 0.52),
            apexX,
            apexY
          );
          // Soft C1-rounded posterior petal lobe tucking smoothly back into the flank
          ctx.bezierCurveTo(
            apexX - outNx * (pelSpan * 0.30) + backTx * (pelSpan * 0.32),
            apexY - outNy * (pelSpan * 0.30) + backTy * (pelSpan * 0.32),
            r1x + outNx * (pelSpan * 0.24) + backTx * (pelSpan * 0.44),
            r1y + outNy * (pelSpan * 0.24) + backTy * (pelSpan * 0.44),
            r1x,
            r1y
          );
          ctx.closePath();
        };

        ctx.save();
        tracePelvic();
        const pg = ctx.createLinearGradient(
          (r0x + r1x) * 0.5,
          (r0y + r1y) * 0.5,
          apexX + outNx * (pelSpan * 0.15),
          apexY + outNy * (pelSpan * 0.15)
        );
        pg.addColorStop(0.0, rgbToRgba(warmBase, 0.94));
        pg.addColorStop(0.42, rgbToRgba(darkenRgb(warmBase, 1.09), 0.94));
        pg.addColorStop(0.84, rgbToRgba(ivoryTip, 0.96));
        pg.addColorStop(1.0, rgbToRgba(ivoryTip, 0.98));
        ctx.fillStyle = pg;
        ctx.fill();

        // Clipped curved radiating fin rays matching the pectoral fin craftsmanship
        ctx.save();
        tracePelvic();
        ctx.clip();
        const pelRayCount = 5;
        for (let r = 0; r < pelRayCount; r++) {
          const frac = (r + 0.5) / pelRayCount;
          // Fan gently from anterior-mid root along the swept petal toward the rounded trailing lobe
          const sx = r0x + (r1x - r0x) * (0.08 + frac * 0.48);
          const sy = r0y + (r1y - r0y) * (0.08 + frac * 0.48);
          const ex =
            apexX -
            outNx * (pelSpan * (0.48 - frac * 0.62)) -
            backTx * (pelSpan * (0.58 - frac * 0.54));
          const ey =
            apexY -
            outNy * (pelSpan * (0.48 - frac * 0.62)) -
            backTy * (pelSpan * (0.58 - frac * 0.54));
          const cx =
            (sx + ex) * 0.5 +
            outNx * (pelSpan * (0.28 - frac * 0.12)) +
            backTx * (pelSpan * 0.08);
          const cy =
            (sy + ey) * 0.5 +
            outNy * (pelSpan * (0.28 - frac * 0.12)) +
            backTy * (pelSpan * 0.08);

          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.quadraticCurveTo(cx, cy, ex, ey);
          ctx.strokeStyle = rayCol;
          ctx.lineWidth = Math.max(0.65, fish.maxHalfWidth * 0.0095);
          ctx.stroke();
        }
        ctx.restore();

        tracePelvic();
        ctx.strokeStyle = finStroke;
        ctx.lineWidth = finOutlineW * 0.86;
        ctx.lineJoin = "round";
        ctx.stroke();
        ctx.restore();
      }

      // === 3. MOKKOTSU SINGLE TUCKED ANAL FIN (slender, rounded sickle petal along tail peduncle) ===
      const analSide: -1 | 1 = -1;
      const aLead = this.sampleSpineFrame(fish, 0.748);
      const aTrail = this.sampleSpineFrame(fish, 0.822);
      const aHw0 = koiBodyHalfWidth(0.748, fish.maxHalfWidth);
      const aHw1 = koiBodyHalfWidth(0.822, fish.maxHalfWidth);
      const aSpan = fish.maxHalfWidth * 0.172 * fish.finSpanFactor;

      const ar0x = aLead.x + aLead.nx * (analSide * aHw0 * 0.80);
      const ar0y = aLead.y + aLead.ny * (analSide * aHw0 * 0.80);
      const ar1x = aTrail.x + aTrail.nx * (analSide * aHw1 * 0.76);
      const ar1y = aTrail.y + aTrail.ny * (analSide * aHw1 * 0.76);

      const aOutNx = aTrail.nx * analSide;
      const aOutNy = aTrail.ny * analSide;
      const aBackTx = -aTrail.tx;
      const aBackTy = -aTrail.ty;
      const aLeadNx = aLead.nx * analSide;
      const aLeadNy = aLead.ny * analSide;
      const aLeadBackTx = -aLead.tx;
      const aLeadBackTy = -aLead.ty;

      // Softly rounded apex tucked neatly along the lower peduncle
      const aApexX = ar1x + aOutNx * (aSpan * 0.88) + aBackTx * (aSpan * 0.78);
      const aApexY = ar1y + aOutNy * (aSpan * 0.88) + aBackTy * (aSpan * 0.78);

      const traceAnal = () => {
        ctx.beginPath();
        ctx.moveTo(ar0x, ar0y);
        // Smooth, slender convex outer edge curving gracefully along the peduncle
        ctx.bezierCurveTo(
          ar0x + aLeadNx * (aSpan * 0.74) + aLeadBackTx * (aSpan * 0.42),
          ar0y + aLeadNy * (aSpan * 0.74) + aLeadBackTy * (aSpan * 0.42),
          aApexX + aOutNx * (aSpan * 0.28) - aBackTx * (aSpan * 0.56),
          aApexY + aOutNy * (aSpan * 0.28) - aBackTy * (aSpan * 0.56),
          aApexX,
          aApexY
        );
        // Smooth rounded trailing tip tucking cleanly back into the peduncle
        ctx.bezierCurveTo(
          aApexX - aOutNx * (aSpan * 0.28) + aBackTx * (aSpan * 0.28),
          aApexY - aOutNy * (aSpan * 0.28) + aBackTy * (aSpan * 0.28),
          ar1x + aOutNx * (aSpan * 0.18) + aBackTx * (aSpan * 0.40),
          ar1y + aOutNy * (aSpan * 0.18) + aBackTy * (aSpan * 0.40),
          ar1x,
          ar1y
        );
        ctx.closePath();
      };

      ctx.save();
      traceAnal();
      const ag = ctx.createLinearGradient(
        (ar0x + ar1x) * 0.5,
        (ar0y + ar1y) * 0.5,
        aApexX + aOutNx * (aSpan * 0.12),
        aApexY + aOutNy * (aSpan * 0.12)
      );
      ag.addColorStop(0.0, rgbToRgba(warmBase, 0.94));
      ag.addColorStop(0.45, rgbToRgba(darkenRgb(warmBase, 1.08), 0.94));
      ag.addColorStop(0.85, rgbToRgba(ivoryTip, 0.96));
      ag.addColorStop(1.0, rgbToRgba(ivoryTip, 0.98));
      ctx.fillStyle = ag;
      ctx.fill();

      // Clipped delicate fin rays inside the anal fin
      ctx.save();
      traceAnal();
      ctx.clip();
      const analRayCount = 4;
      for (let r = 0; r < analRayCount; r++) {
        const frac = (r + 0.5) / analRayCount;
        const sx = ar0x + (ar1x - ar0x) * (0.10 + frac * 0.46);
        const sy = ar0y + (ar1y - ar0y) * (0.10 + frac * 0.46);
        const ex =
          aApexX -
          aOutNx * (aSpan * (0.44 - frac * 0.56)) -
          aBackTx * (aSpan * (0.54 - frac * 0.50));
        const ey =
          aApexY -
          aOutNy * (aSpan * (0.44 - frac * 0.56)) -
          aBackTy * (aSpan * (0.54 - frac * 0.50));
        const cx =
          (sx + ex) * 0.5 +
          aOutNx * (aSpan * (0.24 - frac * 0.10)) +
          aBackTx * (aSpan * 0.06);
        const cy =
          (sy + ey) * 0.5 +
          aOutNy * (aSpan * (0.24 - frac * 0.10)) +
          aBackTy * (aSpan * 0.06);

        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.quadraticCurveTo(cx, cy, ex, ey);
        ctx.strokeStyle = rayCol;
        ctx.lineWidth = Math.max(0.6, fish.maxHalfWidth * 0.0085);
        ctx.stroke();
      }
      ctx.restore();

      traceAnal();
      ctx.strokeStyle = finStroke;
      ctx.lineWidth = finOutlineW * 0.78;
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();
    }
  }

  private paintKoiCaudalFin(
    ctx: CanvasRenderingContext2D,
    fish: KoiFish,
    isLight: boolean,
    basePigment: [number, number, number],
    koiExposure = 1.0
  ): void {
    const style = this.artStyle;
    const fin = computeCaudalFin(fish);
    const cfg = CAUDAL_FIN_CONFIG;
    const spine = fish.spine;
    const n = spine.length;
    const tail = spine[n - 1];

    ctx.save();

    // 1. Soft root anchoring shadow under fin base (alpha ~0.25)
    const rootShadowRadius = fin.finLength * cfg.rootZonePct * 1.4;
    const rootShadow = ctx.createRadialGradient(
      tail.x,
      tail.y,
      0,
      tail.x,
      tail.y,
      rootShadowRadius
    );
    rootShadow.addColorStop(0.0, `rgba(0, 0, 0, ${(cfg.baseShadowAlpha * koiExposure).toFixed(3)})`);
    rootShadow.addColorStop(1.0, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = rootShadow;
    ctx.beginPath();
    ctx.arc(tail.x, tail.y, rootShadowRadius, 0, Math.PI * 2);
    ctx.fill();

    // 2. Translucent fin membrane fill with linear root-to-margin gradient along fin axis
    const pc = CAUDAL_FIN_CONFIG.principalRayCount;
    const tc = pc * 2;
    const gx0 = (fin.baseX[0] + fin.baseX[pc - 1]) * 0.5;
    const gy0 = (fin.baseY[0] + fin.baseY[pc - 1]) * 0.5;
    const gx1 = (fin.tipX[0] + fin.tipX[tc - 1]) * 0.5;
    const gy1 = (fin.tipY[0] + fin.tipY[tc - 1]) * 0.5;
    const tailGrad = ctx.createLinearGradient(gx0, gy0, gx1, gy1);

    if (style === "sumie") {
      tailGrad.addColorStop(0.0, rgbToRgba(darkenRgb(basePigment, 0.92), 0.78));
      tailGrad.addColorStop(cfg.rootZonePct, rgbToRgba(darkenRgb(basePigment, 0.96), 0.72));
      tailGrad.addColorStop(0.52, isLight ? "rgba(232, 224, 208, 0.64)" : "rgba(196, 188, 174, 0.56)");
      tailGrad.addColorStop(1.0, isLight ? "rgba(226, 218, 200, 0.42)" : "rgba(164, 158, 146, 0.34)");
    } else {
      tailGrad.addColorStop(0.0, rgbToRgba(darkenRgb(basePigment, 0.92), 0.90));
      tailGrad.addColorStop(cfg.rootZonePct, rgbToRgba(darkenRgb(basePigment, 0.95), 0.90));
      tailGrad.addColorStop(0.50, rgbToRgba(darkenRgb([250, 240, 220], koiExposure), 0.90));
      tailGrad.addColorStop(0.82, rgbToRgba(darkenRgb([242, 228, 202], koiExposure), 0.90));
      tailGrad.addColorStop(1.0, rgbToRgba(darkenRgb([236, 218, 186], koiExposure), 0.90));
    }

    traceCaudalFinPath(ctx, fin);
    ctx.fillStyle = tailGrad;
    ctx.fill();

    // 2b. Outer membrane contour stroke (delicate fading ink edge in Sumi-e)
    ctx.lineWidth = style === "sumie" ? 0.85 : 1.25;
    ctx.strokeStyle =
      style === "sumie"
        ? isLight
          ? "rgba(38, 34, 30, 0.34)"
          : "rgba(212, 204, 190, 0.34)"
        : isLight
          ? "rgba(62, 44, 26, 0.70)"
          : "rgba(215, 195, 160, 0.60)";
    ctx.stroke();

    // 3. High-definition radiating & bifurcating rays strictly clipped to membrane
    const rayStrokeRgb: [number, number, number] =
      style === "sumie"
        ? isLight
          ? [20, 18, 16]
          : [232, 224, 210]
        : isLight
          ? [88, 64, 40]
          : [186, 162, 124];
    strokeCaudalFinRays(ctx, fin, rayStrokeRgb, koiExposure);

    ctx.restore();
  }

  private paintKoiDorsalFin(
    ctx: CanvasRenderingContext2D,
    fish: KoiFish,
    isLight: boolean,
    isSumie: boolean,
    shiroRgb: [number, number, number],
    outlineRgb: [number, number, number],
    _nightDepth: number
  ): void {
    // Wider translucent ivory dorsal ribbon (0.148 * hw, 0.88 alpha) with clear diagonal rays — legible in Day & Night!
    const sStart = 0.36;
    const sEnd = 0.76;
    const steps = 22;
    const maxRibbonW = fish.maxHalfWidth * (isSumie ? 0.148 : 0.144);
    const swayDir = Math.sin(fish.phase - 1.2) * 0.045 + 0.065;

    const leftPts: Array<{ x: number; y: number }> = [];
    const rightPts: Array<{ x: number; y: number }> = [];
    const centerPts: Array<{ x: number; y: number; tx: number; ty: number; nx: number; ny: number }> = [];

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const s = sStart + (sEnd - sStart) * t;
      const frame = this.sampleSpineFrame(fish, s);
      const widthEnv =
        t < 0.09
          ? Math.sin((t / 0.09) * Math.PI * 0.5)
          : Math.pow(1 - (t - 0.09) / 0.91, 0.62);
      const w = maxRibbonW * widthEnv;
      const latDrift = Math.sin(t * Math.PI * 1.15) * fish.maxHalfWidth * swayDir;
      const cx = frame.x + frame.nx * latDrift;
      const cy = frame.y + frame.ny * latDrift;
      centerPts.push({ x: cx, y: cy, tx: frame.tx, ty: frame.ty, nx: frame.nx, ny: frame.ny });
      leftPts.push({ x: cx - frame.nx * w * 0.42, y: cy - frame.ny * w * 0.42 });
      rightPts.push({ x: cx + frame.nx * w * 0.92, y: cy + frame.ny * w * 0.92 });
    }

    const traceRibbon = () => {
      ctx.beginPath();
      ctx.moveTo(centerPts[0].x + centerPts[0].tx * (maxRibbonW * 0.34), centerPts[0].y + centerPts[0].ty * (maxRibbonW * 0.34));
      for (let i = 0; i <= steps; i++) ctx.lineTo(rightPts[i].x, rightPts[i].y);
      ctx.lineTo(centerPts[steps].x - centerPts[steps].tx * (maxRibbonW * 0.52), centerPts[steps].y - centerPts[steps].ty * (maxRibbonW * 0.52));
      for (let i = steps; i >= 0; i--) ctx.lineTo(leftPts[i].x, leftPts[i].y);
      ctx.closePath();
    };

    ctx.save();
    ctx.save();
    ctx.translate(fish.maxHalfWidth * 0.032, fish.maxHalfWidth * 0.024);
    traceRibbon();
    ctx.fillStyle = isLight ? "rgba(18, 12, 8, 0.24)" : "rgba(0, 0, 0, 0.36)";
    ctx.fill();
    ctx.restore();

    traceRibbon();
    ctx.fillStyle = rgbToRgba(darkenRgb(shiroRgb, isLight ? 1.04 : 1.14), 0.90);
    ctx.fill();

    ctx.save();
    ctx.clip();
    for (let i = 1; i < steps; i++) {
      const p0 = leftPts[i];
      const p1 = rightPts[Math.min(steps, i + 2)];
      const mx = (p0.x + p1.x) * 0.5 + centerPts[i].nx * (maxRibbonW * 0.24);
      const my = (p0.y + p1.y) * 0.5 + centerPts[i].ny * (maxRibbonW * 0.24);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.quadraticCurveTo(mx, my, p1.x, p1.y);
      ctx.strokeStyle = isLight
        ? (isSumie ? "rgba(24, 20, 18, 0.52)" : "rgba(104, 76, 48, 0.52)")
        : "rgba(175, 220, 252, 0.48)";
      ctx.lineWidth = Math.max(0.65, fish.maxHalfWidth * 0.0085);
      ctx.stroke();
    }
    ctx.restore();

    if (isSumie) {
      this.strokeCalligraphicPolyline(ctx, rightPts, Math.max(1.5, fish.maxHalfWidth * 0.026), outlineRgb, isLight ? 0.95 : 0.78, fish.seed + 9.1, false);
      this.strokeCalligraphicPolyline(ctx, leftPts, Math.max(0.6, fish.maxHalfWidth * 0.011), outlineRgb, isLight ? 0.40 : 0.30, fish.seed + 11.4, false);
    } else {
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        if (i === 0) ctx.moveTo(rightPts[i].x, rightPts[i].y);
        else ctx.lineTo(rightPts[i].x, rightPts[i].y);
      }
      ctx.strokeStyle = rgbToRgba(outlineRgb, isLight ? 0.86 : 0.74);
      ctx.lineWidth = Math.max(1.2, fish.maxHalfWidth * 0.016);
      ctx.lineJoin = "round";
      ctx.stroke();

      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        if (i === 0) ctx.moveTo(leftPts[i].x, leftPts[i].y);
        else ctx.lineTo(leftPts[i].x, leftPts[i].y);
      }
      ctx.strokeStyle = rgbToRgba(outlineRgb, isLight ? 0.34 : 0.28);
      ctx.lineWidth = Math.max(0.75, fish.maxHalfWidth * 0.009);
      ctx.stroke();
    }
    ctx.restore();
  }

  private paintKoiHeadDetails(
    ctx: CanvasRenderingContext2D,
    fish: KoiFish,
    isLight: boolean,
    isSumie: boolean,
    shiroRgb: [number, number, number],
    outlineRgb: [number, number, number],
    _nightDepth: number
  ): void {
    const strokeCol = rgbToRgba(outlineRgb, isLight ? (isSumie ? 0.95 : 0.88) : 0.74);
    const lineW = Math.max(1.2, fish.maxHalfWidth * (isSumie ? 0.028 : 0.018));

    // === 1. WARMLY MODELED 3D CHEEK OPERCULA (golden-taupe relief + crescent gill crease in S1; fluid brushed arches in S2!) ===
    const gFront = this.sampleSpineFrame(fish, 0.176);
    const gMid = this.sampleSpineFrame(fish, 0.236);
    const gRear = this.sampleSpineFrame(fish, 0.292);
    const hwF = koiBodyHalfWidth(0.176, fish.maxHalfWidth);
    const hwM = koiBodyHalfWidth(0.236, fish.maxHalfWidth);
    const hwR = koiBodyHalfWidth(0.292, fish.maxHalfWidth);

    const gillShade: [number, number, number] = isLight
      ? (isSumie ? [196, 184, 170] : [206, 176, 144])
      : darkenRgb(shiroRgb, 0.76);

    for (const side of [-1, 1] as const) {
      const fx = gFront.x + gFront.nx * (side * hwF * 0.86);
      const fy = gFront.y + gFront.ny * (side * hwF * 0.86);
      const outerX = gMid.x + gMid.nx * (side * hwM * 1.04);
      const outerY = gMid.y + gMid.ny * (side * hwM * 1.04);
      const rearTipX = gRear.x + gRear.nx * (side * hwR * 1.02) - gRear.tx * (fish.maxHalfWidth * 0.08);
      const rearTipY = gRear.y + gRear.ny * (side * hwR * 1.02) - gRear.ty * (fish.maxHalfWidth * 0.08);
      const innerRearX = gRear.x + gRear.nx * (side * hwR * 0.60) + gRear.tx * (fish.maxHalfWidth * 0.12);
      const innerRearY = gRear.y + gRear.ny * (side * hwR * 0.60) + gRear.ty * (fish.maxHalfWidth * 0.12);
      const innerMidX = gMid.x + gMid.nx * (side * hwM * 0.68);
      const innerMidY = gMid.y + gMid.ny * (side * hwM * 0.68);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.quadraticCurveTo(outerX, outerY, rearTipX, rearTipY);
      ctx.quadraticCurveTo(
        gRear.x + gRear.nx * (side * hwR * 0.84) - gRear.tx * (fish.maxHalfWidth * 0.02),
        gRear.y + gRear.ny * (side * hwR * 0.84) - gRear.ty * (fish.maxHalfWidth * 0.02),
        innerRearX,
        innerRearY
      );
      ctx.quadraticCurveTo(innerMidX, innerMidY, fx, fy);
      ctx.closePath();

      const gg = ctx.createLinearGradient(innerMidX, innerMidY, outerX, outerY);
      gg.addColorStop(0.0, rgbToRgba(shiroRgb, 0.35));
      gg.addColorStop(0.45, rgbToRgba(darkenRgb(shiroRgb, 0.90), 0.92));
      gg.addColorStop(1.0, rgbToRgba(gillShade, 0.98));
      ctx.fillStyle = gg;
      ctx.fill();

      ctx.save();
      ctx.clip();
      for (let st = 0; st < 4; st++) {
        const f = 0.22 + st * 0.20;
        const p0x = fx + (innerRearX - fx) * f;
        const p0y = fy + (innerRearY - fy) * f;
        const p1x = outerX + (rearTipX - outerX) * (f * 0.94);
        const p1y = outerY + (rearTipY - outerY) * (f * 0.94);
        ctx.beginPath();
        ctx.moveTo(p0x, p0y);
        ctx.quadraticCurveTo(
          (p0x + p1x) * 0.5 + gMid.tx * (fish.maxHalfWidth * 0.08),
          (p0y + p1y) * 0.5 + gMid.ty * (fish.maxHalfWidth * 0.08),
          p1x,
          p1y
        );
        ctx.strokeStyle = isLight
          ? (isSumie ? "rgba(24, 20, 18, 0.52)" : "rgba(116, 82, 52, 0.64)")
          : "rgba(10, 18, 28, 0.46)";
        ctx.lineWidth = Math.max(0.8, fish.maxHalfWidth * 0.0105);
        ctx.stroke();
      }
      ctx.restore();

      if (isSumie) {
        const gPts = [
          { x: fx, y: fy },
          { x: outerX, y: outerY },
          { x: rearTipX, y: rearTipY },
          { x: (rearTipX + innerRearX) * 0.5, y: (rearTipY + innerRearY) * 0.5 },
          { x: innerRearX, y: innerRearY },
        ];
        this.strokeCalligraphicPolyline(ctx, gPts, lineW * 1.35, outlineRgb, isLight ? 0.95 : 0.78, fish.seed + side * 5.2, false);
      } else {
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.quadraticCurveTo(outerX, outerY, rearTipX, rearTipY);
        ctx.quadraticCurveTo(
          gRear.x + gRear.nx * (side * hwR * 0.84) - gRear.tx * (fish.maxHalfWidth * 0.02),
          gRear.y + gRear.ny * (side * hwR * 0.84) - gRear.ty * (fish.maxHalfWidth * 0.02),
          innerRearX,
          innerRearY
        );
        ctx.strokeStyle = strokeCol;
        ctx.lineWidth = lineW * 1.05;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();
      }
      ctx.restore();
    }

    // === 2. LEGIBLE ALMOND-DOMED LATERAL EYES ALIGNED TANGENT TO THE TAPERING CHEEK (ZERO FRONT GAP!) ===
    const aheadF = this.sampleSpineFrame(fish, 0.092);
    const behindF = this.sampleSpineFrame(fish, 0.158);
    const aheadHw = koiBodyHalfWidth(0.092, fish.maxHalfWidth);
    const behindHw = koiBodyHalfWidth(0.158, fish.maxHalfWidth);
    const eyeRx = fish.maxHalfWidth * 0.158;
    const eyeRy = fish.maxHalfWidth * 0.082;

    for (const side of [-1, 1] as const) {
      // Exact cheek contour points ahead (toward whiskers) and behind the eye
      const ax = aheadF.x + aheadF.nx * (side * aheadHw * 0.97);
      const ay = aheadF.y + aheadF.ny * (side * aheadHw * 0.97);
      const bx = behindF.x + behindF.nx * (side * behindHw * 0.97);
      const by = behindF.y + behindF.ny * (side * behindHw * 0.97);
      // Center on cheek chord midpoint, nudged slightly inward so BOTH front & rear corners touch the koi flush!
      const cDx = ax - bx;
      const cDy = ay - by;
      const cLen = Math.hypot(cDx, cDy) || 1;
      const cheekAngle = Math.atan2(cDy, cDx);
      // Outward normal of the cheek chord (points outward on `side`)
      const outNx = (-cDy / cLen) * side;
      const outNy = (cDx / cLen) * side;
      const ex = (ax + bx) * 0.5 - outNx * (eyeRy * 0.22);
      const ey = (ay + by) * 0.5 - outNy * (eyeRy * 0.22);

      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(cheekAngle);

      // Soft warm orbital socket shadow hugging the cheek
      ctx.beginPath();
      ctx.ellipse(0, 0, eyeRx * 1.10, eyeRy * 1.12, 0, side > 0 ? 0 : Math.PI, side > 0 ? Math.PI : Math.PI * 2, false);
      ctx.fillStyle = isLight ? "rgba(118, 92, 66, 0.48)" : "rgba(6, 12, 20, 0.55)";
      ctx.fill();

      // Glossy obsidian almond eye bulge seated flush along the cheek contour
      ctx.beginPath();
      ctx.ellipse(0, 0, eyeRx * 0.94, eyeRy * 0.90, 0, side > 0 ? 0 : Math.PI, side > 0 ? Math.PI : Math.PI * 2, false);
      ctx.fillStyle = isLight ? "rgba(16, 14, 12, 0.96)" : "rgba(4, 10, 16, 0.96)";
      ctx.fill();
      ctx.strokeStyle = strokeCol;
      ctx.lineWidth = lineW * 0.72;
      ctx.stroke();

      if (isLight) {
        ctx.beginPath();
        ctx.arc(eyeRx * 0.24, side * eyeRy * 0.36, Math.max(1.0, eyeRy * 0.19), 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255, 248, 236, 0.72)";
        ctx.fill();
      }
      ctx.restore();
    }

    // === 3. SNOUT-MARGIN TEARDROP NOSTRIL PITS (NARES: s = 0.060, u = ±0.74) ===
    const nFrame = this.sampleSpineFrame(fish, 0.060);
    const nHw = koiBodyHalfWidth(0.060, fish.maxHalfWidth);
    const nRad = Math.max(1.1, fish.maxHalfWidth * (isSumie ? 0.032 : 0.023));

    for (const side of [-1, 1] as const) {
      const nx = nFrame.x + nFrame.nx * (side * nHw * 0.74);
      const ny = nFrame.y + nFrame.ny * (side * nHw * 0.74);
      ctx.save();
      if (!isSumie) {
        ctx.beginPath();
        ctx.ellipse(nx, ny, nRad * 1.65, nRad * 1.15, side * 0.45, 0, Math.PI * 2);
        ctx.fillStyle = isLight ? "rgba(142, 114, 88, 0.52)" : "rgba(10, 20, 32, 0.42)";
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(nx, ny, nRad * 0.82, nRad * 0.62, side * 0.45, 0, Math.PI * 2);
        ctx.fillStyle = strokeCol;
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.ellipse(nx, ny, nRad * 1.15, nRad * 0.85, side * 0.40, 0, Math.PI * 2);
        ctx.fillStyle = strokeCol;
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /**
   * Draws a portrait image (`Saayan_artistic.png` or `saayan_artistic_ink.png`) completely filling
   * `(ix, iy, iw, ih)` with zero gap, while preserving the full right-hand side where the vertical
   * calligraphy (`寫樂畫風に倣ふ`) and red hanko seal reside so the text is 100% visible.
   */
  private drawFlushPortrait(
    targetCtx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    dx: number,
    dy: number,
    dw: number,
    dh: number
  ): void {
    // Base painting reference dimensions (997 x 1506)
    const baseW = 997;
    const baseH = 1506;
    const dstAspect = dw / Math.max(1, dh);
    const srcAspect = baseW / baseH;

    let sx = 0;
    let sy = 0;
    let sWidth = baseW;
    let sHeight = baseH;

    if (dstAspect < srcAspect) {
      // Frame is narrower than the 2:3 painting: keep right-anchored crop in painting space
      sWidth = Math.round(Math.max(baseW * 0.88, baseH * dstAspect));
      if (sWidth > baseW) sWidth = baseW;
      sx = baseW - sWidth;
    } else {
      sHeight = Math.round(baseW / dstAspect);
      if (sHeight > baseH) sHeight = baseH;
      sy = Math.round((baseH - sHeight) * 0.38);
    }

    if (img === this.portraitRealImg) {
      // Unmodified saayan_real.png (1025 x 1534): apply strictly uniform 1:1 scale (s = 0.760)
      // and translation (ox = 146.0, oy = 143.0) so the face, eyeglasses, eyes, ear, nose, and chin
      // lock directly onto the painting's face/glasses with zero distortion.
      // In Ink style (sumie), render the revealed real portrait in pure Black & White.
      const s = 0.76;
      const ox = 146.0;
      const oy = 143.0;
      const srcImg: CanvasImageSource =
        this.artStyle === "sumie" ? this.getPortraitRealBwCanvas(img) : img;
      targetCtx.drawImage(
        srcImg,
        sx * s + ox,
        sy * s + oy,
        sWidth * s,
        sHeight * s,
        dx,
        dy,
        dw,
        dh
      );
      return;
    }

    targetCtx.drawImage(img, sx, sy, sWidth, sHeight, dx, dy, dw, dh);
  }

  /**
   * Renders the KOI Portfolio Frame Portrait and its style-switch transition strictly clipped
   * inside the frame opening `(ix, iy, iw, ih)` tucked underneath the red frame bars:
   * - Switching TO Ink style (`mokkotsu` -> `sumie`): Organic Sumi Ink Splatter Luma/Alpha Matte
   *   fills the frame (never spilling outside) to reveal `saayan_artistic_ink.png`.
   * - Switching TO Default style (`sumie` -> `mokkotsu`): Burning Washi Flame Transition
   *   with charred black/umber edge, glowing ember line, and flickering multi-layered flames
   *   burns inside the frame to reveal `Saayan_artistic.png`.
   */
  private paintKoiFramePortraitAndTransition(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    dcx: number,
    dcy: number
  ): void {
    const defImg = this.portraitDefaultImg;
    const inkImg = this.portraitInkImg;
    const hasDef = !!(defImg && (this.portraitDefaultLoaded || defImg.width > 0));
    const hasInk = !!(inkImg && (this.portraitInkLoaded || inkImg.width > 0));
    if (!hasDef && !hasInk) return;

    // Tuck the portrait rect directly underneath the solid midpoint of the 13px outer rim of RED_KOI_BORDER_URI
    // (0.042 * dcx, 0.028 * dcy) so it sits inside the rounded outer corners AND leaves zero inner gap
    const insetX = Math.max(3, Math.round(dcx * 0.042));
    const insetY = Math.max(3, Math.round(dcy * 0.028));
    const ix = Math.round(x + insetX);
    const iy = Math.round(y + insetY);
    const iw = Math.max(16, Math.round(w - insetX * 2));
    const ih = Math.max(16, Math.round(h - insetY * 2));

    ctx.save();
    ctx.beginPath();
    ctx.rect(ix, iy, iw, ih);
    ctx.clip();
    ctx.fillStyle = "#050403";
    ctx.fillRect(ix, iy, iw, ih);

    const targetImg = this.getPortraitImageByKind(this.getTargetPortraitKind());
    const fromImg = this.getPortraitImageByKind(this.portraitTransFromKind);
    const toImg = this.getPortraitImageByKind(this.portraitTransToKind);

    // Pre-warm the FBM burn field and portrait pixel buffers so clicking (1st or 2nd time) never stalls
    if (this.artStyle !== "sumie") {
      this.ensurePortraitBurnField(iw, ih);
      if (this.portraitDefaultImg && (this.portraitDefaultLoaded || this.portraitDefaultImg.width > 0)) {
        this.getPortraitPixelBuffer("default", this.portraitDefaultImg, iw, ih);
      }
      if (this.portraitRealImg && (this.portraitRealLoaded || this.portraitRealImg.width > 0)) {
        this.getPortraitPixelBuffer("real", this.portraitRealImg, iw, ih);
      }
    }

    const transActive =
      this.portraitStyleTransActive &&
      !!fromImg &&
      !!toImg;

    if (!transActive) {
      if (targetImg) {
        this.drawFlushPortrait(ctx, targetImg, ix, iy, iw, ih);
      }
      if (!this.portraitGlazeDismissed && !this.portraitPhotoRevealed) {
        this.paintPortraitGoldenGlaze(ctx, ix, iy, iw, ih);
      }
      ctx.restore();
      return;
    }

    const p = koiClamp(this.portraitStyleTransProgress, 0, 1);
    const tCanvas = this.portraitTransCanvas ?? document.createElement("canvas");
    if (tCanvas.width !== iw || tCanvas.height !== ih) {
      tCanvas.width = iw;
      tCanvas.height = ih;
    }
    this.portraitTransCanvas = tCanvas;
    const tCtx = tCanvas.getContext("2d");
    if (!tCtx) {
      if (targetImg) {
        this.drawFlushPortrait(ctx, targetImg, ix, iy, iw, ih);
      }
      ctx.restore();
      return;
    }

    if (this.portraitStyleTransMode === "ink") {
      // ── 1. ORGANIC SUMI INK SPLATTER & CAPILLARY BLEED TRANSITION ──
      // Base layer: starting image (e.g. Sumi-e Ink painting)
      this.drawFlushPortrait(ctx, fromImg!, ix, iy, iw, ih);

      tCtx.save();
      tCtx.globalCompositeOperation = "source-over";
      tCtx.clearRect(0, 0, iw, ih);
      tCtx.fillStyle = "#000000";

      const maxDiag = Math.hypot(iw, ih);
      // 18 staggered Sumi ink drop impact sites across the frame
      const SPLAT_CENTERS: [number, number, number][] = [
        [0.50, 0.48, 0.00],
        [0.26, 0.30, 0.04],
        [0.74, 0.28, 0.07],
        [0.30, 0.70, 0.10],
        [0.72, 0.72, 0.13],
        [0.50, 0.20, 0.16],
        [0.20, 0.50, 0.19],
        [0.80, 0.52, 0.22],
        [0.48, 0.82, 0.25],
        [0.15, 0.15, 0.28],
        [0.85, 0.16, 0.31],
        [0.16, 0.86, 0.34],
        [0.86, 0.85, 0.37],
        [0.38, 0.40, 0.08],
        [0.62, 0.58, 0.12],
        [0.35, 0.22, 0.21],
        [0.66, 0.82, 0.26],
        [0.50, 0.50, 0.02],
      ];

      // Draw each ink splatter as an organic crown of overlapping round/teardrop ink lobes & fine mist droplets (zero polygon lines!)
      const paintOrganicSplatterCluster = (
        target: CanvasRenderingContext2D,
        cx: number,
        cy: number,
        baseR: number,
        seed: number,
        localP: number
      ) => {
        // 1. Central round ink drop core
        target.beginPath();
        target.arc(cx, cy, baseR * 0.72, 0, Math.PI * 2);
        target.fill();

        // 2. Crown of 22 overlapping circular capillary lobes around the core (creates authentic scalloped ink-blot edge)
        const numLobes = 22;
        for (let k = 0; k < numLobes; k++) {
          const ang = (k / numLobes) * Math.PI * 2 + seed * 0.71;
          const h1 = 0.5 + 0.5 * Math.sin(k * 3.7 + seed * 5.3);
          const h2 = 0.5 + 0.5 * Math.cos(k * 5.9 - seed * 2.9);
          const dist = baseR * (0.48 + 0.38 * h1);
          const lobeR = baseR * (0.22 + 0.24 * h2);
          target.beginPath();
          target.arc(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, lobeR, 0, Math.PI * 2);
          target.fill();
        }

        // 3. Secondary ring of smaller satellite ink splatter beads & mist dots shooting outward on impact
        const shoot = 1 - Math.pow(1 - Math.min(1, localP * 1.8), 2.2);
        const numBeads = 18;
        for (let d = 0; d < numBeads; d++) {
          const dAng = (d / numBeads) * Math.PI * 2 + seed * 1.93 + Math.sin(d * 2.7) * 0.15;
          const h = 0.5 + 0.5 * Math.sin(d * 4.3 + seed * 7.1);
          const dist = baseR * (0.78 + 0.55 * shoot * h);
          const beadR = Math.max(1.8, baseR * (0.04 + 0.09 * (1 - h)) * (1 - localP * 0.2));
          const bx = cx + Math.cos(dAng) * dist;
          const by = cy + Math.sin(dAng) * dist;
          target.beginPath();
          target.arc(bx, by, beadR, 0, Math.PI * 2);
          target.fill();

          // Intermediate bridge droplet between core and outer bead for realistic teardrop splatter chains
          if (d % 2 === 0) {
            const midDist = baseR * (0.68 + 0.28 * shoot * h);
            target.beginPath();
            target.arc(
              cx + Math.cos(dAng) * midDist,
              cy + Math.sin(dAng) * midDist,
              beadR * 1.35,
              0,
              Math.PI * 2
            );
            target.fill();
          }
        }
      };

      // First pass: dark Sumi-ink splatter rim on main ctx right around the expanding splatters
      if (p < 0.96) {
        const bleedAlpha = (1 - koiSmoothstep(0.74, 0.98, p)) * 0.88;
        ctx.save();
        ctx.fillStyle = `rgba(14, 12, 10, ${bleedAlpha.toFixed(3)})`;
        for (let i = 0; i < SPLAT_CENTERS.length; i++) {
          const [nx, ny, delay] = SPLAT_CENTERS[i];
          const localP = koiClamp((p - delay * 1.35) / (1 - delay * 1.15), 0, 1);
          if (localP <= 0.005) continue;
          const ease = localP < 0.7 ? localP * 0.62 : 0.434 + ((localP - 0.7) / 0.3) * 0.566;
          const cx = ix + nx * iw;
          const cy = iy + ny * ih;
          const baseR = ease * maxDiag * 0.34 + 6.5 * (1 - localP * 0.5);
          paintOrganicSplatterCluster(ctx, cx, cy, baseR, i + 1, localP);
        }
        ctx.restore();
      }

      // Second pass: crisp alpha mask on tCtx that reveals `portraitInkImg` inside the ink splatters
      for (let i = 0; i < SPLAT_CENTERS.length; i++) {
        const [nx, ny, delay] = SPLAT_CENTERS[i];
        const localP = koiClamp((p - delay * 1.35) / (1 - delay * 1.15), 0, 1);
        if (localP <= 0.005) continue;
        const ease = localP < 0.7 ? localP * 0.62 : 0.434 + ((localP - 0.7) / 0.3) * 0.566;
        const cx = nx * iw;
        const cy = ny * ih;
        const baseR = ease * maxDiag * 0.34;
        paintOrganicSplatterCluster(tCtx, cx, cy, baseR, i + 1, localP);
      }

      tCtx.globalCompositeOperation = "source-in";
      this.drawFlushPortrait(tCtx, toImg!, 0, 0, iw, ih);
      tCtx.restore();

      ctx.drawImage(tCanvas, ix, iy);
    } else {
      // ── 2. PER-PIXEL 2D DOMAIN-WARPED FBM PAPER-BURN & GLOWING EMBER SHADER ──
      this.paintPerPixelFbmPaperBurn(
        ctx,
        tCtx,
        tCanvas,
        this.portraitTransToKind,
        toImg!,
        this.portraitTransFromKind,
        fromImg!,
        ix,
        iy,
        iw,
        ih,
        p
      );
    }

    ctx.restore();
  }

  /**
   * Paints a subtle, organic gold-leaf glaze sweeping from the bottom-right corner
   * to the top-left corner of the portrait painting as a gentle visual cue to click.
   * Uses layered feathered elliptical gold-leaf blooms, an S-curved warm specular wave,
   * and delicate kinpaku shimmer motes (never a rigid diagonal rectangle).
   */
  private paintPortraitGoldenGlaze(
    ctx: CanvasRenderingContext2D,
    ix: number,
    iy: number,
    iw: number,
    ih: number
  ): void {
    const nowSec = (typeof performance !== "undefined" ? performance.now() : Date.now()) * 0.001;
    const cycleSec = 5.4;
    const sweepSec = 2.05;
    const phaseT = nowSec % cycleSec;
    if (phaseT > sweepSec) return;

    // Smooth ease-in-out sweep from 0 (bottom-right) to 1 (top-left)
    const rawU = phaseT / sweepSec;
    const u = rawU < 0.5
      ? 2 * rawU * rawU
      : 1 - Math.pow(-2 * rawU + 2, 2) / 2;

    // Gentle organic envelope so the glaze blooms softly in and dissolves out
    const env = Math.pow(Math.sin(Math.PI * rawU), 0.72);
    if (env <= 0.004) return;

    const diag = Math.hypot(iw, ih);
    const invDiag = 1 / Math.max(1, diag);
    // Direction vector from bottom-right -> top-left
    const dirX = -iw * invDiag;
    const dirY = -ih * invDiag;
    // Perpendicular vector (runs along the glaze wave crest, bottom-left <-> top-right)
    const perpX = -dirY;
    const perpY = dirX;
    const angleRad = Math.atan2(perpY, perpX);

    // Travel from just outside bottom-right (-0.24) to just past top-left (1.24)
    const travel = -0.24 + u * 1.48;
    const cx = ix + iw * (1 - travel);
    const cy = iy + ih * (1 - travel);

    // Slightly warmer/softer tuning in Sumi-e so it harmonizes with monochrome ink while staying gold
    const styleScale = this.artStyle === "sumie" ? 0.84 : 1.0;

    ctx.save();

    // 1. Broad, diffused antique-gold atmospheric glaze (warm lacquer undertone)
    ctx.globalCompositeOperation = "soft-light";
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angleRad);
    ctx.scale(1.0, 0.36);
    const washR = diag * 0.54;
    const washGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, washR);
    washGrad.addColorStop(0.0, `rgba(232, 186, 84, ${(0.34 * env * styleScale).toFixed(4)})`);
    washGrad.addColorStop(0.45, `rgba(198, 145, 44, ${(0.20 * env * styleScale).toFixed(4)})`);
    washGrad.addColorStop(0.82, `rgba(156, 108, 26, ${(0.07 * env * styleScale).toFixed(4)})`);
    washGrad.addColorStop(1.0, "rgba(156, 108, 26, 0)");
    ctx.fillStyle = washGrad;
    ctx.beginPath();
    ctx.arc(0, 0, washR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 2. Organic multi-lobe undulating gold-leaf sheen (3 feathered caustic pockets along a curved crest)
    ctx.globalCompositeOperation = "screen";
    const lobes: [number, number, number, number, string, string, number][] = [
      // [crestOffsetFrac, trailOffsetFrac, rxScale, ryScale, coreRgb, midRgb, alpha]
      [-0.24,  0.032, 0.34, 0.115, "255, 236, 176", "218, 168, 66", 0.22],
      [ 0.02, -0.018, 0.38, 0.125, "255, 244, 204", "232, 184, 78", 0.28],
      [ 0.27,  0.026, 0.32, 0.105, "248, 222, 148", "194, 142, 46", 0.20],
    ];

    for (let i = 0; i < lobes.length; i++) {
      const [crestF, trailF, rxS, ryS, coreRgb, midRgb, baseA] = lobes[i];
      // Subtle organic wave undulation along the travel direction
      const waveWobble = Math.sin(u * Math.PI * 2.4 + i * 2.15) * diag * 0.024;
      const lx = cx + perpX * (crestF * diag) + dirX * (trailF * diag + waveWobble);
      const ly = cy + perpY * (crestF * diag) + dirY * (trailF * diag + waveWobble);
      const lobeTilt = angleRad + Math.sin(u * Math.PI * 1.8 + i * 1.7) * 0.085;
      const rx = diag * rxS;
      const ry = diag * ryS;

      ctx.save();
      ctx.translate(lx, ly);
      ctx.rotate(lobeTilt);
      ctx.scale(1.0, ry / Math.max(1, rx));
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      const a0 = baseA * env * styleScale;
      g.addColorStop(0.0, `rgba(${coreRgb}, ${a0.toFixed(4)})`);
      g.addColorStop(0.38, `rgba(${midRgb}, ${(a0 * 0.56).toFixed(4)})`);
      g.addColorStop(0.75, `rgba(176, 124, 34, ${(a0 * 0.16).toFixed(4)})`);
      g.addColorStop(1.0, "rgba(176, 124, 34, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 3. Delicate curved champagne-gold liquid filament along the leading crest
    ctx.save();
    const spanHalf = diag * 0.48;
    const p0x = cx - perpX * spanHalf + dirX * (diag * 0.03);
    const p0y = cy - perpY * spanHalf + dirY * (diag * 0.03);
    const p1x = cx + perpX * spanHalf + dirX * (diag * 0.03);
    const p1y = cy + perpY * spanHalf + dirY * (diag * 0.03);
    const bow = diag * (0.055 + 0.018 * Math.sin(u * Math.PI * 2.0));
    const ctrlX = cx + dirX * bow;
    const ctrlY = cy + dirY * bow;

    const crestGrad = ctx.createLinearGradient(p0x, p0y, p1x, p1y);
    crestGrad.addColorStop(0.0, "rgba(255, 240, 192, 0)");
    crestGrad.addColorStop(0.28, `rgba(242, 200, 108, ${(0.18 * env * styleScale).toFixed(4)})`);
    crestGrad.addColorStop(0.52, `rgba(255, 246, 214, ${(0.28 * env * styleScale).toFixed(4)})`);
    crestGrad.addColorStop(0.76, `rgba(232, 186, 88, ${(0.16 * env * styleScale).toFixed(4)})`);
    crestGrad.addColorStop(1.0, "rgba(255, 240, 192, 0)");

    ctx.strokeStyle = crestGrad;
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(4, diag * 0.028);
    ctx.filter = "blur(6px)";
    ctx.beginPath();
    ctx.moveTo(p0x, p0y);
    ctx.quadraticCurveTo(ctrlX, ctrlY, p1x, p1y);
    ctx.stroke();
    ctx.filter = "none";
    ctx.restore();

    // 4. Fine kinpaku (gold-leaf) pinpoint motes catching light strictly as the glaze passes
    const moteCount = 12;
    for (let m = 0; m < moteCount; m++) {
      // Deterministic pseudo-random portrait coordinates
      const hx = ((Math.sin(m * 12.9898 + 4.1414) * 43758.5453) % 1 + 1) % 1;
      const hy = ((Math.sin(m * 78.233 + 1.9173) * 28461.7321) % 1 + 1) % 1;
      const mx = ix + (0.08 + hx * 0.84) * iw;
      const my = iy + (0.08 + hy * 0.84) * ih;
      // Signed distance of mote along the bottom-right -> top-left wave axis
      const dAlong = (mx - cx) * dirX + (my - cy) * dirY;
      const bandSigma = diag * 0.11;
      const prox = Math.exp(-(dAlong * dAlong) / (2 * bandSigma * bandSigma));
      if (prox < 0.08) continue;

      const twinkle = 0.55 + 0.45 * Math.sin(nowSec * 6.2 + m * 2.7);
      const moteA = 0.46 * env * prox * twinkle * styleScale;
      const moteR = Math.max(1.2, diag * (0.004 + (m % 3) * 0.0018));
      const mg = ctx.createRadialGradient(mx, my, 0, mx, my, moteR * 2.4);
      mg.addColorStop(0.0, `rgba(255, 248, 220, ${moteA.toFixed(4)})`);
      mg.addColorStop(0.45, `rgba(236, 190, 88, ${(moteA * 0.5).toFixed(4)})`);
      mg.addColorStop(1.0, "rgba(236, 190, 88, 0)");
      ctx.fillStyle = mg;
      ctx.beginPath();
      ctx.arc(mx, my, moteR * 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  private ensurePortraitBurnField(iw: number, ih: number): Float32Array {
    const fKey = `${iw}x${ih}`;
    if (this.portraitBurnField && this.portraitBurnFieldKey === fKey) {
      return this.portraitBurnField;
    }
    this.portraitBurnFieldKey = fKey;
    const nPixels = iw * ih;
    const field = new Float32Array(nPixels);
    const SEEDS: [number, number, number][] = [
      [0.48, 0.52, 0.00],
      [0.22, 0.30, 0.06],
      [0.78, 0.34, 0.09],
      [0.28, 0.76, 0.12],
      [0.74, 0.72, 0.15],
      [0.52, 0.18, 0.18],
    ];
    let minV = Infinity;
    let maxV = -Infinity;
    const invW = 1 / Math.max(1, iw);
    const invH = 1 / Math.max(1, ih);

    for (let py = 0; py < ih; py++) {
      const ny = py * invH;
      for (let px = 0; px < iw; px++) {
        const nx = px * invW;
        let minSeedDist = Infinity;
        for (let s = 0; s < SEEDS.length; s++) {
          const dx = (nx - SEEDS[s][0]) * 1.15;
          const dy = (ny - SEEDS[s][1]) * 1.45;
          const d = Math.hypot(dx, dy) + SEEDS[s][2];
          if (d < minSeedDist) minSeedDist = d;
        }
        const wx = nx * 4.2 + 0.35 * Math.sin(ny * 9.5 + nx * 6.2);
        const wy = ny * 5.8 + 0.35 * Math.cos(nx * 9.5 - ny * 5.4);
        const n1 = fbm2D(wx, wy, 17);
        const n2 = fbm2D(wx * 2.35 + 3.1, wy * 2.35 - 1.9, 43);
        const n3 = fbm2D(nx * 18.0, ny * 18.0, 89);
        const raw = minSeedDist * 0.72 + n1 * 0.42 + n2 * 0.22 + n3 * 0.09;
        field[py * iw + px] = raw;
        if (raw < minV) minV = raw;
        if (raw > maxV) maxV = raw;
      }
    }

    const span = Math.max(1e-4, maxV - minV);
    for (let i = 0; i < nPixels; i++) {
      field[i] = (field[i] - minV) / span;
    }
    this.portraitBurnField = field;
    return field;
  }

  private getPortraitRealBwCanvas(img: HTMLImageElement): HTMLCanvasElement {
    const w = img.naturalWidth || img.width || 1025;
    const h = img.naturalHeight || img.height || 1534;
    if (this.portraitRealBwCanvas && this.portraitRealBwCanvas.width === w && this.portraitRealBwCanvas.height === h) {
      return this.portraitRealBwCanvas;
    }
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const cCtx = c.getContext("2d", { willReadFrequently: true });
    if (cCtx) {
      cCtx.drawImage(img, 0, 0, w, h);
      const imgData = cCtx.getImageData(0, 0, w, h);
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        const lum = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
        data[i] = lum;
        data[i + 1] = lum;
        data[i + 2] = lum;
      }
      cCtx.putImageData(imgData, 0, 0);
    }
    this.portraitRealBwCanvas = c;
    return c;
  }

  private getPortraitPixelBuffer(
    kind: "default" | "ink" | "real",
    img: HTMLImageElement,
    iw: number,
    ih: number
  ): Uint8ClampedArray | null {
    const bKey = `${kind}:${this.artStyle}:${iw}x${ih}:${img.naturalWidth || img.width}`;
    if (this.portraitPixelBuffers[bKey]) {
      return this.portraitPixelBuffers[bKey];
    }
    const bCanvas = this.portraitBufScratchCanvas ?? document.createElement("canvas");
    if (bCanvas.width !== iw || bCanvas.height !== ih) {
      bCanvas.width = iw;
      bCanvas.height = ih;
    }
    this.portraitBufScratchCanvas = bCanvas;
    const bCtx = bCanvas.getContext("2d", { willReadFrequently: true });
    if (!bCtx) return null;
    bCtx.save();
    bCtx.globalCompositeOperation = "source-over";
    bCtx.clearRect(0, 0, iw, ih);
    this.drawFlushPortrait(bCtx, img, 0, 0, iw, ih);
    const data = new Uint8ClampedArray(bCtx.getImageData(0, 0, iw, ih).data);
    bCtx.restore();
    this.portraitPixelBuffers[bKey] = data;
    return data;
  }

  private paintPerPixelFbmPaperBurn(
    ctx: CanvasRenderingContext2D,
    tCtx: CanvasRenderingContext2D,
    tCanvas: HTMLCanvasElement,
    toKind: "default" | "ink" | "real",
    toImg: HTMLImageElement,
    fromKind: "default" | "ink" | "real",
    fromImg: HTMLImageElement,
    ix: number,
    iy: number,
    iw: number,
    ih: number,
    p: number
  ): void {
    const nPixels = iw * ih;
    const field = this.ensurePortraitBurnField(iw, ih);
    const defData = this.getPortraitPixelBuffer(toKind, toImg, iw, ih);
    const inkData = this.getPortraitPixelBuffer(fromKind, fromImg, iw, ih);
    if (!defData || !inkData) {
      this.drawFlushPortrait(ctx, p < 0.5 ? fromImg : toImg, ix, iy, iw, ih);
      return;
    }

    const outKey = `${iw}x${ih}`;
    if (!this.portraitBurnOutImgData || this.portraitBurnOutKey !== outKey) {
      this.portraitBurnOutKey = outKey;
      this.portraitBurnOutImgData = tCtx.createImageData(iw, ih);
    }
    const outImg = this.portraitBurnOutImgData;
    const out = outImg.data;

    // Advance burn front across [0 .. 1.16] so at p=0 it is 100% Ink and at p=1 it is 100% Default
    const thresh = p * 1.18 - 0.04;
    const flickerTime = p * 38.0;

    for (let i = 0; i < nPixels; i++) {
      const idx = i << 2;
      const v = field[i];
      // Add subtle high-frequency live flame shimmer along the active ember edge
      const shimmer = 0.008 * Math.sin((i % iw) * 0.22 + flickerTime) * Math.cos(((i / iw) | 0) * 0.19 - flickerTime * 1.3);
      const d = v + shimmer - thresh;

      if (d < -0.088) {
        // Zone 1: Completely burned away -> reveal crisp Default Ukiyo-e portrait
        out[idx] = defData[idx];
        out[idx + 1] = defData[idx + 1];
        out[idx + 2] = defData[idx + 2];
        out[idx + 3] = 255;
      } else if (d < -0.048) {
        // Zone 2: Inner incandescent white-hot -> yellow-gold flame core blending from Default portrait
        const u = (d - -0.088) / 0.040; // 0 at inner edge -> 1 at flame crest
        const coreR = 255;
        const coreG = Math.round(250 - (1 - u) * 35);
        const coreB = Math.round(210 * u);
        const mix = u * u * (3 - 2 * u);
        out[idx] = Math.round(defData[idx] * (1 - mix) + coreR * mix);
        out[idx + 1] = Math.round(defData[idx + 1] * (1 - mix) + coreG * mix);
        out[idx + 2] = Math.round(defData[idx + 2] * (1 - mix) + coreB * mix);
        out[idx + 3] = 255;
      } else if (d < -0.012) {
        // Zone 3: Blazing yellow-gold -> fiery orange-red smoldering ember rim
        const u = (d - -0.048) / 0.036; // 0 = white-gold -> 1 = deep crimson-orange ember
        out[idx] = Math.round(255 - u * 45);
        out[idx + 1] = Math.round(215 * (1 - u * 0.82));
        out[idx + 2] = Math.round(110 * Math.pow(1 - u, 2.4));
        out[idx + 3] = 255;
      } else if (d < 0.028) {
        // Zone 4: Deep crimson ember -> carbon-black charred Washi paper edge
        const u = (d - -0.012) / 0.040; // 0 = crimson ember -> 1 = carbon-black char
        const charR = 14;
        const charG = 6;
        const charB = 3;
        out[idx] = Math.round(210 * (1 - u) + charR * u);
        out[idx + 1] = Math.round(38 * (1 - u) + charG * u);
        out[idx + 2] = Math.round(4 * (1 - u) + charB * u);
        out[idx + 3] = 255;
      } else if (d < 0.085) {
        // Zone 5: Carbon-black char -> warm toasted sepia scorch halo -> untouched Ink portrait
        const u = (d - 0.028) / 0.057; // 0 = char -> 1 = untouched Ink portrait
        const ir = inkData[idx];
        const ig = inkData[idx + 1];
        const ib = inkData[idx + 2];
        // Warm toasted sepia tint in the middle of the scorch halo
        const sepiaAmt = Math.sin(u * Math.PI) * 0.65;
        const tr = ir * (1 - sepiaAmt) + (ir * 0.58 + 38) * sepiaAmt;
        const tg = ig * (1 - sepiaAmt) + (ig * 0.34 + 14) * sepiaAmt;
        const tb = ib * (1 - sepiaAmt) + (ib * 0.16 + 4) * sepiaAmt;
        const darken = 0.08 + 0.92 * Math.pow(u, 0.72);
        out[idx] = Math.round(tr * darken);
        out[idx + 1] = Math.round(tg * darken);
        out[idx + 2] = Math.round(tb * darken);
        out[idx + 3] = 255;
      } else {
        // Zone 6: Untouched Ink portrait (`saayan_artistic_ink.png`)
        out[idx] = inkData[idx];
        out[idx + 1] = inkData[idx + 1];
        out[idx + 2] = inkData[idx + 2];
        out[idx + 3] = 255;
      }
    }

    tCtx.putImageData(outImg, 0, 0);
    ctx.drawImage(tCanvas, ix, iy);
  }

  /**
   * Produces a cached monochrome Sumi-e ink-wash version of the ornate border frame image,
   * preserving alpha transparency for the Sumi-e profile menu portrait frame.
   */
  private getSumieBorderSource(rawImg: HTMLImageElement): HTMLCanvasElement {
    const sw = rawImg.naturalWidth;
    const sh = rawImg.naturalHeight;
    if (
      this.sumieBorderCanvas &&
      this.sumieBorderCanvas.width === sw &&
      this.sumieBorderCanvas.height === sh
    ) {
      return this.sumieBorderCanvas;
    }
    const c = document.createElement("canvas");
    c.width = sw;
    c.height = sh;
    const bCtx = c.getContext("2d");
    if (bCtx) {
      bCtx.drawImage(rawImg, 0, 0, sw, sh);
      try {
        const imgData = bCtx.getImageData(0, 0, sw, sh);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] === 0) continue;
          // Perceptual luminance mapped to high-contrast charcoal/sumi ink tone
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          const ink = Math.max(12, Math.min(242, Math.round((lum - 110) * 1.25 + 96)));
          d[i] = ink;
          d[i + 1] = Math.max(10, ink - 2);
          d[i + 2] = Math.max(8, ink - 5);
        }
        bCtx.putImageData(imgData, 0, 0);
      } catch {
        // Fallback if canvas is tainted
      }
    }
    this.sumieBorderCanvas = c;
    return c;
  }

  private drawRawFrameContent(
    targetCtx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number
  ): { borderPadX: number; borderPadY: number } {
    const isSumie = this.artStyle === "sumie";
    const rawImg = this.redBorderImg;
    let borderPadX = Math.max(18, Math.round(w * 0.085));
    let borderPadY = Math.max(18, Math.round(h * 0.065));

    if (rawImg && this.redBorderLoaded && rawImg.naturalWidth > 0 && rawImg.naturalHeight > 0) {
      const img = isSumie ? this.getSumieBorderSource(rawImg) : rawImg;
      const sw = rawImg.naturalWidth;
      const sh = rawImg.naturalHeight;
      const scx = Math.round(sw * 0.28);
      const scy = Math.round(sh * 0.225);

      const scaleCorner = Math.min(w / (sw * 0.85), h / (sh * 0.85), 0.72);
      const dcx = Math.round(scx * scaleCorner);
      const dcy = Math.round(scy * scaleCorner);
      borderPadX = Math.max(16, Math.round(dcx * 0.42));
      borderPadY = Math.max(16, Math.round(dcy * 0.36));

      this.paintKoiFramePortraitAndTransition(targetCtx, x, y, w, h, dcx, dcy);

      targetCtx.drawImage(img, 0, 0, scx, scy, x, y, dcx, dcy);
      targetCtx.drawImage(img, sw - scx, 0, scx, scy, x + w - dcx, y, dcx, dcy);
      targetCtx.drawImage(img, 0, sh - scy, scx, scy, x, y + h - dcy, dcx, dcy);
      targetCtx.drawImage(img, sw - scx, sh - scy, scx, scy, x + w - dcx, y + h - dcy, dcx, dcy);

      if (w > dcx * 2) {
        targetCtx.drawImage(img, scx, 0, sw - scx * 2, scy, x + dcx, y, w - dcx * 2, dcy);
        targetCtx.drawImage(
          img,
          scx,
          sh - scy,
          sw - scx * 2,
          scy,
          x + dcx,
          y + h - dcy,
          w - dcx * 2,
          dcy
        );
      }

      if (h > dcy * 2) {
        targetCtx.drawImage(img, 0, scy, scx, sh - scy * 2, x, y + dcy, dcx, h - dcy * 2);
        targetCtx.drawImage(
          img,
          sw - scx,
          scy,
          scx,
          sh - scy * 2,
          x + w - dcx,
          y + dcy,
          dcx,
          h - dcy * 2
        );
      }
    } else {
      targetCtx.strokeStyle = "#941010";
      targetCtx.lineWidth = 6;
      targetCtx.strokeRect(x + 3, y + 3, w - 6, h - 6);
      targetCtx.lineWidth = 2;
      targetCtx.strokeRect(x + 11, y + 11, w - 22, h - 22);
    }

    return { borderPadX, borderPadY };
  }

  public paintRedKoiBoundingBorder(
    ctx: CanvasRenderingContext2D,
    rect: PondViewportRect,
    viewW = 1280,
    viewH = 800
  ): void {
    const p = this.rectProgress;
    if (p <= 0.002) return;

    const { x, y, w, h } = rect;
    const isLight = this.isLightMode;
    const isSumie = this.artStyle === "sumie";

    // Fast path when fully open & settled (zero tile loop overhead when idle, zero seam/pop)
    if (p >= 0.999) {
      ctx.save();
      ctx.globalAlpha = 1.0;
      this.drawRawFrameContent(ctx, x, y, w, h);
      ctx.restore();
      return;
    }

    // Reduced-motion fallback: simple 0.25s opacity fade
    if (this.rippleReducedMotion) {
      ctx.save();
      ctx.globalAlpha = p;
      this.drawRawFrameContent(ctx, x, y, w, h);
      ctx.restore();
      return;
    }

    // Render complete frame into persistent offscreen buffer `this.frameCompositeCanvas`
    const fw = Math.max(1, Math.round(w));
    const fh = Math.max(1, Math.round(h));
    const fCanvas = this.frameCompositeCanvas ?? document.createElement("canvas");
    if (fCanvas.width !== fw || fCanvas.height !== fh) {
      fCanvas.width = fw;
      fCanvas.height = fh;
    }
    this.frameCompositeCanvas = fCanvas;
    const fCtx = fCanvas.getContext("2d");
    if (!fCtx) return;

    fCtx.clearRect(0, 0, fw, fh);
    const { borderPadX, borderPadY } = this.drawRawFrameContent(fCtx, 0, 0, fw, fh);

    // Evaluate shared Cube-Grid Shockwave Reveal over the left portrait frame from its virtual centre
    const frameBounds: RippleCompositionBounds = {
      minX: x,
      minY: y,
      maxX: x + w,
      maxY: y + h,
    };
    const frameOrigin = computeVirtualCenter(frameBounds);
    this.rippleOrigin = frameOrigin;
    const tileSize = computeAlignedTileSize(
      this.rippleCellW,
      this.rippleCellH,
      viewW,
      viewH,
      this.rippleQualityLevel
    );
    const rippleCfg = buildRippleFieldConfig(
      p,
      frameOrigin,
      frameBounds,
      tileSize,
      false
    );

    const startCol = Math.floor(x / tileSize);
    const endCol = Math.ceil((x + w) / tileSize);
    const startRow = Math.floor(y / tileSize);
    const endRow = Math.ceil((y + h) / tileSize);

    ctx.save();

    for (let c = startCol; c < endCol; c++) {
      const worldX = c * tileSize;
      const tileCenterX = worldX + tileSize * 0.5;
      const clipX0 = Math.max(x, worldX);
      const clipX1 = Math.min(x + w, worldX + tileSize);
      const sw = clipX1 - clipX0;
      if (sw <= 0.5) continue;
      const sx = clipX0 - x;

      const isBorderX =
        tileCenterX - x < borderPadX || x + w - tileCenterX < borderPadX;

      for (let r = startRow; r < endRow; r++) {
        const worldY = r * tileSize;
        const tileCenterY = worldY + tileSize * 0.5;
        const clipY0 = Math.max(y, worldY);
        const clipY1 = Math.min(y + h, worldY + tileSize);
        const sh = clipY1 - clipY0;
        if (sh <= 0.5) continue;
        const sy = clipY0 - y;

        const sample = evaluateRippleTile(
          tileCenterX,
          tileCenterY,
          p,
          frameOrigin,
          rippleCfg
        );

        // 1. Ahead of shockwave ring: show nothing (pond stays 100% visible)
        if (sample.reveal <= 0.001) continue;

        // 2. Behind noisy tail (settled): draw exact un-displaced frame slice with zero grid line
        if (sample.settled || (Math.abs(sample.height) <= 0.003 && sample.gridAlpha <= 0.005)) {
          ctx.drawImage(fCanvas, sx, sy, sw, sh, clipX0, clipY0, sw, sh);
          continue;
        }

        const isBorderY =
          tileCenterY - y < borderPadY || y + h - tileCenterY < borderPadY;
        const isBorderTile = isBorderX || isBorderY;

        const shiftX = -sample.height * TILE_MAX_EXTRUDE_PX * 0.62;
        const shiftY = -sample.height * TILE_MAX_EXTRUDE_PX * 0.92;
        const drawX = clipX0 + shiftX;
        const drawY = clipY0 + shiftY;

        // 3. 3D Extruded Cube Side Walls & Drop Shadow when raised (height > 0.03)
        if (sample.height > 0.03) {
          const depthPx = Math.max(1.5, sample.height * TILE_MAX_EXTRUDE_PX * 0.85);
          ctx.fillStyle = isSumie
            ? isLight
              ? "rgba(28, 24, 18, 0.52)"
              : "rgba(0, 0, 0, 0.78)"
            : "rgba(22, 3, 2, 0.68)";
          ctx.fillRect(drawX + 2, drawY + 2, sw + depthPx * 0.55, sh + depthPx * 0.82);

          ctx.fillStyle = isBorderTile
            ? "#9c7822"
            : isSumie
              ? isLight
                ? "#aba08e"
                : "#0c0b09"
              : "#3e0604";
          ctx.fillRect(drawX + sw - 1, drawY + 1, depthPx * 0.55, sh);
          ctx.fillStyle = isBorderTile
            ? "#785a14"
            : isSumie
              ? isLight
                ? "#948978"
                : "#080706"
              : "#2b0403";
          ctx.fillRect(drawX + 1, drawY + sh - 1, sw + depthPx * 0.45, depthPx * 0.82);
        }

        // 4. Base Tile Backing (Gold on border tiles, Red Brocade / Sumi-e under active wave tiles)
        const waveBlend = koiClamp(
          Math.max(Math.abs(sample.height) * 1.45, sample.gridAlpha * 0.72),
          0,
          1
        );
        ctx.drawImage(fCanvas, sx, sy, sw, sh, drawX, drawY, sw, sh);

        if (isBorderTile) {
          const bGoldAlpha = koiClamp(waveBlend * 0.84, 0, 0.92);
          if (bGoldAlpha > 0.01) {
            const bGrad = ctx.createLinearGradient(drawX, drawY, drawX + sw, drawY + sh);
            if (!isSumie) {
              bGrad.addColorStop(0.0, `rgba(255, 247, 196, ${bGoldAlpha.toFixed(3)})`);
              bGrad.addColorStop(0.5, `rgba(230, 190, 83, ${bGoldAlpha.toFixed(3)})`);
              bGrad.addColorStop(1.0, `rgba(196, 142, 32, ${bGoldAlpha.toFixed(3)})`);
            } else {
              bGrad.addColorStop(0.0, `rgba(242, 234, 218, ${bGoldAlpha.toFixed(3)})`);
              bGrad.addColorStop(1.0, `rgba(176, 166, 148, ${bGoldAlpha.toFixed(3)})`);
            }
            ctx.fillStyle = bGrad;
            ctx.fillRect(drawX, drawY, sw, sh);
          }
        } else if (!isSumie && this.redCardLoaded && this.redCardImg && waveBlend > 0.08) {
          ctx.save();
          ctx.globalAlpha = waveBlend * 0.34;
          const bw = this.redCardImg.naturalWidth || 512;
          const bh = this.redCardImg.naturalHeight || 1024;
          const u0 = koiClamp(sx / Math.max(1, w), 0, 0.92);
          const v0 = koiClamp(sy / Math.max(1, h), 0, 0.92);
          ctx.drawImage(
            this.redCardImg,
            u0 * bw,
            v0 * bh,
            Math.max(8, (sw / w) * bw),
            Math.max(8, (sh / h) * bh),
            drawX,
            drawY,
            sw,
            sh
          );
          ctx.restore();
        }

        // 5. Crater Darkening (darker crimson-red shade inside crater trough)
        if (sample.craterFactor > 0.01) {
          const cAlpha = koiClamp(sample.craterFactor * 0.64, 0, 0.85);
          ctx.fillStyle = isSumie
            ? isLight
              ? `rgba(32, 26, 20, ${(cAlpha * 0.55).toFixed(3)})`
              : `rgba(2, 2, 2, ${(cAlpha * 0.78).toFixed(3)})`
            : `rgba(26, 2, 2, ${cAlpha.toFixed(3)})`;
          ctx.fillRect(drawX, drawY, sw, sh);

          ctx.fillStyle = "rgba(0, 0, 0, 0.36)";
          ctx.fillRect(drawX, drawY, sw, 2);
          ctx.fillRect(drawX, drawY, 2, sh);
        }

        // 6. Raised Rim Gold Foil Highlight (--bp-gold-foil)
        if (sample.rimFactor > 0.01) {
          const rAlpha = koiClamp(sample.rimFactor * 0.88, 0, 0.95);
          const gGrad = ctx.createLinearGradient(drawX, drawY, drawX + sw, drawY + sh);
          if (!isSumie) {
            gGrad.addColorStop(0.0, `rgba(255, 247, 196, ${rAlpha.toFixed(3)})`);
            gGrad.addColorStop(0.45, `rgba(230, 190, 83, ${(rAlpha * 0.82).toFixed(3)})`);
            gGrad.addColorStop(1.0, `rgba(196, 142, 32, ${(rAlpha * 0.88).toFixed(3)})`);
          } else {
            gGrad.addColorStop(0.0, `rgba(250, 246, 238, ${(rAlpha * 0.84).toFixed(3)})`);
            gGrad.addColorStop(1.0, `rgba(184, 174, 156, ${(rAlpha * 0.74).toFixed(3)})`);
          }
          ctx.fillStyle = gGrad;
          ctx.fillRect(drawX, drawY, sw, sh);
        }

        // 7. Hairline Gold Grid Lines (fade out to 0 when tiles settle)
        if (sample.gridAlpha > 0.01) {
          ctx.strokeStyle = !isSumie
            ? `rgba(243, 214, 130, ${(sample.gridAlpha * 0.76).toFixed(3)})`
            : isLight
              ? `rgba(36, 32, 28, ${(sample.gridAlpha * 0.54).toFixed(3)})`
              : `rgba(226, 217, 200, ${(sample.gridAlpha * 0.58).toFixed(3)})`;
          ctx.lineWidth = 1;
          ctx.strokeRect(drawX + 0.5, drawY + 0.5, Math.max(1, sw - 1), Math.max(1, sh - 1));
        }
      }
    }

    ctx.restore();
  }


  /**
   * Pre-bakes a 3-Tier Hierarchical River Stone & Gravel Bed (`this.pebbleBedCanvas`):
   * - Base Layer: Textured riverbed silt, organic sediment clouds, and fine sandy grain stippling
   * - Tier 3 (Fine Interstitial Gravel): Small recessed river gravel (`r = 4.5..10.5px`) wedged in crevices
   * - Tier 2 (Multiplicatively Weighted Voronoi River Pebbles): Varied sizes & river-current elongation
   * - Tier 1 (Primary River Cobbles): Large smooth river-worn cobbles with quartz mineral veins & deep AO
   * - Bathymetric Water-Turbidity Depth Fade: Deeper outer stones shift toward cooler olive-teal/umbral tones
   */
  private ensurePebbleBedCanvas(
    width: number,
    height: number,
    isLight: boolean,
    style: KoiArtStyle
  ): HTMLCanvasElement {
    const w = Math.max(64, Math.round(width));
    const h = Math.max(64, Math.round(height));
    const key = `${w}x${h}:${isLight ? "light-moss-v7" : "dark-moss-v7"}:${style}`;
    const cached = this.pebbleBedCache.get(key);
    if (cached) {
      this.pebbleBedCanvas = cached;
      this.pebbleBedKey = key;
      return cached;
    }
    if (this.pebbleBedCache.size >= 4) {
      this.pebbleBedCache.clear();
    }

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    this.pebbleBedCache.set(key, canvas);
    this.pebbleBedCanvas = canvas;
    this.pebbleBedKey = key;

    const pCtx = canvas.getContext("2d");
    if (!pCtx) return canvas;
    pCtx.clearRect(0, 0, w, h);

    // Sumi-e: 4–5 tonal-tier wet-on-wet background lotus pad mosaic settling into paper tooth
    if ((style as KoiArtStyle) === "sumie") {
      const paper = this.ensureSumiePaperBundle(w, h, isLight);
      const mosaic = bakeSumieWashMosaic(w, h, isLight, paper.tooth, paper.toothW, paper.toothH);
      pCtx.drawImage(mosaic, 0, 0, w, h);
      return canvas;
    }

    // 1. Deep Riverbed Silt & Sediment Base
    pCtx.fillStyle =
      style === "sumie"
        ? isLight
          ? "rgba(42, 37, 31, 0.42)"
          : "rgba(5, 4, 3, 0.90)"
        : isLight
          ? "rgba(74, 62, 42, 0.46)"
          : "rgba(6, 5, 4, 0.92)";
    pCtx.fillRect(0, 0, w, h);

    // Subtle sandy sediment patches & fine gravel stippling in the deep silt
    for (let s = 0; s < 32; s++) {
      const sx = hash2D(s, 3, 491) * w;
      const sy = hash2D(s, 7, 491) * h;
      const sr = (0.06 + hash2D(s, 13, 491) * 0.14) * Math.min(w, h);
      const sg = pCtx.createRadialGradient(sx, sy, sr * 0.1, sx, sy, sr);
      const sedCol =
        style === "sumie"
          ? isLight
            ? "118, 110, 98"
            : "24, 21, 18"
          : isLight
            ? "138, 120, 88"
            : "28, 25, 19";
      sg.addColorStop(0.0, `rgba(${sedCol}, 0.22)`);
      sg.addColorStop(1.0, `rgba(${sedCol}, 0)`);
      pCtx.fillStyle = sg;
      pCtx.beginPath();
      pCtx.arc(sx, sy, sr, 0, Math.PI * 2);
      pCtx.fill();
    }

    // Fine riverbed sand & micro-gravel grains visible inside stone crevices
    const sandCount = Math.min(1100, Math.round((w * h) / 1100));
    for (let i = 0; i < sandCount; i++) {
      const gx = hash2D(i, 1, 499) * w;
      const gy = hash2D(i, 2, 499) * h;
      const gr = 0.8 + hash2D(i, 3, 499) * 1.9;
      pCtx.fillStyle =
        i % 2 === 0
          ? isLight
            ? "rgba(186, 168, 134, 0.32)"
            : "rgba(64, 54, 40, 0.36)"
          : isLight
            ? "rgba(52, 42, 28, 0.28)"
            : "rgba(12, 10, 8, 0.52)";
      pCtx.beginPath();
      pCtx.arc(gx, gy, gr, 0, Math.PI * 2);
      pCtx.fill();
    }

    const lightMokkotsuTones: [number, number, number][] = [
      [230, 217, 192],
      [216, 202, 175],
      [202, 188, 160],
      [188, 174, 146],
      [174, 168, 148],
      [162, 156, 136],
      [148, 144, 126],
      [136, 134, 118],
    ];
    const lightSumieTones: [number, number, number][] = [
      [228, 220, 204],
      [212, 204, 188],
      [196, 188, 172],
      [178, 170, 154],
      [160, 152, 138],
      [142, 136, 124],
    ];
    const darkMokkotsuTones: [number, number, number][] = [
      [48, 41, 32],
      [56, 47, 37],
      [38, 33, 26],
      [62, 52, 40],
      [44, 48, 41],
      [34, 30, 24],
      [28, 25, 20],
    ];
    const darkSumieTones: [number, number, number][] = [
      [40, 36, 31],
      [48, 43, 37],
      [32, 29, 25],
      [54, 48, 42],
      [26, 24, 20],
    ];

    const paletteList =
      style === "sumie"
        ? isLight
          ? lightSumieTones
          : darkSumieTones
        : isLight
          ? lightMokkotsuTones
          : darkMokkotsuTones;

    // 2. TIER 3 — Fine Interstitial River Gravel (recessed small stones between main pebbles)
    const gravelCount = Math.min(420, Math.round((w * h) / 2900));
    for (let i = 0; i < gravelCount; i++) {
      const gx = hash2D(i, 5, 511) * w;
      const gy = hash2D(i, 9, 511) * h;
      const rx = 4.5 + hash2D(i, 13, 511) * 6.5;
      const ry = rx * (0.68 + hash2D(i, 17, 511) * 0.38);
      const rot = hash2D(i, 21, 511) * Math.PI;
      const rawRgb = paletteList[i % paletteList.length];
      const gRgb = darkenRgb(rawRgb, 0.72 + hash2D(i, 25, 511) * 0.16);

      pCtx.save();
      pCtx.translate(gx, gy);
      pCtx.rotate(rot);
      pCtx.shadowColor = isLight ? "rgba(28, 20, 12, 0.38)" : "rgba(0, 0, 0, 0.72)";
      pCtx.shadowBlur = 4.5;
      pCtx.shadowOffsetX = 1.6;
      pCtx.shadowOffsetY = 2.0;
      pCtx.fillStyle = rgbToRgba(gRgb, isLight ? 0.86 : 0.90);
      pCtx.beginPath();
      pCtx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      pCtx.fill();
      if (style === "sumie") {
        pCtx.shadowBlur = 0;
        pCtx.shadowOffsetX = 0;
        pCtx.shadowOffsetY = 0;
        pCtx.lineWidth = 1.05;
        pCtx.strokeStyle = "rgba(10, 9, 8, 0.88)";
        pCtx.stroke();
      }
      pCtx.restore();
    }

    // 3. TIER 2 — Multiplicatively Weighted Voronoi River Pebbles (varied sizes & natural crevices)
    const cellStep = 44;
    const cols = Math.ceil(w / cellStep) + 2;
    const rows = Math.ceil(h / cellStep) + 2;
    const seedsX = new Float32Array(cols * rows);
    const seedsY = new Float32Array(cols * rows);
    const seedWeights = new Float32Array(cols * rows);

    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const idx = gy * cols + gx;
        const jx = (hash2D(gx, gy, 503) - 0.5) * cellStep * 0.78;
        const jy = (hash2D(gx, gy, 509) - 0.5) * cellStep * 0.78;
        seedsX[idx] = (gx - 0.5) * cellStep + jx;
        seedsY[idx] = (gy - 0.5) * cellStep + jy;
        // Power-law-like weight distribution so adjacent cells vary naturally in size
        const u = hash2D(gx, gy, 521);
        seedWeights[idx] = 0.62 + Math.pow(u, 1.45) * 0.76;
      }
    }

    const dirs = 20;
    const cosTable = new Float32Array(dirs);
    const sinTable = new Float32Array(dirs);
    for (let d = 0; d < dirs; d++) {
      const a = (d / dirs) * Math.PI * 2;
      cosTable[d] = Math.cos(a);
      sinTable[d] = Math.sin(a);
    }

    const polyX = new Float32Array(dirs);
    const polyY = new Float32Array(dirs);

    const traceStonePath = (ox: number, oy: number, scale: number, cx: number, cy: number) => {
      pCtx.beginPath();
      const s0x = cx + (polyX[dirs - 1] - cx) * scale;
      const s0y = cy + (polyY[dirs - 1] - cy) * scale;
      const s1x = cx + (polyX[0] - cx) * scale;
      const s1y = cy + (polyY[0] - cy) * scale;
      pCtx.moveTo((s0x + s1x) * 0.5 + ox, (s0y + s1y) * 0.5 + oy);
      for (let d = 0; d < dirs; d++) {
        const nextD = (d + 1) % dirs;
        const px = cx + (polyX[d] - cx) * scale + ox;
        const py = cy + (polyY[d] - cy) * scale + oy;
        const nx = cx + (polyX[nextD] - cx) * scale + ox;
        const ny = cy + (polyY[nextD] - cy) * scale + oy;
        pCtx.quadraticCurveTo(px, py, (px + nx) * 0.5, (py + ny) * 0.5);
      }
      pCtx.closePath();
    };

    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const idx0 = gy * cols + gx;
        const x0 = seedsX[idx0];
        const y0 = seedsY[idx0];
        if (x0 < -cellStep || x0 > w + cellStep || y0 < -cellStep || y0 > h + cellStep) {
          continue;
        }

        const w0 = seedWeights[idx0];
        const zDepth = hash2D(gx, gy, 601);
        // Wider, varied sandy/gravel seams so stones don't look like tight artificial paving
        const seamGap = 3.0 + (1 - zDepth) * 2.6 + (hash2D(gx, gy, 607) * 1.8);
        const aspect = 1.0 + hash2D(gx, gy, 611) * 0.34;
        const flowAng = -0.35 + (hash2D(gx, gy, 617) - 0.5) * 0.75;
        const cosF = Math.cos(flowAng);
        const sinF = Math.sin(flowAng);

        let maxRad = 4;

        for (let d = 0; d < dirs; d++) {
          const rx = cosTable[d];
          const ry = sinTable[d];
          // River-worn directional elongation
          const localProj = rx * cosF + ry * sinF;
          const dirScale = 1.0 + (aspect - 1.0) * (localProj * localProj - 0.35);
          let maxT = cellStep * 0.88 * w0 * dirScale;

          const nyMin = Math.max(0, gy - 2);
          const nyMax = Math.min(rows - 1, gy + 2);
          const nxMin = Math.max(0, gx - 2);
          const nxMax = Math.min(cols - 1, gx + 2);

          for (let ngy = nyMin; ngy <= nyMax; ngy++) {
            for (let ngx = nxMin; ngx <= nxMax; ngx++) {
              if (ngx === gx && ngy === gy) continue;
              const nIdx = ngy * cols + ngx;
              const dx = seedsX[nIdx] - x0;
              const dy = seedsY[nIdx] - y0;
              const dist = Math.hypot(dx, dy);
              if (dist < 1) continue;
              const ux = dx / dist;
              const uy = dy / dist;
              const proj = rx * ux + ry * uy;
              if (proj > 0.05) {
                const wN = seedWeights[nIdx];
                const weightRatio = koiClamp(w0 / (w0 + wN), 0.34, 0.66);
                const splitDist = Math.max(3.5, dist * weightRatio - seamGap);
                const tHit = splitDist / proj;
                if (tHit < maxT) maxT = tHit;
              }
            }
          }
          if (maxT > maxRad) maxRad = maxT;
          polyX[d] = x0 + rx * maxT;
          polyY[d] = y0 + ry * maxT;
        }

        // Bathymetric water-turbidity depth fade (deeper near edges/corners, sunlit along diagonal channel)
        const normX = x0 / Math.max(1, w);
        const normY = y0 / Math.max(1, h);
        const sunChannel = Math.exp(-Math.pow((normX - (0.55 - normY * 0.16)) * 2.0, 2));
        const edgeDist = Math.hypot(normX - 0.5, normY - 0.5);
        const turbidity = koiClamp((edgeDist - 0.22) * 0.85, 0, 0.42);
        const depthFactor = 0.68 + 0.22 * zDepth + 0.14 * sunChannel - turbidity * 0.16;

        // A. Soft Continuous Gaussian Shadow + 3D Sculpted River Stone Dome
        const hTone = hash2D(gx, gy, 613);
        let rawRgb = paletteList[Math.floor(hTone * paletteList.length) % paletteList.length];
        if (style !== "sumie" && turbidity > 0.02) {
          const turbidTarget: [number, number, number] = isLight ? [118, 128, 108] : [26, 34, 28];
          rawRgb = mixRgb(rawRgb, turbidTarget, turbidity);
        }

        const litRgb = darkenRgb(rawRgb, depthFactor * 1.10);
        const midRgb = darkenRgb(rawRgb, depthFactor * 0.92);
        const aoEdgeRgb = darkenRgb(rawRgb, depthFactor * 0.64);

        pCtx.save();
        pCtx.shadowColor = isLight ? "rgba(28, 20, 12, 0.44)" : "rgba(0, 0, 0, 0.76)";
        pCtx.shadowBlur = 7.5;
        pCtx.shadowOffsetX = 2.4;
        pCtx.shadowOffsetY = 3.2;
        traceStonePath(0, 0, 1.0, x0, y0);
        const stoneGrad = pCtx.createRadialGradient(
          x0 - maxRad * 0.30,
          y0 - maxRad * 0.30,
          maxRad * 0.05,
          x0,
          y0,
          maxRad * 1.06
        );
        stoneGrad.addColorStop(0.0, rgbToRgba(litRgb, isLight ? 0.92 : 0.95));
        stoneGrad.addColorStop(0.60, rgbToRgba(midRgb, isLight ? 0.90 : 0.93));
        stoneGrad.addColorStop(1.0, rgbToRgba(aoEdgeRgb, isLight ? 0.94 : 0.96));
        pCtx.fillStyle = stoneGrad;
        pCtx.fill();
        if (style === "sumie") {
          pCtx.shadowBlur = 0;
          pCtx.shadowOffsetX = 0;
          pCtx.shadowOffsetY = 0;
          pCtx.lineWidth = 1.45;
          pCtx.strokeStyle = "rgba(10, 9, 8, 0.90)";
          pCtx.stroke();
        }
        pCtx.restore();

        // C. Tactile Mineral Roughness (granite speckles & occasional quartz veins)
        const speckleCount = 4;
        for (let sp = 0; sp < speckleCount; sp++) {
          const sa = hash2D(gx * 7 + sp, gy * 13, 641) * Math.PI * 2;
          const sr = hash2D(gx * 11 + sp, gy * 17, 647) * maxRad * 0.56;
          const sx = x0 + Math.cos(sa) * sr;
          const sy = y0 + Math.sin(sa) * sr;
          const sRad = 0.7 + hash2D(gx + sp, gy, 653) * 1.25;
          pCtx.fillStyle =
            sp % 2 === 0
              ? isLight
                ? "rgba(255, 250, 238, 0.20)"
                : "rgba(218, 194, 152, 0.09)"
              : isLight
                ? "rgba(62, 48, 30, 0.16)"
                : "rgba(8, 6, 4, 0.34)";
          pCtx.beginPath();
          pCtx.arc(sx, sy, sRad, 0, Math.PI * 2);
          pCtx.fill();
        }
      }
    }

    // 4. TIER 1 — Large Primary River Cobbles (~28 smooth elliptical hero stones wedged into the bed)
    const cobbleCount = 28;
    for (let c = 0; c < cobbleCount; c++) {
      const cx = (0.06 + hash2D(c, 3, 661) * 0.88) * w;
      const cy = (0.06 + hash2D(c, 7, 661) * 0.88) * h;
      const rx = 26 + hash2D(c, 11, 661) * 24;
      const ry = rx * (0.64 + hash2D(c, 15, 661) * 0.24);
      const rot = -0.45 + hash2D(c, 19, 661) * 0.9;
      const rawRgb = paletteList[(c * 3) % paletteList.length];

      const normX = cx / Math.max(1, w);
      const normY = cy / Math.max(1, h);
      const sunChannel = Math.exp(-Math.pow((normX - (0.55 - normY * 0.16)) * 2.0, 2));
      const dFactor = 0.82 + 0.16 * sunChannel;

      pCtx.save();
      pCtx.translate(cx, cy);
      pCtx.rotate(rot);

      const traceCobble = (ox: number, oy: number, sc: number) => {
        const steps = 24;
        pCtx.beginPath();
        for (let s = 0; s <= steps; s++) {
          const a = (s / steps) * Math.PI * 2;
          const warp = 1 + 0.045 * Math.sin(a * 3 + c * 1.7) + 0.025 * Math.cos(a * 5 - c);
          const px = ox + Math.cos(a) * rx * sc * warp;
          const py = oy + Math.sin(a) * ry * sc * warp;
          if (s === 0) pCtx.moveTo(px, py);
          else pCtx.lineTo(px, py);
        }
        pCtx.closePath();
      };

      // Soft continuous Gaussian shadow (no discrete stepped layers) + 3D sculpted cobble dome
      pCtx.save();
      pCtx.shadowColor = isLight ? "rgba(22, 15, 8, 0.54)" : "rgba(0, 0, 0, 0.84)";
      pCtx.shadowBlur = 14;
      pCtx.shadowOffsetX = 4.0;
      pCtx.shadowOffsetY = 5.2;
      traceCobble(0, 0, 1.0);
      const cGrad = pCtx.createRadialGradient(-rx * 0.3, -ry * 0.3, rx * 0.06, 0, 0, rx * 1.08);
      cGrad.addColorStop(0.0, rgbToRgba(darkenRgb(rawRgb, dFactor * 1.12), isLight ? 0.95 : 0.97));
      cGrad.addColorStop(0.62, rgbToRgba(darkenRgb(rawRgb, dFactor * 0.94), isLight ? 0.94 : 0.96));
      cGrad.addColorStop(1.0, rgbToRgba(darkenRgb(rawRgb, dFactor * 0.65), isLight ? 0.96 : 0.98));
      pCtx.fillStyle = cGrad;
      pCtx.fill();
      if (style === "sumie") {
        pCtx.shadowBlur = 0;
        pCtx.shadowOffsetX = 0;
        pCtx.shadowOffsetY = 0;
        pCtx.lineWidth = 1.9;
        pCtx.strokeStyle = "rgba(10, 9, 8, 0.92)";
        pCtx.stroke();
      }
      pCtx.restore();

      // Quartz mineral vein & wet top-left highlight inside the cobble
      pCtx.save();
      pCtx.clip();
      if (c % 2 === 0) {
        pCtx.beginPath();
        pCtx.moveTo(-rx * 0.85, -ry * 0.2);
        pCtx.quadraticCurveTo(0, ry * 0.25, rx * 0.85, -ry * 0.1);
        pCtx.lineWidth = 1.1;
        pCtx.strokeStyle = isLight ? "rgba(252, 246, 232, 0.28)" : "rgba(214, 192, 150, 0.14)";
        pCtx.stroke();
      }
      // Wet specular highlight on top-left dome
      const specG = pCtx.createRadialGradient(-rx * 0.32, -ry * 0.32, 1, -rx * 0.28, -ry * 0.28, rx * 0.45);
      specG.addColorStop(0.0, isLight ? "rgba(255, 252, 242, 0.22)" : "rgba(255, 236, 196, 0.10)");
      specG.addColorStop(1.0, "rgba(255, 252, 242, 0)");
      pCtx.fillStyle = specG;
      pCtx.fillRect(-rx, -ry, rx * 2, ry * 2);
      pCtx.restore();

      pCtx.restore();
    }

    // 5. Macro Bathymetric Depth & Corner Turbidity Vignette
    const bathyGrad = pCtx.createRadialGradient(
      w * 0.48,
      h * 0.46,
      Math.min(w, h) * 0.18,
      w * 0.5,
      h * 0.5,
      Math.hypot(w, h) * 0.65
    );
    bathyGrad.addColorStop(0.0, "rgba(0, 0, 0, 0)");
    bathyGrad.addColorStop(
      1.0,
      isLight ? "rgba(58, 48, 32, 0.20)" : "rgba(0, 0, 0, 0.42)"
    );
    pCtx.fillStyle = bathyGrad;
    pCtx.fillRect(0, 0, w, h);

    // 6. Bake Shoreline Border Boulders directly into `pebbleBedCanvas` with soft continuous shadows (zero per-frame cost!)
    this.paintBorderBoulders(pCtx, w, h, isLight, style);

    return canvas;
  }

  /**
   * Pre-computes a seamless, tileable 256x256 Voronoi / Worley Cellular Caustic Distance-Field
   * Texture (`F2 - F1`) so water caustics form authentic polygonal cellular webs with bright
   * triple-junction focal cusps (matching `image_887e11.jpg`).
   */
  private ensureCausticTileCanvas(style: KoiArtStyle, isLight: boolean): HTMLCanvasElement {
    const key = `${style}:${isLight ? "light" : "dark"}:worley-v3`;
    const cached = this.causticTileCache.get(key);
    if (cached) {
      this.causticTileCanvas = cached;
      this.causticTileKey = key;
      return cached;
    }
    if (this.causticTileCache.size >= 6) {
      this.causticTileCache.clear();
    }

    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    this.causticTileCache.set(key, canvas);
    this.causticTileCanvas = canvas;
    this.causticTileKey = key;

    const cCtx = canvas.getContext("2d");
    if (!cCtx) return canvas;

    const imgData = cCtx.createImageData(size, size);
    const data = imgData.data;

    // Periodic 7x7 Worley feature grid for seamless tiling
    const cells = 7;
    const fx = new Float32Array(cells * cells);
    const fy = new Float32Array(cells * cells);
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        const idx = cy * cells + cx;
        fx[idx] = cx + 0.14 + hash2D(cx, cy, 907) * 0.72;
        fy[idx] = cy + 0.14 + hash2D(cx, cy, 919) * 0.72;
      }
    }

    const baseR = style === "sumie" ? (isLight ? 255 : 222) : 255;
    const baseG = style === "sumie" ? (isLight ? 250 : 212) : 238;
    const baseB = style === "sumie" ? (isLight ? 240 : 194) : 172;

    for (let py = 0; py < size; py++) {
      const uy = (py / size) * cells;
      const gy0 = Math.floor(uy);
      for (let px = 0; px < size; px++) {
        const ux = (px / size) * cells;
        const gx0 = Math.floor(ux);

        let d1 = 999;
        let d2 = 999;
        let d3 = 999;

        for (let dy = -1; dy <= 1; dy++) {
          const ncy = (gy0 + dy + cells) % cells;
          const wrapY = (gy0 + dy) * 1.0 - ncy;
          for (let dx = -1; dx <= 1; dx++) {
            const ncx = (gx0 + dx + cells) % cells;
            const wrapX = (gx0 + dx) * 1.0 - ncx;
            const idx = ncy * cells + ncx;
            const ddx = (fx[idx] + wrapX) - ux;
            const ddy = (fy[idx] + wrapY) - uy;
            const dist = Math.hypot(ddx, ddy);
            if (dist < d1) {
              d3 = d2;
              d2 = d1;
              d1 = dist;
            } else if (dist < d2) {
              d3 = d2;
              d2 = dist;
            } else if (dist < d3) {
              d3 = dist;
            }
          }
        }

        // Sharp polygonal caustic cell border (F2 - F1) + bright triple-junction cusp (F3 - F1)
        const edge = Math.max(0, 1.0 - (d2 - d1) * 3.85);
        const ridge = Math.pow(edge, 3.4);
        const cuspEdge = Math.max(0, 1.0 - (d3 - d1) * 2.95);
        const cusp = Math.pow(cuspEdge, 5.2);

        const intensity = Math.min(1.0, ridge * 0.78 + cusp * 0.65);
        const pIdx = (py * size + px) * 4;
        // Boost whiteness at triple-junction cusps
        data[pIdx] = Math.min(255, Math.round(baseR + cusp * 20));
        data[pIdx + 1] = Math.min(255, Math.round(baseG + cusp * 22));
        data[pIdx + 2] = Math.min(255, Math.round(baseB + cusp * 48));
        data[pIdx + 3] = Math.round(intensity * 255);
      }
    }

    cCtx.putImageData(imgData, 0, 0);
    return canvas;
  }

  /**
   * Paints sculpted shoreline & mid-depth river boulders with deep AO shadows, rough mottled stone grain,
   * and velvety moss patches along their sunlit rims.
   */
  private paintBorderBoulders(
    ctx: CanvasRenderingContext2D,
    worldW: number,
    worldH: number,
    isLight: boolean,
    style: KoiArtStyle
  ): void {
    const unit = koiClamp(Math.min(worldW, worldH) / 860, 0.46, 1.22);
    // Margin-anchored coordinates so corner boulders frame the bank naturally on any aspect ratio
    const boulders = [
      { cx: 195 * unit, cy: 62 * unit, rx: 102 * unit, ry: 76 * unit, rot: -0.18, hasMoss: true },
      { cx: 36 * unit, cy: 175 * unit, rx: 62 * unit, ry: 80 * unit, rot: 0.14, hasMoss: true },
      { cx: 42 * unit, cy: worldH * 0.62, rx: 30 * unit, ry: 40 * unit, rot: 0.24, hasMoss: false },
      { cx: 145 * unit, cy: worldH - 175 * unit, rx: 44 * unit, ry: 56 * unit, rot: -0.15, hasMoss: false },
      { cx: worldW - 48 * unit, cy: worldH - 96 * unit, rx: 74 * unit, ry: 60 * unit, rot: -0.22, hasMoss: true },
      { cx: worldW - 185 * unit, cy: worldH - 36 * unit, rx: 60 * unit, ry: 46 * unit, rot: 0.12, hasMoss: true },
      { cx: worldW - 34 * unit, cy: worldH * 0.42, rx: 46 * unit, ry: 62 * unit, rot: -0.12, hasMoss: false },
    ];

    ctx.save();
    for (let i = 0; i < boulders.length; i++) {
      const b = boulders[i];
      const cx = b.cx;
      const cy = b.cy;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(b.rot);

      const traceBoulder = (ox: number, oy: number, scale: number) => {
        const steps = 32;
        ctx.beginPath();
        for (let s = 0; s <= steps; s++) {
          const a = (s / steps) * Math.PI * 2;
          const organic =
            1 +
            0.055 * Math.sin(a * 3 + i * 1.9) +
            0.032 * Math.cos(a * 5 - i) +
            0.018 * Math.sin(a * 9 + i);
          const px = ox + Math.cos(a) * b.rx * scale * organic;
          const py = oy + Math.sin(a) * b.ry * scale * organic;
          if (s === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
      };

      // 1. Soft, continuous Gaussian underwater shadow (no discrete stepped layers) + Sculpted 3D boulder dome fill
      ctx.save();
      ctx.shadowColor = isLight ? "rgba(18, 12, 6, 0.58)" : "rgba(0, 0, 0, 0.88)";
      ctx.shadowBlur = Math.max(12, Math.round(22 * unit));
      ctx.shadowOffsetX = 10 * unit;
      ctx.shadowOffsetY = 14 * unit;
      traceBoulder(0, 0, 1.0);
      const rMax = Math.max(b.rx, b.ry);
      const grad = ctx.createRadialGradient(-b.rx * 0.28, -b.ry * 0.28, rMax * 0.06, 0, 0, rMax * 1.08);
      if (style === "sumie") {
        grad.addColorStop(0.0, isLight ? "rgba(112, 104, 94, 0.94)" : "rgba(78, 72, 64, 0.94)");
        grad.addColorStop(0.65, isLight ? "rgba(78, 72, 64, 0.95)" : "rgba(48, 44, 39, 0.95)");
        grad.addColorStop(1.0, isLight ? "rgba(48, 44, 38, 0.96)" : "rgba(26, 23, 20, 0.96)");
      } else if (isLight) {
        grad.addColorStop(0.0, "rgba(164, 156, 138, 0.95)");
        grad.addColorStop(0.58, "rgba(124, 118, 104, 0.96)");
        grad.addColorStop(1.0, "rgba(84, 78, 66, 0.97)");
      } else {
        grad.addColorStop(0.0, "rgba(74, 68, 58, 0.95)");
        grad.addColorStop(0.62, "rgba(48, 44, 37, 0.96)");
        grad.addColorStop(1.0, "rgba(26, 23, 19, 0.98)");
      }
      ctx.fillStyle = grad;
      ctx.fill();
      if (style === "sumie") {
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.lineWidth = Math.max(1.8, 2.2 * unit);
        ctx.strokeStyle = "rgba(10, 9, 8, 0.94)";
        ctx.stroke();
      }
      ctx.restore();

      // 3. Tactile stone roughness stippling & crevices
      ctx.save();
      ctx.clip();
      for (let sp = 0; sp < 26; sp++) {
        const sa = hash2D(i * 19 + sp, 3, 701) * Math.PI * 2;
        const sr = hash2D(i * 23 + sp, 7, 709) * rMax * 0.82;
        const sx = Math.cos(sa) * sr;
        const sy = Math.sin(sa) * sr;
        const sRad = 1.2 + hash2D(i + sp, 11, 719) * 3.2;
        ctx.fillStyle =
          sp % 3 === 0
            ? isLight
              ? "rgba(248, 240, 222, 0.18)"
              : "rgba(214, 192, 148, 0.10)"
            : isLight
              ? "rgba(44, 36, 26, 0.16)"
              : "rgba(0, 0, 0, 0.32)";
        ctx.beginPath();
        ctx.arc(sx, sy, sRad, 0, Math.PI * 2);
        ctx.fill();
      }

      // 4. Organic, Velvety Bryophyte Moss Mats & Tiny Woodland Shore-Leaflets Clinging to Boulder Rims
      //    (Replaces the old flat green circles with continuous feathered moss cushions, micro-tuft stippling,
      //     and delicate pointed shore-fern/herb leaves modeled after `image_d1f600.jpg`)
      if (b.hasMoss) {
        // A. Continuous velvety moss carpet base along the sunlit rim of the boulder
        const matPuffs = 24;
        for (let m = 0; m < matPuffs; m++) {
          const u = m / (matPuffs - 1);
          const ma = -1.05 + u * 2.35 + (hash2D(i, m, 733) - 0.5) * 0.22;
          const mr = (0.52 + hash2D(i, m, 739) * 0.34) * Math.min(b.rx, b.ry);
          const mx = Math.cos(ma) * mr * (b.rx / rMax);
          const my = Math.sin(ma) * mr * (b.ry / rMax);
          const rxM = (10 + hash2D(i, m, 743) * 14) * unit;
          const ryM = rxM * (0.62 + hash2D(i, m, 751) * 0.26);

          ctx.save();
          ctx.translate(mx, my);
          ctx.rotate(ma + Math.PI * 0.5);

          const mGrad = ctx.createRadialGradient(-rxM * 0.2, -ryM * 0.2, rxM * 0.08, 0, 0, rxM);
          if (style === "sumie") {
            mGrad.addColorStop(0.0, isLight ? "rgba(52, 48, 42, 0.58)" : "rgba(122, 114, 102, 0.44)");
            mGrad.addColorStop(0.65, isLight ? "rgba(38, 34, 30, 0.36)" : "rgba(82, 76, 68, 0.28)");
            mGrad.addColorStop(1.0, "rgba(0, 0, 0, 0)");
          } else if (isLight) {
            mGrad.addColorStop(0.0, "rgba(136, 164, 62, 0.82)");
            mGrad.addColorStop(0.48, "rgba(92, 124, 46, 0.72)");
            mGrad.addColorStop(0.82, "rgba(54, 78, 32, 0.44)");
            mGrad.addColorStop(1.0, "rgba(38, 56, 22, 0)");
          } else {
            mGrad.addColorStop(0.0, "rgba(98, 124, 46, 0.78)");
            mGrad.addColorStop(0.50, "rgba(64, 88, 34, 0.68)");
            mGrad.addColorStop(0.84, "rgba(36, 52, 22, 0.42)");
            mGrad.addColorStop(1.0, "rgba(22, 34, 14, 0)");
          }
          ctx.fillStyle = mGrad;
          ctx.beginPath();
          ctx.ellipse(0, 0, rxM, ryM, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        // B. Fine stippled bryophyte micro-tuft texture (sunlit chartreuse-gold & deep forest-olive spore tufts)
        const tuftCount = 65;
        for (let t = 0; t < tuftCount; t++) {
          const ta = -1.08 + hash2D(i * 31 + t, 3, 757) * 2.40;
          const tr = (0.48 + hash2D(i * 31 + t, 7, 761) * 0.42) * Math.min(b.rx, b.ry);
          const tx = Math.cos(ta) * tr * (b.rx / rMax);
          const ty = Math.sin(ta) * tr * (b.ry / rMax);
          const tRad = (1.6 + hash2D(i * 31 + t, 11, 769) * 3.2) * unit;
          const isSunTip = hash2D(i * 31 + t, 17, 773) > 0.42;

          ctx.fillStyle =
            style === "sumie"
              ? isLight
                ? "rgba(36, 32, 28, 0.38)"
                : "rgba(138, 130, 118, 0.32)"
              : isSunTip
                ? isLight
                  ? "rgba(172, 196, 78, 0.68)"
                  : "rgba(126, 152, 58, 0.58)"
                : isLight
                  ? "rgba(48, 72, 28, 0.62)"
                  : "rgba(28, 46, 18, 0.64)";
          ctx.beginPath();
          ctx.arc(tx, ty, tRad, 0, Math.PI * 2);
          ctx.fill();
        }

        // C. Small pointed woodland shore-leaflets sprouting out of the moss mat crevices
        const leafletCount = 9;
        for (let lf = 0; lf < leafletCount; lf++) {
          const la = -0.92 + (lf / (leafletCount - 1)) * 2.05 + (hash2D(i, lf, 787) - 0.5) * 0.25;
          const lr = (0.64 + hash2D(i, lf, 797) * 0.24) * Math.min(b.rx, b.ry);
          const lx = Math.cos(la) * lr * (b.rx / rMax);
          const ly = Math.sin(la) * lr * (b.ry / rMax);
          const lLen = (9 + hash2D(i, lf, 809) * 8) * unit;
          const lWid = lLen * 0.38;
          const outAng = la + (hash2D(i, lf, 811) - 0.5) * 0.7;

          ctx.save();
          ctx.translate(lx, ly);
          ctx.rotate(outAng);
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.quadraticCurveTo(lLen * 0.45, -lWid, lLen, 0);
          ctx.quadraticCurveTo(lLen * 0.45, lWid, 0, 0);
          ctx.closePath();
          ctx.fillStyle =
            style === "sumie"
              ? isLight
                ? "rgba(58, 52, 46, 0.72)"
                : "rgba(112, 104, 92, 0.65)"
              : isLight
                ? "rgba(124, 156, 58, 0.86)"
                : "rgba(84, 112, 42, 0.82)";
          ctx.fill();
          ctx.restore();
        }
      }
      ctx.restore();

      ctx.lineWidth = 1.2;
      ctx.strokeStyle = isLight ? "rgba(58, 46, 32, 0.38)" : "rgba(186, 162, 120, 0.22)";
      ctx.stroke();

      ctx.restore();
    }
    ctx.restore();
  }

  /**
   * Paints natural, out-of-focus submerged feathery hornwort (*Matsumo* / *Ceratophyllum*) whorls
   * and velvety *Marimo* moss cushions nestled on the riverbed below the swimming Koi
   * (replacing the old ribbon strips).
   */
  private paintSubmergedFlora(
    ctx: CanvasRenderingContext2D,
    worldW: number,
    worldH: number,
    time: number,
    isLight: boolean,
    style: KoiArtStyle
  ): void {
    if ((style as KoiArtStyle) === "sumie") return;
    if (false) return;
    const unit = koiClamp(Math.min(worldW, worldH) / 860, 0.48, 1.22);

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Bed Obstacles: Submerged riverbed stones and moss cushions painted directly over Pass 1 deep stems
    // so deep stems visibly duck behind rocks and vegetation while Pass 2 surface stems pass over them
    const bedStones = [
      { fx: 0.18, fy: 0.22, rx: 24 * unit, ry: 16 * unit, rot: 0.35 },
      { fx: 0.21, fy: 0.24, rx: 15 * unit, ry: 11 * unit, rot: -0.42 },
      { fx: 0.36, fy: 0.18, rx: 22 * unit, ry: 15 * unit, rot: 0.62 },
      { fx: 0.15, fy: 0.48, rx: 25 * unit, ry: 17 * unit, rot: -0.28 },
      { fx: 0.78, fy: 0.68, rx: 28 * unit, ry: 19 * unit, rot: 0.74 },
      { fx: 0.82, fy: 0.65, rx: 17 * unit, ry: 12 * unit, rot: -0.18 },
      { fx: 0.60, fy: 0.79, rx: 23 * unit, ry: 15 * unit, rot: -0.52 },
      { fx: 0.84, fy: 0.46, rx: 21 * unit, ry: 14 * unit, rot: 0.48 },
    ];

    for (let sIdx = 0; sIdx < bedStones.length; sIdx++) {
      const st = bedStones[sIdx];
      const sx = worldW * st.fx;
      const sy = worldH * st.fy;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(st.rot);

      // Soft stone contact shadow on pond floor
      ctx.beginPath();
      ctx.ellipse(2.8 * unit, 3.4 * unit, st.rx * 1.06, st.ry * 1.06, 0, 0, Math.PI * 2);
      ctx.fillStyle = isLight ? "rgba(24, 18, 12, 0.26)" : "rgba(0, 0, 0, 0.48)";
      ctx.fill();

      // Riverbed stone body (occludes Pass 1 deep stems underneath)
      ctx.beginPath();
      ctx.ellipse(0, 0, st.rx, st.ry, 0, 0, Math.PI * 2);
      const sg = ctx.createRadialGradient(-st.rx * 0.28, -st.ry * 0.28, st.rx * 0.08, 0, 0, st.rx * 1.05);
      if (style === "sumie") {
        sg.addColorStop(0.0, isLight ? "rgba(118, 112, 102, 0.84)" : "rgba(74, 70, 64, 0.86)");
        sg.addColorStop(0.65, isLight ? "rgba(82, 76, 68, 0.82)" : "rgba(48, 44, 40, 0.84)");
        sg.addColorStop(1.0, isLight ? "rgba(56, 52, 46, 0.76)" : "rgba(32, 29, 26, 0.78)");
      } else if (isLight) {
        sg.addColorStop(0.0, "rgba(126, 118, 98, 0.86)");
        sg.addColorStop(0.62, "rgba(92, 84, 68, 0.84)");
        sg.addColorStop(1.0, "rgba(64, 58, 46, 0.78)");
      } else {
        sg.addColorStop(0.0, "rgba(78, 72, 58, 0.88)");
        sg.addColorStop(0.62, "rgba(52, 48, 38, 0.86)");
        sg.addColorStop(1.0, "rgba(34, 30, 24, 0.80)");
      }
      ctx.fillStyle = sg;
      ctx.fill();
      if (style === "sumie") {
        ctx.lineWidth = Math.max(1.5, 1.8 * unit);
        ctx.strokeStyle = "rgba(10, 9, 8, 0.92)";
        ctx.stroke();
      }
      ctx.restore();
    }

    // Soft, organic submerged bryophyte moss cushions nestled over stones and deep stems
    const patches = [
      { fx: 0.16, fy: 0.85, rx: 28 * unit, ry: 18 * unit, rot: -0.35 },
      { fx: 0.84, fy: 0.79, rx: 26 * unit, ry: 17 * unit, rot: 0.42 },
      { fx: 0.32, fy: 0.14, rx: 24 * unit, ry: 15 * unit, rot: -0.22 },
      { fx: 0.19, fy: 0.23, rx: 22 * unit, ry: 14 * unit, rot: 0.28 },
      { fx: 0.79, fy: 0.67, rx: 25 * unit, ry: 16 * unit, rot: -0.31 },
      { fx: 0.59, fy: 0.78, rx: 21 * unit, ry: 14 * unit, rot: 0.19 },
    ];

    for (let i = 0; i < patches.length; i++) {
      const p = patches[i];
      const cx = worldW * p.fx;
      const cy = worldH * p.fy;

      // 1. Multi-lobed velvety submerged moss mat (feathered radial gradients, zero hard borders)
      for (let lobe = 0; lobe < 5; lobe++) {
        const la = (lobe / 5) * Math.PI * 2 + i * 1.1;
        const lx = cx + Math.cos(la) * (p.rx * 0.36);
        const ly = cy + Math.sin(la) * (p.ry * 0.36);
        const lr = p.rx * (0.65 + (lobe % 2) * 0.18);
        const mg = ctx.createRadialGradient(lx - lr * 0.2, ly - lr * 0.2, lr * 0.08, lx, ly, lr);
        if (style === "sumie") {
          mg.addColorStop(0.0, isLight ? "rgba(58, 52, 46, 0.24)" : "rgba(88, 82, 74, 0.20)");
          mg.addColorStop(0.65, isLight ? "rgba(42, 38, 34, 0.12)" : "rgba(52, 48, 42, 0.10)");
          mg.addColorStop(1.0, "rgba(0, 0, 0, 0)");
        } else {
          mg.addColorStop(0.0, isLight ? "rgba(82, 114, 56, 0.32)" : "rgba(52, 78, 38, 0.36)");
          mg.addColorStop(0.62, isLight ? "rgba(54, 82, 42, 0.18)" : "rgba(32, 52, 26, 0.22)");
          mg.addColorStop(1.0, "rgba(0, 0, 0, 0)");
        }
        ctx.fillStyle = mg;
        ctx.beginPath();
        ctx.arc(lx, ly, lr, 0, Math.PI * 2);
        ctx.fill();
      }

      // Only velvety moss cushions remain underwater (all other submerged aquatic plants removed per user request)
    }

    ctx.restore();
  }

  /**
   * Draws the exact Bezier silhouette of a Koi fish—including its curved body, both ruffled silk
   * pectoral fins, both ventral fins, and the bilobed veil caudal tail fin—into `targetCtx`
   * shifted by `(ox, oy)`. Used to cast a seamless, continuous-gradient shadow matching the exact
   * shape of the tails and fins.
   */
  private fillExactKoiShadowSilhouette(
    targetCtx: CanvasRenderingContext2D,
    fish: KoiFish,
    ox: number,
    oy: number
  ): void {
    const spine = fish.spine;
    const n = spine.length;
    if (n < 10) return;

    const head = spine[0];
    const n1 = spine[1];
    const hw1 = koiBodyHalfWidth(n1.s, fish.maxHalfWidth);
    const snoutTipX = head.x + head.tx * (hw1 * 0.20) + ox;
    const snoutTipY = head.y + head.ty * (hw1 * 0.20) + oy;

    const tail = spine[n - 1];
    const tailHw = koiBodyHalfWidth(tail.s, fish.maxHalfWidth);
    const sway = Math.sin(fish.phase - 1.9) * fish.maxHalfWidth * 0.48;
    const sway2 = Math.cos(fish.phase - 2.5) * fish.maxHalfWidth * 0.24;
    const peduncleTipX = tail.x - tail.tx * (tailHw * 0.32) + tail.nx * (sway * 0.24) + ox;
    const peduncleTipY = tail.y - tail.ty * (tailHw * 0.32) + tail.ny * (sway * 0.24) + oy;

    // 1. Exact Curved Body Contour with circular cubic-Bezier snout dome
    targetCtx.beginPath();
    targetCtx.moveTo(snoutTipX, snoutTipY);
    targetCtx.bezierCurveTo(
      snoutTipX + head.nx * (hw1 * 0.64),
      snoutTipY + head.ny * (hw1 * 0.64),
      head.x + head.nx * (hw1 * 0.96) + ox,
      head.y + head.ny * (hw1 * 0.96) + oy,
      n1.x + n1.nx * hw1 + ox,
      n1.y + n1.ny * hw1 + oy
    );
    for (let i = 2; i < n; i++) {
      const node = spine[i];
      const hw = koiBodyHalfWidth(node.s, fish.maxHalfWidth);
      const rx = node.x + node.nx * hw + ox;
      const ry = node.y + node.ny * hw + oy;
      const prev = spine[i - 1];
      const prevHw = koiBodyHalfWidth(prev.s, fish.maxHalfWidth);
      const prx = prev.x + prev.nx * prevHw + ox;
      const pry = prev.y + prev.ny * prevHw + oy;
      targetCtx.quadraticCurveTo(prx, pry, (prx + rx) * 0.5, (pry + ry) * 0.5);
    }
    targetCtx.quadraticCurveTo(
      tail.x + tail.nx * (tailHw * 0.88 + sway * 0.14) + ox,
      tail.y + tail.ny * (tailHw * 0.88 + sway * 0.14) + oy,
      peduncleTipX,
      peduncleTipY
    );
    targetCtx.quadraticCurveTo(
      tail.x - tail.nx * (tailHw * 0.88 - sway * 0.14) + ox,
      tail.y - tail.ny * (tailHw * 0.88 - sway * 0.14) + oy,
      tail.x - tail.nx * tailHw + ox,
      tail.y - tail.ny * tailHw + oy
    );
    for (let i = n - 2; i >= 1; i--) {
      const node = spine[i];
      const hw = koiBodyHalfWidth(node.s, fish.maxHalfWidth);
      const lx = node.x - node.nx * hw + ox;
      const ly = node.y - node.ny * hw + oy;
      const next = spine[i + 1];
      const nextHw = koiBodyHalfWidth(next.s, fish.maxHalfWidth);
      const nlx = next.x - next.nx * nextHw + ox;
      const nly = next.y - next.ny * nextHw + oy;
      targetCtx.quadraticCurveTo(nlx, nly, (nlx + lx) * 0.5, (nly + ly) * 0.5);
    }
    targetCtx.lineTo(n1.x - n1.nx * hw1 + ox, n1.y - n1.ny * hw1 + oy);
    targetCtx.bezierCurveTo(
      head.x - head.nx * (hw1 * 0.96) + ox,
      head.y - head.ny * (hw1 * 0.96) + oy,
      snoutTipX - head.nx * (hw1 * 0.64),
      snoutTipY - head.ny * (hw1 * 0.64),
      snoutTipX,
      snoutTipY
    );
    targetCtx.closePath();
    targetCtx.fill();

    // 2. Synced Pectoral & Pelvic Fins (matching redesigned paintKoiPairedFins exactly)
    const isSumie = this.artStyle === "sumie";
    const pLead = this.sampleSpineFrame(fish, 0.276);
    const pTrail = this.sampleSpineFrame(fish, 0.382);
    const hwLead = koiBodyHalfWidth(0.276, fish.maxHalfWidth);
    const hwTrail = koiBodyHalfWidth(0.382, fish.maxHalfWidth);
    const pecSpan = fish.maxHalfWidth * fish.finSpanFactor * (isSumie ? 1.50 : 1.24);
    const sweepOsc = Math.sin(fish.phase * 0.85) * 0.04;

    for (const side of [-1, 1] as const) {
      const rootLx = pLead.x + pLead.nx * (side * hwLead * 0.90) + ox;
      const rootLy = pLead.y + pLead.ny * (side * hwLead * 0.90) + oy;
      const rootTx = pTrail.x + pTrail.nx * (side * hwTrail * 0.88) + ox;
      const rootTy = pTrail.y + pTrail.ny * (side * hwTrail * 0.88) + oy;
      const backSweep = (isSumie ? 0.62 : 0.30) + sweepOsc * side;
      const outX = pLead.nx * side - pLead.tx * backSweep;
      const outY = pLead.ny * side - pLead.ty * backSweep;
      const outLen = Math.hypot(outX, outY) || 1;
      const ux = outX / outLen;
      const uy = outY / outLen;
      const fx = pLead.tx;
      const fy = pLead.ty;
      const tipX = rootLx + ux * pecSpan - fx * (pecSpan * (isSumie ? 0.22 : 0.05));
      const tipY = rootLy + uy * pecSpan - fy * (pecSpan * (isSumie ? 0.22 : 0.05));

      targetCtx.beginPath();
      targetCtx.moveTo(rootLx, rootLy);
      targetCtx.bezierCurveTo(
        rootLx + ux * (pecSpan * 0.48) + fx * (pecSpan * 0.26),
        rootLy + uy * (pecSpan * 0.48) + fy * (pecSpan * 0.26),
        rootLx + ux * (pecSpan * 0.96) + fx * (pecSpan * 0.12),
        rootLy + uy * (pecSpan * 0.96) + fy * (pecSpan * 0.12),
        tipX,
        tipY
      );
      targetCtx.quadraticCurveTo(
        rootTx + ux * (pecSpan * 0.62) - fx * (pecSpan * 0.26),
        rootTy + uy * (pecSpan * 0.62) - fy * (pecSpan * 0.26),
        rootTx,
        rootTy
      );
      targetCtx.closePath();
      targetCtx.fill();
    }

    // 3. Synced Unified Caudal Fin (matching paintKoiCaudalFin 1:1 — zero ghost tail!)
    const caudalFin = computeCaudalFin(fish);
    traceCaudalFinPath(targetCtx, caudalFin, ox, oy);
    targetCtx.fill();
  }

  /**
   * Updates the Dark Mode Flashlight position and dispersal state, plus the dynamic botanical
   * interactions (asynchronous Lotus Leaf sway + Pink Lotus lag, and longitudinal Maple Leaf oscillation).
   */
  private updateFlashlightAndBotanicalState(
    width: number,
    height: number,
    world: PondWorld,
    worldW: number,
    worldH: number,
    time: number
  ): void {
    const now = performance.now();
    const dt =
      this.lastFlashUpdateAt > 0
        ? koiClamp((now - this.lastFlashUpdateAt) / 1000, 0.004, 0.06)
        : 1 / 60;
    this.lastFlashUpdateAt = now;
    this.lastBotanicalUpdateAt = now;

    // 1. Flashlight dispersal & smooth natural cursor follow (synced with virtual sun altitude during sunset/sunrise)
    const curDaylight = this.getDaylightFactor();
    const targetDispersal = !this.flashlightEnabled
      ? 1.0
      : this.transitioning
        ? koiClamp(curDaylight * 1.08, 0, 1)
        : this.isLightMode
          ? 1.0
          : 0.0;
    const speed = this.transitioning ? 4.5 : targetDispersal > this.flashlightDispersal ? 1.55 : 1.35;
    if (this.flashlightDispersal < targetDispersal) {
      this.flashlightDispersal = Math.min(targetDispersal, this.flashlightDispersal + dt * speed);
    } else if (this.flashlightDispersal > targetDispersal) {
      this.flashlightDispersal = Math.max(targetDispersal, this.flashlightDispersal - dt * speed);
    }

    if (this.flashX < 0 || this.flashY < 0) {
      this.flashX = width * 0.5;
      this.flashY = height * 0.5;
    }

    let targetX: number;
    let targetY: number;
    let followRate: number;
    if (
      this.rawPointerActive &&
      this.rawPointerX >= 0 &&
      this.rawPointerY >= 0 &&
      this.rawPointerX <= width &&
      this.rawPointerY <= height
    ) {
      targetX = this.rawPointerX;
      targetY = this.rawPointerY;
      followRate = 14.0;
    } else {
      targetX =
        width * (0.5 + 0.36 * Math.sin(time * 0.34 + 0.5) * Math.cos(time * 0.16));
      targetY =
        height * (0.5 + 0.34 * Math.cos(time * 0.27 + 1.1) * Math.sin(time * 0.19 + 0.3));
      followRate = 2.0;
    }

    const kFollow = 1 - Math.exp(-dt * followRate);
    this.flashX += (targetX - this.flashX) * kFollow;
    this.flashY += (targetY - this.flashY) * kFollow;

    // 2. Step Interactive Single-Ring Click Ripples & Apply Wavefront Forces
    const unit = koiClamp(Math.min(worldW, worldH) / 860, 0.46, 1.22);
    const resolvedPads = this.getResolvedLotusPads(worldW, worldH, unit);
    const largeMapleLeaves = this.getLargeMapleLeafSpecs(worldW, worldH, unit, time);

    // Initialize or proportionally rescale unbounded Maple Leaf positions on resize
    if (
      Math.abs(this.mapleLeafWorldW - worldW) > 1 ||
      Math.abs(this.mapleLeafWorldH - worldH) > 1
    ) {
      const hadPrev = this.mapleLeafWorldW > 0 && this.mapleLeafWorldH > 0;
      const sx = hadPrev ? worldW / this.mapleLeafWorldW : 1;
      const sy = hadPrev ? worldH / this.mapleLeafWorldH : 1;
      this.mapleLeafWorldW = worldW;
      this.mapleLeafWorldH = worldH;
      for (let m = 0; m < largeMapleLeaves.length; m++) {
        const mst = this.mapleLeafStates[m];
        if (!mst.initialized) {
          mst.x = largeMapleLeaves[m].x;
          mst.y = largeMapleLeaves[m].y;
          mst.rot = largeMapleLeaves[m].rot;
          mst.initialized = true;
        } else if (hadPrev) {
          mst.x = koiClamp(mst.x * sx, 24 * unit, worldW - 24 * unit);
          mst.y = koiClamp(mst.y * sy, 24 * unit, worldH - 24 * unit);
        }
      }
    }

    const rippleSpeed = 128 * unit;
    const waveBand = 24 * unit;
    for (let rIdx = this.clickRipples.length - 1; rIdx >= 0; rIdx--) {
      const rip = this.clickRipples[rIdx];
      rip.lastRadius = rip.radius;
      rip.radius += rippleSpeed * dt;
      if (rip.radius >= rip.maxRadius) {
        this.clickRipples.splice(rIdx, 1);
        continue;
      }
      const fade = Math.max(0, 1 - rip.radius / rip.maxRadius);

      // A. Expanding wavefront sways Lotus Pads & Pink Lotuses in place
      for (let i = 0; i < resolvedPads.length; i++) {
        const pa = resolvedPads[i];
        const st = this.lotusPadStates[i];
        const dx = pa.x - rip.x;
        const dy = pa.y - rip.y;
        const dist = Math.hypot(dx, dy);
        if (Math.abs(dist - rip.radius) < pa.r + waveBand) {
          const ux = dist > 0.5 ? dx / dist : 1;
          const uy = dist > 0.5 ? dy / dist : 0;
          st.excite = Math.min(1.5, st.excite + dt * 3.4 * fade);
          st.swayVx += ux * 95 * fade * dt * unit;
          st.swayVy += uy * 95 * fade * dt * unit;
        }
      }

      // B. Expanding wavefront pushes Floating Maple Leaves freely anywhere in the pond
      for (let m = 0; m < largeMapleLeaves.length; m++) {
        const mst = this.mapleLeafStates[m];
        const dx = mst.x - rip.x;
        const dy = mst.y - rip.y;
        const dist = Math.hypot(dx, dy);
        if (Math.abs(dist - rip.radius) < largeMapleLeaves[m].size + waveBand) {
          const ux = dist > 0.5 ? dx / dist : 1;
          const uy = dist > 0.5 ? dy / dist : 0;
          mst.velX += ux * 240 * fade * dt * unit;
          mst.velY += uy * 240 * fade * dt * unit;
        }
      }

      // C. Expanding wavefront pushes Floating Sakura Flowers & Petals freely anywhere in the pond
      for (let s = 0; s < this.floatingSakuraParticles.length; s++) {
        const sp = this.floatingSakuraParticles[s];
        const dx = sp.x - rip.x;
        const dy = sp.y - rip.y;
        const dist = Math.hypot(dx, dy);
        if (Math.abs(dist - rip.radius) < waveBand * 1.25) {
          const ux = dist > 0.5 ? dx / dist : 1;
          const uy = dist > 0.5 ? dy / dist : 0;
          sp.vx += ux * 38 * fade * dt * unit;
          sp.vy += uy * 38 * fade * dt * unit;
          sp.calmCooldown = Math.max(sp.calmCooldown, 1.0);
        }
      }
    }

    // 3. Asynchronous Lotus Leaf Sway + Secondary Phase Lag + Click-Ripple Elastic Sway (In-Place Only)
    for (let i = 0; i < resolvedPads.length; i++) {
      const pa = resolvedPads[i];
      const px = pa.x;
      const py = pa.y;
      const pr = pa.r;
      const st = this.lotusPadStates[i];

      let maxProx = 0;
      for (let k = 0; k < world.koi.length; k++) {
        const fish = world.koi[k];
        const sp = fish.spine;
        if (!sp || sp.length < 6) continue;
        for (const nIdx of [0, 4, 10, sp.length - 1]) {
          const node = sp[nIdx];
          const d = Math.hypot(node.x - px, node.y - py);
          const triggerR = pr * 1.22 + fish.maxHalfWidth * 1.9;
          if (d < triggerR) {
            const prox = (1 - d / triggerR) * koiClamp(fish.speed / 35, 0.35, 1.4);
            if (prox > maxProx) maxProx = prox;
          }
        }
      }

      if (maxProx > 0.02) {
        st.excite = Math.min(1.5, st.excite + dt * (3.8 * maxProx));
      } else {
        st.excite *= Math.exp(-dt * 1.25);
      }

      // Spring-damper for click-ripple sway in place (so lotus leaves & lotuses sway and return smoothly)
      const kLotusSpring = 6.5;
      const kLotusDamp = 2.8;
      st.swayVx += (-kLotusSpring * st.swayX - kLotusDamp * st.swayVx) * dt;
      st.swayVy += (-kLotusSpring * st.swayY - kLotusDamp * st.swayVy) * dt;
      st.swayX += st.swayVx * dt;
      st.swayY += st.swayVy * dt;
      const maxLotusSway = 18 * unit;
      const swayMag = Math.hypot(st.swayX, st.swayY);
      if (swayMag > maxLotusSway) {
        st.swayX = (st.swayX / swayMag) * maxLotusSway;
        st.swayY = (st.swayY / swayMag) * maxLotusSway;
      }

      st.rotVel += (-7.5 * st.rotOffset - 3.0 * st.rotVel) * dt;
      st.rotOffset = koiClamp(st.rotOffset + st.rotVel * dt, -0.26, 0.26);

      // Advance independent leaf phase calmly (gentle swell when koi pass, never high-frequency wobble)
      const instFreq = st.baseFreq + st.excite * 0.24;
      st.leafPhase += dt * instFreq;

      // Secondary phase lag for the companion blooming pink lotus flower
      const targetFlowerPhase = st.leafPhase - 0.68;
      st.flowerPhase += (targetFlowerPhase - st.flowerPhase) * Math.min(1, dt * 4.2);
    }

    // 3B. Priority Koi-Path Parting & Zero-Overlap Solver for All 27 Lotus & Companion Leaves + Stems:
    //     When any koi swims directly under a parent or companion leaf (or across its underwater stem),
    //     the leaf in the fish's direct path gets highest priority, parts fully clear of the koi's body
    //     along with its stem, never overlaps neighboring leaves/maples, and returns smoothly once clear.
    const companionLeaves = this.getResolvedCompanionLeaves(worldW, worldH, unit, resolvedPads);
    interface PartNode {
      isParent: boolean;
      idx: number;
      restX: number;
      restY: number;
      baseX: number;
      baseY: number;
      r: number;
      dispX: number;
      dispY: number;
      dispVx: number;
      dispVy: number;
      bowX: number;
      bowY: number;
      priority: number;
      rootX: number;
      rootY: number;
    }
    const partNodes: PartNode[] = [];
    for (let i = 0; i < resolvedPads.length; i++) {
      const pad = resolvedPads[i];
      const st = this.lotusPadStates[i];
      const ampBoost = 1.0 + st.excite * 0.22;
      const baseSwayX = Math.sin(st.leafPhase) * 3.0 * unit * ampBoost + st.swayX;
      const baseSwayY = Math.cos(st.leafPhase * 0.84 + i) * 2.4 * unit * ampBoost + st.swayY;
      const restTipX = pad.x - Math.cos(pad.notch) * (pad.r * 0.06);
      const restTipY = pad.y - Math.sin(pad.notch) * (pad.r * 0.06);
      const exit = this.computeNearestEdgeExit(restTipX, restTipY, worldW, worldH, unit, i);
      partNodes.push({
        isParent: true,
        idx: i,
        restX: pad.x,
        restY: pad.y,
        baseX: pad.x + baseSwayX,
        baseY: pad.y + baseSwayY,
        r: pad.r,
        dispX: st.dispX,
        dispY: st.dispY,
        dispVx: st.dispVx,
        dispVy: st.dispVy,
        bowX: st.bowX,
        bowY: st.bowY,
        priority: 0,
        rootX: exit.x,
        rootY: exit.y,
      });
    }
    for (let cIdx = 0; cIdx < companionLeaves.length; cIdx++) {
      const comp = companionLeaves[cIdx];
      const st = this.lotusPadStates[comp.parentIdx];
      const cst = this.companionLeafStates[cIdx];
      const cPhase = st.leafPhase * 1.08 + cIdx * 0.85;
      const ampBoost = 1.0 + st.excite * 0.22;
      const baseSwayX = Math.sin(cPhase) * 2.5 * unit * ampBoost + st.swayX * 0.90;
      const baseSwayY = Math.cos(cPhase * 0.86 + cIdx) * 2.0 * unit * ampBoost + st.swayY * 0.90;
      const cleftR = comp.r * 0.20;
      const restTipX = comp.x + Math.cos(comp.notch) * cleftR;
      const restTipY = comp.y + Math.sin(comp.notch) * cleftR;
      const exit = this.computeNearestEdgeExit(restTipX, restTipY, worldW, worldH, unit, 9 + cIdx);
      partNodes.push({
        isParent: false,
        idx: cIdx,
        restX: comp.x,
        restY: comp.y,
        baseX: comp.x + baseSwayX,
        baseY: comp.y + baseSwayY,
        r: comp.r,
        dispX: cst.dispX,
        dispY: cst.dispY,
        dispVx: cst.dispVx,
        dispVy: cst.dispVy,
        bowX: cst.bowX,
        bowY: cst.bowY,
        priority: 0,
        rootX: exit.x,
        rootY: exit.y,
      });
    }

    // Step 1: Compute per-leaf full-clearance parting target & fish-path priority
    const spineSampleIndices = [0, 2, 4, 6, 8, 10, 12, 14, 16, 19];
    for (let nIdx = 0; nIdx < partNodes.length; nIdx++) {
      const nd = partNodes[nIdx];
      const curX = nd.baseX + nd.dispX;
      const curY = nd.baseY + nd.dispY;
      let targetX = 0;
      let targetY = 0;
      let targetBowX = 0;
      let targetBowY = 0;
      let maxPrio = 0;

      for (let k = 0; k < world.koi.length; k++) {
        const fish = world.koi[k];
        const sp = fish.spine;
        if (!sp || sp.length < 10) continue;
        const head = sp[0];
        // Strict contact detection: leaf does NOT displace until the fish body physically contacts it
        let bestDist = Infinity;
        let bestX = head.x;
        let bestY = head.y;
        let bestNx = head.nx;
        let bestNy = head.ny;
        let bestHw = head.halfWidth || fish.maxHalfWidth * 0.75;

        for (let si = 0; si < spineSampleIndices.length; si++) {
          const sIdx = Math.min(sp.length - 1, spineSampleIndices[si]);
          const sn = sp[sIdx];
          const d = Math.hypot(nd.restX - sn.x, nd.restY - sn.y);
          if (d < bestDist) {
            bestDist = d;
            bestX = sn.x;
            bestY = sn.y;
            bestNx = sn.nx;
            bestNy = sn.ny;
            bestHw = Math.max(sn.halfWidth, fish.maxHalfWidth * 0.55);
          }
        }

        // Trigger strictly on physical contact (bestHw + nd.r)
        const contactR = bestHw + nd.r;
        if (bestDist < contactR) {
          const overlap = contactR - bestDist;
          const relX = (Math.hypot(nd.dispX, nd.dispY) > 4 * unit ? curX : nd.restX) - bestX;
          const relY = (Math.hypot(nd.dispX, nd.dispY) > 4 * unit ? curY : nd.restY) - bestY;
          const sideDot = relX * bestNx + relY * bestNy;
          const side = sideDot >= 0 ? 1 : -1;
          // Push smoothly perpendicular to the fish spine so the leaf & stem clear the fish cleanly
          const pushDist = overlap + 6 * unit;
          targetX += bestNx * side * pushDist;
          targetY += bestNy * side * pushDist;
          const prio = 1.0 + overlap / Math.max(1, contactR);
          if (prio > maxPrio) maxPrio = prio;
        }

        // Subtle mid-stem bend only on direct contact (kept taut so stems never over-bend)
        for (const tStem of [0.45, 0.70]) {
          const sx = koiLerp(nd.rootX, curX, tStem);
          const sy = koiLerp(nd.rootY, curY, tStem);
          for (const sIdx of [2, 8, 14]) {
            const sn = sp[Math.min(sp.length - 1, sIdx)];
            const sd = Math.hypot(sx - sn.x, sy - sn.y);
            const stemClear = Math.max(sn.halfWidth, fish.maxHalfWidth * 0.55) + 4 * unit;
            if (sd < stemClear) {
              const sOver = stemClear - sd;
              const sDot = (sx - sn.x) * sn.nx + (sy - sn.y) * sn.ny;
              const sSide = sDot >= 0 ? 1 : -1;
              targetBowX += sn.nx * sSide * sOver * 0.35;
              targetBowY += sn.ny * sSide * sOver * 0.35;
            }
          }
        }
      }

      nd.priority = maxPrio;
      const maxDisp = Math.min(worldW, worldH) * 0.26;
      const tMag = Math.hypot(targetX, targetY);
      if (tMag > maxDisp) {
        targetX = (targetX / tMag) * maxDisp;
        targetY = (targetY / tMag) * maxDisp;
      }

      if (maxPrio > 0) {
        // Fast, fluid parting while koi passes beneath
        const kPush = 18.0;
        const dampPush = 6.2;
        nd.dispVx += ((targetX - nd.dispX) * kPush - nd.dispVx * dampPush) * dt;
        nd.dispVy += ((targetY - nd.dispY) * kPush - nd.dispVy * dampPush) * dt;
      } else {
        // Gentle botanical spring-damper return to rest once fish has passed
        const kRet = 3.8;
        const dampRet = 3.1;
        nd.dispVx += (-nd.dispX * kRet - nd.dispVx * dampRet) * dt;
        nd.dispVy += (-nd.dispY * kRet - nd.dispVy * dampRet) * dt;
      }
      nd.dispX += nd.dispVx * dt;
      nd.dispY += nd.dispVy * dt;

      const bowLerp = Math.min(1, dt * (maxPrio > 0 ? 10.0 : 4.0));
      nd.bowX += (koiClamp(targetBowX, -22 * unit, 22 * unit) - nd.bowX) * bowLerp;
      nd.bowY += (koiClamp(targetBowY, -22 * unit, 22 * unit) - nd.bowY) * bowLerp;
    }

    // Step 2: Multi-pass zero-overlap solver across all 27 parent & companion leaves (priority-weighted)
    for (let pass = 0; pass < 5; pass++) {
      for (let i = 0; i < partNodes.length; i++) {
        const a = partNodes[i];
        const ax = a.baseX + a.dispX;
        const ay = a.baseY + a.dispY;
        for (let j = i + 1; j < partNodes.length; j++) {
          const b = partNodes[j];
          const bx = b.baseX + b.dispX;
          const by = b.baseY + b.dispY;
          const dx = bx - ax;
          const dy = by - ay;
          const dist = Math.hypot(dx, dy) || 0.001;
          const minSep = a.r + b.r + 3.5 * unit;
          if (dist < minSep) {
            const overlap = minSep - dist;
            const ux = dx / dist;
            const uy = dy / dist;
            let wA = 0.5;
            let wB = 0.5;
            if (a.priority > b.priority + 0.05) {
              wA = 0.18;
              wB = 0.82;
            } else if (b.priority > a.priority + 0.05) {
              wA = 0.82;
              wB = 0.18;
            }
            a.dispX -= ux * overlap * wA;
            a.dispY -= uy * overlap * wA;
            b.dispX += ux * overlap * wB;
            b.dispY += uy * overlap * wB;
          }
        }
        // Keep displaced leaves cleanly within pond bounds
        const margin = a.r + 5 * unit;
        const clampedX = koiClamp(a.baseX + a.dispX, margin, Math.max(margin + 1, worldW - margin));
        const clampedY = koiClamp(a.baseY + a.dispY, margin, Math.max(margin + 1, worldH - margin));
        a.dispX = clampedX - a.baseX;
        a.dispY = clampedY - a.baseY;
      }
    }

    // Write back resolved displacements
    for (let nIdx = 0; nIdx < partNodes.length; nIdx++) {
      const nd = partNodes[nIdx];
      if (nd.isParent) {
        const st = this.lotusPadStates[nd.idx];
        st.dispX = nd.dispX;
        st.dispY = nd.dispY;
        st.dispVx = nd.dispVx;
        st.dispVy = nd.dispVy;
        st.bowX = nd.bowX;
        st.bowY = nd.bowY;
      } else {
        const cst = this.companionLeafStates[nd.idx];
        cst.dispX = nd.dispX;
        cst.dispY = nd.dispY;
        cst.dispVx = nd.dispVx;
        cst.dispVy = nd.dispVy;
        cst.bowX = nd.bowX;
        cst.bowY = nd.bowY;
      }
    }

    // 4. Unbounded Free-Floating 2D Water-Drift Physics for the 6 Floating Maple Leaves
    //    (Position & region lock lifted: Koi wakes and click ripples can carry them anywhere in the pond!)
    for (let m = 0; m < largeMapleLeaves.length; m++) {
      const spec = largeMapleLeaves[m];
      const mst = this.mapleLeafStates[m];
      if (!mst.initialized) {
        mst.x = spec.x;
        mst.y = spec.y;
        mst.rot = spec.rot;
        mst.initialized = true;
      }

      let wakeForceX = 0;
      let wakeForceY = 0;

      for (let k = 0; k < world.koi.length; k++) {
        const fish = world.koi[k];
        const sp = fish.spine;
        if (!sp || sp.length < 8) continue;
        const centerNode = sp[6];
        const dist = Math.hypot(centerNode.x - mst.x, centerNode.y - mst.y);
        const trigR = spec.radius + fish.maxHalfWidth * 2.2;

        if (dist < trigR && fish.speed > 6) {
          const uProx = 1 - dist / trigR;
          const bellEnv = uProx * uProx * (3 - 2 * uProx);
          const fDirX = Math.cos(fish.angle);
          const fDirY = Math.sin(fish.angle);
          const wakeMag = bellEnv * koiClamp(fish.speed, 18, 95) * 1.85;
          wakeForceX += fDirX * wakeMag;
          wakeForceY += fDirY * wakeMag;
        }
      }

      // Pure viscous water drag with ZERO home-anchor spring so Maple leaves stay wherever displaced
      const drag = Math.exp(-dt * 1.85);
      mst.velX = (mst.velX + wakeForceX * dt) * drag;
      mst.velY = (mst.velY + wakeForceY * dt) * drag;
      mst.x += mst.velX * dt;
      mst.y += mst.velY * dt;

      mst.rotVel *= Math.exp(-dt * 2.4);
      mst.rot += mst.rotVel * dt;

      const margin = spec.size * 1.05 + 6 * unit;
      mst.x = koiClamp(mst.x, margin, Math.max(margin + 1, worldW - margin));
      mst.y = koiClamp(mst.y, margin, Math.max(margin + 1, worldH - margin));
    }
  }

  /**
   * Returns the exact live world positions `(x, y, size, rot, under, hanko)` of all 6 floating
   * Maple Leaves after applying gentle ambient wave sway, unbounded click/Koi drift, and mutual
   * non-overlap separation against Lotus pads and other Maple leaves.
   */
  private getLiveMapleLeafPositions(
    worldW: number,
    worldH: number,
    unit: number,
    time: number
  ): {
    x: number;
    y: number;
    size: number;
    rot: number;
    under: boolean;
    hanko: boolean;
  }[] {
    const specs = this.getLargeMapleLeafSpecs(worldW, worldH, unit, time);
    const resolvedPads = this.getResolvedLotusPads(worldW, worldH, unit);

    for (let m = 0; m < specs.length; m++) {
      const mst = this.mapleLeafStates[m];
      if (!mst.initialized) {
        mst.x = specs[m].x;
        mst.y = specs[m].y;
        mst.rot = specs[m].rot;
        mst.initialized = true;
      }
    }

    const compLeavesForMaple = this.getResolvedCompanionLeaves(worldW, worldH, unit, resolvedPads);
    // Enforce strict non-overlap on Maple Leaves against all 9 displaced Lotus Pads, 18 Companion Leaves & other Maples
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < specs.length; i++) {
        const m = this.mapleLeafStates[i];
        const mSize = specs[i].size;
        for (let p = 0; p < resolvedPads.length; p++) {
          const lp = resolvedPads[p];
          const st = this.lotusPadStates[p];
          const lpx = lp.x + st.swayX + st.dispX;
          const lpy = lp.y + st.swayY + st.dispY;
          const dx = m.x - lpx;
          const dy = m.y - lpy;
          const dist = Math.hypot(dx, dy) || 0.001;
          const minSep = lp.r * 1.06 + mSize * 1.05 + 6 * unit;
          if (dist < minSep) {
            const ux = dx / dist;
            const uy = dy / dist;
            m.x = lpx + ux * minSep;
            m.y = lpy + uy * minSep;
            const vn = m.velX * ux + m.velY * uy;
            if (vn < 0) {
              m.velX -= ux * vn;
              m.velY -= uy * vn;
            }
          }
        }
        for (let c = 0; c < compLeavesForMaple.length; c++) {
          const cp = compLeavesForMaple[c];
          const st = this.lotusPadStates[cp.parentIdx];
          const cst = this.companionLeafStates[c];
          const cpx = cp.x + st.swayX * 0.90 + (cst ? cst.dispX : 0);
          const cpy = cp.y + st.swayY * 0.90 + (cst ? cst.dispY : 0);
          const dx = m.x - cpx;
          const dy = m.y - cpy;
          const dist = Math.hypot(dx, dy) || 0.001;
          const minSep = cp.r * 1.06 + mSize * 1.05 + 4 * unit;
          if (dist < minSep) {
            const ux = dx / dist;
            const uy = dy / dist;
            m.x = cpx + ux * minSep;
            m.y = cpy + uy * minSep;
            const vn = m.velX * ux + m.velY * uy;
            if (vn < 0) {
              m.velX -= ux * vn;
              m.velY -= uy * vn;
            }
          }
        }
        for (let j = i + 1; j < specs.length; j++) {
          const b = this.mapleLeafStates[j];
          const bSize = specs[j].size;
          const dx = b.x - m.x;
          const dy = b.y - m.y;
          const dist = Math.hypot(dx, dy) || 0.001;
          const minSep = (mSize + bSize) * 1.06 + 6 * unit;
          if (dist < minSep) {
            const push = (minSep - dist) * 0.5;
            const ux = dx / dist;
            const uy = dy / dist;
            m.x -= ux * push;
            m.y -= uy * push;
            b.x += ux * push;
            b.y += uy * push;
          }
        }
        const margin = mSize * 1.05 + 6 * unit;
        m.x = koiClamp(m.x, margin, Math.max(margin + 1, worldW - margin));
        m.y = koiClamp(m.y, margin, Math.max(margin + 1, worldH - margin));
      }
    }

    return specs.map((cm, m) => {
      const mst = this.mapleLeafStates[m];
      const breathAxisX = Math.cos(mst.rot);
      const breathAxisY = Math.sin(mst.rot);
      const longWave = Math.sin(time * 0.72 + m * 0.7) * 3.2 * unit;
      const swayX =
        Math.sin(time * 0.65 + m * 0.6) * 2.0 * unit +
        breathAxisX * longWave;
      const swayY =
        Math.cos(time * 0.58 + m * 0.5) * 1.8 * unit +
        breathAxisY * longWave;
      const rot = mst.rot + Math.sin(time * 0.52 + m) * 0.04;
      return {
        x: mst.x + swayX,
        y: mst.y + swayY,
        size: cm.size,
        rot,
        under: cm.under,
        hanko: cm.hanko,
      };
    });
  }

  private getLargeMapleLeafSpecs(
    worldW: number,
    worldH: number,
    unit: number,
    time = 0
  ): {
    x: number;
    y: number;
    size: number;
    rot: number;
    under: boolean;
    hanko: boolean;
    radius: number;
  }[] {
    // 6 Large Floating Maple Leaves distributed along the peripheral water lanes (keeping the center screen 100% maple-free)
    const baseAnchors = [
      { fx: 0.10, fy: 0.13, size: 52 * unit, rot: 0.45, under: false, hanko: false },
      { fx: 0.22, fy: 0.09, size: 48 * unit, rot: 0.92, under: true, hanko: true },
      { fx: 0.08, fy: 0.31, size: 54 * unit, rot: 1.15, under: false, hanko: false },
      { fx: 0.11, fy: 0.59, size: 50 * unit, rot: 0.72, under: true, hanko: false },
      { fx: 0.89, fy: 0.36, size: 53 * unit, rot: -2.15, under: false, hanko: true },
      { fx: 0.86, fy: 0.84, size: 49 * unit, rot: -1.65, under: true, hanko: false },
    ];

    const resolvedPads = this.getResolvedLotusPads(worldW, worldH, unit);
    const exclusions: { cx: number; cy: number; r: number }[] = [];
    for (let i = 0; i < resolvedPads.length; i++) {
      const p = resolvedPads[i];
      exclusions.push({ cx: p.x, cy: p.y, r: p.r });
      if (p.hasLotus) {
        exclusions.push({
          cx: p.x + Math.cos(p.notch + 0.35) * (p.r * 0.78),
          cy: p.y + Math.sin(p.notch + 0.35) * (p.r * 0.78),
          r: p.r * 0.66,
        });
      }
    }

    const leaves = baseAnchors.map((ba, idx) => {
      // Continuous, calm water-current figure-8 drift & sway on the water surface
      const driftX =
        Math.sin(time * 0.24 + idx * 1.7) * 28 * unit +
        Math.cos(time * 0.15 - idx * 1.1) * 14 * unit;
      const driftY =
        Math.cos(time * 0.21 + idx * 1.3) * 24 * unit +
        Math.sin(time * 0.14 + idx * 0.9) * 12 * unit;
      const rotDrift =
        ba.rot +
        Math.sin(time * 0.32 + idx * 1.4) * 0.22 +
        Math.cos(time * 0.19 - idx) * 0.10;

      return {
        x: worldW * ba.fx + driftX,
        y: worldH * ba.fy + driftY,
        size: ba.size,
        rot: rotDrift,
        under: ba.under,
        hanko: ba.hanko,
        radius: 165 * unit,
      };
    });

    // Enforce: (1) Center screen stays maple-free, (2) Zero overlap with any lotus leaf/flower, (3) Zero leaf-to-leaf intersection
    const centerMinX = worldW * 0.27;
    const centerMaxX = worldW * 0.73;
    const centerMinY = worldH * 0.25;
    const centerMaxY = worldH * 0.75;

    for (let pass = 0; pass < 5; pass++) {
      for (let i = 0; i < leaves.length; i++) {
        const lf = leaves[i];
        // 1. Keep center area of the screen maple-free
        if (
          lf.x > centerMinX - lf.size &&
          lf.x < centerMaxX + lf.size &&
          lf.y > centerMinY - lf.size &&
          lf.y < centerMaxY + lf.size
        ) {
          const dLeft = Math.abs(lf.x - (centerMinX - lf.size));
          const dRight = Math.abs(centerMaxX + lf.size - lf.x);
          const dTop = Math.abs(lf.y - (centerMinY - lf.size));
          const dBot = Math.abs(centerMaxY + lf.size - lf.y);
          const minD = Math.min(dLeft, dRight, dTop, dBot);
          if (minD === dLeft) lf.x = centerMinX - lf.size;
          else if (minD === dRight) lf.x = centerMaxX + lf.size;
          else if (minD === dTop) lf.y = centerMinY - lf.size;
          else lf.y = centerMaxY + lf.size;
        }

        // 2. Keep clear of all 9 lotus leaves & pink lotuses (including dynamic wake margin)
        for (let e = 0; e < exclusions.length; e++) {
          const ex = exclusions[e];
          const dx = lf.x - ex.cx;
          const dy = lf.y - ex.cy;
          const dist = Math.hypot(dx, dy);
          const minClearDist = ex.r + lf.size * 1.18 + 38 * unit;
          if (dist < minClearDist) {
            const ux = dist > 0.001 ? dx / dist : -0.7071;
            const uy = dist > 0.001 ? dy / dist : -0.7071;
            lf.x = ex.cx + ux * minClearDist;
            lf.y = ex.cy + uy * minClearDist;
          }
        }

        // 3. Mutual maple-to-maple non-intersection
        for (let j = i + 1; j < leaves.length; j++) {
          const other = leaves[j];
          const dx = other.x - lf.x;
          const dy = other.y - lf.y;
          const dist = Math.hypot(dx, dy);
          const minMapleSep = (lf.size + other.size) * 1.18 + 18 * unit;
          if (dist < minMapleSep) {
            const ux = dist > 0.001 ? dx / dist : 1;
            const uy = dist > 0.001 ? dy / dist : 0;
            const push = (minMapleSep - dist) * 0.5;
            lf.x -= ux * push;
            lf.y -= uy * push;
            other.x += ux * push;
            other.y += uy * push;
          }
        }

        const edgePad = lf.size * 1.05 + 14 * unit;
        lf.x = koiClamp(lf.x, edgePad, Math.max(edgePad + 1, worldW - edgePad));
        lf.y = koiClamp(lf.y, edgePad, Math.max(edgePad + 1, worldH - edgePad));
      }
    }

    return leaves;
  }

  /**
   * Returns the current flashlight base radius (increased by 10% over the 2x radius).
   */
  private getFlashlightBaseRadius(width: number, height: number): number {
    return Math.max(506, Math.min(width, height) * 0.748);
  }

  /**
   * Initializes and renders the WebGL Water Caustics shader from `caustics.zip`
   * (`caustics.vert.glsl` + `caustics.frag.glsl`), tuned for the KOI pond.
   */
  private renderCausticsShaderCanvas(
    targetW: number,
    targetH: number,
    fullViewH: number,
    rectScale: number,
    time: number,
    style: KoiArtStyle,
    isLight: boolean
  ): HTMLCanvasElement | null {
    if (this.causticGLFailed) return null;

    const renderScale = 0.55;
    const bw = Math.max(64, Math.round(targetW * rectScale * renderScale));
    const bh = Math.max(64, Math.round(targetH * rectScale * renderScale));
    const refH = Math.max(64, Math.round(fullViewH * renderScale));

    if (!this.causticGLCanvas) {
      const c = document.createElement("canvas");
      this.causticGLCanvas = c;
      const gl = (c.getContext("webgl", { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false }) ||
        c.getContext("experimental-webgl", { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false })) as WebGLRenderingContext | null;
      if (!gl) {
        this.causticGLFailed = true;
        return null;
      }
      this.causticGL = gl;

      const vsSource = `
        attribute vec2 aPosition;
        varying vec2 vUv;
        void main() {
          vUv = aPosition * 0.5 + 0.5;
          gl_Position = vec4(aPosition, 0.0, 1.0);
        }
      `;

      const fsSource = `
        precision highp float;
        varying vec2 vUv;

        uniform vec2  uResolution;
        uniform float uRefHeight;
        uniform float uTime;
        uniform float uSpeed;
        uniform float uScale;
        uniform vec2  uMouse;
        uniform float uMouseStrength;
        uniform float uIsSumie;
        uniform float uIsLight;
        uniform float uSunWarmth;
        uniform float uDaylight;

        vec2 hash22(vec2 p) {
          return fract(sin(vec2(dot(p, vec2(127.1, 311.7)),
                                dot(p, vec2(269.5, 183.3)))) * 43758.5453);
        }

        float hash21(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }

        float vnoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }

        void main() {
          float t = uTime * uSpeed;

          vec2 uv = gl_FragCoord.xy / max(1.0, uRefHeight);
          vec2 p = uv * uScale;

          vec2 w = vec2(
            vnoise(p * 0.35 + vec2(sin(t * 0.08) * 0.65, 0.0)),
            vnoise(p * 0.35 + vec2(7.3, cos(t * 0.08) * 0.65))
          ) - 0.5;
          p += w * 0.6;

          vec2 ip = floor(p);
          vec2 fp = p - ip;
          float f1 = 8.0, f2 = 8.0, f3 = 8.0;

          for (int j = -1; j <= 1; j++) {
            for (int i = -1; i <= 1; i++) {
              vec2 g = vec2(float(i), float(j));
              vec2 h = hash22(ip + g);
              vec2 o = 0.5 + 0.40 * vec2(
                sin(t * (0.25 + 0.35 * h.x) + 6.2831 * h.y),
                sin(t * (0.25 + 0.35 * h.y) + 6.2831 * h.x + 1.7)
              );
              float d = length(g + o - fp);
              if (d < f1)      { f3 = f2; f2 = f1; f1 = d; }
              else if (d < f2) { f3 = f2; f2 = d; }
              else if (d < f3) { f3 = d; }
            }
          }

          float e  = f2 - f1;
          float es = sqrt(e * e + 0.05) - 0.224;
          float base = 0.02 + 0.125 * pow(f1 / 0.5, 2.4);

          float mRaw = vnoise(p * 0.45 + vec2(sin(t * 0.18) * 1.4, -cos(t * 0.15) * 1.2)) * 0.6
                     + vnoise(p * 0.80 + vec2(-cos(t * 0.22) * 1.3, sin(t * 0.19) * 1.1)) * 0.4;

          vec2 mp = uMouse * vec2(uResolution.x / max(1.0, uRefHeight), 1.0) * uScale;
          mRaw += uMouseStrength * 0.12 * exp(-dot(p - mp, p - mp) * 0.08);

          float m = smoothstep(0.58, 0.86, mRaw);

          float jj = f3 - f1;
          float ambientWeb = 0.22 * exp(-es * 24.0) + 0.34 * exp(-jj * 8.5);
          float hot = (0.32 + 0.68 * m) * (1.85 * exp(-jj * 10.0) + 0.48 * exp(-jj * 5.0) + 0.22 * exp(-es * 26.0)) + ambientWeb;

          float c = base + hot;
          c = 1.0 - exp(-c * 1.35);

          c += (hash21(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
          c = clamp(c, 0.0, 1.0);

          vec3 middayLow = vec3(1.0, 0.89, 0.58);
          vec3 middayHigh = vec3(1.0, 0.99, 0.90);
          vec3 sunsetLow = vec3(1.0, 0.44, 0.16);
          vec3 sunsetHigh = vec3(1.0, 0.82, 0.46);
          vec3 mokkotsuCol = mix(
            mix(middayLow, sunsetLow, uSunWarmth),
            mix(middayHigh, sunsetHigh, uSunWarmth),
            clamp(hot * 0.75, 0.0, 1.0)
          );
          vec3 sumieLow = mix(vec3(0.95, 0.91, 0.84), vec3(0.90, 0.86, 0.78), uSunWarmth);
          vec3 sumieHigh = mix(vec3(1.0, 0.98, 0.94), vec3(0.98, 0.95, 0.88), uSunWarmth);
          vec3 sumieCol = mix(sumieLow, sumieHigh, clamp(hot * 0.75, 0.0, 1.0));
          vec3 finalCol = mix(mokkotsuCol, sumieCol, uIsSumie);

          float alpha = smoothstep(0.045, 0.78, c) * mix(0.88, 0.82, uDaylight);
          gl_FragColor = vec4(finalCol, alpha);
        }
      `;

      const compile = (type: number, src: string) => {
        const sh = gl.createShader(type)!;
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
          gl.deleteShader(sh);
          return null;
        }
        return sh;
      };

      const vs = compile(gl.VERTEX_SHADER, vsSource);
      const fs = compile(gl.FRAGMENT_SHADER, fsSource);
      if (!vs || !fs) {
        this.causticGLFailed = true;
        return null;
      }

      const prog = gl.createProgram()!;
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.bindAttribLocation(prog, 0, "aPosition");
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        this.causticGLFailed = true;
        return null;
      }

      this.causticGLProg = prog;
      this.causticGLUniforms = {
        uResolution: gl.getUniformLocation(prog, "uResolution"),
        uRefHeight: gl.getUniformLocation(prog, "uRefHeight"),
        uTime: gl.getUniformLocation(prog, "uTime"),
        uSpeed: gl.getUniformLocation(prog, "uSpeed"),
        uScale: gl.getUniformLocation(prog, "uScale"),
        uMouse: gl.getUniformLocation(prog, "uMouse"),
        uMouseStrength: gl.getUniformLocation(prog, "uMouseStrength"),
        uIsSumie: gl.getUniformLocation(prog, "uIsSumie"),
        uIsLight: gl.getUniformLocation(prog, "uIsLight"),
        uSunWarmth: gl.getUniformLocation(prog, "uSunWarmth"),
        uDaylight: gl.getUniformLocation(prog, "uDaylight"),
      };

      const quad = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      this.causticGLQuad = quad;
    }

    const gl = this.causticGL;
    const prog = this.causticGLProg;
    const canvas = this.causticGLCanvas;
    if (!gl || !prog || !canvas) return null;

    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }

    gl.viewport(0, 0, bw, bh);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.causticGLQuad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(this.causticGLUniforms.uResolution, bw, bh);
    gl.uniform1f(this.causticGLUniforms.uRefHeight, refH);
    gl.uniform1f(this.causticGLUniforms.uTime, time);
    gl.uniform1f(this.causticGLUniforms.uSpeed, 1.65);
    gl.uniform1f(this.causticGLUniforms.uScale, 7.2);
    gl.uniform2f(this.causticGLUniforms.uMouse, 0.5, 0.5);
    gl.uniform1f(this.causticGLUniforms.uMouseStrength, 0.0);
    const solar = this.getSolarLightingState();
    gl.uniform1f(this.causticGLUniforms.uIsSumie, style === "sumie" ? 1.0 : 0.0);
    gl.uniform1f(this.causticGLUniforms.uIsLight, isLight ? 1.0 : 0.0);
    gl.uniform1f(this.causticGLUniforms.uSunWarmth, solar.lowSunWarmth);
    gl.uniform1f(this.causticGLUniforms.uDaylight, solar.daylight);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return canvas;
  }

  /**
   * Pre-bakes a realistic, dappled overhanging Tree Bough & Foliage Canopy Shadow
   * (`this.canopyShadowCanvas`), modeled directly after `image_5d611d.jpg` and `image_5d5e74.jpg`:
   * - Crooked, tapering main tree boughs and forking secondary limbs reaching in from the upper-right bank
   * - Over 115 overlapping clusters of serrated palmate/feathery leaves at multiple depths
   * - Irregular *komorebi* (sunlight bokeh gaps) punched between branches and foliage clusters
   * - Two-stage optical penumbra blur so branch cores and leaf silhouettes have natural distance softness
   */
  /**
   * Evaluates a smooth Catmull-Rom spline through `waypoints` with superimposed multi-frequency
   * perpendicular S-curve undulation so NO branch, sub-branch, or twig ever has a straight segment.
   */
  private sampleSCurveBranch(
    waypoints: { x: number; y: number; w: number }[],
    samples: number,
    sWaveAmp1: number,
    sWaveFreq1: number,
    sWavePhase1: number,
    sWaveAmp2: number,
    sWaveFreq2: number,
    sWavePhase2: number
  ): {
    x: number;
    y: number;
    tx: number;
    ty: number;
    nx: number;
    ny: number;
    w: number;
  }[] {
    const n = waypoints.length;
    if (n < 2) return [];

    const rawPts: { x: number; y: number; w: number }[] = [];
    const segs = n - 1;

    for (let s = 0; s <= samples; s++) {
      const u = s / samples;
      const scaled = u * segs;
      const idx = Math.min(segs - 1, Math.floor(scaled));
      const t = scaled - idx;

      const p0 = waypoints[Math.max(0, idx - 1)];
      const p1 = waypoints[idx];
      const p2 = waypoints[idx + 1];
      const p3 = waypoints[Math.min(n - 1, idx + 2)];

      const t2 = t * t;
      const t3 = t2 * t;

      // Catmull-Rom spline position
      const cx =
        0.5 *
        (2 * p1.x +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const cy =
        0.5 *
        (2 * p1.y +
          (-p0.y + p2.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      const cw = p1.w + (p2.w - p1.w) * t;

      // Approximate tangent for perpendicular S-wave modulation
      const dtx =
        0.5 *
        (-p0.x +
          p2.x +
          2 * (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t +
          3 * (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t2);
      const dty =
        0.5 *
        (-p0.y +
          p2.y +
          2 * (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t +
          3 * (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t2);
      const dLen = Math.max(1e-4, Math.hypot(dtx, dty));
      const pnx = -dty / dLen;
      const pny = dtx / dLen;

      // Smoothly ramp S-wave from 0 at root (u=0) so child forks stay 100% attached to parent limbs!
      const rootEnvelope = Math.sin(Math.min(1, u * 3.2) * (Math.PI * 0.5));
      const sOff =
        rootEnvelope *
        (sWaveAmp1 * Math.sin(u * sWaveFreq1 + sWavePhase1) +
          sWaveAmp2 * Math.sin(u * sWaveFreq2 + sWavePhase2));

      rawPts.push({
        x: cx + pnx * sOff,
        y: cy + pny * sOff,
        w: cw,
      });
    }

    const out: {
      x: number;
      y: number;
      tx: number;
      ty: number;
      nx: number;
      ny: number;
      w: number;
    }[] = [];
    for (let i = 0; i < rawPts.length; i++) {
      const prev = rawPts[Math.max(0, i - 1)];
      const next = rawPts[Math.min(rawPts.length - 1, i + 1)];
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      const len = Math.max(1e-4, Math.hypot(dx, dy));
      const tx = dx / len;
      const ty = dy / len;
      out.push({
        x: rawPts[i].x,
        y: rawPts[i].y,
        tx,
        ty,
        nx: -ty,
        ny: tx,
        w: rawPts[i].w,
      });
    }
    return out;
  }

  private sakuraSpriteCacheKey = "";
  private floatingFlowerSprites: HTMLCanvasElement[] = [];
  private sunkenFlowerSprites: HTMLCanvasElement[] = [];
  private floatingPetalSprites: HTMLCanvasElement[] = [];
  private sunkenPetalSprites: HTMLCanvasElement[] = [];

  private floatingSakuraParticles: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    r: number; // base unscaled radius (12..15.5 for flower, 7.0..8.4 for petal)
    kind: "flower" | "petal";
    variant: number;
    rot: number;
    phase: number;
    corner: 0 | 1;
    clusterIdx: number;
    calmCooldown: number; // 0..1 cooldown after click/Koi displacement so re-clustering is slow & serene
  }[] = [];
  private floatingSakuraWorldW = 0;
  private floatingSakuraWorldH = 0;

  /**
   * Initializes 116 Free-Roaming Floating Water-Surface Sakura Particles
   * (50 whole 5-petaled flowers + 66 single notched petals; initially seeded in Top-Right & Bottom-Left,
   * with no region lock so clicks can carry them anywhere across the pond).
   */
  private initFloatingSakuraParticles(worldW: number, worldH: number, unit: number): void {
    const hadPrev =
      this.floatingSakuraParticles.length === 116 &&
      this.floatingSakuraWorldW > 0 &&
      this.floatingSakuraWorldH > 0;
    if (hadPrev) {
      const sx = worldW / this.floatingSakuraWorldW;
      const sy = worldH / this.floatingSakuraWorldH;
      this.floatingSakuraWorldW = worldW;
      this.floatingSakuraWorldH = worldH;
      for (let i = 0; i < this.floatingSakuraParticles.length; i++) {
        const p = this.floatingSakuraParticles[i];
        p.x = koiClamp(p.x * sx, 18 * unit, worldW - 18 * unit);
        p.y = koiClamp(p.y * sy, 18 * unit, worldH - 18 * unit);
      }
      return;
    }

    this.floatingSakuraWorldW = worldW;
    this.floatingSakuraWorldH = worldH;
    this.floatingSakuraParticles = [];

    const trClusters = [
      { fx: 0.90, fy: 0.09 },
      { fx: 0.74, fy: 0.08 },
      { fx: 0.89, fy: 0.25 },
    ];
    const blClusters = [
      { fx: 0.10, fy: 0.91 },
      { fx: 0.26, fy: 0.92 },
      { fx: 0.11, fy: 0.75 },
    ];

    for (let corner = 0; corner < 2; corner++) {
      const clusters = corner === 0 ? trClusters : blClusters;
      for (let i = 0; i < 58; i++) {
        const isFlower = i < 25;
        const cIdx = i % 3;
        const c = clusters[cIdx];
        const seed = corner * 500 + i + 1;

        const ringIdx = Math.floor(i / 3);
        const goldenAng = ringIdx * 2.39996 + corner * 1.1;
        const spreadDist = (16 + Math.sqrt(ringIdx) * 24) * unit;
        const px = koiClamp(
          worldW * c.fx + Math.cos(goldenAng) * spreadDist,
          20 * unit,
          worldW - 20 * unit
        );
        const py = koiClamp(
          worldH * c.fy + Math.sin(goldenAng) * spreadDist,
          20 * unit,
          worldH - 20 * unit
        );

        const rBase = isFlower
          ? 12.2 + hash2D(seed, 3, 1709) * 3.2
          : 7.2 + hash2D(seed, 7, 1721) * 1.3;

        this.floatingSakuraParticles.push({
          x: px,
          y: py,
          vx: 0,
          vy: 0,
          r: rBase,
          kind: isFlower ? "flower" : "petal",
          variant: i % 4,
          rot: hash2D(seed, 11, 1733) * Math.PI * 2,
          phase: hash2D(seed, 17, 1741) * Math.PI * 2,
          corner: corner as 0 | 1,
          clusterIdx: cIdx,
          calmCooldown: 0,
        });
      }
    }
  }

  /**
   * Returns the 42 Sunken Pond-Bed Sakura items (18 whole 5-petaled flowers + 24 single petals)
   * resting on the submerged riverbed stones in the Top-Right and Bottom-Left corners.
   */
  private getSunkenSakuraSpecs(): {
    fx: number;
    fy: number;
    r: number;
    kind: "flower" | "petal";
    variant: number;
    rot: number;
    phase: number;
  }[] {
    return [
      // ==================== TOP-RIGHT CORNER SUNKEN WHOLE FLOWERS (9) ====================
      { fx: 0.91, fy: 0.09, r: 13.5, kind: "flower", variant: 0, rot: 0.8, phase: 0.4 },
      { fx: 0.83, fy: 0.08, r: 12.8, kind: "flower", variant: 1, rot: 2.1, phase: 1.3 },
      { fx: 0.73, fy: 0.09, r: 12.2, kind: "flower", variant: 2, rot: 0.2, phase: 2.2 },
      { fx: 0.63, fy: 0.08, r: 11.5, kind: "flower", variant: 3, rot: 1.6, phase: 3.1 },
      { fx: 0.90, fy: 0.16, r: 13.2, kind: "flower", variant: 0, rot: 2.7, phase: 4.0 },
      { fx: 0.81, fy: 0.18, r: 12.5, kind: "flower", variant: 1, rot: 1.1, phase: 4.9 },
      { fx: 0.72, fy: 0.19, r: 11.8, kind: "flower", variant: 2, rot: 2.4, phase: 5.8 },
      { fx: 0.92, fy: 0.26, r: 12.6, kind: "flower", variant: 3, rot: 0.5, phase: 0.9 },
      { fx: 0.84, fy: 0.29, r: 11.6, kind: "flower", variant: 0, rot: 1.9, phase: 1.8 },

      // ==================== TOP-RIGHT CORNER SUNKEN SINGLE PETALS (12) ====================
      { fx: 0.95, fy: 0.07, r: 7.4, kind: "petal", variant: 0, rot: 1.2, phase: 0.2 },
      { fx: 0.86, fy: 0.06, r: 7.0, kind: "petal", variant: 1, rot: -0.8, phase: 0.9 },
      { fx: 0.77, fy: 0.06, r: 6.8, kind: "petal", variant: 2, rot: 2.3, phase: 1.6 },
      { fx: 0.68, fy: 0.06, r: 6.5, kind: "petal", variant: 0, rot: -1.5, phase: 2.3 },
      { fx: 0.94, fy: 0.18, r: 7.2, kind: "petal", variant: 1, rot: 0.6, phase: 3.0 },
      { fx: 0.85, fy: 0.15, r: 6.8, kind: "petal", variant: 2, rot: -2.0, phase: 3.7 },
      { fx: 0.76, fy: 0.15, r: 6.6, kind: "petal", variant: 0, rot: 1.4, phase: 4.4 },
      { fx: 0.67, fy: 0.14, r: 6.4, kind: "petal", variant: 1, rot: -0.5, phase: 5.1 },
      { fx: 0.88, fy: 0.23, r: 7.0, kind: "petal", variant: 2, rot: 2.1, phase: 5.8 },
      { fx: 0.79, fy: 0.24, r: 6.5, kind: "petal", variant: 0, rot: -1.2, phase: 0.6 },
      { fx: 0.95, fy: 0.32, r: 6.8, kind: "petal", variant: 1, rot: 0.9, phase: 1.4 },
      { fx: 0.88, fy: 0.35, r: 6.4, kind: "petal", variant: 2, rot: -1.8, phase: 2.2 },

      // ==================== BOTTOM-LEFT CORNER SUNKEN WHOLE FLOWERS (9) ====================
      { fx: 0.09, fy: 0.91, r: 13.5, kind: "flower", variant: 0, rot: 1.5, phase: 0.7 },
      { fx: 0.17, fy: 0.92, r: 12.8, kind: "flower", variant: 1, rot: 2.8, phase: 1.6 },
      { fx: 0.27, fy: 0.91, r: 12.2, kind: "flower", variant: 2, rot: 0.6, phase: 2.5 },
      { fx: 0.37, fy: 0.92, r: 11.5, kind: "flower", variant: 3, rot: 1.9, phase: 3.4 },
      { fx: 0.10, fy: 0.84, r: 13.2, kind: "flower", variant: 0, rot: 0.3, phase: 4.3 },
      { fx: 0.19, fy: 0.82, r: 12.5, kind: "flower", variant: 1, rot: 1.7, phase: 5.2 },
      { fx: 0.28, fy: 0.81, r: 11.8, kind: "flower", variant: 2, rot: 2.9, phase: 6.0 },
      { fx: 0.08, fy: 0.74, r: 12.6, kind: "flower", variant: 3, rot: 1.0, phase: 1.1 },
      { fx: 0.16, fy: 0.71, r: 11.6, kind: "flower", variant: 0, rot: 2.3, phase: 2.0 },

      // ==================== BOTTOM-LEFT CORNER SUNKEN SINGLE PETALS (12) ====================
      { fx: 0.05, fy: 0.93, r: 7.4, kind: "petal", variant: 0, rot: -1.1, phase: 0.5 },
      { fx: 0.14, fy: 0.94, r: 7.0, kind: "petal", variant: 1, rot: 0.9, phase: 1.2 },
      { fx: 0.23, fy: 0.94, r: 6.8, kind: "petal", variant: 2, rot: -2.1, phase: 1.9 },
      { fx: 0.32, fy: 0.94, r: 6.5, kind: "petal", variant: 0, rot: 1.6, phase: 2.6 },
      { fx: 0.06, fy: 0.82, r: 7.2, kind: "petal", variant: 1, rot: -0.7, phase: 3.3 },
      { fx: 0.15, fy: 0.85, r: 6.8, kind: "petal", variant: 2, rot: 2.2, phase: 4.0 },
      { fx: 0.24, fy: 0.85, r: 6.6, kind: "petal", variant: 0, rot: -1.4, phase: 4.7 },
      { fx: 0.33, fy: 0.86, r: 6.4, kind: "petal", variant: 1, rot: 0.5, phase: 5.4 },
      { fx: 0.12, fy: 0.77, r: 7.0, kind: "petal", variant: 2, rot: -1.9, phase: 6.1 },
      { fx: 0.21, fy: 0.76, r: 6.5, kind: "petal", variant: 0, rot: 1.3, phase: 0.8 },
      { fx: 0.05, fy: 0.68, r: 6.8, kind: "petal", variant: 1, rot: -0.4, phase: 1.5 },
      { fx: 0.12, fy: 0.65, r: 6.4, kind: "petal", variant: 2, rot: 2.0, phase: 2.3 },
    ];
  }

  /**
   * Pre-bakes 100% opaque sprites for:
   * - 4 color variants of Crisp Floating Water-Surface Whole Sakura Flowers (`floatingFlowerSprites`)
   * - 4 color variants of Darker Sunken Pond-Bed Whole Sakura Flowers (`sunkenFlowerSprites`)
   * - 3 color variants of Floating & Sunken Single Sakura Petals (`floatingPetalSprites`, `sunkenPetalSprites`)
   * so all 102 Sakura flowers and petals render at a locked 60 FPS!
   */
  private ensureSakuraBotanicalSprites(
    unit: number,
    isLight: boolean,
    style: KoiArtStyle
  ): void {
    const quantUnit = Math.round(unit * 40) / 40;
    const key = `${quantUnit}:${isLight ? "L" : "D"}:${style}:sakura-water-v14`;
    const cachedSakura = this.sakuraSpriteCacheMap.get(key);
    if (cachedSakura && cachedSakura.floatingFlower.length === 4) {
      this.sakuraSpriteCacheKey = key;
      this.floatingFlowerSprites = cachedSakura.floatingFlower;
      this.sunkenFlowerSprites = cachedSakura.sunkenFlower;
      this.floatingPetalSprites = cachedSakura.floatingPetal;
      this.sunkenPetalSprites = cachedSakura.sunkenPetal;
      return;
    }
    if (this.sakuraSpriteCacheMap.size >= 6) {
      this.sakuraSpriteCacheMap.clear();
    }
    this.sakuraSpriteCacheKey = key;
    this.floatingFlowerSprites = [];
    this.sunkenFlowerSprites = [];
    this.floatingPetalSprites = [];
    this.sunkenPetalSprites = [];

    const floatingVariants: [number, number, number][] = [
      [246, 158, 186],
      [252, 184, 206],
      [238, 134, 168],
      [254, 204, 220],
    ];
    // Darker, submerged-toned variants for sunken pond-bed Sakura
    const sunkenVariants: [number, number, number][] = [
      [158, 78, 102],
      [172, 92, 116],
      [144, 66, 90],
      [164, 86, 108],
    ];

    const monoFloatingTones: [number, number, number][] = [
      [194, 190, 182],
      [212, 208, 200],
      [174, 170, 162],
      [204, 200, 192],
    ];
    const monoSunkenTones: [number, number, number][] = [
      [126, 122, 116],
      [138, 134, 128],
      [112, 108, 102],
      [132, 128, 122],
    ];

    const bakeFlowerSprite = (
      rgb: [number, number, number],
      isSunken: boolean,
      isMono: boolean
    ): HTMLCanvasElement => {
      const refR = 16 * quantUnit;
      const margin = Math.ceil(16 * quantUnit);
      const dim = Math.max(48, Math.ceil((refR + margin) * 2));
      const cx = dim * 0.5;
      const cy = dim * 0.5;
      const c = document.createElement("canvas");
      c.width = dim;
      c.height = dim;
      const tCtx = c.getContext("2d");
      if (!tCtx) return c;

      tCtx.save();
      tCtx.translate(cx, cy);

      // 1. Subsurface drop shadow (deeper offset for floating water-surface flowers, tight stone-contact shadow for sunken flowers)
      const shOffX = (isSunken ? 1.8 : 6.5) * quantUnit;
      const shOffY = (isSunken ? 2.4 : 8.5) * quantUnit;
      const shRad = refR * (isSunken ? 1.08 : 1.24);
      const shG = tCtx.createRadialGradient(shOffX, shOffY, refR * 0.1, shOffX, shOffY, shRad);
      shG.addColorStop(
        0.0,
        isLight
          ? isSunken
            ? "rgba(24, 16, 12, 0.48)"
            : "rgba(20, 14, 8, 0.44)"
          : "rgba(0, 0, 0, 0.76)"
      );
      shG.addColorStop(
        0.55,
        isLight
          ? isSunken
            ? "rgba(24, 16, 12, 0.22)"
            : "rgba(20, 14, 8, 0.20)"
          : "rgba(0, 0, 0, 0.36)"
      );
      shG.addColorStop(1.0, "rgba(0, 0, 0, 0)");
      tCtx.fillStyle = shG;
      tCtx.beginPath();
      tCtx.arc(shOffX, shOffY, shRad, 0, Math.PI * 2);
      tCtx.fill();

      const dimFactor = isLight ? 1.0 : isSunken ? 0.62 : 0.78;
      const midRgb: [number, number, number] = [
        Math.round(rgb[0] * dimFactor),
        Math.round(rgb[1] * dimFactor),
        Math.round(rgb[2] * dimFactor),
      ];
      const tipTarget: [number, number, number] = isMono
        ? isSunken
          ? [Math.round(188 * dimFactor), Math.round(184 * dimFactor), Math.round(176 * dimFactor)]
          : [Math.round(252 * dimFactor), Math.round(250 * dimFactor), Math.round(244 * dimFactor)]
        : isSunken
          ? [Math.round(196 * dimFactor), Math.round(138 * dimFactor), Math.round(156 * dimFactor)]
          : [Math.round(255 * dimFactor), Math.round(246 * dimFactor), Math.round(250 * dimFactor)];
      const throatTarget: [number, number, number] = isMono
        ? isSunken
          ? [Math.round(32 * dimFactor), Math.round(30 * dimFactor), Math.round(28 * dimFactor)]
          : [Math.round(48 * dimFactor), Math.round(44 * dimFactor), Math.round(40 * dimFactor)]
        : isSunken
          ? [Math.round(108 * dimFactor), Math.round(24 * dimFactor), Math.round(48 * dimFactor)]
          : [Math.round(188 * dimFactor), Math.round(38 * dimFactor), Math.round(78 * dimFactor)];

      const tipRgb = mixRgb(midRgb, tipTarget, 0.56);
      const throatRgb = mixRgb(midRgb, throatTarget, 0.62);

      // 2. Five 100%-Opaque Cupped Notched Petals
      const petalCount = 5;
      for (let p = 0; p < petalCount; p++) {
        const a = (p / petalCount) * Math.PI * 2;
        tCtx.save();
        tCtx.rotate(a);

        const pLen = refR;
        const pW = refR * 0.64;
        tCtx.beginPath();
        tCtx.moveTo(0, 0);
        tCtx.bezierCurveTo(pLen * 0.24, -pW * 0.98, pLen * 0.76, -pW * 0.90, pLen, -pW * 0.16);
        tCtx.quadraticCurveTo(pLen * 0.90, -pW * 0.05, pLen * 0.84, 0);
        tCtx.quadraticCurveTo(pLen * 0.90, pW * 0.05, pLen, pW * 0.16);
        tCtx.bezierCurveTo(pLen * 0.76, pW * 0.90, pLen * 0.24, pW * 0.98, 0, 0);
        tCtx.closePath();

        const pGrad = tCtx.createLinearGradient(0, 0, pLen, 0);
        pGrad.addColorStop(0.0, rgbToRgba(throatRgb, isSunken ? 0.92 : 1.0));
        pGrad.addColorStop(0.38, rgbToRgba(midRgb, isSunken ? 0.92 : 1.0));
        pGrad.addColorStop(0.84, rgbToRgba(tipRgb, isSunken ? 0.92 : 1.0));
        pGrad.addColorStop(1.0, rgbToRgba(midRgb, isSunken ? 0.92 : 1.0));
        tCtx.fillStyle = pGrad;
        tCtx.fill();

        tCtx.strokeStyle = isMono ? "rgba(10, 9, 8, 0.92)" : rgbToRgba(darkenRgb(midRgb, 0.72), 0.42);
        tCtx.lineWidth = isMono ? Math.max(1.0, 1.15 * quantUnit) : Math.max(0.45, refR * 0.036);
        tCtx.stroke();

        tCtx.beginPath();
        tCtx.moveTo(pLen * 0.16, 0);
        tCtx.quadraticCurveTo(pLen * 0.45, -pW * 0.09, pLen * 0.74, 0);
        tCtx.strokeStyle = rgbToRgba(throatRgb, 0.22);
        tCtx.stroke();

        tCtx.restore();
      }

      // 3. Star Throat (Monochrome Sumi Charcoal vs. Deep Crimson)
      const heartG = tCtx.createRadialGradient(0, 0, 0, 0, 0, refR * 0.30);
      if (isMono) {
        heartG.addColorStop(
          0.0,
          isSunken
            ? isLight
              ? "rgba(22, 20, 18, 0.94)"
              : "rgba(14, 13, 12, 0.94)"
            : isLight
              ? "rgba(26, 24, 22, 1.0)"
              : "rgba(18, 16, 15, 1.0)"
        );
        heartG.addColorStop(
          0.60,
          isSunken
            ? "rgba(52, 48, 44, 0.75)"
            : "rgba(68, 64, 58, 0.85)"
        );
        heartG.addColorStop(1.0, "rgba(68, 64, 58, 0)");
      } else {
        heartG.addColorStop(
          0.0,
          isSunken
            ? isLight
              ? "rgba(88, 16, 36, 0.94)"
              : "rgba(58, 10, 24, 0.94)"
            : isLight
              ? "rgba(142, 22, 52, 1.0)"
              : "rgba(98, 14, 36, 1.0)"
        );
        heartG.addColorStop(
          0.60,
          isSunken
            ? "rgba(124, 30, 56, 0.75)"
            : "rgba(188, 42, 78, 0.85)"
        );
        heartG.addColorStop(1.0, "rgba(188, 42, 78, 0)");
      }
      tCtx.fillStyle = heartG;
      tCtx.beginPath();
      tCtx.arc(0, 0, refR * 0.30, 0, Math.PI * 2);
      tCtx.fill();

      // 4. 12 Radiating Fine Stamen Filaments & Pollen Anthers
      const stamenCount = 12;
      if (isMono) {
        tCtx.strokeStyle = isSunken
          ? "rgba(38, 35, 32, 0.82)"
          : "rgba(42, 38, 34, 0.88)";
        tCtx.fillStyle = isSunken
          ? isLight
            ? "rgba(176, 172, 164, 0.90)"
            : "rgba(138, 134, 128, 0.88)"
          : isLight
            ? "rgba(238, 234, 226, 1.0)"
            : "rgba(198, 194, 186, 1.0)";
      } else {
        tCtx.strokeStyle = isSunken
          ? "rgba(122, 28, 52, 0.82)"
          : "rgba(176, 36, 68, 0.88)";
        tCtx.fillStyle = isSunken
          ? isLight
            ? "rgba(196, 174, 122, 0.90)"
            : "rgba(148, 130, 92, 0.88)"
          : isLight
            ? "rgba(255, 238, 184, 1.0)"
            : "rgba(218, 198, 146, 1.0)";
      }
      tCtx.lineWidth = Math.max(0.45, refR * 0.038);
      for (let st = 0; st < stamenCount; st++) {
        const sa = (st / stamenCount) * Math.PI * 2;
        const sLen = refR * (0.24 + (st % 3) * 0.055);
        const sx = Math.cos(sa) * sLen;
        const sy = Math.sin(sa) * sLen;
        const cAng = sa + (st % 2 === 0 ? 0.18 : -0.18);
        const ctrlX = Math.cos(cAng) * (sLen * 0.54);
        const ctrlY = Math.sin(cAng) * (sLen * 0.54);
        tCtx.beginPath();
        tCtx.moveTo(0, 0);
        tCtx.quadraticCurveTo(ctrlX, ctrlY, sx, sy);
        tCtx.stroke();

        tCtx.beginPath();
        tCtx.arc(sx, sy, Math.max(0.65, refR * 0.046), 0, Math.PI * 2);
        tCtx.fill();
      }

      tCtx.restore();
      return c;
    };

    const bakePetalSprite = (
      rgb: [number, number, number],
      isSunken: boolean,
      isMono: boolean
    ): HTMLCanvasElement => {
      const pLen = 9.0 * quantUnit;
      const pW = pLen * 0.62;
      const margin = Math.ceil(10 * quantUnit);
      const dim = Math.max(28, Math.ceil((pLen + margin) * 2));
      const cx = dim * 0.5;
      const cy = dim * 0.5;
      const c = document.createElement("canvas");
      c.width = dim;
      c.height = dim;
      const tCtx = c.getContext("2d");
      if (!tCtx) return c;

      tCtx.save();
      tCtx.translate(cx, cy);

      tCtx.shadowColor = isLight
        ? isSunken
          ? "rgba(22, 14, 10, 0.42)"
          : "rgba(20, 14, 8, 0.38)"
        : "rgba(0, 0, 0, 0.72)";
      tCtx.shadowBlur = (isSunken ? 2.2 : 4.2) * quantUnit;
      tCtx.shadowOffsetX = (isSunken ? 1.4 : 4.5) * quantUnit;
      tCtx.shadowOffsetY = (isSunken ? 1.8 : 5.8) * quantUnit;

      const ox = -pLen * 0.5;
      tCtx.beginPath();
      tCtx.moveTo(ox, 0);
      tCtx.bezierCurveTo(ox + pLen * 0.26, -pW * 0.96, ox + pLen * 0.78, -pW * 0.88, ox + pLen, -pW * 0.17);
      tCtx.quadraticCurveTo(ox + pLen * 0.90, -pW * 0.05, ox + pLen * 0.84, 0);
      tCtx.quadraticCurveTo(ox + pLen * 0.90, pW * 0.05, ox + pLen, pW * 0.17);
      tCtx.bezierCurveTo(ox + pLen * 0.78, pW * 0.88, ox + pLen * 0.26, pW * 0.96, ox, 0);
      tCtx.closePath();

      const dimFactor = isLight ? 1.0 : isSunken ? 0.62 : 0.78;
      const midRgb: [number, number, number] = [
        Math.round(rgb[0] * dimFactor),
        Math.round(rgb[1] * dimFactor),
        Math.round(rgb[2] * dimFactor),
      ];
      const baseRgb = mixRgb(
        midRgb,
        isMono
          ? isSunken
            ? [34, 32, 28]
            : [52, 48, 44]
          : isSunken
            ? [108, 24, 48]
            : [196, 48, 86],
        0.55
      );
      const tipRgb = mixRgb(
        midRgb,
        isMono
          ? isSunken
            ? [190, 186, 178]
            : [252, 250, 244]
          : isSunken
            ? [196, 138, 156]
            : [255, 244, 248],
        0.58
      );

      const pg = tCtx.createLinearGradient(ox, 0, ox + pLen, 0);
      pg.addColorStop(0.0, rgbToRgba(baseRgb, isSunken ? 0.92 : 1.0));
      pg.addColorStop(0.50, rgbToRgba(midRgb, isSunken ? 0.92 : 1.0));
      pg.addColorStop(1.0, rgbToRgba(tipRgb, isSunken ? 0.92 : 1.0));
      tCtx.fillStyle = pg;
      tCtx.fill();

      tCtx.shadowBlur = 0;
      tCtx.shadowOffsetX = 0;
      tCtx.shadowOffsetY = 0;
      tCtx.strokeStyle = isMono ? "rgba(10, 9, 8, 0.92)" : rgbToRgba(darkenRgb(midRgb, 0.74), 0.36);
      tCtx.lineWidth = isMono ? Math.max(0.95, 1.1 * quantUnit) : Math.max(0.4, pLen * 0.035);
      tCtx.stroke();

      tCtx.restore();
      return c;
    };

    // In Sumi-e (Ink) mode, ALL sakura flowers and petals are 100% black-and-white Sumi-e ink wash!
    for (let v = 0; v < 4; v++) {
      const isMono = style === "sumie";
      this.floatingFlowerSprites.push(
        bakeFlowerSprite(isMono ? monoFloatingTones[v] : floatingVariants[v], false, isMono)
      );
      this.sunkenFlowerSprites.push(
        bakeFlowerSprite(isMono ? monoSunkenTones[v] : sunkenVariants[v], true, isMono)
      );
    }
    for (let v = 0; v < 3; v++) {
      const isMono = style === "sumie";
      this.floatingPetalSprites.push(
        bakePetalSprite(isMono ? monoFloatingTones[v] : floatingVariants[v], false, isMono)
      );
      this.sunkenPetalSprites.push(
        bakePetalSprite(isMono ? monoSunkenTones[v] : sunkenVariants[v], true, isMono)
      );
    }
    this.sakuraSpriteCacheMap.set(key, {
      floatingFlower: this.floatingFlowerSprites,
      sunkenFlower: this.sunkenFlowerSprites,
      floatingPetal: this.floatingPetalSprites,
      sunkenPetal: this.sunkenPetalSprites,
    });
  }

  /**
   * Renders the 42 Sunken Pond-Bed Sakura flowers & petals resting on the submerged riverbed stones
   * in the Top-Right and Bottom-Left corners (layered *underneath* the swimming Koi and *underneath*
   * the water caustics), with darker submerged coloration and gentle enlarging/contracting movement.
   */
  private paintSunkenSakuraOnBed(
    ctx: CanvasRenderingContext2D,
    worldW: number,
    worldH: number,
    time: number,
    isLight: boolean,
    style: KoiArtStyle
  ): void {
    if ((style as KoiArtStyle) === "sumie") return;
    if (false) return;
    const unit = koiClamp(Math.min(worldW, worldH) / 860, 0.48, 1.25);
    const daylight = this.getDaylightFactor();
    const blendDayNight = daylight > 0.002 && daylight < 0.998;

    this.ensureSakuraBotanicalSprites(unit, true, style);
    const daySunkenF = this.sunkenFlowerSprites;
    const daySunkenP = this.sunkenPetalSprites;
    let nightSunkenF = daySunkenF;
    let nightSunkenP = daySunkenP;
    if (daylight < 0.998) {
      this.ensureSakuraBotanicalSprites(unit, false, style);
      nightSunkenF = this.sunkenFlowerSprites;
      nightSunkenP = this.sunkenPetalSprites;
    }

    const sunkenSpecs = this.getSunkenSakuraSpecs();
    ctx.save();

    for (let i = 0; i < sunkenSpecs.length; i++) {
      const sp = sunkenSpecs[i];
      const daySpr =
        sp.kind === "flower"
          ? daySunkenF[sp.variant % daySunkenF.length]
          : daySunkenP[sp.variant % daySunkenP.length];
      const nightSpr =
        sp.kind === "flower"
          ? nightSunkenF[sp.variant % nightSunkenF.length]
          : nightSunkenP[sp.variant % nightSunkenP.length];
      if (!daySpr && !nightSpr) continue;

      const swayX = Math.sin(time * 0.32 + sp.phase) * 3.2 * unit;
      const swayY = Math.cos(time * 0.27 + sp.phase * 1.1) * 2.6 * unit;
      const w1 = Math.sin(time * 2.25 + sp.phase);
      const w2 = Math.cos(time * 1.65 - sp.phase * 0.8);
      const pulseScaleX = 1.0 + (w1 * 0.085 + w2 * 0.035);
      const pulseScaleY = 1.0 + (-w1 * 0.075 + w2 * 0.030);
      const baseScale = sp.kind === "flower" ? sp.r / 16.0 : sp.r / 9.0;

      const px = worldW * sp.fx + swayX;
      const py = worldH * sp.fy + swayY;
      const rot = sp.rot + Math.sin(time * 0.28 + sp.phase) * 0.04;

      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(rot);
      ctx.scale(baseScale * pulseScaleX, baseScale * pulseScaleY);
      if (blendDayNight) {
        if (daySpr) ctx.drawImage(daySpr, -daySpr.width * 0.5, -daySpr.height * 0.5);
        if (nightSpr) {
          ctx.globalAlpha = 1.0 - daylight;
          ctx.drawImage(nightSpr, -nightSpr.width * 0.5, -nightSpr.height * 0.5);
        }
      } else {
        const spr = daylight >= 0.5 ? daySpr : nightSpr;
        if (spr) ctx.drawImage(spr, -spr.width * 0.5, -spr.height * 0.5);
      }
      ctx.restore();
    }

    ctx.restore();
  }

  /**
   * Preserves the Dappled Overhanging Tree-Canopy Water Shadow (`ensureCanopyShadowCanvas`)
   * in the Top-Right and Bottom-Left corners per user request ("Keep the shadow").
   */
  private ensureCanopyShadowCanvas(
    width: number,
    height: number,
    isLight: boolean
  ): HTMLCanvasElement {
    const w = Math.max(128, Math.round(width));
    const h = Math.max(128, Math.round(height));
    const unit = koiClamp(Math.min(w, h) / 860, 0.48, 1.25);
    const pad = Math.ceil(64 * unit);
    const cw = w + pad * 2;
    const ch = h + pad * 2;

    const key = `${cw}x${ch}:${isLight ? "day" : "night"}:canopy-shadow-v12`;
    const cached = this.canopyShadowCache.get(key);
    if (cached) {
      this.canopyShadowCanvas = cached;
      this.canopyShadowKey = key;
      return cached;
    }
    if (this.canopyShadowCache.size >= 4) {
      this.canopyShadowCache.clear();
    }

    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    this.canopyShadowCache.set(key, canvas);
    this.canopyShadowCanvas = canvas;
    this.canopyShadowKey = key;

    const cCtx = canvas.getContext("2d");
    if (!cCtx) return canvas;
    cCtx.clearRect(0, 0, cw, ch);

    const rawCanvas = document.createElement("canvas");
    rawCanvas.width = cw;
    rawCanvas.height = ch;
    const rCtx = rawCanvas.getContext("2d");
    if (!rCtx) return canvas;

    rCtx.save();
    rCtx.translate(pad, pad);

    const shCol = isLight ? "18, 24, 20" : "2, 4, 4";

    // 1. Sub-canopy corner ambient occlusion
    const trOcc = rCtx.createRadialGradient(
      w,
      0,
      10 * unit,
      w - 110 * unit,
      70 * unit,
      340 * unit
    );
    trOcc.addColorStop(0.0, isLight ? "rgba(16, 20, 16, 0.64)" : "rgba(0, 0, 0, 0.82)");
    trOcc.addColorStop(0.55, isLight ? "rgba(20, 24, 20, 0.34)" : "rgba(0, 0, 0, 0.50)");
    trOcc.addColorStop(1.0, "rgba(0, 0, 0, 0)");
    rCtx.fillStyle = trOcc;
    rCtx.fillRect(0, 0, w, h);

    const blOcc = rCtx.createRadialGradient(
      0,
      h,
      10 * unit,
      90 * unit,
      h - 70 * unit,
      290 * unit
    );
    blOcc.addColorStop(0.0, isLight ? "rgba(16, 20, 16, 0.60)" : "rgba(0, 0, 0, 0.80)");
    blOcc.addColorStop(0.55, isLight ? "rgba(20, 24, 20, 0.32)" : "rgba(0, 0, 0, 0.46)");
    blOcc.addColorStop(1.0, "rgba(0, 0, 0, 0)");
    rCtx.fillStyle = blOcc;
    rCtx.fillRect(0, 0, w, h);

    // 2. Dappled branching & foliage shadow boughs in Top-Right and Bottom-Left corners
    const shadowBoughs: { x: number; y: number; w: number }[][] = [
      [
        { x: w + 52 * unit, y: h * 0.34, w: 22 },
        { x: w * 0.86, y: h * 0.24, w: 16 },
        { x: w * 0.73, y: h * 0.15, w: 11.5 },
        { x: w * 0.59, y: h * 0.11, w: 7.5 },
        { x: w * 0.45, y: h * 0.06, w: 3.2 },
      ],
      [
        { x: w * 0.74, y: h * 0.16, w: 10 },
        { x: w * 0.65, y: h * 0.28, w: 6.4 },
        { x: w * 0.55, y: h * 0.38, w: 3.5 },
        { x: w * 0.48, y: h * 0.45, w: 1.8 },
      ],
      [
        { x: w * 0.85, y: h * 0.24, w: 9 },
        { x: w * 0.78, y: h * 0.35, w: 5.2 },
        { x: w * 0.70, y: h * 0.43, w: 2.2 },
      ],
      [
        { x: -52 * unit, y: h * 0.70, w: 19 },
        { x: w * 0.08, y: h * 0.79, w: 14 },
        { x: w * 0.19, y: h * 0.89, w: 9.5 },
        { x: w * 0.29, y: h + 44 * unit, w: 6 },
      ],
      [
        { x: w * 0.08, y: h * 0.79, w: 8 },
        { x: w * 0.14, y: h * 0.67, w: 4.5 },
        { x: w * 0.21, y: h * 0.56, w: 1.8 },
      ],
    ];

    for (let bIdx = 0; bIdx < shadowBoughs.length; bIdx++) {
      const spine = this.sampleSCurveBranch(
        shadowBoughs[bIdx],
        36,
        14 * unit,
        Math.PI * 2.2,
        (bIdx + 1) * 0.7,
        6 * unit,
        Math.PI * 4.3,
        (bIdx + 1) * 1.3
      );
      if (spine.length < 2) continue;

      rCtx.fillStyle = `rgba(${shCol}, 0.74)`;
      rCtx.beginPath();
      for (let i = 0; i < spine.length; i++) {
        const p = spine[i];
        const hw = p.w * 0.5 * unit;
        if (i === 0) rCtx.moveTo(p.x + p.nx * hw, p.y + p.ny * hw);
        else rCtx.lineTo(p.x + p.nx * hw, p.y + p.ny * hw);
      }
      for (let i = spine.length - 1; i >= 0; i--) {
        const p = spine[i];
        const hw = p.w * 0.5 * unit;
        rCtx.lineTo(p.x - p.nx * hw, p.y - p.ny * hw);
      }
      rCtx.closePath();
      rCtx.fill();

      for (let k = 2; k < spine.length; k += 2) {
        const pt = spine[k];
        const seed = bIdx * 100 + k;
        const sr = (12 + hash2D(seed, 3, 1117) * 24) * unit;
        const sa = hash2D(seed, 7, 1123) * Math.PI * 2;
        const cx = pt.x + Math.cos(sa) * sr * 0.65;
        const cy = pt.y + Math.sin(sa) * sr * 0.65;
        const rad = (14 + hash2D(seed, 11, 1129) * 18) * unit;
        const alpha = 0.36 + hash2D(seed, 19, 1153) * 0.32;
        rCtx.fillStyle = `rgba(${shCol}, ${alpha.toFixed(3)})`;
        rCtx.beginPath();
        rCtx.arc(cx, cy, rad, 0, Math.PI * 2);
        rCtx.fill();
      }
    }

    // 3. Dappled Komorebi sunlight apertures
    rCtx.save();
    rCtx.globalCompositeOperation = "destination-out";
    for (let g = 0; g < 28; g++) {
      const gx1 = w * (0.45 + hash2D(g, 5, 1163) * 0.48);
      const gy1 = h * (0.04 + hash2D(g, 9, 1171) * 0.40);
      const gr1 = (8 + hash2D(g, 13, 1181) * 18) * unit;
      const gg1 = rCtx.createRadialGradient(gx1, gy1, gr1 * 0.1, gx1, gy1, gr1);
      gg1.addColorStop(0.0, "rgba(0, 0, 0, 0.80)");
      gg1.addColorStop(0.6, "rgba(0, 0, 0, 0.40)");
      gg1.addColorStop(1.0, "rgba(0, 0, 0, 0)");
      rCtx.fillStyle = gg1;
      rCtx.beginPath();
      rCtx.arc(gx1, gy1, gr1, 0, Math.PI * 2);
      rCtx.fill();

      const gx2 = w * (0.04 + hash2D(g, 17, 1201) * 0.36);
      const gy2 = h * (0.58 + hash2D(g, 23, 1213) * 0.38);
      const gr2 = (8 + hash2D(g, 29, 1223) * 16) * unit;
      const gg2 = rCtx.createRadialGradient(gx2, gy2, gr2 * 0.1, gx2, gy2, gr2);
      gg2.addColorStop(0.0, "rgba(0, 0, 0, 0.80)");
      gg2.addColorStop(0.6, "rgba(0, 0, 0, 0.40)");
      gg2.addColorStop(1.0, "rgba(0, 0, 0, 0)");
      rCtx.fillStyle = gg2;
      rCtx.beginPath();
      rCtx.arc(gx2, gy2, gr2, 0, Math.PI * 2);
      rCtx.fill();
    }
    rCtx.restore();
    rCtx.restore();

    cCtx.save();
    cCtx.filter = `blur(${Math.max(5, Math.round(9.5 * unit))}px)`;
    cCtx.globalAlpha = 0.62;
    cCtx.drawImage(rawCanvas, 0, 0);

    cCtx.filter = `blur(${Math.max(2, Math.round(3.8 * unit))}px)`;
    cCtx.globalAlpha = 0.48;
    cCtx.drawImage(rawCanvas, 0, 0);
    cCtx.filter = "none";
    cCtx.restore();

    return canvas;
  }

  /**
   * Renders the 60 Floating Water-Surface Sakura flowers & single petals in the Top-Right and
   * Bottom-Left corners of the pond:
   * - ZERO branches, trees, or twigs
   * - ZERO blur (`filter = "none"`)
   * - Constant size (ZERO enlarging or contracting on the water surface!)
   * - Calm longitudinal/lateral water-current drift, gentle rotational sway, and smooth spring-damped
   *   Koi wake displacement (just like the maple leaves!).
   */
  /**
   * Updates and renders the 116 Free-Roaming Floating Water-Surface Sakura Flowers & Petals:
   * - Slow, calm GLYPH-style surface-tension clustering physics (particles gently attract toward
   *   their local cluster raft & nearby neighbors, part smoothly when a Koi swims through, and
   *   slowly re-cluster afterward).
   * - 6-Pass Exact Rigid Circle Separation Solver across ALL floating surface items (all 116
   *   floating Sakura flowers & petals, all 6 floating Maple leaves, and all 9 Lotus leaves) so
   *   NO Sakura flower, petal, maple leaf, or lotus leaf EVER goes over or under each other!
   */
  private paintOverhangingSakuraCanopy(
    ctx: CanvasRenderingContext2D,
    world: PondWorld,
    worldW: number,
    worldH: number,
    time: number,
    isLight: boolean,
    style: KoiArtStyle,
    skipPhysics = false
  ): void {
    if ((style as KoiArtStyle) === "sumie") return;
    const unit = koiClamp(Math.min(worldW, worldH) / 860, 0.48, 1.25);
    this.ensureSakuraBotanicalSprites(unit, isLight, style);

    if (
      this.floatingSakuraParticles.length !== 116 ||
      Math.abs(this.floatingSakuraWorldW - worldW) > 2 ||
      Math.abs(this.floatingSakuraWorldH - worldH) > 2
    ) {
      this.initFloatingSakuraParticles(worldW, worldH, unit);
    }

    const particles = this.floatingSakuraParticles;
    const n = particles.length;
    const dt = 0.016;

    if (!skipPhysics) {

    // Precompute effective collision radii (strictly bounding the visual petal tips so zero pixels ever overlap!)
    const colRad = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = particles[i];
      colRad[i] = (p.kind === "flower" ? p.r * 1.06 : p.r * 0.68) * unit;
    }

    // 1. Apply Very Calm, Unbounded GLYPH-Style Neighbor Cohesion + Gentle Ambient Water Swirl + Koi Wake Parting
    //    (ZERO corner/region lock: Sakura can drift anywhere in the pond when clicked and slowly, calmly re-cluster!)
    for (let i = 0; i < n; i++) {
      const p = particles[i];
      if (p.calmCooldown > 0) {
        p.calmCooldown = Math.max(0, p.calmCooldown - dt * 0.28);
      }

      let fx = 0;
      let fy = 0;

      // A. Very calm surface-tension neighbor cohesion (pulls nearby Sakura anywhere in the pond together slowly)
      let cohX = 0;
      let cohY = 0;
      let cohCount = 0;
      const cohRange = 115 * unit;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const q = particles[j];
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const dist = Math.hypot(dx, dy);
        const minTouch = colRad[i] + colRad[j] + 2.5 * unit;
        if (dist > minTouch && dist < cohRange) {
          cohX += q.x;
          cohY += q.y;
          cohCount++;
        }
      }
      if (cohCount > 0) {
        cohX /= cohCount;
        cohY /= cohCount;
        // Suppressed during calmCooldown so displaced flowers glide out smoothly and then very calmly come together
        const calmFactor = 0.068 * (1 - p.calmCooldown * 0.88);
        fx += (cohX - p.x) * calmFactor;
        fy += (cohY - p.y) * calmFactor;
      }

      // B. Ultra-gentle ambient water-current breath
      fx += Math.sin(time * 0.32 + p.phase) * 1.15 * unit;
      fy += Math.cos(time * 0.27 + p.phase * 1.1) * 1.05 * unit;

      // C. Smooth Koi wake parting when a Koi swims underneath/through the cluster
      const detectR = colRad[i] + 56 * unit;
      for (let k = 0; k < world.koi.length; k++) {
        const fish = world.koi[k];
        for (let s = 0; s <= 12; s += 4) {
          const node = fish.spine[s];
          if (!node) continue;
          const dx = p.x - node.x;
          const dy = p.y - node.y;
          const dist = Math.hypot(dx, dy);
          if (dist < detectR && dist > 0.1) {
            const falloff = Math.pow(1.0 - dist / detectR, 2);
            const wakePush = 52.0 * falloff * unit;
            fx += (dx / dist) * wakePush + node.tx * fish.speed * 0.14 * falloff;
            fy += (dy / dist) * wakePush + node.ty * fish.speed * 0.14 * falloff;
            p.calmCooldown = Math.max(p.calmCooldown, 0.85 * falloff);
          }
        }
      }

      // High water viscosity damping (0.91) & calm clustering speed cap
      p.vx = (p.vx + fx * dt) * 0.91;
      p.vy = (p.vy + fy * dt) * 0.91;
      const spd = Math.hypot(p.vx, p.vy);
      // Allow brisk outward travel when actively pushed by a click ripple/wake, but cap re-clustering speed to a serene 3.8 * unit
      const maxSpd = (3.8 + p.calmCooldown * 36.0) * unit;
      if (spd > maxSpd) {
        p.vx = (p.vx / spd) * maxSpd;
        p.vy = (p.vy / spd) * maxSpd;
      }

      p.x += p.vx * dt * 8.5;
      p.y += p.vy * dt * 8.5;
    }

    // 2. 8-Pass Unified Rigid Circle Separation Solver across ALL Floating Surface Elements:
    //    - All 9 Lotus Pads & Blooming Lotuses
    //    - All 6 Live Floating Maple Leaves
    //    - All 116 Floating Sakura Flowers & Petals
    const resolvedPads = this.getResolvedLotusPads(worldW, worldH, unit);
    const liveMaples = this.getLiveMapleLeafPositions(worldW, worldH, unit, time);

    for (let pass = 0; pass < 8; pass++) {
      // A. Separate Sakura particles from one another
      for (let i = 0; i < n; i++) {
        const a = particles[i];
        const rA = colRad[i];
        for (let j = i + 1; j < n; j++) {
          const b = particles[j];
          const rB = colRad[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy);
          const minSep = rA + rB + 2.2 * unit;
          if (dist < minSep) {
            const ux = dist > 0.001 ? dx / dist : Math.cos(i * 1.7 + j);
            const uy = dist > 0.001 ? dy / dist : Math.sin(i * 1.7 + j);
            const overlap = minSep - dist;
            const wA = rB / (rA + rB);
            const wB = rA / (rA + rB);
            a.x -= ux * overlap * wA;
            a.y -= uy * overlap * wA;
            b.x += ux * overlap * wB;
            b.y += uy * overlap * wB;

            const relVn = (b.vx - a.vx) * ux + (b.vy - a.vy) * uy;
            if (relVn < 0) {
              a.vx += ux * relVn * wA * 0.6;
              a.vy += uy * relVn * wA * 0.6;
              b.vx -= ux * relVn * wB * 0.6;
              b.vy -= uy * relVn * wB * 0.6;
            }
          }
        }
      }

      // B. Separate Sakura particles from all 9 Lotus Pads & all 6 Floating Maple Leaves, and clamp to pond viewport
      for (let i = 0; i < n; i++) {
        const a = particles[i];
        const rA = colRad[i];

        for (let p = 0; p < resolvedPads.length; p++) {
          const lp = resolvedPads[p];
          const st = this.lotusPadStates[p];
          const lpx = lp.x + st.swayX + st.dispX;
          const lpy = lp.y + st.swayY + st.dispY;
          const dx = a.x - lpx;
          const dy = a.y - lpy;
          const dist = Math.hypot(dx, dy) || 0.001;
          const minSep = lp.r * 1.05 + rA + 4.0 * unit;
          if (dist < minSep) {
            const ux = dx / dist;
            const uy = dy / dist;
            a.x = lpx + ux * minSep;
            a.y = lpy + uy * minSep;
            const vn = a.vx * ux + a.vy * uy;
            if (vn < 0) {
              a.vx -= ux * vn;
              a.vy -= uy * vn;
            }
          }
          if (lp.hasLotus) {
            const flX = lpx + Math.cos(lp.notch + 0.35) * (lp.r * 0.78);
            const flY = lpy + Math.sin(lp.notch + 0.35) * (lp.r * 0.78);
            const fdx = a.x - flX;
            const fdy = a.y - flY;
            const fDist = Math.hypot(fdx, fdy) || 0.001;
            const fMinSep = lp.r * 0.66 + rA + 4.0 * unit;
            if (fDist < fMinSep) {
              a.x = flX + (fdx / fDist) * fMinSep;
              a.y = flY + (fdy / fDist) * fMinSep;
            }
          }
        }

        for (let m = 0; m < liveMaples.length; m++) {
          const ml = liveMaples[m];
          const dx = a.x - ml.x;
          const dy = a.y - ml.y;
          const dist = Math.hypot(dx, dy) || 0.001;
          const minSep = ml.size * 1.04 + rA + 4.0 * unit;
          if (dist < minSep) {
            const ux = dx / dist;
            const uy = dy / dist;
            a.x = ml.x + ux * minSep;
            a.y = ml.y + uy * minSep;
            const vn = a.vx * ux + a.vy * uy;
            if (vn < 0) {
              a.vx -= ux * vn;
              a.vy -= uy * vn;
            }
          }
        }

        const margin = rA + 4 * unit;
        a.x = koiClamp(a.x, margin, Math.max(margin + 1, worldW - margin));
        a.y = koiClamp(a.y, margin, Math.max(margin + 1, worldH - margin));
      }
    }
    } // end if (!skipPhysics)

    // 3. Render all 116 Non-Overlapping Floating Sakura Flowers & Petals with continuous daylight cross-fade!
    const sakuraDay = this.getDaylightFactor();
    const sakuraBlend = sakuraDay > 0.002 && sakuraDay < 0.998;
    this.ensureSakuraBotanicalSprites(unit, true, style);
    const dayFloatF = this.floatingFlowerSprites;
    const dayFloatP = this.floatingPetalSprites;
    let nightFloatF = dayFloatF;
    let nightFloatP = dayFloatP;
    if (sakuraDay < 0.998) {
      this.ensureSakuraBotanicalSprites(unit, false, style);
      nightFloatF = this.floatingFlowerSprites;
      nightFloatP = this.floatingPetalSprites;
    }

    ctx.save();
    for (let i = 0; i < n; i++) {
      const p = particles[i];
      const rot =
        p.rot +
        Math.sin(time * 0.36 + p.phase) * 0.12 +
        Math.cos(time * 0.22 - p.phase) * 0.07;

      const baseScale = p.kind === "flower" ? p.r / 16.0 : p.r / 9.0;
      const daySpr =
        p.kind === "flower"
          ? dayFloatF[p.variant % dayFloatF.length]
          : dayFloatP[p.variant % dayFloatP.length];
      const nightSpr =
        p.kind === "flower"
          ? nightFloatF[p.variant % nightFloatF.length]
          : nightFloatP[p.variant % nightFloatP.length];
      if (!daySpr && !nightSpr) continue;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(rot);
      ctx.scale(baseScale, baseScale);
      if (sakuraBlend) {
        if (daySpr) ctx.drawImage(daySpr, -daySpr.width * 0.5, -daySpr.height * 0.5);
        if (nightSpr) {
          ctx.globalAlpha = 1.0 - sakuraDay;
          ctx.drawImage(nightSpr, -nightSpr.width * 0.5, -nightSpr.height * 0.5);
        }
      } else {
        const spr = sakuraDay >= 0.5 ? daySpr : nightSpr;
        if (spr) ctx.drawImage(spr, -spr.width * 0.5, -spr.height * 0.5);
      }
      ctx.restore();
    }
    ctx.restore();
  }

  /**
   * Step 1 of Underwater Optics: Casts Ultra-Soft Continuous-Gradient Underwater Floor Shadows
   * (matching the exact Bezier contours of each Koi's body, pectoral fins, ventral fins, and
   * bilobed caudal tail fin, plus the enlarged Lotus Pads) onto an offscreen shadow buffer,
   * blurs with a wide pillowy Gaussian penumbra, and punches out (`destination-out`) each Koi's
   * un-offset `(0, 0)` footprint so a Koi's own floor shadow NEVER shows through its body or fins!
   */
  private paintUnderwaterFloorShadows(
    ctx: CanvasRenderingContext2D,
    world: PondWorld,
    worldW: number,
    worldH: number,
    time: number,
    isLight: boolean,
    style: KoiArtStyle
  ): void {
    if (false) return;

    const shadowScale = 0.5;
    const w = Math.max(64, Math.round(worldW * shadowScale));
    const h = Math.max(64, Math.round(worldH * shadowScale));
    const unit = koiClamp(Math.min(worldW, worldH) / 860, 0.48, 1.22);

    const shCanvas = this.shadowWorkCanvas ?? document.createElement("canvas");
    if (shCanvas.width !== w || shCanvas.height !== h) {
      shCanvas.width = w;
      shCanvas.height = h;
    }
    this.shadowWorkCanvas = shCanvas;

    const blurCanvas = this.shadowBlurCanvas ?? document.createElement("canvas");
    if (blurCanvas.width !== w || blurCanvas.height !== h) {
      blurCanvas.width = w;
      blurCanvas.height = h;
    }
    this.shadowBlurCanvas = blurCanvas;

    const sCtx = shCanvas.getContext("2d");
    const bCtx = blurCanvas.getContext("2d");
    if (!sCtx || !bCtx) return;

    sCtx.clearRect(0, 0, w, h);
    bCtx.clearRect(0, 0, w, h);

    sCtx.save();
    sCtx.scale(shadowScale, shadowScale);

    const solar = this.getSolarLightingState();
    const shDay = solar.daylight;
    const koiShX = solar.shadowX * 1.10 * unit;
    const koiShY = solar.shadowY * 1.08 * unit;
    const padShX = solar.shadowX * unit;
    const padShY = solar.shadowY * unit;
    const compShX = solar.shadowX * 0.80 * unit;
    const compShY = solar.shadowY * 0.81 * unit;

    const shRgb = mixRgb([0, 0, 0], [20, 13, 6], shDay);
    sCtx.fillStyle = rgbToRgba(shRgb, 1.0);
    for (let i = 0; i < world.koi.length; i++) {
      this.fillExactKoiShadowSilhouette(sCtx, world.koi[i], koiShX, koiShY);
    }

    if (style !== "sumie") {
    const lotusPads = this.getResolvedLotusPads(worldW, worldH, unit);
    for (let i = 0; i < lotusPads.length; i++) {
      const lp = lotusPads[i];
      const st = this.lotusPadStates[i];
      const ampBoost = 1.0 + st.excite * 1.65;
      const swayX = Math.sin(st.leafPhase) * 3.0 * unit * ampBoost + st.swayX + st.dispX;
      const swayY = Math.cos(st.leafPhase * 0.84 + i) * 2.4 * unit * ampBoost + st.swayY + st.dispY;
      const cx = lp.x + swayX + padShX;
      const cy = lp.y + swayY + padShY;
      sCtx.beginPath();
      sCtx.arc(cx, cy, lp.r * 0.98, 0, Math.PI * 2);
      sCtx.fill();
    }
    const compPads = this.getResolvedCompanionLeaves(worldW, worldH, unit, lotusPads);
    for (let cIdx = 0; cIdx < compPads.length; cIdx++) {
      const cp = compPads[cIdx];
      const st = this.lotusPadStates[cp.parentIdx];
      const cst = this.companionLeafStates[cIdx];
      const cPhase = st.leafPhase * 1.08 + cIdx * 0.85;
      const ampBoost = 1.0 + st.excite * 1.55;
      const swayX = Math.sin(cPhase) * 2.5 * unit * ampBoost + st.swayX * 0.90 + (cst ? cst.dispX : 0);
      const swayY = Math.cos(cPhase * 0.86 + cIdx) * 2.0 * unit * ampBoost + st.swayY * 0.90 + (cst ? cst.dispY : 0);
      sCtx.beginPath();
      sCtx.arc(cp.x + swayX + compShX, cp.y + swayY + compShY, cp.r * 0.95, 0, Math.PI * 2);
      sCtx.fill();
    }
    }
    sCtx.restore();

    bCtx.save();
    bCtx.filter = `blur(${Math.max(6, Math.round(10.5 * solar.shadowBlurScale * unit))}px)`;
    bCtx.drawImage(shCanvas, 0, 0);
    bCtx.filter = "none";
    bCtx.restore();

    ctx.save();
    ctx.globalAlpha = koiLerp(0.76, 0.58, shDay) * koiLerp(1.0, 0.78, solar.lowSunWarmth * 0.5);
    ctx.drawImage(blurCanvas, 0, 0, worldW, worldH);
    ctx.restore();
  }

  /**
   * Step 2 of Underwater Optics (Rendered *Above* the Swimming Koi & *Below* the Floating Lotus Pads):
   * - Uses the WebGL shader from `caustics.zip` (`caustics.frag.glsl`) at constant 1:1 screen-space scale.
   * - In Light Mode: renders full-pond sunlight caustics.
   * - In Dark Mode: there are NO ambient sunlight caustics; ONLY the area covered by the active flashlight
   *   has caustics (and when the flashlight is toggled off into default dark mode, zero caustics appear).
   * - Attenuates caustics underneath the branching/dappled tree canopy shadow (`canopyShadowCanvas`).
   * - Renders occasional circular ripples exclusively around the floating Lotus Leaves.
   */
  private paintWaterCausticsAndWaves(
    ctx: CanvasRenderingContext2D,
    world: PondWorld,
    worldW: number,
    worldH: number,
    viewW: number,
    viewH: number,
    rect: PondViewportRect,
    time: number,
    isLight: boolean,
    style: KoiArtStyle
  ): void {
    if ((style as KoiArtStyle) === "sumie") return;

    const w = Math.max(64, Math.round(worldW));
    const h = Math.max(64, Math.round(worldH));
    const unit = koiClamp(Math.min(worldW, worldH) / 860, 0.48, 1.22);
    const invRectScale = 1.0 / Math.max(0.25, rect.scale);

    const largeMaples = this.getLargeMapleLeafSpecs(worldW, worldH, unit, time);

    const easeDisp = koiSmoothstep(0, 1, this.flashlightDispersal);
    const darkFlashStrength = 1.0 - easeDisp;
    const solar = this.getSolarLightingState();
    const daylightFactor = solar.daylight;
    const shouldRenderCaustics = daylightFactor > 0.015;

    if (shouldRenderCaustics) {
      const workCanvas = this.causticWorkCanvas ?? document.createElement("canvas");
      if (workCanvas.width !== w || workCanvas.height !== h) {
        workCanvas.width = w;
        workCanvas.height = h;
      }
      this.causticWorkCanvas = workCanvas;
      const cCtx = workCanvas.getContext("2d");

      if (cCtx) {
        cCtx.clearRect(0, 0, w, h);

        const glCaustics = this.renderCausticsShaderCanvas(
          w,
          h,
          viewH,
          rect.scale,
          time,
          style,
          isLight
        );
        if (glCaustics) {
          cCtx.save();
          cCtx.globalAlpha = isLight ? 1.0 : Math.max(0.55, darkFlashStrength);
          cCtx.drawImage(glCaustics, 0, 0, w, h);
          cCtx.restore();
        } else {
          const causticTile = this.ensureCausticTileCanvas(style, isLight);
          const pat = cCtx.createPattern(causticTile, "repeat");
          if (pat) {
            cCtx.save();
            cCtx.globalAlpha = isLight ? 0.54 : 0.48 * darkFlashStrength;
            const shift1X = (Math.sin(time * 0.38) * 115 + Math.cos(time * 0.21) * 42) * invRectScale;
            const shift1Y = (Math.cos(time * 0.31) * 98 + Math.sin(time * 0.19) * 36) * invRectScale;
            cCtx.translate(w * 0.5 + shift1X, h * 0.5 + shift1Y);
            cCtx.scale(1.16 * invRectScale, 1.06 * invRectScale);
            cCtx.fillStyle = pat;
            cCtx.fillRect(-w - 512, -h - 512, w * 2 + 1024, h * 2 + 1024);
            cCtx.restore();
          }
        }

        if (daylightFactor > 0.015) {
          cCtx.save();
          cCtx.globalCompositeOperation = "destination-in";
          const sx = solar.sunNormX * w;
          const sy = solar.sunNormY * h;
          const dirX = w * 0.5 - sx;
          const dirY = h * 0.5 - sy;
          const dirLen = Math.hypot(dirX, dirY) || 1;
          const ux = dirX / dirLen;
          const uy = dirY / dirLen;
          const span = Math.hypot(w, h) * 0.55;
          const gx0 = w * 0.5 - ux * span;
          const gy0 = h * 0.5 - uy * span;
          const gx1 = w * 0.5 + ux * span;
          const gy1 = h * 0.5 + uy * span;
          const sunMask = cCtx.createLinearGradient(gx0, gy0, gx1, gy1);
          sunMask.addColorStop(0.0, "rgba(0, 0, 0, 0.96)");
          sunMask.addColorStop(0.32, "rgba(0, 0, 0, 1.0)");
          sunMask.addColorStop(0.65, "rgba(0, 0, 0, 0.72)");
          sunMask.addColorStop(1.0, "rgba(0, 0, 0, 0.28)");
          cCtx.fillStyle = sunMask;
          cCtx.fillRect(0, 0, w, h);
          cCtx.restore();
        } else {
          const localFlashX = (this.flashX - rect.x) * invRectScale;
          const localFlashY = (this.flashY - rect.y) * invRectScale;
          const baseRadius = this.getFlashlightBaseRadius(viewW, viewH);
          // Tighten water caustics strictly to the brightest inner 38% core of the flashlight
          // without changing the flashlight's overall light radius!
          const localFlashR = baseRadius * 0.38 * invRectScale;

          const maskCanvas = this.causticMaskCanvas ?? document.createElement("canvas");
          if (maskCanvas.width !== w || maskCanvas.height !== h) {
            maskCanvas.width = w;
            maskCanvas.height = h;
          }
          this.causticMaskCanvas = maskCanvas;
          const mCtx = maskCanvas.getContext("2d");
          if (mCtx) {
            mCtx.clearRect(0, 0, w, h);
            if (darkFlashStrength > 0.01) {
              const flashMask = mCtx.createRadialGradient(
                localFlashX,
                localFlashY,
                localFlashR * 0.04,
                localFlashX,
                localFlashY,
                localFlashR
              );
              flashMask.addColorStop(0.0, `rgba(0, 0, 0, ${(1.0 * darkFlashStrength).toFixed(3)})`);
              flashMask.addColorStop(0.46, `rgba(0, 0, 0, ${(0.82 * darkFlashStrength).toFixed(3)})`);
              flashMask.addColorStop(0.78, `rgba(0, 0, 0, ${(0.26 * darkFlashStrength).toFixed(3)})`);
              flashMask.addColorStop(1.0, "rgba(0, 0, 0, 0)");
              mCtx.fillStyle = flashMask;
              mCtx.fillRect(0, 0, w, h);
            }
            // Dark mode lantern light removed per user request

            cCtx.save();
            cCtx.globalCompositeOperation = "destination-in";
            cCtx.drawImage(maskCanvas, 0, 0);
            cCtx.restore();
          }
        }

        // Occlude caustics inside the offset floor shadows & dappled tree canopy shadow
        cCtx.save();
        cCtx.globalCompositeOperation = "destination-out";

        if (this.shadowBlurCanvas) {
          cCtx.globalAlpha = 0.88;
          cCtx.drawImage(this.shadowBlurCanvas, 0, 0, w, h);
        }



        cCtx.globalAlpha = 1.0;
        cCtx.fillStyle = "rgba(0, 0, 0, 0.88)";
        const liveMaplesForOcc = this.getLiveMapleLeafPositions(worldW, worldH, unit, time);
        for (let i = 0; i < liveMaplesForOcc.length; i++) {
          const lm = liveMaplesForOcc[i];
          const cx = lm.x + (lm.under ? 13 : 9) * unit * 0.78;
          const cy = lm.y + (lm.under ? 13 : 9) * unit;
          // Exact 7-lobed palmate maple leaf silhouette following live unbounded position!
          this.fillMapleLeafSilhouette(cCtx, cx, cy, lm.size * 0.98, lm.rot);
        }

        // Attenuate caustics underneath the branching & dappled tree canopy shadow (allowing komorebi gaps to sparkle!)
        const canopyCanvas = this.ensureCanopyShadowCanvas(w, h, isLight);
        const cPad = Math.ceil(64 * unit);
        const cSwayX = Math.sin(time * 0.36) * 2.8 * unit;
        const cSwayY = Math.cos(time * 0.30) * 2.2 * unit;
        cCtx.globalAlpha = 0.88;
        cCtx.drawImage(canopyCanvas, -cPad + cSwayX, -cPad + cSwayY, w + cPad * 2, h + cPad * 2);

        cCtx.restore();

        ctx.save();
        ctx.globalCompositeOperation = "screen";
        ctx.globalAlpha = daylightFactor;
        ctx.drawImage(workCanvas, 0, 0, worldW, worldH);
        ctx.restore();
      }
    }
  }

  /**
   * Paints multi-depth shoreline & floating vegetation:
   * - All 15 Japanese maple (*momiji*) leaves (4 floating + 11 overhanging canopy) dynamically
   *   oscillate longitudinally back and forth when a Koi swims past and settle back to their anchors.
   * - 3-depth shoreline arching sedge/iris grass blades with central midribs & sunlit tips.
   */
  public paintAquaticFlora(
    ctx: CanvasRenderingContext2D,
    worldW: number,
    worldH: number,
    time: number,
    isLight: boolean,
    style: KoiArtStyle
  ): void {
    if (false) return;

    const unit = koiClamp(Math.min(worldW, worldH) / 860, 0.46, 1.22);

    if ((style as KoiArtStyle) === "sumie") {
      const daylight = this.getDaylightFactor();
      const quantUnit = Math.round(unit * 40) / 40;
      const useLight = daylight >= 0.5;

      // 1. Soft mid-grey wash backing patches + bigger individual 5-petal flowers
      //    that displace individually when clicked!
      const clusterSpecs = [
        { fx: 0.12, fy: 0.82, r: 66, seed: 11, count: 16 },
        { fx: 0.25, fy: 0.87, r: 52, seed: 23, count: 12 },
        { fx: 0.80, fy: 0.12, r: 70, seed: 37, count: 16 },
        { fx: 0.91, fy: 0.30, r: 44, seed: 53, count: 10 },
      ];
      if (this.sumieFlowers.length === 0) {
        for (let c = 0; c < clusterSpecs.length; c++) {
          const cs = clusterSpecs[c];
          for (let f = 0; f < cs.count; f++) {
            const fa = (f / cs.count) * Math.PI * 2 + (hash2D(cs.seed, f * 3, 733) - 0.5) * 0.65;
            const fd = (0.14 + Math.sqrt(hash2D(cs.seed, f * 5 + 1, 733)) * 0.84) * (cs.r / 860);
            this.sumieFlowers.push({
              fx: cs.fx + Math.cos(fa) * fd * 0.72,
              fy: cs.fy + Math.sin(fa) * fd * 1.12,
              ox: 0,
              oy: 0,
              vx: 0,
              vy: 0,
              rot: hash2D(cs.seed, f * 11 + 3, 733) * Math.PI * 2,
              vrot: 0,
              sizeIdx: f % 4,
              phase: hash2D(cs.seed, f * 13 + 7, 739) * Math.PI * 2,
            });
          }
        }
      }

      // Draw cached soft mid-grey wash backing patches
      const getBackings = (lightFlag: boolean) => {
        const ck = `${quantUnit}:${lightFlag ? "L" : "D"}:sumie-backings-v2`;
        let arr = this.sumieClusterCache.get(ck);
        if (!arr) {
          if (this.sumieClusterCache.size >= 4) this.sumieClusterCache.clear();
          arr = clusterSpecs.map((cs) =>
            bakeSumieWashBackingSprite(cs.r * quantUnit, lightFlag, cs.seed)
          );
          this.sumieClusterCache.set(ck, arr);
        }
        return arr;
      };
      const getSingleFlowers = (lightFlag: boolean) => {
        const fk = `${quantUnit}:${lightFlag ? "L" : "D"}:sumie-flowers-v2`;
        let arr = this.sumieSingleFlowerCache.get(fk);
        if (!arr) {
          if (this.sumieSingleFlowerCache.size >= 4) this.sumieSingleFlowerCache.clear();
          // Bigger individual 5-petal flowers (~14px to 23px diameter)
          arr = [7.2, 8.6, 10.0, 11.4].map((rad) =>
            bakeSumieSingleFlowerSprite(rad * quantUnit, lightFlag)
          );
          this.sumieSingleFlowerCache.set(fk, arr);
        }
        return arr;
      };

      const backings = getBackings(useLight);
      const flowerSprites = getSingleFlowers(useLight);
      ctx.save();
      for (let c = 0; c < clusterSpecs.length; c++) {
        const cs = clusterSpecs[c];
        const spr = backings[c];
        ctx.drawImage(spr, worldW * cs.fx - spr.width * 0.5, worldH * cs.fy - spr.height * 0.5);
      }

      // Step individual flower physics (water drag, gentle spring return, click-ripple wave push)
      const dt = this.sumieFlowersLastTime < 0 ? 1 / 60 : Math.min(0.05, Math.max(0.001, time - this.sumieFlowersLastTime));
      this.sumieFlowersLastTime = time;
      const drag = Math.exp(-2.15 * dt);
      const rotDrag = Math.exp(-2.4 * dt);

      for (let i = 0; i < this.sumieFlowers.length; i++) {
        const fl = this.sumieFlowers[i];
        const baseX = worldW * fl.fx;
        const baseY = worldH * fl.fy;
        const curX = baseX + fl.ox;
        const curY = baseY + fl.oy;

        // Wave-front push as click ripples sweep past each individual flower
        for (let ri = 0; ri < this.clickRipples.length; ri++) {
          const rip = this.clickRipples[ri];
          const dx = curX - rip.x;
          const dy = curY - rip.y;
          const d = Math.hypot(dx, dy) || 1;
          const band = Math.exp(-Math.pow((d - rip.radius) / (24 * unit), 2));
          if (band > 0.08) {
            const accel = band * rip.strength * 85 * unit;
            fl.vx += (dx / d) * accel * dt;
            fl.vy += (dy / d) * accel * dt;
            fl.vrot += ((i % 2 === 0 ? 1 : -1) * 1.4 * band * rip.strength) * dt;
          }
        }

        // Gentle spring back toward cluster home + viscous water damping
        fl.vx += -fl.ox * 0.42 * dt;
        fl.vy += -fl.oy * 0.42 * dt;
        fl.vx *= drag;
        fl.vy *= drag;
        fl.ox += fl.vx * dt;
        fl.oy += fl.vy * dt;
        fl.vrot *= rotDrag;
        fl.rot += fl.vrot * dt;

        const driftX = Math.sin(time * 0.45 + fl.phase) * 2.2 * unit;
        const driftY = Math.cos(time * 0.38 + fl.phase * 1.3) * 1.8 * unit;
        const spr = flowerSprites[fl.sizeIdx];
        ctx.save();
        ctx.translate(baseX + fl.ox + driftX, baseY + fl.oy + driftY);
        ctx.rotate(fl.rot + Math.sin(time * 0.3 + fl.phase) * 0.08);
        ctx.drawImage(spr, -spr.width * 0.5, -spr.height * 0.5);
        ctx.restore();
      }

      // 2. Cached 5-7 lobed dark-ink maple leaves (larger: ~46-68px across, zero cast shadow)
      const getMaples = (lightFlag: boolean) => {
        const mk = `${quantUnit}:${lightFlag ? "L" : "D"}:sumie-maples-v2`;
        let arr = this.sumieMapleCache.get(mk);
        if (!arr) {
          if (this.sumieMapleCache.size >= 4) this.sumieMapleCache.clear();
          arr = [0, 1, 2, 3, 4, 5].map((v) =>
            bakeSumieMapleSprite((23 + (v % 3) * 5.2) * quantUnit, lightFlag, v)
          );
          this.sumieMapleCache.set(mk, arr);
        }
        return arr;
      };
      const mapleSprites = getMaples(useLight);
      const liveMaples = this.getLiveMapleLeafPositions(worldW, worldH, unit, time);
      for (let m = 0; m < liveMaples.length; m++) {
        const cm = liveMaples[m];
        const spr = mapleSprites[m % mapleSprites.length];
        ctx.save();
        ctx.translate(cm.x, cm.y);
        ctx.rotate(cm.rot);
        ctx.globalAlpha = cm.under ? 0.84 : 0.96;
        ctx.drawImage(spr, -spr.width * 0.5, -spr.height * 0.5);
        ctx.restore();
      }
      ctx.restore();
      return;
    }

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const drawMapleLeaf = (
      lx: number,
      ly: number,
      size: number,
      rot: number,
      shadowOffset: number,
      alpha = 0.95,
      foregroundBlur = 0,
      isHankoAccent = false
    ) => {
      const lobes = [
        { ang: 0.0, len: 1.0, w: 0.23 },
        { ang: -0.58, len: 0.88, w: 0.21 },
        { ang: 0.58, len: 0.88, w: 0.21 },
        { ang: -1.16, len: 0.68, w: 0.17 },
        { ang: 1.16, len: 0.68, w: 0.17 },
        { ang: -1.72, len: 0.44, w: 0.13 },
        { ang: 1.72, len: 0.44, w: 0.13 },
      ];

      const traceLobe = (lLen: number, lW: number) => {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.bezierCurveTo(lLen * 0.28, -lW * 0.65, lLen * 0.62, -lW * 1.15, lLen, 0);
        ctx.bezierCurveTo(lLen * 0.62, lW * 1.15, lLen * 0.28, lW * 0.65, 0, 0);
        ctx.closePath();
      };

      const mSolar = this.getSolarLightingState();
      const mDay = mSolar.daylight;
      if (shadowOffset > 0) {
        const shScale = shadowOffset / Math.max(1, 26 * unit);
        ctx.save();
        const shCol = mixRgb([0, 0, 0], [18, 12, 6], mDay);
        ctx.shadowColor = rgbToRgba(shCol, koiLerp(0.76, 0.52, mDay));
        ctx.shadowBlur = Math.max(4, Math.round(7.5 * mSolar.shadowBlurScale * unit));
        ctx.shadowOffsetX = mSolar.shadowX * shScale * unit;
        ctx.shadowOffsetY = mSolar.shadowY * shScale * unit;
        ctx.fillStyle = rgbToRgba(shCol, koiLerp(0.68, 0.44, mDay));
        this.fillMapleLeafSilhouette(ctx, lx, ly, size * 0.96, rot);
        ctx.restore();
      }

      ctx.save();
      ctx.translate(lx, ly);
      ctx.rotate(rot);

      const leafGrad = ctx.createRadialGradient(
        size * 0.12,
        0,
        size * 0.04,
        0,
        0,
        size * 1.02
      );
      if (style === "sumie") {
        // 100% Black-and-white Sumi-e ink wash maple leaves (continuous daylight blend)
        const c0 = mixRgb([124, 120, 114], [92, 88, 82], mDay);
        const c1 = mixRgb([76, 72, 68], [48, 45, 42], mDay);
        const c2 = mixRgb([34, 32, 30], [20, 19, 18], mDay);
        leafGrad.addColorStop(0.0, rgbToRgba(c0, alpha));
        leafGrad.addColorStop(0.55, rgbToRgba(c1, alpha));
        leafGrad.addColorStop(1.0, rgbToRgba(c2, alpha * 0.96));
      } else {
        leafGrad.addColorStop(0.0, `rgba(246, 98, 48, ${alpha.toFixed(3)})`);
        leafGrad.addColorStop(0.48, `rgba(208, 38, 24, ${alpha.toFixed(3)})`);
        leafGrad.addColorStop(0.85, `rgba(154, 22, 16, ${alpha.toFixed(3)})`);
        leafGrad.addColorStop(1.0, `rgba(98, 14, 10, ${(alpha * 0.96).toFixed(3)})`);
      }
      ctx.fillStyle = leafGrad;

      for (const lb of lobes) {
        ctx.save();
        ctx.rotate(lb.ang);
        traceLobe(size * lb.len, size * lb.w);
        ctx.fill();
        if (style === "sumie") {
          ctx.lineWidth = Math.max(1.45, 1.85 * unit);
          ctx.lineJoin = "round";
          ctx.strokeStyle = "rgba(10, 9, 8, 0.94)";
          ctx.stroke();
        }
        ctx.restore();
      }

      ctx.shadowBlur = 0;
      ctx.strokeStyle =
        style === "sumie"
          ? "rgba(236, 228, 212, 0.30)"
          : "rgba(255, 196, 128, 0.38)";
      ctx.lineWidth = Math.max(0.55, size * 0.028);
      for (const lb of lobes) {
        ctx.save();
        ctx.rotate(lb.ang);
        const vLen = size * lb.len * 0.84;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(vLen, 0);
        ctx.stroke();
        ctx.restore();
      }

      ctx.restore();
    };

    // Render the 6 Non-Overlapping Floating Japanese Maple (*Momiji*) Leaves:
    const liveMaples = this.getLiveMapleLeafPositions(worldW, worldH, unit, time);
    for (let m = 0; m < liveMaples.length; m++) {
      const cm = liveMaples[m];
      drawMapleLeaf(
        cm.x,
        cm.y,
        cm.size,
        cm.rot,
        (cm.under ? 13 : 9) * unit,
        cm.under ? 0.88 : 0.98,
        0,
        cm.hanko
      );
    }

    ctx.restore();
  }

  /**
   * Paints soft diagonal sunlight beams (in Light Mode), swaying dappled tree-canopy shadows
   * in the upper-right, and subtle water-surface reflections.
   */
  private paintSunlightAndReflections(
    ctx: CanvasRenderingContext2D,
    worldW: number,
    worldH: number,
    time: number,
    isLight: boolean,
    style: KoiArtStyle
  ): void {
    if ((style as KoiArtStyle) === "sumie") return;

    const unit = koiClamp(Math.min(worldW, worldH) / 860, 0.48, 1.22);
    ctx.save();

    const solar = this.getSolarLightingState();
    const daylight = solar.daylight;
    const h = solar.h;
    const sunNormX = solar.sunNormX;
    const sunNormY = solar.sunNormY;

    if (daylight > 0.015) {
      const beamX0 = worldW * koiClamp(sunNormX - 0.45, 0, 1);
      const beamY0 = worldH * koiClamp(sunNormY - 0.42, 0, 1);
      const beamX1 = worldW * koiClamp(sunNormX + 0.45, 0, 1);
      const beamY1 = worldH * koiClamp(sunNormY + 0.42, 0, 1);
      const sunGrad = ctx.createLinearGradient(beamX0, beamY0, beamX1, beamY1);
      const sunAlpha = 0.16 * daylight;
      const sunTone =
        style === "sumie"
          ? "250, 244, 232"
          : h >= 14.5 && h < 18.2
            ? "255, 182, 102"
            : h >= 4.8 && h < 8.6
              ? "255, 210, 162"
              : "255, 238, 188";
      sunGrad.addColorStop(0.0, `rgba(${sunTone}, 0)`);
      sunGrad.addColorStop(0.28, `rgba(${sunTone}, 0)`);
      sunGrad.addColorStop(0.50, `rgba(${sunTone}, ${sunAlpha.toFixed(3)})`);
      sunGrad.addColorStop(0.72, `rgba(${sunTone}, 0)`);
      sunGrad.addColorStop(1.0, `rgba(${sunTone}, 0)`);
      ctx.fillStyle = sunGrad;
      ctx.fillRect(0, 0, worldW, worldH);
    }

    // Continuous Sunrise / Dawn (04:50..09:00) and Sunset / Dusk (14:20..18:25) subtle atmospheric tint wash
    if (h >= 4.85 && h < 9.0) {
      const dawnBell = Math.sin(((h - 4.85) / 4.15) * Math.PI);
      if (dawnBell > 0.01) {
        const dawnCol = style === "sumie" ? "210, 214, 222" : "242, 162, 126";
        ctx.fillStyle = `rgba(${dawnCol}, ${(0.16 * dawnBell).toFixed(3)})`;
        ctx.fillRect(0, 0, worldW, worldH);
      }
    } else if (h >= 14.35 && h < 18.35) {
      const duskBell = Math.sin(((h - 14.35) / 4.0) * Math.PI);
      if (duskBell > 0.01) {
        const goldenCol = style === "sumie" ? "156, 148, 136" : "232, 104, 36";
        ctx.fillStyle = `rgba(${goldenCol}, ${(0.20 * duskBell).toFixed(3)})`;
        ctx.fillRect(0, 0, worldW, worldH);
      }
    }

    // 2. Realistic Dappled Branching Tree Canopy Shadow at Top-Right & Bottom-Left (with overscan bleed)
    const cw = Math.max(128, Math.round(worldW));
    const ch = Math.max(128, Math.round(worldH));
    const cUnit = koiClamp(Math.min(cw, ch) / 860, 0.48, 1.25);
    const cPad = Math.ceil(64 * cUnit);
    const canopyCanvas = this.ensureCanopyShadowCanvas(cw, ch, isLight);
    const cSwayX = Math.sin(time * 0.36) * 2.8 * cUnit;
    const cSwayY = Math.cos(time * 0.30) * 2.2 * cUnit;
    ctx.save();
    ctx.globalAlpha = isLight ? 0.56 : 0.72;
    ctx.drawImage(canopyCanvas, -cPad + cSwayX, -cPad + cSwayY, cw + cPad * 2, ch + cPad * 2);
    ctx.restore();

    const sheenX = worldW * (0.52 + Math.sin(time * 0.22) * 0.04);
    const sheenY = worldH * (0.44 + Math.cos(time * 0.18) * 0.04);
    const sheenR = Math.min(worldW, worldH) * 0.48;
    const sheenGrad = ctx.createRadialGradient(sheenX, sheenY, sheenR * 0.05, sheenX, sheenY, sheenR);
    sheenGrad.addColorStop(
      0.0,
      isLight ? "rgba(255, 252, 240, 0.11)" : "rgba(255, 236, 192, 0.04)"
    );
    sheenGrad.addColorStop(1.0, "rgba(255, 252, 240, 0)");
    ctx.fillStyle = sheenGrad;
    ctx.fillRect(0, 0, worldW, worldH);

    ctx.restore();
  }

  /**
   * Renders the Dark Mode Flashlight veil over the KOI pond when in Dark Mode
   * with +10% increased beam radius (`Math.max(506, Math.min(width, height) * 0.748)`).
   */

  /**
   * Paints evening sunset fireflies (*Hotaru*) as tiny warm golden light sources scattered naturally
   * across the pond, complete with subtle halos, delicate translucent wings on closer hoverers,
   * and faint warm golden reflections on nearby submerged stones, passing KOIs, drifting maples,
   * floating sakura blossoms/petals, and lily pads.
   */

  /**
   * Startles any daytime dragonflies within `reach` of `(x, y)` so they immediately dart away
   * to a distant waypoint across the pond.
   */
  private startleDragonfliesNear(
    x: number,
    y: number,
    reach: number,
    worldW: number,
    worldH: number,
    unit: number
  ): void {
    const dfFactor = this.getDaytimeDragonflyFactor();
    if (dfFactor <= 0.01) return;

    for (let i = 0; i < this.dragonflyStates.length; i++) {
      const df = this.dragonflyStates[i];
      if (!df.initialized) continue;
      const dx = df.x - x;
      const dy = df.y - y;
      const dist = Math.hypot(dx, dy);
      if (dist < reach && df.mode !== "darting") {
        df.mode = "darting";
        df.modeTimer = 0.85 + (i % 3) * 0.28;
        const escapeAng =
          dist > 1.0
            ? Math.atan2(dy, dx) + (Math.sin(i * 2.3 + df.wingPhase) * 0.55)
            : i * 1.25;
        const jumpDist = (260 + (i % 3) * 85) * unit;
        df.targetX = koiClamp(
          df.x + Math.cos(escapeAng) * jumpDist,
          75 * unit,
          worldW - 75 * unit
        );
        df.targetY = koiClamp(
          df.y + Math.sin(escapeAng) * jumpDist,
          75 * unit,
          worldH - 75 * unit
        );
        const spd = (390 + (i % 3) * 45) * unit;
        df.vx = Math.cos(escapeAng) * spd;
        df.vy = Math.sin(escapeAng) * spd;
        df.heading = escapeAng;
      }
    }
  }

  /**
   * Updates and paints 5 daytime dragonflies (*Tonbo* — 3 *Akiakane* vermilion darters and
   * 2 *Ruri-boshi* cerulean-emerald hawkers) present during morning and noon (`05:45..16:25`).
   * Features rapid shimmering gossamer double-wings, lotus-leaf perching, soft underwater
   * riverbed shadows, faint water/lily-pad reflections, and cursor/click dart-away behavior.
   */
  /**
   * Computes the exact live world-space position `(x, y)` and orientation `heading` for a dragonfly
   * perched on a moving pond element (`"lotus-leaf"`, `"lotus-flower"`, `"companion-leaf"`, or `"maple-leaf"`),
   * locking 1:1 with the element's instantaneous sway, drift, and rotation.
   */
  private getDragonflyPerchWorldPose(
    perchType: "none" | "lotus-leaf" | "lotus-flower" | "maple-leaf" | "companion-leaf",
    perchIdx: number,
    offsetAngle: number,
    offsetR: number,
    localHeading: number,
    resolvedPads: { x: number; y: number; r: number; notch: number; hasLotus: boolean }[],
    companionLeaves: { x: number; y: number; r: number; notch: number; parentIdx: number }[],
    liveMaples: { x: number; y: number; size: number; rot: number; under: boolean; hanko: boolean }[],
    unit: number
  ): { x: number; y: number; heading: number } | null {
    if (perchType === "lotus-leaf" && resolvedPads.length > 0) {
      const idx = ((perchIdx % resolvedPads.length) + resolvedPads.length) % resolvedPads.length;
      const pad = resolvedPads[idx];
      const st = this.lotusPadStates[idx];
      const ampBoost = st ? 1.0 + st.excite * 0.22 : 1.0;
      const swayX = st ? Math.sin(st.leafPhase) * 3.0 * unit * ampBoost + st.swayX + st.dispX : 0;
      const swayY = st ? Math.cos(st.leafPhase * 0.84 + idx) * 2.4 * unit * ampBoost + st.swayY + st.dispY : 0;
      const cx = pad.x + swayX;
      const cy = pad.y + swayY;
      const notchAngle =
        pad.notch +
        (st ? Math.sin(st.leafPhase * 0.58) * (0.025 + st.excite * 0.015) + st.rotOffset : 0);
      const worldAng = notchAngle + offsetAngle;
      const distR = pad.r * offsetR;
      return {
        x: cx + Math.cos(worldAng) * distR,
        y: cy + Math.sin(worldAng) * distR,
        heading: notchAngle + localHeading,
      };
    }

    if (perchType === "lotus-flower" && resolvedPads.length > 0) {
      const idx = ((perchIdx % resolvedPads.length) + resolvedPads.length) % resolvedPads.length;
      const pad = resolvedPads[idx];
      if (!pad.hasLotus) return null;
      const st = this.lotusPadStates[idx];
      const lagAmp = st ? 1.0 + st.excite * 0.24 : 1.0;
      const flSwayX = st ? Math.sin(st.flowerPhase) * 3.8 * unit * lagAmp + st.swayX * 1.18 + st.dispX : 0;
      const flSwayY = st ? Math.cos(st.flowerPhase * 0.84 + idx) * 3.1 * unit * lagAmp + st.swayY * 1.18 + st.dispY : 0;
      const baseNotch =
        pad.notch +
        (st ? Math.sin(st.flowerPhase * 0.58) * (0.025 + st.excite * 0.015) + st.rotOffset * 1.12 : 0);
      const flX = pad.x + flSwayX + Math.cos(baseNotch + 0.35) * (pad.r * 0.78);
      const flY = pad.y + flSwayY + Math.sin(baseNotch + 0.35) * (pad.r * 0.78);
      const flRad = pad.r * 0.64;
      const worldAng = baseNotch + offsetAngle;
      const distR = flRad * koiClamp(offsetR, 0.16, 0.48);
      return {
        x: flX + Math.cos(worldAng) * distR,
        y: flY + Math.sin(worldAng) * distR,
        heading: baseNotch + localHeading,
      };
    }

    if (perchType === "companion-leaf" && companionLeaves.length > 0) {
      const idx = ((perchIdx % companionLeaves.length) + companionLeaves.length) % companionLeaves.length;
      const comp = companionLeaves[idx];
      const st = this.lotusPadStates[comp.parentIdx];
      const cst = this.companionLeafStates[idx];
      const cPhase = st.leafPhase * 1.08 + idx * 0.85;
      const ampBoost = 1.0 + st.excite * 0.22;
      const swayX = Math.sin(cPhase) * 2.5 * unit * ampBoost + st.swayX * 0.90 + (cst ? cst.dispX : 0);
      const swayY = Math.cos(cPhase * 0.86 + idx) * 2.0 * unit * ampBoost + st.swayY * 0.90 + (cst ? cst.dispY : 0);
      const cx = comp.x + swayX;
      const cy = comp.y + swayY;
      const notchAngle =
        comp.notch +
        Math.sin(cPhase * 0.62) * (0.025 + st.excite * 0.015) +
        st.rotOffset * 0.92;
      const worldAng = notchAngle + offsetAngle;
      const distR = comp.r * koiClamp(offsetR, 0.18, 0.48);
      return {
        x: cx + Math.cos(worldAng) * distR,
        y: cy + Math.sin(worldAng) * distR,
        heading: notchAngle + localHeading,
      };
    }

    if (perchType === "maple-leaf" && liveMaples.length > 0) {
      const idx = ((perchIdx % liveMaples.length) + liveMaples.length) % liveMaples.length;
      const m = liveMaples[idx];
      const worldAng = m.rot + offsetAngle;
      const distR = m.size * koiClamp(offsetR, 0.12, 0.36);
      return {
        x: m.x + Math.cos(worldAng) * distR,
        y: m.y + Math.sin(worldAng) * distR,
        heading: m.rot + localHeading,
      };
    }

    return null;
  }

  /**
   * Returns true if any other dragonfly (`j !== excludeDfIdx`) is currently perched on or
   * flying toward the same element, guaranteeing no two dragonflies ever sit together on the same element.
   */
  private isPerchElementOccupied(
    excludeDfIdx: number,
    perchType: "none" | "lotus-leaf" | "lotus-flower" | "maple-leaf" | "companion-leaf",
    perchIdx: number
  ): boolean {
    if (perchType === "none" || perchIdx < 0) return false;
    for (let j = 0; j < this.dragonflyStates.length; j++) {
      if (j === excludeDfIdx) continue;
      const other = this.dragonflyStates[j];
      if (!other.initialized || other.perchType === "none" || other.perchPadIdx < 0) continue;
      if (other.perchType === perchType && other.perchPadIdx === perchIdx) {
        return true;
      }
      // Also prevent sitting on both a lotus pad and its attached lotus flower simultaneously
      if (
        (perchType === "lotus-leaf" || perchType === "lotus-flower") &&
        (other.perchType === "lotus-leaf" || other.perchType === "lotus-flower") &&
        other.perchPadIdx === perchIdx
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Selects an unoccupied moving pond element (lotus leaf, blooming lotus flower, companion leaf,
   * or floating maple leaf) for dragonfly `dfIdx` to perch on.
   */
  private pickExclusivePerchElement(
    dfIdx: number,
    time: number,
    resolvedPads: { x: number; y: number; r: number; notch: number; hasLotus: boolean }[],
    companionLeaves: { x: number; y: number; r: number; notch: number; parentIdx: number }[],
    liveMaples: { x: number; y: number; size: number; rot: number; under: boolean; hanko: boolean }[]
  ): {
    perchType: "none" | "lotus-leaf" | "lotus-flower" | "maple-leaf" | "companion-leaf";
    perchIdx: number;
    offsetAngle: number;
    offsetR: number;
    localHeading: number;
  } {
    const candidates: {
      perchType: "lotus-leaf" | "lotus-flower" | "maple-leaf" | "companion-leaf";
      perchIdx: number;
    }[] = [];

    for (let p = 0; p < resolvedPads.length; p++) {
      if (resolvedPads[p].hasLotus) {
        candidates.push({ perchType: "lotus-flower", perchIdx: p });
      }
      candidates.push({ perchType: "lotus-leaf", perchIdx: p });
    }
    for (let c = 0; c < companionLeaves.length; c += 2) {
      candidates.push({ perchType: "companion-leaf", perchIdx: c });
    }
    for (let m = 0; m < liveMaples.length; m++) {
      candidates.push({ perchType: "maple-leaf", perchIdx: m });
    }

    const free = candidates.filter(
      (c) => !this.isPerchElementOccupied(dfIdx, c.perchType, c.perchIdx)
    );
    if (free.length === 0) {
      return {
        perchType: "none",
        perchIdx: -1,
        offsetAngle: 0,
        offsetR: 0.45,
        localHeading: 0,
      };
    }

    const pickIdx =
      Math.floor(hash2D(dfIdx, Math.floor(time * 2.7), 733) * free.length) % free.length;
    const chosen = free[pickIdx];
    const h1 = hash2D(chosen.perchIdx, dfIdx + Math.floor(time), 739);
    const h2 = hash2D(dfIdx, chosen.perchIdx + Math.floor(time), 743);
    const h3 = hash2D(dfIdx + 3, chosen.perchIdx, 751);

    // Keep offsetAngle clear of the V-notch cleft (`±0.45 rad` around 0) on lotus & companion leaves
    const offsetAngle =
      chosen.perchType === "lotus-leaf" || chosen.perchType === "companion-leaf"
        ? 0.55 + h1 * (Math.PI * 2 - 1.1)
        : (h1 - 0.5) * Math.PI * 1.6;
    const offsetR =
      chosen.perchType === "lotus-flower"
        ? 0.20 + h2 * 0.25
        : chosen.perchType === "maple-leaf"
          ? 0.14 + h2 * 0.20
          : chosen.perchType === "companion-leaf"
            ? 0.22 + h2 * 0.24
            : 0.34 + h2 * 0.32;
    const localHeading = (h3 - 0.5) * Math.PI * 2;

    return {
      perchType: chosen.perchType,
      perchIdx: chosen.perchIdx,
      offsetAngle,
      offsetR,
      localHeading,
    };
  }

  private paintDaytimeDragonflies(
    ctx: CanvasRenderingContext2D,
    worldW: number,
    worldH: number,
    time: number,
    isLight: boolean,
    style: KoiArtStyle,
    skipPhysics: boolean
  ): void {
    if ((style as KoiArtStyle) === "sumie") return;
    const dfFactor = this.getDaytimeDragonflyFactor();
    const hNow = KoiPondRenderer.normalizeHours(this.timeOfDayHours);
    const isDuskDepart = hNow >= 15.65 || hNow < 5.75;
    const isDawnArrive = hNow >= 5.75 && hNow < 9.5 && dfFactor < 0.99;
    const anyStillInView = this.dragonflyStates.some((d) => d.initialized && !d.departed);
    if (dfFactor <= 0.005 && !anyStillInView) return;

    const unit = koiClamp(Math.min(worldW, worldH) / 860, 0.48, 1.25);
    const isSumie = style === "sumie";
    const resolvedPads = this.getResolvedLotusPads(worldW, worldH, unit);
    const companionLeaves = this.getResolvedCompanionLeaves(worldW, worldH, unit, resolvedPads);
    const liveMaples = this.getLiveMapleLeafPositions(worldW, worldH, unit, time);

    const now = performance.now();
    const dt =
      this.lastDragonflyUpdateAt > 0
        ? koiClamp((now - this.lastDragonflyUpdateAt) / 1000, 0.004, 0.05)
        : 0.016;
    if (!skipPhysics) {
      this.lastDragonflyUpdateAt = now;
    }

    for (let i = 0; i < this.dragonflyStates.length; i++) {
      const df = this.dragonflyStates[i];
      if (!df.initialized) {
        const seedX = 0.18 + ((i * 0.17) % 0.68);
        const seedY = 0.20 + (((i * 0.29) + 0.11) % 0.64);
        df.x = seedX * worldW;
        df.y = seedY * worldH;
        df.targetX = df.x;
        df.targetY = df.y;
        if (df.mode === "perched") {
          const picked = this.pickExclusivePerchElement(
            i,
            time + i * 1.7,
            resolvedPads,
            companionLeaves,
            liveMaples
          );
          df.perchType = picked.perchType;
          df.perchPadIdx = picked.perchIdx;
          df.perchOffsetAngle = picked.offsetAngle;
          df.perchOffsetR = picked.offsetR;
          df.perchLocalHeading = picked.localHeading;
          const pose = this.getDragonflyPerchWorldPose(
            df.perchType,
            df.perchPadIdx,
            df.perchOffsetAngle,
            df.perchOffsetR,
            df.perchLocalHeading,
            resolvedPads,
            companionLeaves,
            liveMaples,
            unit
          );
          if (pose) {
            df.x = pose.x;
            df.y = pose.y;
            df.heading = pose.heading;
          }
        } else {
          df.perchType = "none";
          df.perchPadIdx = -1;
          df.flightTimeLeft = 14.0 + i * 3.0;
        }
        df.initialized = true;
      }

      if (!skipPhysics) {
        if (isDuskDepart && !df.departed) {
          if (df.mode === "perched" || df.perchType !== "none") {
            df.mode = "darting";
            df.perchType = "none";
            df.perchPadIdx = -1;
            df.modeTimer = 3.0;
          }
          const dLeft = df.x;
          const dRight = worldW - df.x;
          const dTop = df.y;
          const dBottom = worldH - df.y;
          const minEdge = Math.min(dLeft, dRight, dTop, dBottom);
          const marginOut = 105 * unit;
          if (minEdge === dLeft) {
            df.targetX = -marginOut;
            df.targetY = koiClamp(df.y + (i - 2) * 28 * unit, 40 * unit, worldH - 40 * unit);
          } else if (minEdge === dRight) {
            df.targetX = worldW + marginOut;
            df.targetY = koiClamp(df.y + (i - 2) * 28 * unit, 40 * unit, worldH - 40 * unit);
          } else if (minEdge === dTop) {
            df.targetX = koiClamp(df.x + (i - 2) * 32 * unit, 40 * unit, worldW - 40 * unit);
            df.targetY = -marginOut;
          } else {
            df.targetX = koiClamp(df.x + (i - 2) * 32 * unit, 40 * unit, worldW - 40 * unit);
            df.targetY = worldH + marginOut;
          }
          df.mode = "darting";
          df.wingPhase += dt * 48.0;
          const edx = df.targetX - df.x;
          const edy = df.targetY - df.y;
          const edist = Math.hypot(edx, edy);
          if (df.x < -52 * unit || df.x > worldW + 52 * unit || df.y < -52 * unit || df.y > worldH + 52 * unit || edist < 18 * unit) {
            df.departed = true;
          } else {
            const ang = Math.atan2(edy, edx);
            const exitSpd = (430 + (i % 3) * 55) * unit;
            df.vx += (Math.cos(ang) * exitSpd - df.vx) * Math.min(1, dt * 8.5);
            df.vy += (Math.sin(ang) * exitSpd - df.vy) * Math.min(1, dt * 8.5);
            df.x += df.vx * dt;
            df.y += df.vy * dt;
            let diff = ang - df.heading;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            df.heading += diff * Math.min(1, dt * 12);
          }
          continue;
        }

        if (!isDuskDepart && df.departed && dfFactor > 0.02) {
          df.departed = false;
          df.mode = "darting";
          df.perchType = "none";
          df.perchPadIdx = -1;
          df.modeTimer = 2.6 + (i % 3) * 0.5;
          df.flightTimeLeft = 8.0 + i * 2.0;
          const edge = i % 4;
          const spawnOut = 64 * unit;
          if (edge === 0) { df.x = worldW + spawnOut; df.y = (0.18 + i * 0.14) * worldH; }
          else if (edge === 1) { df.x = -spawnOut; df.y = (0.22 + i * 0.13) * worldH; }
          else if (edge === 2) { df.x = (0.20 + i * 0.15) * worldW; df.y = -spawnOut; }
          else { df.x = (0.25 + i * 0.14) * worldW; df.y = worldH + spawnOut; }
          df.targetX = (0.20 + ((i * 0.19 + 0.08) % 0.62)) * worldW;
          df.targetY = (0.22 + ((i * 0.23 + 0.10) % 0.56)) * worldH;
          df.heading = Math.atan2(df.targetY - df.y, df.targetX - df.x);
          df.vx = Math.cos(df.heading) * 280 * unit;
          df.vy = Math.sin(df.heading) * 280 * unit;
        }
        if (df.departed) continue;

        df.modeTimer -= dt;
        if (df.mode !== "perched" && df.flightTimeLeft > 0) {
          df.flightTimeLeft = Math.max(0, df.flightTimeLeft - dt);
        }
        df.wingPhase += dt * (df.mode === "perched" ? 3.5 : 42.0);

        if (df.mode === "perched") {
          // If another dragonfly somehow claimed this element, release into flight
          if (this.isPerchElementOccupied(i, df.perchType, df.perchPadIdx)) {
            df.mode = "darting";
            df.perchType = "none";
            df.perchPadIdx = -1;
            df.flightTimeLeft = 9.0 + hash2D(i, Math.floor(time), 703) * 5.0;
            df.modeTimer = 2.0 + hash2D(i, Math.floor(time), 705) * 1.4;
            df.targetX = (0.14 + hash2D(i, Math.floor(time * 3), 719) * 0.72) * worldW;
            df.targetY = (0.15 + hash2D(Math.floor(time * 3), i, 727) * 0.70) * worldH;
          } else {
            const pose = this.getDragonflyPerchWorldPose(
              df.perchType,
              df.perchPadIdx,
              df.perchOffsetAngle,
              df.perchOffsetR,
              df.perchLocalHeading,
              resolvedPads,
              companionLeaves,
              liveMaples,
              unit
            );
            if (pose) {
              // Strict 1:1 lock with the moving element (lotus, lotus leaf, companion leaf, or maple leaf)
              df.x = pose.x;
              df.y = pose.y;
              df.heading = pose.heading;
            }
            df.vx = 0;
            df.vy = 0;

            if (df.modeTimer <= 0) {
              df.mode = "darting";
              // Fly for much longer (9.5 to 15.0 seconds across multiple open-water waypoints) before perching again
              df.flightTimeLeft = 14.0 + hash2D(i, Math.floor(time * 2), 701) * 8.0;
              df.modeTimer = 2.1 + hash2D(i, Math.floor(time * 2), 709) * 1.6;
              df.perchType = "none";
              df.perchPadIdx = -1;
              df.targetX = (0.14 + hash2D(i, Math.floor(time * 3), 719) * 0.72) * worldW;
              df.targetY = (0.15 + hash2D(Math.floor(time * 3), i, 727) * 0.70) * worldH;
            }
          }
        } else if (df.mode === "hovering") {
          // Calm hover drift without cursor wobble
          const hoverBobX = Math.cos(time * 1.9 + i * 1.9) * 8 * unit;
          const hoverBobY = Math.sin(time * 2.2 + i * 2.3) * 8 * unit;
          df.x += (df.targetX + hoverBobX * 0.12 - df.x) * Math.min(1, dt * 4.0);
          df.y += (df.targetY + hoverBobY * 0.12 - df.y) * Math.min(1, dt * 4.0);

          if (df.modeTimer <= 0) {
            df.mode = "darting";
            df.modeTimer = 2.0 + hash2D(i, Math.floor(time * 2), 751) * 1.6;
            // Only seek a perch after the extended flight timer has elapsed
            if (
              df.flightTimeLeft <= 0 &&
              hash2D(i, Math.floor(time * 2), 757) < 0.65
            ) {
              const picked = this.pickExclusivePerchElement(
                i,
                time,
                resolvedPads,
                companionLeaves,
                liveMaples
              );
              df.perchType = picked.perchType;
              df.perchPadIdx = picked.perchIdx;
              df.perchOffsetAngle = picked.offsetAngle;
              df.perchOffsetR = picked.offsetR;
              df.perchLocalHeading = picked.localHeading;
              const pose = this.getDragonflyPerchWorldPose(
                df.perchType,
                df.perchPadIdx,
                df.perchOffsetAngle,
                df.perchOffsetR,
                df.perchLocalHeading,
                resolvedPads,
                companionLeaves,
                liveMaples,
                unit
              );
              if (pose) {
                df.targetX = pose.x;
                df.targetY = pose.y;
              } else {
                df.perchType = "none";
                df.perchPadIdx = -1;
                df.targetX = (0.12 + hash2D(i, Math.floor(time * 3), 787) * 0.76) * worldW;
                df.targetY = (0.14 + hash2D(Math.floor(time * 3), i, 797) * 0.72) * worldH;
              }
            } else {
              df.perchType = "none";
              df.perchPadIdx = -1;
              df.targetX = (0.12 + hash2D(i, Math.floor(time * 3), 787) * 0.76) * worldW;
              df.targetY = (0.14 + hash2D(Math.floor(time * 3), i, 797) * 0.72) * worldH;
            }
          }
        } else {
          // "darting" smoothly toward (targetX, targetY)
          if (df.perchType !== "none" && df.perchPadIdx >= 0) {
            if (this.isPerchElementOccupied(i, df.perchType, df.perchPadIdx)) {
              df.perchType = "none";
              df.perchPadIdx = -1;
              df.targetX = (0.14 + hash2D(i, Math.floor(time * 3), 821) * 0.72) * worldW;
              df.targetY = (0.15 + hash2D(Math.floor(time * 3), i, 829) * 0.70) * worldH;
            } else {
              const pose = this.getDragonflyPerchWorldPose(
                df.perchType,
                df.perchPadIdx,
                df.perchOffsetAngle,
                df.perchOffsetR,
                df.perchLocalHeading,
                resolvedPads,
                companionLeaves,
                liveMaples,
                unit
              );
              if (pose) {
                df.targetX = pose.x;
                df.targetY = pose.y;
              }
            }
          }

          const dx = df.targetX - df.x;
          const dy = df.targetY - df.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 14 * unit || df.modeTimer <= 0) {
            if (
              df.perchType !== "none" &&
              df.perchPadIdx >= 0 &&
              !this.isPerchElementOccupied(i, df.perchType, df.perchPadIdx)
            ) {
              df.mode = "perched";
              df.modeTimer = 3.2 + hash2D(i, Math.floor(time), 809) * 3.0;
              const pose = this.getDragonflyPerchWorldPose(
                df.perchType,
                df.perchPadIdx,
                df.perchOffsetAngle,
                df.perchOffsetR,
                df.perchLocalHeading,
                resolvedPads,
                companionLeaves,
                liveMaples,
                unit
              );
              if (pose) {
                df.x = pose.x;
                df.y = pose.y;
                df.heading = pose.heading;
              }
              df.vx = 0;
              df.vy = 0;
            } else if (df.flightTimeLeft > 0) {
              // Continue flying across open water for longer before hovering/perching
              if (hash2D(i, Math.floor(time * 3), 817) < 0.72) {
                df.mode = "darting";
                df.modeTimer = 2.0 + hash2D(i, Math.floor(time * 2), 823) * 1.5;
                df.perchType = "none";
                df.perchPadIdx = -1;
                df.targetX = (0.12 + hash2D(i, Math.floor(time * 4), 839) * 0.76) * worldW;
                df.targetY = (0.14 + hash2D(Math.floor(time * 4), i, 853) * 0.72) * worldH;
              } else {
                df.mode = "hovering";
                df.modeTimer = 1.6 + hash2D(i, Math.floor(time), 811) * 1.8;
                df.vx *= 0.15;
                df.vy *= 0.15;
              }
            } else {
              df.mode = "hovering";
              df.modeTimer = 1.6 + hash2D(i, Math.floor(time), 811) * 1.8;
              df.vx *= 0.15;
              df.vy *= 0.15;
            }
          } else {
            // Smooth, non-wobbling flight trajectory
            const desiredAng = Math.atan2(dy, dx);
            const cruiseSpd = Math.min(340 * unit, Math.max(125 * unit, dist * 2.8));
            const desiredVx = Math.cos(desiredAng) * cruiseSpd;
            const desiredVy = Math.sin(desiredAng) * cruiseSpd;
            df.vx += (desiredVx - df.vx) * Math.min(1, dt * 7.0);
            df.vy += (desiredVy - df.vy) * Math.min(1, dt * 7.0);
            df.x = koiClamp(df.x + df.vx * dt, 32 * unit, worldW - 32 * unit);
            df.y = koiClamp(df.y + df.vy * dt, 32 * unit, worldH - 32 * unit);

            if (Math.hypot(df.vx, df.vy) > 8 * unit) {
              const targetH = Math.atan2(df.vy, df.vx);
              let diff = targetH - df.heading;
              while (diff > Math.PI) diff -= Math.PI * 2;
              while (diff < -Math.PI) diff += Math.PI * 2;
              df.heading += diff * Math.min(1, dt * 12);
            }
          }
        }
      }
    }

    // Render all 5 dragonflies (shadows & reflections first, then bodies & gossamer wings)
    ctx.save();
    const dfSolar = this.getSolarLightingState();

    for (let i = 0; i < this.dragonflyStates.length; i++) {
      const df = this.dragonflyStates[i];
      if (!df.initialized || df.departed) continue;
      const edgeDist = Math.min(df.x, worldW - df.x, df.y, worldH - df.y);
      const edgeFade = koiSmoothstep(-42 * unit, 22 * unit, edgeDist);
      const dfVisAlpha = isDuskDepart ? edgeFade : (isDawnArrive ? Math.max(edgeFade, dfFactor) : Math.min(1, dfFactor * 1.15));
      if (dfVisAlpha <= 0.01) continue;

      const s = df.scale * unit;
      const isPerched = df.mode === "perched";
      if (isPerched) {
        const pose = this.getDragonflyPerchWorldPose(
          df.perchType,
          df.perchPadIdx,
          df.perchOffsetAngle,
          df.perchOffsetR,
          df.perchLocalHeading,
          resolvedPads,
          companionLeaves,
          liveMaples,
          unit
        );
        if (pose) {
          df.x = pose.x;
          df.y = pose.y;
          df.heading = pose.heading;
        }
      }
      const bodyLen = 28 * s;
      const wingSpan = 22 * s;
      const wingBeat = isPerched ? 0 : Math.sin(df.wingPhase) * 0.28;

      // 1. Soft Underwater / Leaf-Surface Shadow aligned to live solar shadow vector
      const shMult = isPerched ? 0.14 : 0.58;
      const shScale = isPerched ? 0.98 : 0.90;
      ctx.save();
      ctx.translate(df.x + dfSolar.shadowX * shMult * unit, df.y + dfSolar.shadowY * shMult * unit);
      ctx.rotate(df.heading);
      ctx.scale(shScale, shScale);
      ctx.globalAlpha = (isPerched ? 0.34 : 0.22) * dfVisAlpha;
      ctx.fillStyle = "rgba(14, 10, 6, 1)";

      // Shadow abdomen + thorax
      ctx.beginPath();
      ctx.ellipse(-bodyLen * 0.22, 0, bodyLen * 0.52, 1.8 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      // Shadow 4 outstretched dragonfly wings (perpendicular to thorax along ±Y)
      for (const side of [-1, 1]) {
        ctx.save();
        ctx.translate(bodyLen * 0.14, side * 1.2 * s);
        ctx.rotate(-side * (0.20 + wingBeat * 0.35));
        ctx.beginPath();
        ctx.ellipse(0, side * wingSpan * 0.52, 2.5 * s, wingSpan * 0.52, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.translate(bodyLen * 0.02, side * 1.1 * s);
        ctx.rotate(side * (0.18 - wingBeat * 0.32));
        ctx.beginPath();
        ctx.ellipse(0, side * wingSpan * 0.45, 3.0 * s, wingSpan * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();

      // 2. Faint Rippled Water / Lily-Pad Reflection beneath the dragonfly
      const reflOffset = (isPerched ? 1.8 : 6.5) * unit;
      const rippleJit = isPerched ? 0 : Math.sin(time * 2.4 + i * 1.7) * 0.8 * unit;
      ctx.save();
      ctx.translate(df.x + rippleJit, df.y + reflOffset);
      ctx.rotate(df.heading);
      ctx.globalAlpha = 0.16 * dfVisAlpha;
      const reflGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, wingSpan * 1.05);
      if (isSumie) {
        reflGrad.addColorStop(0.0, "rgba(218, 212, 198, 0.55)");
        reflGrad.addColorStop(1.0, "rgba(218, 212, 198, 0)");
      } else if (df.variety === "akiakane") {
        reflGrad.addColorStop(0.0, "rgba(232, 84, 52, 0.65)");
        reflGrad.addColorStop(0.55, "rgba(244, 212, 168, 0.32)");
        reflGrad.addColorStop(1.0, "rgba(244, 212, 168, 0)");
      } else {
        reflGrad.addColorStop(0.0, "rgba(56, 184, 176, 0.65)");
        reflGrad.addColorStop(0.55, "rgba(212, 242, 236, 0.32)");
        reflGrad.addColorStop(1.0, "rgba(212, 242, 236, 0)");
      }
      ctx.fillStyle = reflGrad;
      ctx.beginPath();
      ctx.ellipse(0, 0, bodyLen * 0.65, wingSpan * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 3. Anatomical Dragonfly Body & Shimmering Double-Wings
      ctx.save();
      ctx.translate(df.x, df.y);
      ctx.rotate(df.heading);
      ctx.globalAlpha = dfVisAlpha;

      // 3A. Slender Segmented Abdomen (8 tapering segments behind thorax)
      const isAki = df.variety === "akiakane";
      const abdBaseCol = isSumie
        ? isAki
          ? [186, 48, 34]
          : [48, 44, 40]
        : isAki
          ? [216, 52, 34]
          : [38, 156, 152];
      const abdTipCol = isSumie
        ? [24, 22, 20]
        : isAki
          ? [148, 28, 18]
          : [22, 92, 96];

      const segCount = 8;
      for (let sg = segCount - 1; sg >= 0; sg--) {
        const u = sg / (segCount - 1);
        const segX = bodyLen * 0.02 - u * bodyLen * 0.68;
        const segLen = (bodyLen * 0.68) / segCount;
        const segW = (1.55 - u * 0.72) * s;
        const rCol = Math.round(abdBaseCol[0] + (abdTipCol[0] - abdBaseCol[0]) * u);
        const gCol = Math.round(abdBaseCol[1] + (abdTipCol[1] - abdBaseCol[1]) * u);
        const bCol = Math.round(abdBaseCol[2] + (abdTipCol[2] - abdBaseCol[2]) * u);

        ctx.fillStyle = `rgb(${rCol}, ${gCol}, ${bCol})`;
        ctx.beginPath();
        ctx.ellipse(segX, 0, segLen * 0.62, segW, 0, 0, Math.PI * 2);
        ctx.fill();
        if (isSumie) {
          ctx.lineWidth = Math.max(0.85, 0.95 * s);
          ctx.strokeStyle = "rgba(10, 9, 8, 0.92)";
          ctx.stroke();
        }

        // Subtle dark segment ring & dorsal highlight
        ctx.fillStyle = "rgba(18, 14, 10, 0.55)";
        ctx.beginPath();
        ctx.arc(segX - segLen * 0.45, 0, segW * 0.82, 0, Math.PI * 2);
        ctx.fill();
      }

      // 3B. Muscular Thorax
      ctx.fillStyle = isSumie
        ? "rgb(36, 33, 30)"
        : isAki
          ? "rgb(118, 42, 26)"
          : "rgb(28, 84, 78)";
      ctx.beginPath();
      ctx.ellipse(bodyLen * 0.12, 0, 4.4 * s, 2.45 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      if (isSumie) {
        ctx.lineWidth = Math.max(0.95, 1.05 * s);
        ctx.strokeStyle = "rgba(10, 9, 8, 0.92)";
        ctx.stroke();
      }

      // Dorsal thoracic highlight
      ctx.fillStyle = isSumie
        ? "rgba(218, 210, 196, 0.32)"
        : isAki
          ? "rgba(255, 168, 122, 0.45)"
          : "rgba(148, 242, 228, 0.45)";
      ctx.beginPath();
      ctx.ellipse(bodyLen * 0.13, -0.35 * s, 2.8 * s, 1.1 * s, 0, 0, Math.PI * 2);
      ctx.fill();

      // 3C. Head & Compound Eyes
      ctx.fillStyle = isSumie
        ? "rgb(22, 20, 18)"
        : isAki
          ? "rgb(88, 26, 18)"
          : "rgb(18, 58, 56)";
      ctx.beginPath();
      ctx.ellipse(bodyLen * 0.27, 0, 1.9 * s, 2.3 * s, 0, 0, Math.PI * 2);
      ctx.fill();

      for (const eyeSide of [-1, 1]) {
        ctx.fillStyle = isSumie
          ? "rgb(16, 14, 12)"
          : isAki
            ? "rgb(164, 34, 22)"
            : "rgb(28, 128, 134)";
        ctx.beginPath();
        ctx.arc(bodyLen * 0.28, eyeSide * 1.35 * s, 1.25 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255, 252, 240, 0.72)";
        ctx.beginPath();
        ctx.arc(bodyLen * 0.30, eyeSide * 1.25 * s, 0.42 * s, 0, Math.PI * 2);
        ctx.fill();
      }

      // 3D. 4 Wide-Open Outstretched Gossamer Wings (*Anisoptera* — spread perpendicular along ±Y)
      const drawWingPair = (blurPass: boolean, phaseOffset: number) => {
        const flap = isPerched
          ? Math.sin(df.wingPhase) * 0.025
          : Math.sin(df.wingPhase + phaseOffset) * 0.24;
        const alphaMul = blurPass ? 0.36 : 1.0;

        for (const side of [-1, 1]) {
          // Forewing: spread wide open along ±Y, swept slightly forward (-side * 0.22 rad)
          ctx.save();
          ctx.translate(bodyLen * 0.16, side * 1.35 * s);
          const foreAng = -side * (0.22 + flap * 0.38);
          ctx.rotate(foreAng);

          const fwLen = wingSpan * 1.08 * (isPerched ? 1.0 : 0.92 + 0.08 * Math.cos(df.wingPhase + phaseOffset));
          const fwW = 2.65 * s;
          const fGrad = ctx.createLinearGradient(0, 0, 0, side * fwLen);
          if (isSumie) {
            fGrad.addColorStop(0.0, `rgba(236, 230, 218, ${(0.56 * alphaMul).toFixed(3)})`);
            fGrad.addColorStop(0.7, `rgba(196, 188, 174, ${(0.38 * alphaMul).toFixed(3)})`);
            fGrad.addColorStop(1.0, `rgba(148, 140, 128, ${(0.18 * alphaMul).toFixed(3)})`);
          } else if (isAki) {
            fGrad.addColorStop(0.0, `rgba(255, 240, 214, ${(0.64 * alphaMul).toFixed(3)})`);
            fGrad.addColorStop(0.65, `rgba(246, 228, 200, ${(0.44 * alphaMul).toFixed(3)})`);
            fGrad.addColorStop(1.0, `rgba(226, 202, 172, ${(0.22 * alphaMul).toFixed(3)})`);
          } else {
            fGrad.addColorStop(0.0, `rgba(228, 250, 248, ${(0.64 * alphaMul).toFixed(3)})`);
            fGrad.addColorStop(0.65, `rgba(200, 238, 240, ${(0.44 * alphaMul).toFixed(3)})`);
            fGrad.addColorStop(1.0, `rgba(172, 216, 222, ${(0.22 * alphaMul).toFixed(3)})`);
          }

          // Tapered dragonfly forewing contour (narrow stalk at root, widening toward tip)
          ctx.fillStyle = fGrad;
          ctx.beginPath();
          ctx.moveTo(0.4 * s, 0);
          ctx.bezierCurveTo(
            fwW * 0.95,
            side * fwLen * 0.28,
            fwW * 1.05,
            side * fwLen * 0.82,
            0.15 * s,
            side * fwLen
          );
          ctx.bezierCurveTo(
            -fwW * 0.92,
            side * fwLen * 0.86,
            -fwW * 1.08,
            side * fwLen * 0.30,
            -0.35 * s,
            0
          );
          ctx.closePath();
          ctx.fill();

          if (!blurPass) {
            // Leading costal vein, median vein & dark pterostigma cell near wingtip
            ctx.strokeStyle = isSumie
              ? "rgba(42, 38, 34, 0.52)"
              : "rgba(68, 52, 34, 0.48)";
            ctx.lineWidth = Math.max(0.5, 0.65 * s);
            ctx.beginPath();
            ctx.moveTo(0.4 * s, 0);
            ctx.quadraticCurveTo(fwW * 0.72, side * fwLen * 0.52, 0.15 * s, side * fwLen * 0.98);
            ctx.stroke();

            ctx.lineWidth = Math.max(0.35, 0.42 * s);
            ctx.beginPath();
            ctx.moveTo(0, side * fwLen * 0.12);
            ctx.quadraticCurveTo(-fwW * 0.25, side * fwLen * 0.55, -0.2 * s, side * fwLen * 0.90);
            ctx.stroke();

            ctx.fillStyle = isSumie
              ? "rgba(38, 34, 30, 0.62)"
              : isAki
                ? "rgba(172, 46, 26, 0.72)"
                : "rgba(26, 98, 102, 0.72)";
            ctx.beginPath();
            ctx.ellipse(fwW * 0.42, side * fwLen * 0.82, 0.62 * s, 1.65 * s, 0, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();

          // Hindwing: spread wide open along ±Y just behind forewing, angled slightly backward (+side * 0.16 rad)
          ctx.save();
          ctx.translate(bodyLen * 0.04, side * 1.25 * s);
          const hindAng = side * (0.16 - flap * 0.34);
          ctx.rotate(hindAng);

          const hwLen = wingSpan * 0.94 * (isPerched ? 1.0 : 0.92 + 0.08 * Math.sin(df.wingPhase + phaseOffset));
          const hwW = 3.25 * s;
          ctx.fillStyle = fGrad;
          ctx.beginPath();
          ctx.moveTo(0.35 * s, 0);
          ctx.bezierCurveTo(
            hwW * 0.88,
            side * hwLen * 0.26,
            hwW * 0.95,
            side * hwLen * 0.80,
            0.10 * s,
            side * hwLen
          );
          ctx.bezierCurveTo(
            -hwW * 0.95,
            side * hwLen * 0.84,
            -hwW * 1.18,
            side * hwLen * 0.26,
            -0.55 * s,
            0
          );
          ctx.closePath();
          ctx.fill();

          if (!blurPass) {
            ctx.strokeStyle = isSumie
              ? "rgba(42, 38, 34, 0.46)"
              : "rgba(68, 52, 34, 0.42)";
            ctx.lineWidth = Math.max(0.45, 0.55 * s);
            ctx.beginPath();
            ctx.moveTo(0.35 * s, 0);
            ctx.quadraticCurveTo(hwW * 0.64, side * hwLen * 0.50, 0.10 * s, side * hwLen * 0.96);
            ctx.stroke();

            ctx.fillStyle = isSumie
              ? "rgba(38, 34, 30, 0.58)"
              : isAki
                ? "rgba(172, 46, 26, 0.66)"
                : "rgba(26, 98, 102, 0.66)";
            ctx.beginPath();
            ctx.ellipse(hwW * 0.36, side * hwLen * 0.80, 0.58 * s, 1.45 * s, 0, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        }
      };

      if (!isPerched) {
        drawWingPair(true, 1.35);
      }
      drawWingPair(false, 0.0);

      ctx.restore();
    }

    ctx.restore();
  }

  private paintEveningFirefliesAndReflections(
    ctx: CanvasRenderingContext2D,
    world: PondWorld,
    worldW: number,
    worldH: number,
    time: number,
    isLight: boolean,
    style: KoiArtStyle
  ): void {
    if ((style as KoiArtStyle) === "sumie") return;
    const fireflyFactor = this.getEveningFireflyFactor();
    if (fireflyFactor <= 0.005) return;

    // When toggled to dark mode via click, delay fireflies by 2.0s then emerge in arithmetic progression
    const hasToggleDelay = this.darkModeToggleAt > 0;
    const sinceDarkToggleSec = hasToggleDelay ? (performance.now() - this.darkModeToggleAt) / 1000 : 999;
    if (hasToggleDelay && sinceDarkToggleSec < 2.0) return;

    const unit = koiClamp(Math.min(worldW, worldH) / 860, 0.48, 1.25);
    const isSumie = style === "sumie";

    // 32 tiny warm golden light sources emerging in arithmetic progression from the shoreline
    const count = 32;
    const apStepSec = 0.14; // t_i = 2.0 + 0.14 * i seconds
    const fireflies: {
      x: number;
      y: number;
      scale: number;
      alpha: number;
    }[] = [];

    for (let i = 0; i < count; i++) {
      // Low-discrepancy Halton (2, 3) base with organic jitter so spacing is natural across the pond
      let n2 = i + 1;
      let b2 = 0;
      let f2 = 0.5;
      while (n2 > 0) {
        b2 += (n2 & 1) * f2;
        n2 >>= 1;
        f2 *= 0.5;
      }
      let n3 = i + 1;
      let b3 = 0;
      let f3 = 1 / 3;
      while (n3 > 0) {
        b3 += (n3 % 3) * f3;
        n3 = Math.floor(n3 / 3);
        f3 /= 3;
      }

      const jx = (hash2D(i, 3, 941) - 0.5) * 0.09;
      const jy = (hash2D(i, 7, 941) - 0.5) * 0.09;
      const anchorX = koiClamp(0.05 + b2 * 0.90 + jx, 0.04, 0.95) * worldW;
      const anchorY = koiClamp(0.06 + b3 * 0.88 + jy, 0.05, 0.95) * worldH;

      let emerge: number;
      if (hasToggleDelay) {
        const apStartSec = 2.0 + i * apStepSec;
        if (sinceDarkToggleSec < apStartSec) continue;
        emerge = koiSmoothstep(0, 1, koiClamp((sinceDarkToggleSec - apStartSec) / 0.85, 0, 1));
      } else {
        const stagger = hash2D(i, 61, 941) * 0.24;
        const emergeRaw = koiClamp((fireflyFactor - stagger * 0.65) / Math.max(0.25, 0.94 - stagger * 0.65), 0, 1);
        emerge = koiSmoothstep(0, 1, emergeRaw);
      }

      const freq1 = 0.24 + hash2D(i, 11, 941) * 0.22;
      const freq2 = 0.38 + hash2D(i, 13, 941) * 0.28;
      const ph1 = hash2D(i, 17, 941) * Math.PI * 2;
      const ph2 = hash2D(i, 19, 941) * Math.PI * 2;
      const rx1 = (16 + hash2D(i, 23, 941) * 26) * unit;
      const ry1 = (14 + hash2D(i, 29, 941) * 24) * unit;
      const rx2 = (6 + hash2D(i, 31, 941) * 11) * unit;
      const ry2 = (5 + hash2D(i, 37, 941) * 10) * unit;

      const dx1 = Math.sin(time * freq1 + ph1) * rx1 + Math.cos(time * freq2 + ph2) * rx2;
      const dy1 = Math.cos(time * (freq1 * 0.88) + ph2) * ry1 + Math.sin(time * (freq2 * 1.07) + ph1) * ry2;

      const fx = koiClamp(anchorX + dx1, 14 * unit, worldW - 14 * unit);
      const fy = koiClamp(anchorY + dy1, 14 * unit, worldH - 14 * unit);

      const pulseSpd = 1.05 + hash2D(i, 41, 941) * 1.25;
      const pulsePh = hash2D(i, 43, 941) * Math.PI * 2;
      const rawWave = 0.5 + 0.5 * Math.sin(time * pulseSpd + pulsePh);
      const pulse = 0.38 + 0.62 * Math.pow(rawWave, 1.4);

      // +20% firefly size (`scale * 1.20`) and +20% luminosity (`alpha * 1.20`)
      const scale = (0.58 + hash2D(i, 53, 941) * 0.56) * 1.20;

      fireflies.push({
        x: fx,
        y: fy,
        scale,
        alpha: Math.min(1.0, fireflyFactor * emerge * pulse * 1.20),
      });
    }

    ctx.save();
    ctx.globalCompositeOperation = "screen";

    // =========================================================================
    // PASS 1: FAINT GOLDEN REFLECTIONS ON NEARBY STONES & WATER SURFACE
    // =========================================================================
    for (let i = 0; i < fireflies.length; i++) {
      const ff = fireflies[i];
      if (ff.alpha <= 0.02) continue;

      // Softly rippled water-surface & submerged stone reflection beneath the firefly
      const rippleDx = Math.sin(time * 3.2 + i * 1.7) * 2.2 * unit;
      const rippleDy = Math.cos(time * 2.7 + i * 2.1) * 1.6 * unit;
      const rx = ff.x + 2.0 * unit + rippleDx;
      const ry = ff.y + 4.0 * unit + rippleDy;
      const stoneReflR = (24 + 14 * ff.scale) * 1.20 * unit;

      const sg = ctx.createRadialGradient(rx, ry, 0, rx, ry, stoneReflR);
      const a0 = Math.min(0.45, (isSumie ? 0.132 : 0.18) * ff.alpha);
      const a1 = Math.min(0.25, (isSumie ? 0.054 : 0.078) * ff.alpha);
      sg.addColorStop(0.0, `rgba(255, 202, 82, ${a0.toFixed(3)})`);
      sg.addColorStop(0.50, `rgba(224, 148, 38, ${a1.toFixed(3)})`);
      sg.addColorStop(1.0, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.arc(rx, ry, stoneReflR, 0, Math.PI * 2);
      ctx.fill();
    }

    // =========================================================================
    // PASS 2: FAINT DIFFUSED GOLDEN REFLECTIONS ON PASSING KOIs, LILY PADS,
    //         DRIFTING MAPLES, AND FLOATING SAKURA
    // =========================================================================

    // 2A. Passing KOIs — soft warm golden sheen on scales/flanks directly beneath or near a firefly
    const koiReach = 92 * 1.20 * unit;
    for (let k = 0; k < world.koi.length; k++) {
      const fish = world.koi[k];
      if (!fish.spine || fish.spine.length < 4) continue;
      const sampleIndices = [1, 3, 5, 7, 10];
      for (const sIdx of sampleIndices) {
        if (sIdx >= fish.spine.length) continue;
        const pt = fish.spine[sIdx];
        const prev = fish.spine[Math.max(0, sIdx - 1)];
        const segAng = Math.atan2(prev.y - pt.y, prev.x - pt.x);
        const segR = Math.max(9 * unit, pt.halfWidth || (fish.bodyLength || 95) * 0.14);

        for (let i = 0; i < fireflies.length; i++) {
          const ff = fireflies[i];
          const dx = ff.x - pt.x;
          const dy = ff.y - pt.y;
          const dist = Math.hypot(dx, dy);
          if (dist >= koiReach) continue;

          const falloff = Math.pow(1.0 - dist / koiReach, 1.75) * ff.alpha;
          if (falloff <= 0.015) continue;

          const ux = dist > 0.5 ? dx / dist : 0;
          const uy = dist > 0.5 ? dy / dist : 0;
          const gx = pt.x + ux * Math.min(segR * 0.55, dist * 0.35);
          const gy = pt.y + uy * Math.min(segR * 0.55, dist * 0.35);
          const reflRx = segR * 1.55 * 1.20;
          const reflRy = segR * 0.92 * 1.20;

          ctx.save();
          ctx.translate(gx, gy);
          ctx.rotate(segAng);
          ctx.scale(1, reflRy / reflRx);
          const kg = ctx.createRadialGradient(0, 0, 0, 0, 0, reflRx);
          const ka = Math.min(0.32, (isSumie ? 0.168 : 0.228) * falloff);
          kg.addColorStop(0.0, `rgba(255, 224, 118, ${ka.toFixed(3)})`);
          kg.addColorStop(0.55, `rgba(246, 178, 56, ${(ka * 0.45).toFixed(3)})`);
          kg.addColorStop(1.0, "rgba(0, 0, 0, 0)");
          ctx.fillStyle = kg;
          ctx.beginPath();
          ctx.arc(0, 0, reflRx, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    }

    // 2B. Lily Pads — soft golden light wash clipped to the pad, centered right at the firefly's position
    //     so only the part of the lily pad physically near the firefly catches the faint reflection
    const resolvedPads = this.getResolvedLotusPads(worldW, worldH, unit);
    for (let p = 0; p < resolvedPads.length; p++) {
      const basePad = resolvedPads[p];
      const st = this.lotusPadStates[p];
      const padX = basePad.x + (st ? st.swayX : 0);
      const padY = basePad.y + (st ? st.swayY : 0);
      const padR = basePad.r;
      const maxDist = padR + 48 * 1.20 * unit;

      for (let i = 0; i < fireflies.length; i++) {
        const ff = fireflies[i];
        const dx = ff.x - padX;
        const dy = ff.y - padY;
        const dist = Math.hypot(dx, dy);
        if (dist >= maxDist) continue;

        const falloff = Math.pow(1.0 - Math.max(0, dist - padR * 0.6) / (padR * 0.4 + 48 * 1.20 * unit), 1.5) * ff.alpha;
        if (falloff <= 0.015) continue;

        const reflR = (30 + 12 * ff.scale) * 1.20 * unit;
        ctx.save();
        ctx.beginPath();
        ctx.arc(padX, padY, padR, 0, Math.PI * 2);
        ctx.clip();

        const lg = ctx.createRadialGradient(ff.x, ff.y, 0, ff.x, ff.y, reflR);
        const la = Math.min(0.28, (isSumie ? 0.156 : 0.216) * falloff);
        lg.addColorStop(0.0, `rgba(255, 222, 112, ${la.toFixed(3)})`);
        lg.addColorStop(0.55, `rgba(242, 176, 52, ${(la * 0.45).toFixed(3)})`);
        lg.addColorStop(1.0, "rgba(0, 0, 0, 0)");
        ctx.fillStyle = lg;
        ctx.beginPath();
        ctx.arc(ff.x, ff.y, reflR, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // 2C. Drifting Maple Leaves (*Momiji*) — faint warm golden reflection when a firefly hovers nearby (+20% area & luminosity)
    const liveMaples = this.getLiveMapleLeafPositions(worldW, worldH, unit, time);
    for (let m = 0; m < liveMaples.length; m++) {
      const leaf = liveMaples[m];
      const mapleReach = (leaf.size + 64 * unit) * 1.20;
      for (let i = 0; i < fireflies.length; i++) {
        const ff = fireflies[i];
        const dx = ff.x - leaf.x;
        const dy = ff.y - leaf.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= mapleReach) continue;

        const falloff = Math.pow(1.0 - dist / mapleReach, 1.6) * ff.alpha;
        if (falloff <= 0.015) continue;

        const mr = leaf.size * 1.05 * 1.20;
        const mg = ctx.createRadialGradient(leaf.x, leaf.y, 0, leaf.x, leaf.y, mr);
        const ma = Math.min(0.28, (isSumie ? 0.156 : 0.216) * falloff);
        mg.addColorStop(0.0, `rgba(255, 222, 114, ${ma.toFixed(3)})`);
        mg.addColorStop(0.60, `rgba(244, 174, 52, ${(ma * 0.42).toFixed(3)})`);
        mg.addColorStop(1.0, "rgba(0, 0, 0, 0)");
        ctx.fillStyle = mg;
        ctx.beginPath();
        ctx.arc(leaf.x, leaf.y, mr, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 2D. Floating Sakura Blossoms & Petals — faint golden petal reflection near fireflies (+20% area & luminosity)
    const sakuraReach = 68 * 1.20 * unit;
    for (let sIdx = 0; sIdx < this.floatingSakuraParticles.length; sIdx++) {
      const sp = this.floatingSakuraParticles[sIdx];
      for (let i = 0; i < fireflies.length; i++) {
        const ff = fireflies[i];
        const dx = ff.x - sp.x;
        const dy = ff.y - sp.y;
        if (Math.abs(dx) >= sakuraReach || Math.abs(dy) >= sakuraReach) continue;
        const dist = Math.hypot(dx, dy);
        if (dist >= sakuraReach) continue;

        const falloff = Math.pow(1.0 - dist / sakuraReach, 1.6) * ff.alpha;
        if (falloff <= 0.02) continue;

        const sr = (sp.kind === "flower" ? 11 : 7) * 1.20 * unit;
        const sg = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, sr);
        const sa = Math.min(0.30, (isSumie ? 0.168 : 0.24) * falloff);
        sg.addColorStop(0.0, `rgba(255, 224, 122, ${sa.toFixed(3)})`);
        sg.addColorStop(1.0, "rgba(0, 0, 0, 0)");
        ctx.fillStyle = sg;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, sr, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // =========================================================================
    // PASS 3: WARM GOLDEN LIGHT SOURCES WITH HALOS (+20% SIZE & LUMINOSITY)
    // =========================================================================
    for (let i = 0; i < fireflies.length; i++) {
      const ff = fireflies[i];
      if (ff.alpha <= 0.015) continue;

      const s = ff.scale * unit;

      // 1. Subtle Outer Warm Golden Halo (+20% radius & luminosity)
      const haloR = (15 + 9 * ff.scale) * 1.20 * unit;
      const haloGrad = ctx.createRadialGradient(ff.x, ff.y, 0, ff.x, ff.y, haloR);
      const hA0 = Math.min(0.45, (isSumie ? 0.24 : 0.312) * ff.alpha);
      const hA1 = Math.min(0.22, (isSumie ? 0.09 : 0.12) * ff.alpha);
      haloGrad.addColorStop(0.0, `rgba(255, 202, 74, ${hA0.toFixed(3)})`);
      haloGrad.addColorStop(0.42, `rgba(236, 152, 34, ${hA1.toFixed(3)})`);
      haloGrad.addColorStop(1.0, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = haloGrad;
      ctx.beginPath();
      ctx.arc(ff.x, ff.y, haloR, 0, Math.PI * 2);
      ctx.fill();

      // 2. Warm Golden Inner Corona
      const coronaR = 5.4 * s;
      const coronaGrad = ctx.createRadialGradient(ff.x, ff.y, 0, ff.x, ff.y, coronaR);
      coronaGrad.addColorStop(0.0, `rgba(255, 242, 168, ${(0.86 * ff.alpha).toFixed(3)})`);
      coronaGrad.addColorStop(0.46, `rgba(255, 198, 64, ${(0.48 * ff.alpha).toFixed(3)})`);
      coronaGrad.addColorStop(1.0, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = coronaGrad;
      ctx.beginPath();
      ctx.arc(ff.x, ff.y, coronaR, 0, Math.PI * 2);
      ctx.fill();

      // 3. Tiny Crisp Warm Golden Light Core
      const coreR = Math.max(1.3, 2.0 * s);
      const coreGrad = ctx.createRadialGradient(ff.x, ff.y, 0, ff.x, ff.y, coreR);
      coreGrad.addColorStop(0.0, `rgba(255, 253, 234, ${(0.98 * ff.alpha).toFixed(3)})`);
      coreGrad.addColorStop(0.68, `rgba(255, 222, 98, ${(0.92 * ff.alpha).toFixed(3)})`);
      coreGrad.addColorStop(1.0, "rgba(255, 182, 46, 0)");
      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.arc(ff.x, ff.y, coreR, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  private paintDarkFlashlightVeil(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ): void {
    if (this.flashlightDispersal >= 0.998) {
      return;
    }

    const easeDisp = koiSmoothstep(0, 1, this.flashlightDispersal);
    const baseRadius = this.getFlashlightBaseRadius(width, height);
    const maxDiag = Math.hypot(width, height) * 1.65;
    const outerRadius = koiLerp(baseRadius, maxDiag, easeDisp * easeDisp);
    const innerCoreR = outerRadius * 0.10;

    const maxVeilAlpha = 0.968 * (1 - easeDisp);
    if (maxVeilAlpha <= 0.005) return;

    ctx.save();

    // Warm amber lantern bloom inside the flashlight core (on open pond only)
    if (this.rectProgress <= 0.01) {
    const bloomGrad = ctx.createRadialGradient(
      this.flashX,
      this.flashY,
      0,
      this.flashX,
      this.flashY,
      outerRadius * 0.78
    );
    const bloomAlpha = 0.20 * (1 - easeDisp);
    bloomGrad.addColorStop(0.0, `rgba(255, 204, 118, ${bloomAlpha.toFixed(3)})`);
    bloomGrad.addColorStop(0.45, `rgba(242, 158, 72, ${(bloomAlpha * 0.54).toFixed(3)})`);
    bloomGrad.addColorStop(0.78, `rgba(196, 114, 42, ${(bloomAlpha * 0.20).toFixed(3)})`);
    bloomGrad.addColorStop(1.0, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = bloomGrad;
    ctx.fillRect(0, 0, width, height);
    }

    // Multi-stop soft-gradient darkness veil surrounding the flashlight
    const veilGrad = ctx.createRadialGradient(
      this.flashX,
      this.flashY,
      innerCoreR,
      this.flashX,
      this.flashY,
      outerRadius
    );
    veilGrad.addColorStop(0.0, "rgba(5, 4, 3, 0)");
    veilGrad.addColorStop(0.22, `rgba(5, 4, 3, ${(maxVeilAlpha * 0.08).toFixed(3)})`);
    veilGrad.addColorStop(0.45, `rgba(5, 4, 3, ${(maxVeilAlpha * 0.32).toFixed(3)})`);
    veilGrad.addColorStop(0.68, `rgba(5, 4, 3, ${(maxVeilAlpha * 0.68).toFixed(3)})`);
    veilGrad.addColorStop(0.86, `rgba(5, 4, 3, ${(maxVeilAlpha * 0.91).toFixed(3)})`);
    veilGrad.addColorStop(1.0, `rgba(5, 4, 3, ${maxVeilAlpha.toFixed(3)})`);

    ctx.fillStyle = veilGrad;
    ctx.fillRect(0, 0, width, height);

    ctx.restore();
  }

  /**
   * Pre-bakes 3 size-tiered DOF-blurred airborne sakura petal sprites (each with a `near` 100%-size
   * heavier bokeh blur and a `far` 80%-size slightly sharper blur) per `(quantUnit, isLight, style)`
   * so `paintAirborneDofSakuraPetals` runs at 60 FPS with zero per-frame `ctx.filter` cost.
   */
  private ensureDofSakuraSprites(
    unit: number,
    isLight: boolean,
    style: KoiArtStyle
  ): Array<{ near: HTMLCanvasElement; far: HTMLCanvasElement }> {
    const quantUnit = Math.round(unit * 40) / 40;
    const key = `${quantUnit}:${isLight ? "L" : "D"}:${style}:dof-sakura-v6`;
    const cached = this.dofSakuraCache.get(key);
    if (cached) return cached;
    if (this.dofSakuraCache.size >= 8) this.dofSakuraCache.clear();

    const tiers = [
      { len: 28 * quantUnit, nearBlur: 2.4 * quantUnit, farBlur: 1.05 * quantUnit },
      { len: 46 * quantUnit, nearBlur: 4.6 * quantUnit, farBlur: 2.3 * quantUnit },
      { len: 72 * quantUnit, nearBlur: 7.8 * quantUnit, farBlur: 4.2 * quantUnit },
    ];

    const bakeOne = (pLen: number, blurPx: number): HTMLCanvasElement => {
      const pW = pLen * 0.66;
      const pad = Math.ceil(blurPx * 3.0 + 10);
      const cw = Math.ceil(pLen + pad * 2);
      const ch = Math.ceil(pW * 2.0 + pad * 2);
      const c = document.createElement("canvas");
      c.width = cw;
      c.height = ch;
      const g = c.getContext("2d");
      if (!g) return c;

      g.save();
      g.translate(pad, ch * 0.5);
      if (blurPx > 0.2) {
        g.filter = `blur(${blurPx.toFixed(2)}px)`;
      }

      // Authentic notched sakura petal silhouette along +X
      g.beginPath();
      g.moveTo(0, 0);
      g.bezierCurveTo(pLen * 0.24, -pW * 0.94, pLen * 0.78, -pW * 0.88, pLen, -pW * 0.19);
      g.quadraticCurveTo(pLen * 0.89, -pW * 0.05, pLen * 0.82, 0);
      g.quadraticCurveTo(pLen * 0.89, pW * 0.05, pLen, pW * 0.19);
      g.bezierCurveTo(pLen * 0.78, pW * 0.88, pLen * 0.24, pW * 0.94, 0, 0);
      g.closePath();

      const grad = g.createLinearGradient(0, 0, pLen, 0);
      if (style === "sumie") {
        if (isLight) {
          // Pure monochrome wet-on-wet ink wash sakura petal (charcoal base -> warm cream reserved-paper tip)
          grad.addColorStop(0.0, "rgba(38, 35, 31, 1.0)");
          grad.addColorStop(0.45, "rgba(128, 121, 110, 1.0)");
          grad.addColorStop(1.0, "rgba(236, 228, 212, 1.0)");
        } else {
          // Night Sumi-e: inverted silver-grey ink wash petal
          grad.addColorStop(0.0, "rgba(116, 110, 100, 1.0)");
          grad.addColorStop(0.50, "rgba(186, 179, 166, 1.0)");
          grad.addColorStop(1.0, "rgba(228, 221, 208, 1.0)");
        }
      } else {
        if (isLight) {
          // Mokkotsu Day: lush watercolor blush-pink sakura petal
          grad.addColorStop(0.0, "rgba(214, 68, 112, 1.0)");
          grad.addColorStop(0.48, "rgba(248, 158, 188, 1.0)");
          grad.addColorStop(1.0, "rgba(255, 242, 247, 1.0)");
        } else {
          // Mokkotsu Night: softly moonlit lavender-blush sakura petal
          grad.addColorStop(0.0, "rgba(124, 76, 112, 1.0)");
          grad.addColorStop(0.50, "rgba(182, 154, 188, 1.0)");
          grad.addColorStop(1.0, "rgba(224, 212, 234, 1.0)");
        }
      }
      g.fillStyle = grad;
      g.fill();
      // Second fill pass reinforces bokeh core opacity without hardening the Gaussian blurred rim
      g.fill();

      // Delicate central petal vein hint
      g.beginPath();
      g.moveTo(pLen * 0.14, 0);
      g.lineTo(pLen * 0.72, 0);
      g.lineWidth = Math.max(0.6, pLen * 0.022);
      g.strokeStyle =
        style === "sumie"
          ? isLight
            ? "rgba(32, 29, 26, 0.24)"
            : "rgba(232, 224, 210, 0.24)"
          : isLight
            ? "rgba(202, 68, 108, 0.22)"
            : "rgba(230, 214, 240, 0.20)";
      g.stroke();

      g.filter = "none";
      g.restore();
      return c;
    };

    const sprites = tiers.map((t) => ({
      near: bakeOne(t.len, t.nearBlur),
      far: bakeOne(t.len, t.farBlur),
    }));
    this.dofSakuraCache.set(key, sprites);
    return sprites;
  }

  /**
   * Renders at most 3 airborne DOF-blurred sakura petals (1 Small, 1 Medium, 1 Large) drifting
   * diagonally on the wind from the outer edges of the top-right triangle toward the outer edges
   * of the bottom-left triangle, shrinking 100% -> 80% and subtly sharpening as they fall.
   * Purely deterministic in `time` so Mokkotsu and Sumi-e stay pixel-aligned during fluid swaps.
   */
  private paintAirborneDofSakuraPetals(
    ctx: CanvasRenderingContext2D,
    worldW: number,
    worldH: number,
    time: number,
    style: KoiArtStyle
  ): void {
    const unit = koiClamp(Math.min(worldW, worldH) / 860, 0.48, 1.22);
    const daylight = this.getDaylightFactor();
    const daySprites = this.ensureDofSakuraSprites(unit, true, style);
    const nightSprites = daylight < 0.998 ? this.ensureDofSakuraSprites(unit, false, style) : daySprites;

    // 3 size tiers: Small (slower, 3.8..5.0s), Medium (2.8..4.0s), Large (2.1..3.2s)
    // Each tier has a 1..3s quiet pause between exit and next entry; initial phases are staggered
    // so petals appear organically (1 to 3 visible at once, never a shower).
    const tierCfg = [
      { minDrift: 3.8, maxDrift: 5.0, initDelay: 0.4, seed: 101, baseAlpha: 1.0 },
      { minDrift: 2.9, maxDrift: 4.1, initDelay: 2.1, seed: 223, baseAlpha: 0.98 },
      { minDrift: 2.1, maxDrift: 3.3, initDelay: 3.7, seed: 359, baseAlpha: 0.96 },
    ];

    const flashActive = daylight < 0.85 && this.flashlightDispersal < 0.98;
    const flashRadius = this.getFlashlightBaseRadius(worldW, worldH) * 0.95;

    ctx.save();
    for (let tier = 0; tier < 3; tier++) {
      const cfg = tierCfg[tier];
      const tLocal = time - cfg.initDelay;
      if (tLocal < 0) continue;

      // Deterministic cycle finder (each cycle = drift [2..5s] + pause [1..3s], avg ~5.2s)
      // Use a constant-time approximate cycle index + bounded walk so cost is O(1) even after hours
      const slotPeriod = (cfg.minDrift + cfg.maxDrift) * 0.5 + 2.0;
      const cycleIdx = Math.floor(tLocal / slotPeriod);
      const tInSlot = tLocal - cycleIdx * slotPeriod;

      // Per-cycle deterministic drift duration (strictly within 2..5s) & pause (1..3s)
      const hDrift = hash2D(cycleIdx, tier * 7 + 1, cfg.seed);
      const hPause = hash2D(cycleIdx, tier * 7 + 2, cfg.seed);
      const driftDur = cfg.minDrift + hDrift * (cfg.maxDrift - cfg.minDrift);
      const pauseDur = 1.0 + hPause * 2.0;
      // Scale slot cleanly so active window is driftDur / (driftDur + pauseDur) of slotPeriod
      const activeDur = Math.min(driftDur, slotPeriod * (driftDur / (driftDur + pauseDur)));
      if (tInSlot > activeDur) continue; // quiet gap before next petal enters

      const u = koiClamp(tInSlot / Math.max(0.1, activeDur), 0, 1);

      // Compute off-screen entry on the outer edges of the top-right triangle
      // and off-screen exit on the outer edges of the bottom-left triangle
      const margin = (54 + tier * 26) * unit;
      const hSide = hash2D(cycleIdx, tier * 11 + 3, cfg.seed);
      const hPos = hash2D(cycleIdx, tier * 11 + 4, cfg.seed);
      const hAngle = (hash2D(cycleIdx, tier * 11 + 5, cfg.seed) - 0.5) * 0.22;

      let startX: number;
      let startY: number;
      if (hSide < 0.52) {
        // Enter along the TOP edge (top-right triangle: x in 32%..102% of width)
        startX = worldW * (0.32 + hPos * 0.70);
        startY = -margin;
      } else {
        // Enter along the RIGHT edge (top-right triangle: y in -2%..66% of height)
        startX = worldW + margin;
        startY = worldH * (-0.02 + hPos * 0.68);
      }

      // Diagonal wind vector heading down-left (approx 135 deg in screen coords, tilted to viewport aspect)
      const baseAngle = Math.atan2(worldH, -worldW) + hAngle;
      const dirX = Math.cos(baseAngle); // < 0
      const dirY = Math.sin(baseAngle); // > 0

      // Exact ray intersection with left edge (-margin) and bottom edge (worldH + margin)
      const tLeft = (-margin - startX) / Math.min(-0.05, dirX);
      const tBottom = (worldH + margin - startY) / Math.max(0.05, dirY);
      const travelDist = Math.min(tLeft, tBottom);

      // Gentle sinusoidal wind sway perpendicular to diagonal path
      const swayFreq = 1.6 + hash2D(cycleIdx, tier * 13 + 6, cfg.seed) * 1.1;
      const swayPhase = hash2D(cycleIdx, tier * 13 + 7, cfg.seed) * Math.PI * 2;
      const swayAmp = (14 + tier * 10) * unit;
      const sway = Math.sin(u * Math.PI * swayFreq + swayPhase) * swayAmp * Math.sin(u * Math.PI);

      const perpX = -dirY;
      const perpY = dirX;
      const px = startX + dirX * (travelDist * u) + perpX * sway;
      const py = startY + dirY * (travelDist * u) + perpY * sway;

      // Shrink smoothly from 100% size at entry to 80% size at exit (simulating falling toward pond)
      const fallScale = 1.0 - 0.20 * u;
      // Organic flutter tumble & rotation
      const rot0 = hash2D(cycleIdx, tier * 17 + 8, cfg.seed) * Math.PI * 2;
      const spinRate = (hash2D(cycleIdx, tier * 17 + 9, cfg.seed) > 0.5 ? 1 : -1) * (1.4 + hash2D(cycleIdx, tier * 17 + 10, cfg.seed) * 1.6);
      const rot = rot0 + u * spinRate;
      const tumbleY = 0.64 + 0.36 * Math.abs(Math.cos(u * Math.PI * (1.8 + tier * 0.35) + swayPhase));

      // Night moonlight opacity + subtle brightening near active lantern beam
      let nightBoost = 0;
      if (flashActive) {
        const fd = Math.hypot(px - this.flashX, py - this.flashY);
        if (fd < flashRadius) {
          nightBoost = (1.0 - fd / flashRadius) * (1.0 - this.flashlightDispersal) * 0.28;
        }
      }
      const alpha = koiClamp(cfg.baseAlpha * koiLerp(0.84 + nightBoost, 1.0, daylight), 0.25, 1.0);

      // Subtle blur sharpening as petal falls: cross-fade `near` (heavier bokeh) -> `far` (crisper)
      const nearWeight = 1.0 - u * 0.85;
      const farWeight = u * 0.85;

      const drawPair = (pair: { near: HTMLCanvasElement; far: HTMLCanvasElement }, layerAlpha: number) => {
        if (layerAlpha <= 0.005) return;
        if (nearWeight > 0.01) {
          ctx.globalAlpha = layerAlpha * nearWeight;
          ctx.drawImage(pair.near, -pair.near.width * 0.5, -pair.near.height * 0.5);
        }
        if (farWeight > 0.01) {
          ctx.globalAlpha = layerAlpha * farWeight;
          ctx.drawImage(pair.far, -pair.far.width * 0.5, -pair.far.height * 0.5);
        }
      };

      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(rot);
      ctx.scale(fallScale, fallScale * tumbleY);

      if (daylight >= 0.998) {
        drawPair(daySprites[tier], alpha);
      } else if (daylight <= 0.002) {
        drawPair(nightSprites[tier], alpha);
      } else {
        drawPair(daySprites[tier], alpha * daylight);
        drawPair(nightSprites[tier], alpha * (1.0 - daylight));
      }
      ctx.restore();
    }
    ctx.restore();
  }

  public render(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    world: PondWorld,
    time: number,
    config: KoiPondConfig
  ): void {
    this.updateTransition(performance.now());
    const rect = this.computePondRect(width, height, this.rectProgress);
    const effW = width;
    const effH = height;

    const skipPhysics = this.skipPhysicsStepOnce;
    this.skipPhysicsStepOnce = false;
    if (!skipPhysics) {
      this.updateFlashlightAndBotanicalState(width, height, world, effW, effH, time);
    }
    const daylight = this.getDaylightFactor();
    const isLight = daylight >= 0.35;

    if (daylight >= 0.998) {
      const parchmentDay = this.ensureParchmentCanvas(width, height, true);
      ctx.drawImage(parchmentDay, 0, 0, width, height);
    } else if (daylight <= 0.002) {
      const parchmentNight = this.ensureParchmentCanvas(width, height, false);
      ctx.drawImage(parchmentNight, 0, 0, width, height);
    } else {
      const parchmentDay = this.ensureParchmentCanvas(width, height, true);
      ctx.drawImage(parchmentDay, 0, 0, width, height);
      const parchmentNight = this.ensureParchmentCanvas(width, height, false);
      ctx.save();
      ctx.globalAlpha = 1.0 - daylight;
      ctx.drawImage(parchmentNight, 0, 0, width, height);
      ctx.restore();
    }

    // Always render the living pond layers (never go blank when the Profile Menu opens)
    ctx.save();
    if (config.showWaterTexture !== false) {
      this.paintSubmergedWaterWash(ctx, effW, effH, time, isLight);
    }

    // 1A. Underwater Stems Pass 1: Deep Stems (1/3 of stems drawn first at 62% opacity)
    this.paintUnderwaterStemsPass(ctx, effW, effH, time, isLight, this.artStyle, "deep");

    // 1B. Bed Obstacles: Submerged riverbed stones, moss cushions & sunken pond-bed Sakura painted directly over deep stems
    this.paintSubmergedFlora(ctx, effW, effH, time, isLight, this.artStyle);
    this.paintSunkenSakuraOnBed(ctx, effW, effH, time, isLight, this.artStyle);

    // 2. Continuous-gradient underwater floor shadows
    this.paintUnderwaterFloorShadows(ctx, world, effW, effH, time, isLight, this.artStyle);

    // 2B. Underwater Stems Pass 2 & Pass 3: Surface Stems (drawn over the stones) & Lateral Buds (pedicels with closed buds / coiled scrolls)
    this.paintUnderwaterStemsPass(ctx, effW, effH, time, isLight, this.artStyle, "surface-and-buds");

    // Smooth twilight riverbed deepening bell curve (0.0 at both full day and full night — zero snap!)
    if (daylight > 0.001 && daylight < 0.999) {
      const twilightBell = Math.sin(daylight * Math.PI);
      const bedDarkness = twilightBell * 0.24;
      ctx.fillStyle = `rgba(8, 6, 4, ${bedDarkness.toFixed(3)})`;
      ctx.fillRect(0, 0, effW, effH);
    }

    // 3. Pond food and Z-Stratified Living Koi Fishes
    this.paintHandBrushedRipples(ctx, world, isLight);
    this.paintPondFood(ctx, world.food, time, isLight);

    for (let i = 0; i < world.koi.length; i++) {
      this.paintLivingKoi(ctx, world.koi[i], isLight, config.showScales !== false);
    }

    // 4. WebGL Caustics & Interactive Single-Ring Click Ripples
    this.paintWaterCausticsAndWaves(
      ctx,
      world,
      effW,
      effH,
      width,
      height,
      rect,
      time,
      isLight,
      this.artStyle
    );
    this.paintHandBrushedRipples(ctx, world, isLight);

    // 5. Surface & overhanging botanical layers
    this.paintLotusPads(ctx, effW, effH, time, isLight);
    this.paintAquaticFlora(ctx, effW, effH, time, isLight, this.artStyle);
    this.paintSunlightAndReflections(ctx, effW, effH, time, isLight, this.artStyle);

    // 6. Floating Water-Surface Sakura Flowers & Petals + Daytime Dragonflies (Morning & Noon)
    this.paintOverhangingSakuraCanopy(ctx, world, effW, effH, time, isLight, this.artStyle, skipPhysics);
    this.paintDaytimeDragonflies(ctx, effW, effH, time, isLight, this.artStyle, skipPhysics);

    // Smooth twilight veil bell curve (0.0 at both full day and full night — zero snap into night!)
    if (daylight > 0.001 && daylight < 0.999) {
      const twilightBell = Math.sin(daylight * Math.PI);
      const duskDarkness = twilightBell * 0.14;
      ctx.fillStyle = `rgba(8, 6, 4, ${duskDarkness.toFixed(3)})`;
      ctx.fillRect(0, 0, effW, effH);
    }

    // 7. Evening Sunset Fireflies (*Hotaru*) with subtle halos and faint reflections on stones, KOIs, maples, sakura & lily pads
    this.paintEveningFirefliesAndReflections(
      ctx,
      world,
      effW,
      effH,
      time,
      isLight,
      this.artStyle
    );

    // 8. Foreground Airborne DOF-Blurred Sakura Petals (max 3 of different sizes, top-right -> bottom-left, 100% -> 80% scale)
    this.paintAirborneDofSakuraPetals(ctx, effW, effH, time, this.artStyle);
    ctx.restore();

    // When the Profile Menu opens, blur the pond background instead of blanking it,
    // then render opaque column backings (in Dark Mode) and the sharp left portrait frame on top
    if (this.rectProgress > 0.002) {
      const effectiveBlur = this.menuBlurPx * this.rectProgress;
      if (effectiveBlur > 0.15) {
        this.applyPondBlurInPlace(ctx, width, height, effectiveBlur);
      }

      if (daylight < 0.995 && this.activeColumnRects.length > 0) {
        ctx.save();
        const colDarkAlpha = (1.0 - daylight) * (this.rippleReducedMotion ? this.rectProgress : 1.0);
        ctx.globalAlpha = colDarkAlpha;
        if (this.rectProgress < 0.999 && !this.rippleReducedMotion) {
          const colsBounds = this.computeColumnsStageBounds(width, height);
          const colsOrigin = computeVirtualCenter(colsBounds);
          const tileSize = computeAlignedTileSize(
            this.rippleCellW,
            this.rippleCellH,
            width,
            height,
            this.rippleQualityLevel
          );
          const rippleCfg = buildRippleFieldConfig(
            this.rectProgress,
            colsOrigin,
            colsBounds,
            tileSize,
            false
          );
          ctx.beginPath();
          ctx.arc(
            colsOrigin.x,
            colsOrigin.y,
            Math.max(0, rippleCfg.ringRadiusPx),
            0,
            Math.PI * 2
          );
          ctx.clip();
        }
        ctx.fillStyle = "#050403";
        for (let i = 0; i < this.activeColumnRects.length; i++) {
          const cr = this.activeColumnRects[i];
          ctx.fillRect(cr.x, cr.y, cr.w, cr.h);
        }
        ctx.restore();
      }

      const frameRect = this.computeLeftFrameRect(width, height, this.rectProgress);
      this.paintRedKoiBoundingBorder(ctx, frameRect, width, height);
    }

    this.paintDarkFlashlightVeil(ctx, width, height);
  }
}

function viewportHOrDefault(h: number): number {
  return h > 0 ? h : 900;
}
