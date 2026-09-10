import { definePlugin, type RegisteredPlugin } from './plugin-manifest.ts'

export const APPLE_DEVELOPMENT_PLUGIN_ID = 'copse.apple-development'
export const APPLE_DEVELOPMENT_PANEL_ID = 'apple-development'

/**
 * Apple Development is a first-party pack because its typed host driver and
 * thread view require capabilities the user-plugin worker deliberately lacks.
 * Agent workflows come from the pinned, bundled XcodeBuildMCP server and are
 * activated only for enrolled local projects. Experimental stability keeps the
 * pack off for fresh profiles; an upgrade migration also prevents existing
 * profiles from inheriting it enabled.
 */
export const appleDevelopmentPlugin: RegisteredPlugin = definePlugin(
  {
    name: APPLE_DEVELOPMENT_PLUGIN_ID,
    description:
      'Build, test, and run enrolled local Apple projects with an installed Xcode. Adds thread-scoped target selection, supervised operations, diagnostics, and Simulator controls.',
    trust: 'first-party',
    stability: 'experimental',
    ui: [
      {
        id: APPLE_DEVELOPMENT_PANEL_ID,
        level: 3,
        slot: 'thread-plugin-panel',
        title: 'Apple Development',
      },
      {
        id: 'apple-development-setup',
        level: 3,
        slot: 'settings-plugin-detail',
        title: 'Apple Development setup',
      },
    ],
    storage: { namespace: APPLE_DEVELOPMENT_PLUGIN_ID },
  },
  {
    uiContributions: [
      {
        id: APPLE_DEVELOPMENT_PANEL_ID,
        level: 3,
        slot: 'thread-plugin-panel',
        title: 'Apple Development',
      },
      {
        id: 'apple-development-setup',
        level: 3,
        slot: 'settings-plugin-detail',
        title: 'Apple Development setup',
      },
    ],
  },
)
