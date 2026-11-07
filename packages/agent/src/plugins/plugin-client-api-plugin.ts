import { definePlugin } from './plugin-manifest.ts'
import type { PluginRegistry } from './plugin-registry.ts'

export const PLUGIN_CLIENT_API_ID = 'copse.plugin-client-api'
export const PLUGIN_CLIENT_API_CAPABILITY = 'plugin-client-api'

/** A user manifest declaring the same capability name cannot enable this host service. */
export function isPluginClientApiEnabled(registry: PluginRegistry): boolean {
  return registry.isEnabled(PLUGIN_CLIENT_API_ID)
}
const capability = {
  name: PLUGIN_CLIENT_API_CAPABILITY,
  title: 'Interactive client API',
  description:
    'Allow local interactive clients to request desktop pairing. Connecting grants shell-approval control, recent chat titles and text opening those chats and using desktop-offered follow-ups for this app session. Disabling disconnects all clients and revokes their access.',
}
export const pluginClientApiPlugin = definePlugin(
  {
    name: PLUGIN_CLIENT_API_ID,
    description:
      'Connect local interactive clients to real shell-command approvals and recent chat titles and text, and desktop-offered follow-ups. Pair in Copse for each session. Clients may see sensitive command arguments across all projects. Disable to revoke every connection.',
    trust: 'first-party',
    stability: 'experimental',
    capabilities: [capability],
  },
  { capabilities: [capability] },
)
