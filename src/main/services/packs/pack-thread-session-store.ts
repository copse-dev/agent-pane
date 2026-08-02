import { storageGet, storageUpdate } from '../storage/storage.ts'

const MAX_SESSION_BYTES = 256 * 1024

export interface PackThreadSessionStore {
  get(packId: string, threadId: string): Promise<unknown>
  set(packId: string, threadId: string, state: unknown): Promise<void>
  delete(packId: string, threadId: string): Promise<void>
}

function sessionBagKey(packId: string): string {
  return `pack.${encodeURIComponent(packId)}.threadSessions`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validatePackThreadSessionState(state: unknown): void {
  if (state === undefined || typeof state === 'function' || typeof state === 'symbol') {
    throw new Error('Pack thread session state must be JSON serializable.')
  }
  let serialized: string
  try {
    serialized = JSON.stringify(state)
  } catch {
    throw new Error('Pack thread session state must be JSON serializable.')
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SESSION_BYTES) {
    throw new Error('Pack thread session state exceeds 256 KB.')
  }
}

/** Durable state keyed mechanically by both pack and Copse thread identity. */
export const persistentPackThreadSessionStore: PackThreadSessionStore = {
  get(packId, threadId) {
    const raw = storageGet(sessionBagKey(packId))
    const value = isRecord(raw) ? (raw[threadId] ?? null) : null
    validatePackThreadSessionState(value)
    return Promise.resolve(value)
  },
  async set(packId, threadId, state) {
    validatePackThreadSessionState(state)
    await storageUpdate(sessionBagKey(packId), (raw) => ({
      ...(isRecord(raw) ? raw : {}),
      [threadId]: state,
    }))
  },
  async delete(packId, threadId) {
    await storageUpdate(sessionBagKey(packId), (raw) => {
      return Object.fromEntries(
        Object.entries(isRecord(raw) ? raw : {}).filter(([key]) => key !== threadId),
      )
    })
  },
}
