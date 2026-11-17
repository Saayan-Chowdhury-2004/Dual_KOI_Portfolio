/**
 * Core configuration, variety definitions, and simulation state interfaces
 * for the koi pond engine of this portfolio.
 */

export type KoiVariety =
  | 'kohaku'
  | 'sanke'
  | 'showa';

export type PondThemeName = 'black-pond' | 'light-pond';

export type DetailQuality = 'low' | 'medium' | 'high';

export interface KoiSpec {
  variety?: KoiVariety;
  /** Relative size multiplier (default: 3.28 to 4.41) */
  size?: number;
  /** Optional deterministic seed for reproducible markings */
  seed?: number;
}

export interface PondPalette {
  name: PondThemeName;
  label: string;
  background: string;
  backgroundSecondary: string;
  waterBase: string;
  waterShimmer: string;
  waterRipple: string;
  waterWake: string;
  shadowColor: string;
  isLight: boolean;
  /** Whether to draw the topographic canopy terrain glyphs (both themes; celadon in light, deep green-teal in dark) */
  terrain: boolean;
  /** Sparse dim caustic motes drifting in the open water */
  causticMotes: boolean;
}

export interface KoiPondConfig {
  /** Number of koi swimming in the pond */
  fishCount: number;
  /** Minimum relative fish size multiplier */
  minSize: number;
  /** Maximum relative fish size multiplier */
  maxSize: number;
  /** Global animation & swimming speed multiplier */
  animationSpeed: number;
  /** Character cell width in CSS pixels */
  cellWidth: number;
  /** Character cell height in CSS pixels */
  cellHeight: number;
  /** Supersampling and scale/fin-ray detail level */
  detailQuality: DetailQuality;
  /** Active pond colour theme */
  pondTheme: PondThemeName;
  /** Custom background override (optional hex string) */
  customBackground?: string;
  /** Pointer & click interaction sensitivity from 0.0 to 2.0 */
  interactionSensitivity: number;
  /** Whether to show subtle scale crescents on larger fish */
  showScales: boolean;
  /** Whether to show ambient water texture & ripples */
  showWaterTexture: boolean;
  /** Respect OS prefers-reduced-motion setting */
  respectReducedMotion: boolean;
  /** Optional explicit list of koi specs to spawn */
  fishSpecs?: KoiSpec[];
}

export interface SpineNode {
  x: number;
  y: number;
  /** Tangent unit vector X */
  tx: number;
  /** Tangent unit vector Y */
  ty: number;
  /** Normal unit vector X (-ty) */
  nx: number;
  /** Normal unit vector Y (tx) */
  ny: number;
  /** Normalized longitudinal coordinate s in [0, 1] */
  s: number;
  /** World-space half-width at this spine node */
  halfWidth: number;
}

export interface OrganicPatch {
  /** Longitudinal center in [0.05, 0.85] */
  sCenter: number;
  /** Lateral center in [-0.85, 0.85] */
  uCenter: number;
  /** Longitudinal radius */
  sRadius: number;
  /** Lateral radius */
  uRadius: number;
  /** Domain-warping frequency */
  warpFreq: number;
  /** Domain-warping amplitude */
  warpAmp: number;
  /** Phase offset for organic lobe deformation */
  phase: number;
  /** Layer type: 'hi' (red/orange), 'sumi' (black), or 'shiro' (white patch on Showa) */
  layer: 'hi' | 'sumi' | 'shiro';
}

export type SwimMode = 'cruise' | 'glide' | 'accelerate';

/** What a koi is currently doing. Each koi rolls the next one from its own personality weights. */
export type KoiBehavior = 'cruise' | 'loiter' | 'drift' | 'trail';

/** Floating food pellet dropped by clicking/tapping on the pond. */
export interface PondFoodPellet {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  age: number;
  maxAge: number;
  phase: number;
  seed: number;
  active: boolean;
}

/** Per-koi steering state: current goal, personality, smoothed avoidance, and fluid attention. */
export interface KoiBrain {
  behavior: KoiBehavior;
  /** Current waypoint (cruise) in world px */
  targetX: number;
  targetY: number;
  /** Seconds since the current waypoint was chosen */
  targetAge: number;
  /** Speed requested by the behavior as a fraction of baseCruiseSpeed */
  speedFactor: number;
  /** Loiter orbit centre, radius and sense (+1 = heading angle increasing) */
  orbitX: number;
  orbitY: number;
  orbitRadius: number;
  orbitDir: 1 | -1;
  /** Trail: id of the koi being followed and which flank to hold */
  followId: number;
  followSide: 1 | -1;
  /** Drift / weave: phase of the slow heading wander */
  wanderPhase: number;
  /** Smoothed heading bias (rad) applied while giving way to another koi */
  avoidBias: number;
  /** Seconds spent giving way in a row; long values force a change of plan */
  blockedTime: number;
  /** Personal appetite for each behavior */
  weights: Record<KoiBehavior, number>;
  /** Preferred region of the pond (normalized 0..1) so the four koi spread out */
  homeX: number;
  homeY: number;
  /** Deterministic per-koi random source */
  rng: () => number;

