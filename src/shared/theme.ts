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

/** Passed from main → preload so the renderer paints the saved theme before boot(). */
export const BOOT_THEME_ARG_PREFIX = '--copse-boot-theme='

export function bootThemeArgument(theme: Theme): string {
  return `${BOOT_THEME_ARG_PREFIX}${theme}`
}

export function parseBootThemeArgument(argv: readonly string[]): Theme | null {
  const arg = argv.find((entry) => entry.startsWith(BOOT_THEME_ARG_PREFIX))
  const theme = arg?.slice(BOOT_THEME_ARG_PREFIX.length)
  return theme === 'light' || theme === 'dark' ? theme : null
}
