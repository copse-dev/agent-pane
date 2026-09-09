import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import {
  eventInboxRecordSchema,
  type EventInboxRecord,
} from '@shared/supervisor/event-inbox-schema.ts'
import { projectStoreDir } from '../storage/copse-paths.ts'
import { runSerialized } from '../storage/write-queue.ts'

export function eventDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function eventInboxKey(record: Pick<EventInboxRecord, 'binding' | 'delivery'>): string {
  return eventDigest(
    JSON.stringify([
      record.binding.projectId,
      record.binding.automationId,
      record.binding.definitionRevision,
      record.delivery.sourceId,
      record.delivery.connectionId,
      record.delivery.deliveryId,
    ]),
  )
}

export interface EventInboxStore {
  get(projectId: string, key: string): Promise<EventInboxRecord | null>
  list(projectId: string): Promise<EventInboxRecord[]>
  update(
    projectId: string,
    key: string,
    update: (current: EventInboxRecord | null) => EventInboxRecord,
  ): Promise<EventInboxRecord>
}

/** Single app writer, atomic replacement; corrupt identities fail closed, never become new deliveries. */
export class FileEventInboxStore implements EventInboxStore {
  private readonly env: NodeJS.ProcessEnv
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env
  }

  private root(projectId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(projectId)) throw new Error('Invalid event project identity')
    return join(projectStoreDir(projectId, this.env), 'event-inbox')
  }

  private path(projectId: string, key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid event inbox identity')
    return join(this.root(projectId), `${key}.json`)
  }

  private read(projectId: string, key: string): EventInboxRecord | null {
    const path = this.path(projectId, key)
    if (!existsSync(path)) return null
    const record = safeJsonParse(
      readFileSync(path, 'utf8'),
      decodeWithSchema(eventInboxRecordSchema),
    )
    if (
      !record ||
      record.key !== key ||
      record.binding.projectId !== projectId ||
      eventInboxKey(record) !== key ||
      eventDigest(record.delivery.payload) !== record.payloadSha256
    ) {
      throw new Error(`Invalid event inbox record: ${key}`)
    }
    return record
  }

  get(projectId: string, key: string): Promise<EventInboxRecord | null> {
    return runSerialized(this.path(projectId, key), () => this.read(projectId, key))
  }

  list(projectId: string): Promise<EventInboxRecord[]> {
    return runSerialized(this.root(projectId), () => {
      const root = this.root(projectId)
      if (!existsSync(root)) return []
      return readdirSync(root)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => {
          const record = this.read(projectId, name.slice(0, -5))
          if (!record) throw new Error('Event inbox record disappeared during recovery')
          return record
        })
    })
  }

  update(
    projectId: string,
    key: string,
    update: (current: EventInboxRecord | null) => EventInboxRecord,
  ): Promise<EventInboxRecord> {
    return runSerialized(this.path(projectId, key), () => {
      const current = this.read(projectId, key)
      const next = eventInboxRecordSchema.parse(update(current ? structuredClone(current) : null))
      if (
        next.key !== key ||
        next.binding.projectId !== projectId ||
        eventInboxKey(next) !== key ||
        eventDigest(next.delivery.payload) !== next.payloadSha256
      ) {
        throw new Error('Event inbox write does not match its identity')
      }
      if (
        current &&
        (JSON.stringify(current.binding) !== JSON.stringify(next.binding) ||
          JSON.stringify(current.delivery) !== JSON.stringify(next.delivery) ||
          current.receivedAt !== next.receivedAt ||
          (current.runId && current.runId !== next.runId))
      ) {
        throw new Error('Event evidence and claimed run identities are immutable')
      }
      if (current && current.state !== next.state) {
        const transitions: Record<EventInboxRecord['state'], readonly EventInboxRecord['state'][]> =
          {
            admitted: ['claimed', 'fenced'],
            claimed: ['queued', 'prepared', 'fenced'],
            queued: ['prepared', 'fenced'],
            prepared: [],
            filtered: [],
            fenced: [],
          }
        if (!transitions[current.state].includes(next.state))
          throw new Error('Invalid event inbox state transition')
      }
      const path = this.path(projectId, key)
      mkdirSync(this.root(projectId), { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, `${JSON.stringify(next)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
          flush: true,
        })
        renameSync(temporary, path)
      } finally {
        rmSync(temporary, { force: true })
      }
      return next
    })
  }
}
