import { DEVELOPER_MODE_SETTING } from '@shared/developer-mode.ts'
import { migrateLegacyAppearanceDefaults } from '@shared/appearance.ts'
import type { ApiClient } from '../../preload/api.d.ts'

export interface StartupSettings {
  model: unknown
  layout: unknown
  autoPortraitRightPanel: unknown
  rightPanelPosition: unknown
  openLinksInBuiltInBrowser: unknown
  theme: unknown
  fontSize: unknown
  uiScale: unknown
  uiAccentColor: unknown
  uiTintColor: unknown
  uiTintStrength: unknown
  developerMode: unknown
}

/**
 * Read the preferences needed for first paint in one IPC flight.
 *
 * These values are independent. Keeping the fan-out in one tested helper avoids
 * adding another full renderer/main round trip to startup whenever a visual
 * preference is introduced.
 */
export async function loadStartupSettings(
  settings: Pick<ApiClient['settings'], 'get' | 'set'>,
): Promise<StartupSettings> {
  const [
    model,
    layout,
    autoPortraitRightPanel,
    rightPanelPosition,
    openLinksInBuiltInBrowser,
    theme,
    fontSize,
    uiScale,
    uiAccentColor,
    uiTintColor,
    uiTintStrength,
    developerMode,
  ] = await Promise.all([
    settings.get('model'),
    settings.get('layout'),
    settings.get('autoPortraitRightPanel'),
    settings.get('rightPanelPosition'),
    settings.get('openLinksInBuiltInBrowser'),
    settings.get('theme'),
    settings.get('fontSize'),
    settings.get('uiScale'),
    settings.get('uiAccentColor'),
    settings.get('uiTintColor'),
    settings.get('uiTintStrength'),
    settings.get(DEVELOPER_MODE_SETTING),
  ])

  const loaded: StartupSettings = {
    model,
    layout,
    autoPortraitRightPanel,
    rightPanelPosition,
    openLinksInBuiltInBrowser,
    theme,
    fontSize,
    uiScale,
    uiAccentColor,
    uiTintColor,
    uiTintStrength,
    developerMode,
  }

  const migratedAppearance = migrateLegacyAppearanceDefaults(loaded)
  if (!migratedAppearance) return loaded

  await Promise.all([
    settings.set('theme', migratedAppearance.theme),
    settings.set('uiAccentColor', migratedAppearance.uiAccentColor),
    settings.set('uiTintColor', migratedAppearance.uiTintColor),
    settings.set('uiTintStrength', migratedAppearance.uiTintStrength),
  ])

  return { ...loaded, ...migratedAppearance }
}
