import { definePlugin, type RegisteredPlugin } from './plugin-manifest.ts'

export const DARK_FACTORY_PLUGIN_ID = 'copse.dark-factory'

export const darkFactoryPlugin: RegisteredPlugin = definePlugin(
  {
    name: DARK_FACTORY_PLUGIN_ID,
    description:
      'Dark-factory PR orchestration — observes Copse-owned pull requests with one adaptive fleet sensor so CI and stale-work events can be handled without per-thread pollers.',
    trust: 'first-party',
    stability: 'experimental',
    storage: { namespace: DARK_FACTORY_PLUGIN_ID },
  },
  {},
)
