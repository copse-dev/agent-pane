// Canonical definition lives in the LLM module, which owns the model-id
// namespacing vocabulary; re-exported here so pack consumers keep their
// existing import path and the literal never drifts between the two.
export { PACK_MODEL_PREFIX } from '@copse/llm/reserved-prefixes.ts'
import { PACK_MODEL_PREFIX } from '@copse/llm/reserved-prefixes.ts'
import { parseModelSelection } from '@copse/llm/model-selection.ts'

export interface PackModelSelection {
  packId: string
  routeId: string
}

/** Stable footer/model-setting value for one selected pack's thread model. */
export function packModelValue(packId: string, routeId: string): string {
  return `${PACK_MODEL_PREFIX}${encodeURIComponent(packId)}:${encodeURIComponent(routeId)}`
}

/** Parse a pack model value without accepting missing or malformed identities. */
export function parsePackModelSelection(value: string): PackModelSelection | null {
  // The shared parser splits the two halves; decoding them stays here, because
  // URI-encoding the identities is this namespace's own convention.
  const selection = parseModelSelection(value)
  if (selection.namespace !== 'pack-model') return null
  if (!selection.agent || !selection.id) return null
  try {
    const packId = decodeURIComponent(selection.agent)
    const routeId = decodeURIComponent(selection.id)
    return packId && routeId ? { packId, routeId } : null
  } catch {
    return null
  }
}
