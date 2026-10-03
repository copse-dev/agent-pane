function normalizeExclusiveBound(
  schema: Record<string, unknown>,
  inclusiveKey: 'minimum' | 'maximum',
  exclusiveKey: 'exclusiveMinimum' | 'exclusiveMaximum',
): void {
  const exclusive = schema[exclusiveKey]
  if (typeof exclusive !== 'boolean') return
  const inclusive = schema[inclusiveKey]
  if (exclusive && typeof inclusive === 'number') {
    schema[exclusiveKey] = inclusive
    Reflect.deleteProperty(schema, inclusiveKey)
    return
  }
  Reflect.deleteProperty(schema, exclusiveKey)
}

/**
 * OpenAPI 3 represents exclusive numeric bounds as a boolean beside
 * `minimum`/`maximum`; current JSON Schema represents the exclusive keyword as
 * the bound itself. Some OpenAI-compatible servers validate tool parameters
 * against the current metaschema and reject the legacy boolean form before the
 * model runs. Clone and normalize recursively at this transport boundary so the
 * registry and the caller-owned schema remain unchanged.
 */
export function normalizeOpenAIToolSchema(value: Record<string, unknown>): Record<string, unknown>
export function normalizeOpenAIToolSchema(value: unknown): unknown
export function normalizeOpenAIToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeOpenAIToolSchema(item))
  if (!value || typeof value !== 'object') return value

  const normalized: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    normalized[key] = normalizeOpenAIToolSchema(child)
  }
  normalizeExclusiveBound(normalized, 'minimum', 'exclusiveMinimum')
  normalizeExclusiveBound(normalized, 'maximum', 'exclusiveMaximum')
  return normalized
}
