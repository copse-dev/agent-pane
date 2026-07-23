/** Whole-interface scale multiplier (CSS tokens + editor/terminal fonts). */
export const DEFAULT_UI_SCALE = 1
export const UI_SCALE_MIN = 0.85
export const UI_SCALE_MAX = 1.35
export const UI_SCALE_STEP = 0.05

export function clampUiScale(value: number): number {
  const stepped = Math.round(value / UI_SCALE_STEP) * UI_SCALE_STEP
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, stepped))
}

export function parseUiScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_UI_SCALE
  return clampUiScale(value)
}

export function stepUiScale(current: number, direction: 'in' | 'out' | 'reset'): number {
  if (direction === 'reset') return DEFAULT_UI_SCALE
  const delta = direction === 'in' ? UI_SCALE_STEP : -UI_SCALE_STEP
  return clampUiScale(current + delta)
}

export function scaledEditorFontSize(fontSize: number, uiScale: number): number {
  return Math.round(fontSize * uiScale)
}

export function uiScaleLabel(scale: number): string {
  return `${String(Math.round(scale * 100))}%`
}
