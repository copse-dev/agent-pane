/** Default interface scale (100%). Matches `:root { --ui-scale: 1 }` in tokens.css. */
export const DEFAULT_UI_SCALE = 1

/** Smallest allowed interface scale (75%). */
export const UI_SCALE_MIN = 0.75

/** Largest allowed interface scale (150%). */
export const UI_SCALE_MAX = 1.5

/** Step used by ⌘+/- / pinch / menu Zoom In·Out. */
export const UI_SCALE_STEP = 0.1

/**
 * Clamp and snap a raw scale to two decimal places within
 * [`UI_SCALE_MIN`, `UI_SCALE_MAX`].
 */
export function clampUiScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_UI_SCALE
  const clamped = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, value))
  return Math.round(clamped * 100) / 100
}

/** Coerce an unknown settings value to a valid uiScale, else the default. */
export function normalizeUiScale(value: unknown): number {
  return typeof value === 'number' ? clampUiScale(value) : DEFAULT_UI_SCALE
}

/** Step the current scale up (`+1`) or down (`-1`) by `UI_SCALE_STEP`. */
export function stepUiScale(current: number, direction: 1 | -1): number {
  return clampUiScale(clampUiScale(current) + direction * UI_SCALE_STEP)
}

/** Monaco / xterm pixel size after applying the interface scale. */
export function scaledEditorFontSize(fontSize: number, uiScale: number): number {
  const size = Number.isFinite(fontSize) ? fontSize : 14
  return Math.max(8, Math.round(size * clampUiScale(uiScale)))
}
