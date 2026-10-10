import { DEVELOPER_MODE_SETTING } from '@shared/developer-mode.ts'
import {
  APPEARANCE_DEFAULTS_MIGRATION_SETTING,
  APPEARANCE_DEFAULTS_MIGRATION_VERSION,
  migrateLegacyAppearanceDefaults,
} from '@shared/appearance.ts'
import type { ApiClient } from '../../preload/api.d.ts'

/** One-time marker: concise threads became default-on and a stored `false` was cleared. */
export const CONCISE_THREADS_DEFAULT_MIGRATION_SETTING = 'conciseThreadsDefaultMigrated'

export interface StartupSettings {
  model: unknown
  layout: unknown
  autoPortraitRightPanel: unknown
  rightPanelPosition: unknown
  sidebarThreadSort: unknown
  sidebarThreadSortReverse: unknown
  sidebarThreadGroup: unknown
  openLinksInBuiltInBrowser: unknown
  theme: unknown
  fontSize: unknown
  animateAgentAvatars: unknown
  conciseThreadsEnabled: unknown
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
    sidebarThreadSort,
    sidebarThreadSortReverse,
    sidebarThreadGroup,
    openLinksInBuiltInBrowser,
    theme,
    fontSize,
    animateAgentAvatars,
    conciseThreadsEnabled,
    uiScale,
    uiAccentColor,
    uiTintColor,
    uiTintStrength,
    developerMode,
    appearanceDefaultsMigrationVersion,
    conciseThreadsDefaultMigrated,
  ] = await Promise.all([
    settings.get('model'),
    settings.get('layout'),
    settings.get('autoPortraitRightPanel'),
    settings.get('rightPanelPosition'),
    settings.get('sidebarThreadSort'),
    settings.get('sidebarThreadSortReverse'),
    settings.get('sidebarThreadGroup'),
    settings.get('openLinksInBuiltInBrowser'),
    settings.get('theme'),
    settings.get('fontSize'),
    settings.get('animateAgentAvatars'),
    settings.get('conciseThreadsEnabled'),
    settings.get('uiScale'),
    settings.get('uiAccentColor'),
    settings.get('uiTintColor'),
    settings.get('uiTintStrength'),
    settings.get(DEVELOPER_MODE_SETTING),
    settings.get(APPEARANCE_DEFAULTS_MIGRATION_SETTING),
    settings.get(CONCISE_THREADS_DEFAULT_MIGRATION_SETTING),
  ])

  const unmigrated: StartupSettings = {
    model,
    layout,
    autoPortraitRightPanel,
    rightPanelPosition,
    sidebarThreadSort,
    sidebarThreadSortReverse,
    sidebarThreadGroup,
    openLinksInBuiltInBrowser,
    theme,
    fontSize,
    animateAgentAvatars,
    conciseThreadsEnabled,
    uiScale,
    uiAccentColor,
    uiTintColor,
    uiTintStrength,
    developerMode,
  }

  // Before the default flipped, the Settings dialog saved every field, so a
  // stored `false` is as likely to be an untouched default as a choice. Clear it
  // once; the marker keeps any later opt-out the user's own.
  let loaded = unmigrated
  if (conciseThreadsDefaultMigrated !== true) {
    if (unmigrated.conciseThreadsEnabled === false) {
      await settings.set('conciseThreadsEnabled', true)
      loaded = { ...unmigrated, conciseThreadsEnabled: true }
    }
    await settings.set(CONCISE_THREADS_DEFAULT_MIGRATION_SETTING, true)
  }

  if (appearanceDefaultsMigrationVersion === APPEARANCE_DEFAULTS_MIGRATION_VERSION) {
    return loaded
  }

  const migratedAppearance = migrateLegacyAppearanceDefaults(loaded)
  if (!migratedAppearance) {
    await settings.set(APPEARANCE_DEFAULTS_MIGRATION_SETTING, APPEARANCE_DEFAULTS_MIGRATION_VERSION)
    return loaded
  }

  await Promise.all([
    settings.set('theme', migratedAppearance.theme),
    settings.set('uiAccentColor', migratedAppearance.uiAccentColor),
    settings.set('uiTintColor', migratedAppearance.uiTintColor),
    settings.set('uiTintStrength', migratedAppearance.uiTintStrength),
  ])
  await settings.set(APPEARANCE_DEFAULTS_MIGRATION_SETTING, APPEARANCE_DEFAULTS_MIGRATION_VERSION)

  return { ...loaded, ...migratedAppearance }
}
