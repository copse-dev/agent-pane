import { isRecord } from '@copse/std/unknown-value.ts'

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

/** Expose union fields to servers requiring an object-shaped parameter envelope. */
function objectUnionProperties(branches: Record<string, unknown>[]): Record<string, unknown> {
  const keys = new Set(
    branches.flatMap((branch) =>
      isRecord(branch['properties']) ? Object.keys(branch['properties']) : [],
    ),
  )
  const properties: Record<string, unknown> = {}
  for (const key of keys) {
    const alternatives: unknown[] = []
    for (const branch of branches) {
      const fields = branch['properties']
      if (isRecord(fields) && Object.hasOwn(fields, key)) alternatives.push(fields[key])
      else if (
        isRecord(branch['patternProperties']) &&
        Object.keys(branch['patternProperties']).length > 0
      )
        alternatives.push({})
      else if (branch['additionalProperties'] !== false)
        alternatives.push(
          isRecord(branch['additionalProperties']) ? branch['additionalProperties'] : {},
        )
    }
    // A permissive branch leaves this field unconstrained; the original union
    // below still applies each branch's own required fields and restrictions.
    const unconstrained = alternatives.some(
      (schema) => isRecord(schema) && Object.keys(schema).length === 0,
    )
    const unique = [
      ...new Map(alternatives.map((schema) => [JSON.stringify(schema), schema])).values(),
    ]
    properties[key] = unconstrained ? {} : unique.length === 1 ? unique[0] : { anyOf: unique }
  }
  return properties
}

/**
 * OpenAPI 3 represents exclusive numeric bounds as a boolean beside
 * `minimum`/`maximum`; current JSON Schema represents the exclusive keyword as
 * the bound itself. Some OpenAI-compatible servers validate tool parameters
 * against the current metaschema and reject the legacy boolean form before the
 * model runs. Clone and normalize recursively at this transport boundary so the
 * registry and the caller-owned schema remain unchanged.
 */
interface NormalizeToolSchemaOptions {
  /** Strict-schema qualification must inspect the original root union. */
  objectUnionEnvelope?: boolean
}

export function normalizeOpenAIToolSchema(
  value: Record<string, unknown>,
  options?: NormalizeToolSchemaOptions,
): Record<string, unknown>
export function normalizeOpenAIToolSchema(
  value: unknown,
  options?: NormalizeToolSchemaOptions,
): unknown
export function normalizeOpenAIToolSchema(
  value: unknown,
  options: NormalizeToolSchemaOptions = {},
): unknown {
  return normalizeSchemaValue(value, options.objectUnionEnvelope !== false)
}

function normalizeSchemaValue(value: unknown, root: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeSchemaValue(item, false))
  if (!value || typeof value !== 'object') return value

  const normalized: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    normalized[key] = normalizeSchemaValue(child, false)
  }
  // A union of object branches is still an object. OpenAI-compatible engines
  // such as LM Studio require an explicit root type before accepting a tool.
  // Keep every branch and its required fields rather than flattening validation.
  const branches = normalized['anyOf'] ?? normalized['oneOf']
  if (
    root &&
    normalized['type'] === undefined &&
    Array.isArray(branches) &&
    branches.length > 0 &&
    branches.every((branch) => isRecord(branch) && branch['type'] === 'object')
  ) {
    normalized['type'] = 'object'
    const objects = branches.filter(isRecord)
    if (normalized['properties'] === undefined)
      normalized['properties'] = objectUnionProperties(objects)
    if (normalized['required'] === undefined) {
      const required = objects.map((branch) =>
        Array.isArray(branch['required'])
          ? branch['required'].filter((key) => typeof key === 'string')
          : [],
      )
      normalized['required'] = (required[0] ?? []).filter((key) =>
        required.every((keys) => keys.includes(key)),
      )
    }
  }
  normalizeExclusiveBound(normalized, 'minimum', 'exclusiveMinimum')
  normalizeExclusiveBound(normalized, 'maximum', 'exclusiveMaximum')
  return normalized
}
