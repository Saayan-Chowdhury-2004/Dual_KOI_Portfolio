export { KoiPondEngine } from "./engine";
export {
  BrutalistPortfolioUI,
  computeDynamicAgeBreakdown,
  type DynamicAgeBreakdown,
  type InteractiveElementBounds,
} from "./portfolioColumns";
export {
  SUBJECT_PROFILE,
  EXPERIENCE_ITEMS,
  EDUCATION_ITEMS,
  SKILL_CATEGORIES,
  PROJECT_TOPICS,
  CONTACT_CHANNELS,
} from "./portfolioData";
export {
  KoiPondRenderer,
  KOI_ART_STYLES,
  type KoiArtStyle,
  type KoiArtStyleMeta,
} from "./koiRenderer";
export { PondWorld } from "./pondWorld";
export { POND_PALETTES } from "./koiPond";
export { KOI_VARIETIES, VARIETY_ORDER } from "./koiVarieties";
export type { KoiSpec, KoiVariety, KoiFish, KoiPondConfig, PondFish } from "./koiTypes";
export {
  CAUDAL_FIN_CONFIG,
  CaudalFinScratchBuffer,
  computeCaudalFin,
  traceCaudalFinPath,
  strokeCaudalFinRays,
} from "./caudalFin";

export { GalleryScrollUI } from "./galleryScroll";
export { GALLERY_SCROLL_ITEMS, type GalleryScrollItem } from "./galleryData";
