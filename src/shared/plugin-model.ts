// Canonical definition lives in the LLM module, which owns the model-id
// namespacing vocabulary; re-exported here so plugin consumers keep their
// existing import path and the literal never drifts between the two.
export { PLUGIN_MODEL_PREFIX } from '@copse/llm/reserved-prefixes.ts'
import { PLUGIN_MODEL_PREFIX } from '@copse/llm/reserved-prefixes.ts'
import { parseModelSelection } from '@copse/llm/model-selection.ts'

export interface PluginModelSelection {
  pluginId: string
  routeId: string
}

/** Stable footer/model-setting value for one selected plugin's thread model. */
export function pluginModelValue(pluginId: string, routeId: string): string {
  return `${PLUGIN_MODEL_PREFIX}${encodeURIComponent(pluginId)}:${encodeURIComponent(routeId)}`
}

/** Parse a plugin model value without accepting missing or malformed identities. */
export function parsePluginModelSelection(value: string): PluginModelSelection | null {
  // The shared parser splits the two halves; decoding them stays here, because
  // URI-encoding the identities is this namespace's own convention.
  const selection = parseModelSelection(value)
  if (selection.namespace !== 'plugin-model') return null
  if (!selection.agent || !selection.id) return null
  try {
    const pluginId = decodeURIComponent(selection.agent)
    const routeId = decodeURIComponent(selection.id)
    return pluginId && routeId ? { pluginId, routeId } : null
  } catch {
    return null
  }
}
