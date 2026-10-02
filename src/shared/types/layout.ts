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
  // In the side-by-side layout this ratio applies to the width left after the
  // Projects pane, so chat always keeps at least one third of the shared area.
  files: { min: 300, maxRatio: 2 / 3 },
  // Panel opens at a third of the window's height in the stacked (vertical)
  // layout until the user drags it to a different size.
  filesStacked: { min: 220, maxRatio: 0.75, defaultRatio: 1 / 3 },
  tree: { min: 120, max: 400 },
} as const
