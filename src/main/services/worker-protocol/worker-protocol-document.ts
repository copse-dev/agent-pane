import { z } from 'zod'
import {
  appToRunHostSchema,
  CONTAINER_RUN_HOST_PROTOCOL,
  runHostToAppSchema,
} from '../container-runtime/run-host.ts'
import {
  appToHostSchema,
  hostToAppSchema,
  TURN_HOST_PROTOCOL,
} from '../turn-host/turn-host-protocol.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { workerCapabilitiesSchema, type WorkerRole } from './worker-capabilities.ts'

/**
 * The harness worker protocol, written down (`harness-worker-roadmap.md`, R2).
 *
 * Every worker speaks newline-delimited JSON over a line it serves: one message
 * per line, each an object whose `t` names it. A client says `hello` first with
 * its version and the role's protocol number; the worker answers `hello` with
 * its own, its pid and what it can run (`worker-capabilities.ts`). A line that
 * does not parse is dropped, and the line stays open.
 *
 * This document is generated from the same schemas each end checks its
 * messages with, so it cannot drift from what they accept. Two forms:
 *
 * - the full JSON Schema, a build output (`dist/schemas/worker-protocol.schema.json`)
 *   for a transport or a worker on another machine to code against;
 * - the manifest (`schemas/worker-protocol.manifest.json`): each role's
 *   protocol number and each message's top-level fields, committed, so adding,
 *   removing or making optional a message or field shows in review. A change
 *   inside a field's shape shows only in the full schema.
 *
 * A payload either end passes on unread (a stream chunk, a snapshot, a
 * container record) is `{}` in the schema: a worker on another machine
 * cannot code against those yet.
 */

export const WORKER_PROTOCOL_MANIFEST_PATH = 'schemas/worker-protocol.manifest.json'
export const WORKER_PROTOCOL_SCHEMA_BUILD_PATH = 'dist/schemas/worker-protocol.schema.json'

type JsonSchema = Record<string, unknown>

interface RoleSchemas {
  protocol: number
  clientToWorker: z.ZodType
  workerToClient: z.ZodType
}

const ROLES: Record<WorkerRole, RoleSchemas> = {
  turns: {
    protocol: TURN_HOST_PROTOCOL,
    clientToWorker: appToHostSchema,
    workerToClient: hostToAppSchema,
  },
  'container-run': {
    protocol: CONTAINER_RUN_HOST_PROTOCOL,
    clientToWorker: appToRunHostSchema,
    workerToClient: runHostToAppSchema,
  },
}

export interface WorkerProtocolDocument {
  $schema: string
  $comment: string
  capabilities: JsonSchema
  roles: Record<
    WorkerRole,
    { protocol: number; clientToWorker: JsonSchema; workerToClient: JsonSchema }
  >
}

/**
 * A message schema as a sender must write it. A payload either end passes on
 * unread (a stream chunk, a container record) has no shape here: it is `{}`.
 */
function toJson(schema: z.ZodType): JsonSchema {
  const { $schema: _drop, ...rest }: JsonSchema = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  })
  return rest
}

function roleSchemas(role: WorkerRole): WorkerProtocolDocument['roles'][WorkerRole] {
  const { protocol, clientToWorker, workerToClient } = ROLES[role]
  return {
    protocol,
    clientToWorker: toJson(clientToWorker),
    workerToClient: toJson(workerToClient),
  }
}

export function workerProtocolDocument(): WorkerProtocolDocument {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $comment:
      'Generated from the worker line schemas (src/main/services/worker-protocol/worker-protocol-document.ts); do not edit by hand.',
    capabilities: toJson(workerCapabilitiesSchema),
    roles: { turns: roleSchemas('turns'), 'container-run': roleSchemas('container-run') },
  }
}

/** Each message's fields, sorted, with `?` on the ones a sender may leave out. */
type MessageFields = Record<string, string[]>

export interface WorkerProtocolManifest {
  $comment: string
  capabilities: string[]
  roles: Record<
    WorkerRole,
    { protocol: number; clientToWorker: MessageFields; workerToClient: MessageFields }
  >
}

function records(value: unknown): JsonSchema[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function properties(schema: JsonSchema): Record<string, JsonSchema> {
  const value = schema['properties']
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, field]) => (isRecord(field) ? [[key, field]] : [])),
  )
}

function messageFields(union: JsonSchema): MessageFields {
  const variants = records(union['oneOf'] ?? union['anyOf'])
  if (variants.length === 0) throw new Error('a worker line schema is not a union of messages')
  const fields: MessageFields = {}
  for (const variant of variants) {
    const shape = properties(variant)
    const name = shape['t']?.['const']
    if (typeof name !== 'string') throw new Error('a worker message has no literal `t`')
    const listed = variant['required']
    const required = new Set(Array.isArray(listed) ? listed : [])
    fields[name] = Object.keys(shape)
      .filter((key) => key !== 't')
      .map((key) => (required.has(key) ? key : `${key}?`))
      .sort()
  }
  return Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)))
}

function fieldPaths(schema: JsonSchema, prefix = ''): string[] {
  const shape = properties(schema)
  if (Object.keys(shape).length === 0) return [prefix]
  return Object.entries(shape).flatMap(([key, value]) =>
    fieldPaths(value, prefix ? `${prefix}.${key}` : key),
  )
}

function roleManifest(
  document: WorkerProtocolDocument,
  role: WorkerRole,
): WorkerProtocolManifest['roles'][WorkerRole] {
  const { protocol, clientToWorker, workerToClient } = document.roles[role]
  return {
    protocol,
    clientToWorker: messageFields(clientToWorker),
    workerToClient: messageFields(workerToClient),
  }
}

export function workerProtocolManifest(
  document: WorkerProtocolDocument = workerProtocolDocument(),
): WorkerProtocolManifest {
  return {
    $comment:
      'Generated by `pnpm run gen:worker-protocol`; do not edit by hand. The full JSON Schema is a build output (dist/schemas/worker-protocol.schema.json).',
    capabilities: fieldPaths(document.capabilities).sort(),
    roles: {
      turns: roleManifest(document, 'turns'),
      'container-run': roleManifest(document, 'container-run'),
    },
  }
}

export function serializeWorkerProtocol(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}
