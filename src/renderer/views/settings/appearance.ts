import { DEFAULT_TINT_STRENGTH, isUiTintStrength, type UiTintStrength } from '@shared/appearance.ts'
export {
  DEFAULT_ACCENT_COLOR,
  DEFAULT_TINT_COLOR,
  DEFAULT_TINT_STRENGTH,
  isUiTintStrength,
  type UiTintStrength,
} from '@shared/appearance.ts'

/**
 * Whole-app tint (Appearance ▸ Interface tint). The hue is mixed into every
 * neutral surface at a strength that maps to a percentage; `off` disables it.
 * Applied by writing --tint-hue / --tint-amount on the document root, which
 * tokens.css folds into every --bg-* surface (see its --tint-* comment).
 */
const COPSE_SITE_TINT_COLOR = '#002E2B'
const TINT_STRENGTH_AMOUNTS: Record<UiTintStrength, string> = {
  off: '0%',
  subtle: '4%',
  medium: '8%',
  strong: '16%',
}
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

// The tint-strength slider snaps to these ordered levels (index = 0..3).
const UI_TINT_STRENGTHS: readonly UiTintStrength[] = ['off', 'subtle', 'medium', 'strong']
export const TINT_STRENGTH_LABELS: Record<UiTintStrength, string> = {
  off: 'Off',
  subtle: 'Subtle',
  medium: 'Medium',
  strong: 'Strong',
}

/** Map a slider value (or an already-internal strength string) to a strength. */
export function tintStrengthFromValue(value: unknown): UiTintStrength {
  if (isUiTintStrength(value)) return value
  const index = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  return UI_TINT_STRENGTHS[index] ?? DEFAULT_TINT_STRENGTH
}

/** Map a strength back to the slider's current numeric value. */
export function tintSliderIndex(strength: UiTintStrength): number {
  const index = UI_TINT_STRENGTHS.indexOf(strength)
  return index >= 0 ? index : UI_TINT_STRENGTHS.indexOf(DEFAULT_TINT_STRENGTH)
}

function accentTextColor(color: string): '#444444' | '#ffffff' {
  const linearChannel = (offset: number): number => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }
  const red = linearChannel(1)
  const green = linearChannel(3)
  const blue = linearChannel(5)
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
  return luminance > 0.179 ? '#444444' : '#ffffff'
}

/** Apply the interaction hue and keep text on solid accent fills readable. */
export function applyUiAccent(color: string): void {
  if (!HEX_COLOR.test(color)) return
  const root = document.documentElement
  root.style.setProperty('--accent-color', color)
  root.style.setProperty('--text-on-accent', accentTextColor(color))
}

/** Push the tint onto the document root so every surface picks it up at once. */
export function applyUiTint(color: string, strength: UiTintStrength): void {
  const root = document.documentElement
  if (HEX_COLOR.test(color)) {
    root.style.setProperty('--tint-hue', color)
    root.dataset['tintPalette'] =
      color.toLowerCase() === COPSE_SITE_TINT_COLOR.toLowerCase() ? 'copse' : 'custom'
  }
  root.dataset['tintStrength'] = strength
  root.style.setProperty('--tint-amount', TINT_STRENGTH_AMOUNTS[strength])
}

/**
 * Single source of truth for the simple form fields, so each setting's default
 * is declared once instead of being duplicated across the load and save handlers
 * (an open default-drift bug class). Fields needing bespoke wiring (model select,
 * theme/fontSize from the store, app icon radios, the LM Studio security bundle
 * saved via `setSecurity`) stay hand-coded below.
 *
 * `kind: 'checkbox'` reads/writes `.checked`; `'text'` reads/writes `.value`.
 * `save: true` means the field round-trips through `api.settings.set(name, …)`
 * symmetrically; security-bundle fields set `save: false` (loaded here, saved by
 * the `setSecurity` call) so their defaults are still declared in one place.
 */
