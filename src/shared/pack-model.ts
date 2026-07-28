export const PACK_MODEL_PREFIX = 'pack-model:'

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
  if (!value.startsWith(PACK_MODEL_PREFIX)) return null
  const encoded = value.slice(PACK_MODEL_PREFIX.length)
  const separator = encoded.indexOf(':')
  if (separator <= 0 || separator === encoded.length - 1) return null
  try {
    const packId = decodeURIComponent(encoded.slice(0, separator))
    const routeId = decodeURIComponent(encoded.slice(separator + 1))
    return packId && routeId ? { packId, routeId } : null
  } catch {
    return null
  }
}
