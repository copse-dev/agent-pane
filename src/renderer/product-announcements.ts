import type { SettingsSection } from './views/settings-dialog.ts'

export interface ProductAnnouncement {
  /** Stable and unique. Keep the same ID when correcting copy. */
  id: string
  title: string
  message: string
  detail?: string
  settingsAction?: {
    label: string
    section: SettingsSection
  }
}

/**
 * Currently relevant, shipped announcements, in presentation order. Add an
 * entry with the change it announces; remove retired entries so new installs
 * are not greeted by years of history. Never reuse an ID for a different change.
 * Empty until a real change graduates — Compact is still experimental.
 */
export const PRODUCT_ANNOUNCEMENTS: readonly ProductAnnouncement[] = []
