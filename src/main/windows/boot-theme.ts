import { nativeTheme } from 'electron'
import { DEFAULT_THEME_PREFERENCE, isThemePreference, type Theme } from '@shared/types/state.ts'
import { resolveThemeFromPreference, THEME_BACKGROUND } from '@shared/theme.ts'
import { getSetting } from '../services/storage/settings.ts'

/** Read the persisted theme preference and resolve it before the renderer paints. */
export function readBootTheme(): Theme {
  const saved = getSetting<string>('theme', DEFAULT_THEME_PREFERENCE)
  const preference = isThemePreference(saved) ? saved : DEFAULT_THEME_PREFERENCE
  return resolveThemeFromPreference(preference, nativeTheme.shouldUseDarkColors)
}

export function bootThemeWindowOptions(): { backgroundColor: string; query: { t: Theme } } {
  const theme = readBootTheme()
  return { backgroundColor: THEME_BACKGROUND[theme], query: { t: theme } }
}
