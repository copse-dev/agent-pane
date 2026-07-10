import type { Theme, ThemePreference } from '@shared/types/state.ts'

/** The OS "dark mode" media query, read live each call (cheap, and avoids
 *  caching a stale MediaQueryList across pop-out windows). */
function prefersDark(): MediaQueryList {
  return window.matchMedia('(prefers-color-scheme: dark)')
}

/** Resolve a stored preference to the concrete theme the UI should render.
 *  `system` follows the OS; `light`/`dark` pass through. */
export function resolveTheme(preference: ThemePreference): Theme {
  if (preference === 'light' || preference === 'dark') return preference
  return prefersDark().matches ? 'dark' : 'light'
}

/** Reflect the effective theme on <html> so tokens.css / themes.css apply. */
export function applyThemeToDocument(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme
}

/**
 * Live-track the OS colour scheme. `onChange` fires with the newly resolved
 * theme only while the current preference (read fresh via `getPreference`, so
 * it reflects later Settings changes) is `system`. Pinned light/dark ignore the
 * OS entirely.
 */
export function watchSystemTheme(
  getPreference: () => ThemePreference,
  onChange: (theme: Theme) => void,
): void {
  prefersDark().addEventListener('change', (event) => {
    if (getPreference() !== 'system') return
    onChange(event.matches ? 'dark' : 'light')
  })
}
