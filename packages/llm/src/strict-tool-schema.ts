import { isDeepStrictEqual } from 'node:util'
import { isRecord } from '@copse/std/unknown-value.ts'
import { normalizeOpenAIToolSchema } from './normalize-tool-schema.ts'
import type { LLMTool } from './wire-types.ts'

/**
 * OpenAI function-tool `strict: true` support.
 *
 * Strict mode constrains decoding to the tool's JSON Schema, so the model can
 * no longer emit a missing required key or an out-of-enum value. It only
 * accepts a subset of JSON Schema (https://developers.openai.com/api/docs/guides/structured-outputs,
 * "Supported schemas"), and rejects the whole request on a schema outside it:
 *
 *  - the root is an object (not a union);
 *  - every object sets `additionalProperties: false` and lists ALL of its
 *    properties in `required` — an optional field is spelled as a nullable type;
 *  - types are string / number / integer / boolean / object / array / enum /
 *    `anyOf`; `allOf`, `not`, `if/then/else`, `dependent*` are unsupported and
 *    `oneOf` is not listed, so it is rewritten to the equivalent `anyOf`;
 *  - string `pattern` and a fixed list of `format`s, number bounds and
 *    `minItems`/`maxItems` are supported; `minLength`/`maxLength` are not.
 *
 * {@link toStrictSchema} is the single source of truth: it either produces a
 * schema in that subset or names every reason it cannot. A schema "qualifies
 * as-is" exactly when the conversion is the identity. Nothing here mutates its
 * input, and the tool registry keeps validating with its own (original) schema,
 * so anything strict mode cannot enforce is still enforced there.
 *
 * Optional → required-nullable is the one lossy-looking rewrite, and it is
 * reversed by {@link restoreAbsentOptionals}, which must run on the model's
 * arguments before the registry validates them: a `null` the model sent for a
 * field that was originally optional means "absent".
 */

type JsonObject = Record<string, unknown>

/** `format` values strict mode accepts; any other is dropped (the registry still validates it). */
const SUPPORTED_FORMATS: ReadonlySet<string> = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'uuid',
])

/** Keywords strict mode understands; copied through unchanged. */
const KEPT_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'description',
  'title',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
])

/**
 * Constraints and annotations strict mode does not take. They only ever narrow
 * what the model may send, and the registry re-validates every call against the
 * original schema, so dropping them costs a decode-time hint, never correctness.
 */
const DROPPED_KEYWORDS: ReadonlySet<string> = new Set([
  'default',
  'minLength',
  'maxLength',
  'examples',
  'example',
  'uniqueItems',
  'deprecated',
  'readOnly',
  'writeOnly',
  '$schema',
  '$id',
  '$comment',
])

/** Nesting depth strict mode allows for objects. */
const MAX_OBJECT_DEPTH = 10

export type StrictSchemaVerdict =
  | { kind: 'as-is' }
  | { kind: 'convertible'; changes: string[] }
  | { kind: 'incompatible'; reasons: string[] }

export type StrictConversion =
  | { ok: true; schema: JsonObject; changes: string[] }
  | { ok: false; reasons: string[] }

interface Walk {
  reasons: string[]
  changes: string[]
}

function at(path: string): string {
  return path === '' ? 'the root' : path
}

function fail(walk: Walk, path: string, message: string): JsonObject {
  walk.reasons.push(`${at(path)}: ${message}`)
  return {}
}

function typeList(node: JsonObject): string[] {
  const { type } = node
  if (typeof type === 'string') return [type]
  if (Array.isArray(type)) return type.filter((t) => typeof t === 'string')
  return []
}

/** True when a (source) schema lets `null` through as a value. */
export function admitsNull(schema: unknown): boolean {
  if (!isRecord(schema)) return false
  if (schema['nullable'] === true) return true
  if (typeList(schema).includes('null')) return true
  return unionBranches(schema).some(admitsNull)
}

function unionBranches(schema: JsonObject): unknown[] {
  const branches = Array.isArray(schema['anyOf']) ? schema['anyOf'] : schema['oneOf']
  return Array.isArray(branches) ? branches : []
}

