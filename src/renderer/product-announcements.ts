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
 */
export const PRODUCT_ANNOUNCEMENTS: readonly ProductAnnouncement[] = [
  {
    id: 'concise-threads-default-v1',
    title: 'Concise threads are now on',
    message:
      'For highly capable models, threads now show results and the closing summary. Tool calls and reasoning are hidden while a turn runs and once it finishes.',
    detail:
      'Use Show steps under any turn to see everything, or turn this off in Settings → Appearance.',
    settingsAction: { label: 'Appearance settings', section: 'appearance' },
  },
]
