import { definePlugin, type RegisteredPlugin } from './plugin-manifest.ts'

export const APPLE_DEVELOPMENT_PLUGIN_ID = 'copse.apple-development'
export const APPLE_DEVELOPMENT_PANEL_ID = 'apple-development'
export const APPLE_DEVELOPMENT_TOOL_NAMES = ['open_simulator_desktop'] as const
/** Offer Apple development when an Apple project opens; on unless the user opts out. */
export const APPLE_DEVELOPMENT_SUGGEST_SETTING_ID = 'suggest-projects'

/**
 * Apple Development is a first-party plugin because its typed host driver and
 * thread view require capabilities the user-plugin worker deliberately lacks.
 * Agent workflows come from the pinned, bundled XcodeBuildMCP server and are
 * activated only for enrolled local projects. Experimental stability keeps the
 * plugin off for fresh profiles; an upgrade migration also prevents existing
 * profiles from inheriting it enabled.
 */
export const appleDevelopmentPlugin: RegisteredPlugin = definePlugin(
  {
    name: APPLE_DEVELOPMENT_PLUGIN_ID,
    description:
      'Build, test, and run enrolled local Apple projects with an installed Xcode. Adds thread-scoped target selection, supervised operations, diagnostics, and Simulator controls.',
    trust: 'first-party',
    stability: 'experimental',
    tools: {
      native: [...APPLE_DEVELOPMENT_TOOL_NAMES],
      acpTools: [...APPLE_DEVELOPMENT_TOOL_NAMES],
    },
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
    settings: {
      [APPLE_DEVELOPMENT_SUGGEST_SETTING_ID]: {
        kind: 'boolean',
        title: 'Suggest for Apple projects',
        description:
          'When you open a project with an Xcode project or workspace, offer to turn on Apple development for it. This works while the plugin is off.',
        default: true,
      },
    },
    storage: { namespace: APPLE_DEVELOPMENT_PLUGIN_ID },
  },
  {
    toolNames: [...APPLE_DEVELOPMENT_TOOL_NAMES],
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