  /** Smoothly ramped attention blend weight [0..1] for cursor curiosity or food attraction */
  attentionWeight: number;
  /** Reaction delay (s) before a newly noticed stimulus begins curving the koi's course */
  perceptionDelay: number;
  /** Low-pass filtered perceived stimulus coordinates so fast cursor moves never jerk the fish */
  perceivedX: number;
  perceivedY: number;
  /** Whether perceivedX/Y have been seeded */
  hasPerceivedTarget: boolean;
  /** Tangential arc approach sense (+1 or -1) so approaches curve naturally rather than arrowing straight */
  approachSign: 1 | -1;
  /** ID of the specific food pellet this koi is currently curving toward (0 if none) */
  foodTargetId: number;
}

export interface KoiFish {
  id: number;
  name: string;
  variety: KoiVariety;
  varietyLabel: string;
  varietyJapanese: string;
  seed: number;
  /** Size multiplier (3.28 - 4.41) */
  size: number;
  /** Total spine length in world/pixel units */
  bodyLength: number;
  /** Maximum half-width in world/pixel units */
  maxHalfWidth: number;
  /** Individual body girth factor */
  girthFactor: number;
  /** Individual fin span multiplier */
  finSpanFactor: number;
  /** Individual tail lobe length multiplier */
  tailLengthFactor: number;

  /** Head world position */
  x: number;
  y: number;
  /** Current swimming heading in radians */
  angle: number;
  /** Smoothed angular velocity (rad/s) */
  turnRate: number;
  /** Smoothed body curvature for fin/tail articulation */
  curvature: number;
  /** Current linear speed (px/s) */
  speed: number;
  /** Target cruise speed (px/s) */
  baseCruiseSpeed: number;
  /** Right-of-way speed multiplier [0.0..1.18] to let another koi pass without overlap */
  yieldMultiplier: number;
  /** Current locomotive state */
  swimMode: SwimMode;
  /** Remaining time in current locomotive state (seconds) */
  modeTimer: number;

  /** Goal-driven steering state (replaces the old fixed figure-eight path) */
  brain: KoiBrain;
  /** Ring buffer of past head positions; the body follows this trail */
  trailX: Float32Array;
  trailY: Float32Array;
  /** Index of the newest stored trail point */
  trailHead: number;
  /** Number of valid trail points */
  trailCount: number;

  /** Travelling wave phase (radians) */
  phase: number;
  /** Pectoral fin flutter phase (radians) */
  finPhase: number;
  /** Reaction boost from nearby click ripple */
  startleBoost: number;

  /** Preallocated 20 spine nodes in world coordinates */
  spine: SpineNode[];
  /** Rest spine nodes sampled from the head trail behind the snout */
  restSpineX: Float32Array;
  restSpineY: Float32Array;

  /** Pre-generated organic dorsal markings in fish-local (s, u) space */
  patches: OrganicPatch[];
  /** Variety-specific color tones */
  colors: {
    baseHex: string;
    baseRgb: [number, number, number];
    hiHex: string;
    hiRgb: [number, number, number];
    sumiHex: string;
    sumiRgb: [number, number, number];
    shiroHex: string;
    shiroRgb: [number, number, number];
    finHex: string;
    finRgb: [number, number, number];
    hasMotoguro: boolean;
  };

  /** World-space axis-aligned bounding box updated each frame */
  bbox: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
}

export interface PondRipple {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  strength: number;
  speed: number;
  active: boolean;
}

export type PartKind =
  | 'none'
  | 'shadow'
  | 'body'
  | 'head'
  | 'pectoral-fin'
  | 'dorsal-fin'
  | 'pelvic-fin'
  | 'caudal-fin';

export interface SampleHit {
  part: PartKind;
  /** Coverage / opacity weight [0..1] */
  coverage: number;
  /** Longitudinal fish coordinate s */
  s: number;
  /** Normalized lateral coordinate u in [-1..1] */
  u: number;
  /** Local 3D dorsal shading intensity [0..1] */
  shade: number;
  /** World-space feature direction angle (for fin rays / scales) */
  rayAngle: number;
  /** Radial position along fin span [0..1] */
  finSpanU: number;
  /** Chordwise position along fin [0..1] */
  finChordV: number;
}

/** One small schooling pond fish (medaka minnow) drawn as a single glyph cell. */
export interface PondFish {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Tail-beat / shimmer phase. */
  phase: number;
  /** 0 calm -> 1 scattering. Spreads to neighbours. */
  alarm: number;
  /** Smoothed angular velocity (rad/s); hard turns flash silver. */
  turn: number;
  /** 0.55 far/dim -> 1 near/bright. */
  depth: number;
  /** Rotation sense shared by a school when it mills gently. */
  millDir: 1 | -1;
  /** Cell column/row cached by the renderer for fast glyph lookup. */
  col: number;
  row: number;
}
