import type { Theme, ThemePreference } from './types/state.ts'

/** Resolve a stored preference to the concrete theme the UI should render. */
export function resolveThemeFromPreference(
  preference: ThemePreference,
  prefersDark: boolean,
): Theme {
  if (preference === 'light' || preference === 'dark') return preference
  return prefersDark ? 'dark' : 'light'
}

/** BrowserWindow `backgroundColor` for each resolved theme (matches tokens.css surfaces). */
export const THEME_BACKGROUND: Record<Theme, string> = {
  dark: '#1e1e1e',
  light: '#ffffff',
}