function withNull(schema: JsonObject): JsonObject {
  if (admitsNull(schema)) return schema
  if (schema['anyOf'] !== undefined) {
    return { ...schema, anyOf: [...unionBranches(schema), { type: 'null' }] }
  }
  // A `type` that admits null is not enough on its own: constrained decoding
  // also honours `enum`, so without null in it an optional enum could never be
  // left out and the model would be forced to pick a value.
  const rawValues: unknown = schema['enum']
  const values: unknown[] = Array.isArray(rawValues) ? rawValues : []
  const withNullValue = Array.isArray(rawValues) && !values.includes(null)
  return {
    ...schema,
    type: [...typeList(schema), 'null'],
    ...(withNullValue ? { enum: [...values, null] } : {}),
  }
}

function convertUnion(
  node: JsonObject,
  branches: unknown[],
  path: string,
  depth: number,
  walk: Walk,
): JsonObject {
  // Restoration must identify an object branch before dropping optional nulls.
  // A shape match alone cannot distinguish discriminators or preserve a null
  // that another branch requires. Leave unsupported/ambiguous unions non-strict.
  const objects = branches.filter(isRecord).filter((branch) => typeList(branch).includes('object'))
  if (branches.some((branch) => isRecord(branch) && unionBranches(branch).length > 0)) {
    return fail(walk, path, 'nested union branches cannot be safely restored')
  }
  for (let index = 0; index < objects.length; index++) {
    const left = objects[index]
    if (!left) continue
    for (const right of objects.slice(index + 1)) {
      if (!distinguishableObjects(left, right)) {
        return fail(walk, path, 'object union branches cannot be safely distinguished')
      }
    }
  }
  if (node['oneOf'] !== undefined) walk.changes.push(`${at(path)}: oneOf → anyOf`)
  const out: JsonObject = {}
  for (const key of ['title', 'description']) {
    if (node[key] !== undefined) out[key] = node[key]
  }
  out['anyOf'] = branches.map((branch, i) =>
    convertNode(branch, `${path}/anyOf/${String(i)}`, depth, walk),
  )
  return out
}

function convertObject(node: JsonObject, path: string, depth: number, walk: Walk): JsonObject {
  if (depth > MAX_OBJECT_DEPTH) {
    return fail(walk, path, `objects nest deeper than ${String(MAX_OBJECT_DEPTH)} levels`)
  }
  const otherTypes = typeList(node).filter((t) => t !== 'object' && t !== 'null')
  if (otherTypes.length > 0) {
    return fail(walk, path, `object mixed with ${otherTypes.join(', ')} in one type array`)
  }
  const additional = node['additionalProperties']
  if (additional !== undefined && additional !== false) {
    return fail(walk, path, 'open-ended object (additionalProperties other than false)')
  }
  if (additional === undefined) walk.changes.push(`${at(path)}: additionalProperties: false added`)
  const rawProps = node['properties']
  if (rawProps !== undefined && !isRecord(rawProps)) return fail(walk, path, 'malformed properties')
  const props = rawProps ?? {}
  const rawRequired = node['required']
  const required = Array.isArray(rawRequired)
    ? rawRequired.filter((k) => typeof k === 'string')
    : []
  for (const key of required) {
    if (!Object.hasOwn(props, key)) return fail(walk, path, `required key "${key}" has no schema`)
  }
  const convertedProps: JsonObject = {}
  for (const [key, child] of Object.entries(props)) {
    const converted = convertNode(child, `${path}/properties/${key}`, depth + 1, walk)
    if (required.includes(key)) {
      convertedProps[key] = converted
      continue
    }
    walk.changes.push(`${at(path)}: optional "${key}" → required nullable`)
    convertedProps[key] = withNull(converted)
  }
  const out: JsonObject = {}
  for (const key of ['title', 'description']) {
    if (node[key] !== undefined) out[key] = node[key]
  }
  out['type'] = typeList(node).includes('null') ? ['object', 'null'] : 'object'
  out['properties'] = convertedProps
  out['required'] = Object.keys(convertedProps)
  out['additionalProperties'] = false
  return out
}

