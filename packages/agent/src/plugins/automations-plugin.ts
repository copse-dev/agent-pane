// The `copse.automations` first-party plugin.
//
// This plugin owns the lifecycle and level-3 Settings surface for the local
// automation prototype. The clock and thread-store write stay host-side: plugins
// in `packages/agent` are deliberately Electron-free (execution-guidance rule
// 4), while first-party level-3 views may be implemented by the renderer.
import { definePlugin, type RegisteredPlugin } from './plugin-manifest.ts'

export const AUTOMATIONS_PLUGIN_ID = 'copse.automations'

export const automationsPlugin: RegisteredPlugin = definePlugin(
  {
    name: AUTOMATIONS_PLUGIN_ID,
    description:
      'Project-scoped cron schedules that start fresh, grouped, worktree-backed tasks while Copse is running.',
    trust: 'first-party',
    stability: 'experimental',
    ui: [
      {
        id: 'schedule-editor',
        level: 3,
        slot: 'settings-plugin-detail',
        title: 'Automation schedules',
      },
    ],
    storage: { namespace: AUTOMATIONS_PLUGIN_ID },
  },
  {
    uiContributions: [
      {
        id: 'schedule-editor',
        level: 3,
        slot: 'settings-plugin-detail',
        title: 'Automation schedules',
      },
    ],
  },
)
