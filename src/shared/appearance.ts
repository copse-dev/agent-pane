import { DEFAULT_THEME_PREFERENCE, type ThemePreference } from './types/state.ts'

export type UiTintStrength = 'off' | 'subtle' | 'medium' | 'strong'

export const DEFAULT_ACCENT_COLOR = '#FF93D0'
export const DEFAULT_TINT_COLOR = '#244C25'
export const DEFAULT_TINT_STRENGTH: UiTintStrength = 'subtle'

interface StoredAppearance {
  theme: unknown
  uiAccentColor: unknown
  uiTintColor: unknown
  uiTintStrength: unknown
}

export interface MigratedAppearance {
  theme: ThemePreference
  uiAccentColor: string
  uiTintColor: string
  uiTintStrength: UiTintStrength
}

const LEGACY_DEFAULTS = {
  theme: 'system',
  uiAccentColor: '#20FD85',
  uiTintColor: '#002E2B',
  uiTintStrength: 'subtle',
} as const

function sameHex(value: unknown, expected: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === expected.toLowerCase()
}

/**
 * Upgrade only the complete Appearance default tuple shipped before #1469.
 * Requiring every legacy value keeps any user-customised combination intact.
 */
export function migrateLegacyAppearanceDefaults(
  stored: StoredAppearance,
): MigratedAppearance | null {
  if (
    stored.theme !== LEGACY_DEFAULTS.theme ||
    !sameHex(stored.uiAccentColor, LEGACY_DEFAULTS.uiAccentColor) ||
    !sameHex(stored.uiTintColor, LEGACY_DEFAULTS.uiTintColor) ||
    stored.uiTintStrength !== LEGACY_DEFAULTS.uiTintStrength
  ) {
    return null
  }

  return {
    theme: DEFAULT_THEME_PREFERENCE,
    uiAccentColor: DEFAULT_ACCENT_COLOR,
    uiTintColor: DEFAULT_TINT_COLOR,
    uiTintStrength: DEFAULT_TINT_STRENGTH,
  }
}

export function isUiTintStrength(value: unknown): value is UiTintStrength {
  return value === 'off' || value === 'subtle' || value === 'medium' || value === 'strong'
}
