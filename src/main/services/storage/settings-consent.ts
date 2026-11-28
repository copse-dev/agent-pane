/** Settings that only affect local presentation and notifications. */
const PRESENTATION_SETTINGS = new Set([
  'acknowledgedProductAnnouncements',
  'alertBounce',
  'alertOnInteraction',
  'alertOnThreadFinished',
  'alertSound',
  'alertSystemNotification',
  'animateAgentAvatars',
  'appIconVariant',
  'appearanceDefaultsMigrationVersion',
  'autoPortraitRightPanel',
  'chatGptPlanWelcomeSeen',
  'conciseThreadsDefaultMigrated',
  'fontSize',
  'layout',
  'onboardingCompleted',
  'rightPanelPosition',
  'sidebarThreadGroup',
  'sidebarThreadSort',
  'sidebarThreadSortReverse',
  'theme',
  'uiAccentColor',
  'uiScale',
  'uiTintColor',
  'uiTintStrength',
])

/** Future settings require confirmation unless explicitly classified as presentation-only. */
export function settingsConsentDetail(changes: Record<string, unknown>): string | null {
  const privileged = Object.fromEntries(
    Object.entries(changes).filter(
      ([key, value]) => value !== undefined && !PRESENTATION_SETTINGS.has(key),
    ),
  )
  if (Object.keys(privileged).length === 0) return null
  const detail = JSON.stringify(privileged, null, 2)
  if (detail.length > 12_000) throw new Error('Setting change is too large to confirm safely')
  return `Allow these Copse setting changes?\n\n${detail}`
}
