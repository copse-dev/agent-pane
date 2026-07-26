// The `copse.automations` first-party pack.
//
// This pack owns the lifecycle and level-3 Settings surface for the local
// automation prototype. The clock and thread-store write stay host-side: packs
// in `packages/agent` are deliberately Electron-free (execution-guidance rule
// 4), while first-party level-3 views may be implemented by the renderer.
import { definePack, type RegisteredPack } from './pack-manifest.ts'

export const AUTOMATIONS_PACK_ID = 'copse.automations'

export const automationsPack: RegisteredPack = definePack(
  {
    name: AUTOMATIONS_PACK_ID,
    description:
      'Project-scoped cron schedules that start model-pinned tasks while Copse is running.',
    trust: 'first-party',
    ui: [
      {
        id: 'schedule-editor',
        level: 3,
        slot: 'settings-pack-detail',
        title: 'Automation schedules',
      },
    ],
    storage: { namespace: AUTOMATIONS_PACK_ID },
  },
  {
    uiContributions: [
      {
        id: 'schedule-editor',
        level: 3,
        slot: 'settings-pack-detail',
        title: 'Automation schedules',
      },
    ],
  },
)
