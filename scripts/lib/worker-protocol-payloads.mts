// Give the worker protocol's pass-through payloads their shapes
// (`docs/plans/harness-worker-roadmap.md`, R2).
//
// The worker line schemas check a stream chunk, a transcript snapshot or a
// container record only as "an object": both ends run the same code that wrote
// it, so parsing it twice would only cost time. A worker on another machine
// still has to know what to write. The renderer API protocol already describes
// these types from their TypeScript declarations (`api-protocol.mts`), so the
// published worker schema points each such field at that description and
// carries the definitions it needs.

import { isRecord } from '../../src/shared/unknown-value.mts'

type JsonSchema = Record<string, unknown>

/** A payload field of one message, and the API protocol type that describes it. */
export interface WorkerPayloadType {
  role: string
  direction: 'clientToWorker' | 'workerToClient'
  message: string
  field: string
  type: string
}

/**
 * A type the API protocol does not name, made from one it does: a host's
 * thread prompt is the window's command less the fields the app adds when it
 * forwards it (`HostThreadPromptCommand` in `turn-host-protocol.ts`).
 */
interface DerivedType {
  from: string
  without: readonly string[]
}

const DERIVED_TYPES: Readonly<Record<string, DerivedType>> = {
  HostThreadPromptCommand: { from: 'ThreadPromptCommand', without: ['id', 'expiresAt'] },
}

export const WORKER_PAYLOAD_TYPES: readonly WorkerPayloadType[] = [
  {
    role: 'turns',
    direction: 'workerToClient',
    message: 'chunk',
    field: 'chunk',
    type: 'StreamChunk',
  },
  {
    role: 'turns',
    direction: 'workerToClient',
    message: 'chunk',
    field: 'stamp',
    type: 'TranscriptStamp',
  },
  {
    role: 'turns',
    direction: 'workerToClient',
    message: 'snapshot',
    field: 'snapshot',
    type: 'TranscriptSnapshot',
  },
  {
    role: 'container-run',
    direction: 'workerToClient',
    message: 'done',
    field: 'record',
    type: 'ThreadContainerRecord',
  },
  {
    role: 'turns',
    direction: 'workerToClient',
    message: 'thread-prompt',
    field: 'command',
    type: 'HostThreadPromptCommand',
  },
]

function child(value: unknown, key: string): JsonSchema {
  const next = isRecord(value) ? value[key] : undefined
  if (!isRecord(next)) throw new Error(`the worker protocol has no ${key} where expected`)
  return next
}

/** Every `#/$defs/<name>` a schema refers to, directly. */
function refsIn(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) refsIn(item, into)
    return
  }
  if (!isRecord(value)) return
  for (const [key, item] of Object.entries(value)) {
    if (key === '$ref' && typeof item === 'string' && item.startsWith('#/$defs/'))
      into.add(item.slice('#/$defs/'.length))
    else refsIn(item, into)
  }
}

/** `derived.from`'s definition without the fields `derived.without` names. */
function derive(name: string, derived: DerivedType, apiDefs: JsonSchema): JsonSchema {
  const source = apiDefs[derived.from]
  if (!isRecord(source)) throw new Error(`the API protocol does not describe ${derived.from}`)
  const properties = child(source, 'properties')
  for (const key of derived.without)
    if (!Object.hasOwn(properties, key)) throw new Error(`${derived.from} has no field ${key}`)
  const listed = source['required']
  return {
    ...source,
    description: `${derived.from} without ${derived.without.join(', ')} (${name}).`,
    properties: Object.fromEntries(
      Object.entries(properties).filter(([key]) => !derived.without.includes(key)),
    ),
    required: (Array.isArray(listed) ? listed : []).filter(
      (key: unknown) => typeof key !== 'string' || !derived.without.includes(key),
    ),
  }
}

/**
 * The worker protocol document with each pass-through payload pointed at its
 * type, and the API protocol definitions those types need under `$defs`.
 * Throws when a listed message, field or type is missing, so a rename cannot
 * leave the published schema quietly vague again.
 */
export function withPayloadTypes(document: JsonSchema, sourceDefs: JsonSchema): JsonSchema {
  const apiDefs: JsonSchema = { ...sourceDefs }
  for (const [name, derived] of Object.entries(DERIVED_TYPES)) {
    if (Object.hasOwn(apiDefs, name)) throw new Error(`the API protocol already has ${name}`)
    apiDefs[name] = derive(name, derived, sourceDefs)
  }
  const copy: JsonSchema = structuredClone(document)
  const wanted = new Set<string>()
  for (const payload of WORKER_PAYLOAD_TYPES) {
    const union = child(child(child(copy, 'roles'), payload.role), payload.direction)
    const variants: unknown = union['oneOf'] ?? union['anyOf']
    const variant: unknown = Array.isArray(variants)
      ? variants.find(
          (item: unknown) =>
            isRecord(item) && child(child(item, 'properties'), 't')['const'] === payload.message,
        )
      : undefined
    if (!isRecord(variant))
      throw new Error(`${payload.role} has no ${payload.direction} message ${payload.message}`)
    const properties = child(variant, 'properties')
    if (!Object.hasOwn(properties, payload.field))
      throw new Error(`${payload.role} ${payload.message} has no field ${payload.field}`)
    if (!Object.hasOwn(apiDefs, payload.type))
      throw new Error(`the API protocol does not describe ${payload.type}`)
    // The API protocol names a second type of the same name `<name>__<file>`:
    // then the bare name may not be the type this line carries.
    if (Object.keys(apiDefs).some((name) => name.startsWith(`${payload.type}__`)))
      throw new Error(`the API protocol has more than one ${payload.type}; name the one meant`)
    const ref = { $ref: `#/$defs/${payload.type}` }
    // A field the line checks keeps its checked limits beside the full type.
    const checked = properties[payload.field]
    properties[payload.field] =
      isRecord(checked) && Object.keys(checked).length > 0 ? { allOf: [checked, ref] } : ref
    wanted.add(payload.type)
  }
  // Each definition with the ones it refers to, until nothing new turns up.
  const defs: JsonSchema = {}
  const queue = [...wanted]
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (Object.hasOwn(defs, name)) continue
    const definition = apiDefs[name]
    if (!isRecord(definition)) throw new Error(`the API protocol does not describe ${name}`)
    defs[name] = definition
    const refs = new Set<string>()
    refsIn(definition, refs)
    queue.push(...refs)
  }
  // The document's own definitions, if it ever has any, stay; a name both use
  // would make one of them point at the other's type.
  const own = isRecord(copy['$defs']) ? copy['$defs'] : {}
  for (const name of Object.keys(defs))
    if (Object.hasOwn(own, name)) throw new Error(`$defs/${name} is defined twice`)
  copy['$defs'] = Object.fromEntries(
    Object.entries({ ...own, ...defs }).sort(([a], [b]) => a.localeCompare(b)),
  )
  return copy
}
