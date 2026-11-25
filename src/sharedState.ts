export type PortfolioLayerId = "mokkotsu" | "sumie";

export interface SharedPortfolioState {
  isLightMode: boolean;
  isPortfolioOpen: boolean;
  expandedColumnIndex: number | null;
  activeProjectTopic: number | null;
  isGalleryOpen?: boolean;
  galleryScrollTop?: number;
  activeGalleryItemIndex?: number | null;
  activeGallerySlideIndex?: number;
  isFlashlightEnabled?: boolean;
  menuBlurPx?: number;
  timeOfDayHours?: number;
  manualThemeOverride?: boolean | null;
}