function convertNode(node: unknown, path: string, depth: number, walk: Walk): JsonObject {
  if (!isRecord(node)) return fail(walk, path, 'schema is not an object')

  for (const key of Object.keys(node)) {
    if (KEPT_KEYWORDS.has(key) || key === 'oneOf' || key === 'nullable') continue
    if (DROPPED_KEYWORDS.has(key)) walk.changes.push(`${at(path)}: dropped ${key}`)
    else return fail(walk, path, `unsupported keyword "${key}"`)
  }
  if (node['anyOf'] !== undefined && node['oneOf'] !== undefined) {
    return fail(walk, path, 'both anyOf and oneOf')
  }

  const branches = unionBranches(node)
  const types = typeList(node)
  const isNullable = node['nullable'] === true
  if (isNullable) walk.changes.push(`${at(path)}: nullable → type array`)

  let out: JsonObject
  if (node['anyOf'] !== undefined || node['oneOf'] !== undefined) {
    if (branches.length === 0) return fail(walk, path, 'empty union')
    out = convertUnion(node, branches, path, depth, walk)
  } else if (types.includes('object')) {
    out = convertObject(node, path, depth, walk)
  } else if (types.length === 0) {
    return fail(walk, path, 'schema has no type')
  } else {
    out = {}
    for (const [key, value] of Object.entries(node)) {
      if (!KEPT_KEYWORDS.has(key)) continue
      if (key === 'format' && !(typeof value === 'string' && SUPPORTED_FORMATS.has(value))) {
        walk.changes.push(`${at(path)}: dropped format ${JSON.stringify(value)}`)
        continue
      }
      out[key] = value
    }
    if (types.includes('array')) {
      if (node['items'] === undefined) return fail(walk, path, 'array has no items schema')
      out['items'] = convertNode(node['items'], `${path}/items`, depth, walk)
    }
    if (isRecord(out['exclusiveMinimum']) || typeof out['exclusiveMinimum'] === 'boolean') {
      return fail(walk, path, 'boolean exclusiveMinimum (legacy OpenAPI 3.0 form)')
    }
    if (typeof out['exclusiveMaximum'] === 'boolean') {
      return fail(walk, path, 'boolean exclusiveMaximum (legacy OpenAPI 3.0 form)')
    }
  }
  return isNullable ? withNull(out) : out
}

/** Convert a tool's JSON Schema to the strict subset, or say why that cannot be done. */
export function toStrictSchema(schema: unknown): StrictConversion {
  const walk: Walk = { reasons: [], changes: [] }
  if (!isRecord(schema) || !typeList(schema).includes('object')) {
    return { ok: false, reasons: ['the root: must be an object schema (not a union)'] }
  }
  const converted = convertNode(schema, '', 1, walk)
  if (walk.reasons.length > 0) return { ok: false, reasons: walk.reasons }
  return { ok: true, schema: converted, changes: walk.changes }
}

/** Classify a schema: usable as-is, usable after a reversible rewrite, or not usable. */
export function classifyStrictSchema(schema: unknown): StrictSchemaVerdict {
  const conversion = toStrictSchema(schema)
  if (!conversion.ok) return { kind: 'incompatible', reasons: conversion.reasons }
  if (isDeepStrictEqual(conversion.schema, schema)) return { kind: 'as-is' }
  return { kind: 'convertible', changes: conversion.changes }
}

/** True when the schema already satisfies strict mode with no rewrite at all. */
export function strictCompatibleSchema(schema: unknown): boolean {
  return classifyStrictSchema(schema).kind === 'as-is'
}

function stringSet(value: unknown): ReadonlySet<string> {
  return new Set(Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [])
}

/** Finite discriminator values; null is included conservatively for nullable schemas. */
function discriminatorValues(schema: unknown): unknown[] | null {
  if (!isRecord(schema)) return null
  const values: unknown[] | null = Object.hasOwn(schema, 'const')
    ? [schema['const']]
    : Array.isArray(schema['enum'])
      ? schema['enum']
      : null
  if (!values) return null
  return admitsNull(schema) ? [...values, null] : values
}

