export interface LayoutState {
  projectsPaneWidth: number
  filesPaneWidth: number
  filesPaneHeight: number
  fileTreeWidth: number
}

export const DEFAULT_LAYOUT: LayoutState = {
  projectsPaneWidth: 240,
  filesPaneWidth: 480,
  filesPaneHeight: 360,
  fileTreeWidth: 200,
}

export const LAYOUT_LIMITS = {
  projects: { min: 180, max: 400 },
  files: { min: 300, maxRatio: 0.7 },
  filesStacked: { min: 220, maxRatio: 0.75 },
  tree: { min: 120, max: 400 },
} as const
