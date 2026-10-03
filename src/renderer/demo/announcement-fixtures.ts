import type { ProductAnnouncement } from '../product-announcements.ts'

/** Illustrative copy only; these IDs never appear in the shipped catalog. */
export const DEMO_PRODUCT_ANNOUNCEMENTS: readonly ProductAnnouncement[] = [
  {
    id: 'demo-compact-released',
    title: 'Compact is now the default',
    message:
      'Compact view is out of experimental and available to everyone. Chats now have a more concise, focused layout.',
    detail: 'Prefer another view? Change it anytime in Settings → Appearance.',
    settingsAction: { label: 'Appearance settings', section: 'appearance' },
  },
  {
    id: 'demo-announcements-ready',
    title: 'Stay up to date',
    message: 'When a change affects how you use Copse, you’ll see a short announcement here.',
    detail: 'Dismiss it once and carry on with your work.',
  },
]