function distinguishableObjects(left: JsonObject, right: JsonObject): boolean {
  const leftProps = isRecord(left['properties']) ? left['properties'] : {}
  const rightProps = isRecord(right['properties']) ? right['properties'] : {}
  const leftRequired = stringSet(left['required'])
  const rightRequired = stringSet(right['required'])
  // Closed strict objects cannot match a sibling's exclusive required key.
  if ([...leftRequired].some((key) => !Object.hasOwn(rightProps, key))) return true
  if ([...rightRequired].some((key) => !Object.hasOwn(leftProps, key))) return true
  for (const key of leftRequired) {
    if (!rightRequired.has(key)) continue
    const leftValues = discriminatorValues(leftProps[key])
    const rightValues = discriminatorValues(rightProps[key])
    if (
      leftValues &&
      rightValues &&
      !leftValues.some((value) => rightValues.some((other) => isDeepStrictEqual(value, other)))
    ) {
      return true
    }
  }
  return false
}

function fitsObjectBranch(value: JsonObject, branch: unknown): boolean {
  if (!isRecord(branch) || !isRecord(branch['properties'])) return false
  const props = branch['properties']
  if (!Object.keys(value).every((key) => Object.hasOwn(props, key))) return false
  return [...stringSet(branch['required'])].every((key) => {
    if (!Object.hasOwn(value, key)) return false
    const values = discriminatorValues(props[key])
    return values === null || values.some((candidate) => isDeepStrictEqual(value[key], candidate))
  })
}

/**
 * Undo the optional → required-nullable rewrite on the model's arguments.
 *
 * Walks `value` alongside the ORIGINAL schema and drops each `null` the model
 * sent for a property that was optional there and did not itself admit `null`.
 * Everything else — including a `null` for a required field — is left for the
 * registry to reject with its usual error. Strict conversion admits object
 * unions only when required keys or finite discriminators distinguish their
 * branches; restoration checks those discriminators before selecting a branch.
 */
export function restoreAbsentOptionals(value: unknown, schema: unknown): unknown {
  if (!isRecord(schema)) return value
  if (Array.isArray(value))
    return value.map((item) => restoreAbsentOptionals(item, schema['items']))
  if (!isRecord(value)) return value

  const branches = unionBranches(schema)
  if (branches.length > 0) {
    for (const branch of branches) {
      const restored = restoreAbsentOptionals(value, branch)
      if (isRecord(restored) && fitsObjectBranch(restored, branch)) return restored
    }
    return value
  }

  const props = isRecord(schema['properties']) ? schema['properties'] : {}
  const required = stringSet(schema['required'])
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]): Array<[string, unknown]> => {
      const propSchema = Object.hasOwn(props, key) ? props[key] : undefined
      if (child === null && propSchema !== undefined && !required.has(key)) {
        if (!admitsNull(propSchema)) return []
      }
      return [[key, restoreAbsentOptionals(child, propSchema)]]
    }),
  )
}

/** A function tool as sent on an OpenAI wire (`strict` is valid on both Responses and Chat Completions). */
export interface StrictWireTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  strict: boolean
}

export interface StrictToolSet {
  tools: StrictWireTool[]
  /** Map a call's arguments back to what the tool's own (original) schema expects. */
  restoreArgs: (toolName: string, args: unknown) => unknown
}

/**
 * Decide `strict` per tool. With `enabled` false every tool is sent unchanged
 * and non-strict (the provider does not vouch for strict mode). Otherwise each
 * tool whose schema converts is sent in strict form and the rest stay as-is,
 * non-strict.
 */
export function prepareStrictTools(tools: readonly LLMTool[], enabled: boolean): StrictToolSet {
  const originals = new Map<string, unknown>()
  const wire = tools.map((tool): StrictWireTool => {
    const source = normalizeOpenAIToolSchema(tool.parameters)
    const conversion = enabled ? toStrictSchema(source) : null
    if (conversion?.ok) {
      originals.set(tool.name, source)
      return {
        name: tool.name,
        description: tool.description,
        parameters: conversion.schema,
        strict: true,
      }
    }
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    }
  })
  return {
    tools: wire,
    restoreArgs: (toolName, args) =>
      originals.has(toolName) ? restoreAbsentOptionals(args, originals.get(toolName)) : args,
  }
}
