export type PortfolioLayerId = "mokkotsu" | "sumie";

export interface SharedPortfolioState {
  isLightMode: boolean;
  isPortfolioOpen: boolean;
  expandedColumnIndex: number | null;
  activeProjectTopic: number | null;
  isFlashlightEnabled?: boolean;
  menuBlurPx?: number;
  timeOfDayHours?: number;
  manualThemeOverride?: boolean | null;
}
