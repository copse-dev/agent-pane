// Stable first-party steering for website implementation requests.
//
// This plugin contributes one conditional turn-start hook. The hook detects a
// site-building request from the raw user text and supplies a brand-agnostic
// creative-engineering brief. The same canonical hook is assembled for the
// built-in loop and ACP; disabling the plugin removes that guidance from new
// turns without changing the visible user message or historical threads.
import { definePlugin, type RegisteredPlugin } from './plugin-manifest.ts'
import { siteBuildingSteeringHook } from '../hooks/turn-start-hooks.ts'

export const SITE_BUILDING_PLUGIN_ID = 'copse.site-building'

export const siteBuildingPlugin: RegisteredPlugin = definePlugin(
  {
    name: SITE_BUILDING_PLUGIN_ID,
    description:
      'Site building — adds a focused design, implementation, accessibility, and browser-verification brief when a user asks Copse to build a website.',
    trust: 'first-party',
    stability: 'stable',
    storage: { namespace: SITE_BUILDING_PLUGIN_ID },
  },
  {
    blockingHooks: [siteBuildingSteeringHook],
  },
)
