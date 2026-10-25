import { definePlugin, type RegisteredPlugin } from './plugin-manifest.ts'
import { engineeringSteeringHook } from '../engineering-steering.ts'

export const ENGINEERING_PLUGIN_ID = 'copse.engineering'

export const engineeringPlugin: RegisteredPlugin = definePlugin(
  {
    name: ENGINEERING_PLUGIN_ID,
    description:
      'Guides investigations, changes, and reviews with clear acceptance checks, proportionate effort, and evidence of the result. Explicitly invoked skills take precedence.',
    trust: 'first-party',
    stability: 'experimental',
  },
  { blockingHooks: [engineeringSteeringHook] },
)
