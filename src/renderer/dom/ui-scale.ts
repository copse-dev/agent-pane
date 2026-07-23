import { clampUiScale, DEFAULT_UI_SCALE } from '@shared/ui-scale.ts'

/** Push interface scale onto the document root (`tokens.css` reads `--ui-scale`). */
export function applyUiScale(scale: number): void {
  document.documentElement.style.setProperty('--ui-scale', String(clampUiScale(scale)))
}

export function readAppliedUiScale(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim()
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? clampUiScale(parsed) : DEFAULT_UI_SCALE
}
