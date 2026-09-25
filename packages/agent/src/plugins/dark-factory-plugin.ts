import { definePlugin, type RegisteredPlugin } from './plugin-manifest.ts'

export const DARK_FACTORY_PLUGIN_ID = 'copse.dark-factory'

export const darkFactoryPlugin: RegisteredPlugin = definePlugin(
  {
    name: DARK_FACTORY_PLUGIN_ID,
    description:
      'Dark-factory PR orchestration (groundwork only) — while on, runs a fleet poll timer that nothing acts on yet. It does not read, watch, or change pull requests or CI.',
    trust: 'first-party',
    stability: 'experimental',
    storage: { namespace: DARK_FACTORY_PLUGIN_ID },
  },
  {},
)
