import { storageGet, storageUpdate } from '../storage/storage.ts'

const MAX_SESSION_BYTES = 256 * 1024

export interface PluginThreadSessionStore {
  get(pluginId: string, threadId: string): Promise<unknown>
  set(pluginId: string, threadId: string, state: unknown): Promise<void>
  delete(pluginId: string, threadId: string): Promise<void>
}

function sessionBagKey(pluginId: string): string {
  return `pack.${encodeURIComponent(pluginId)}.threadSessions`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validatePluginThreadSessionState(state: unknown): void {
  if (state === undefined || typeof state === 'function' || typeof state === 'symbol') {
    throw new Error('Plugin thread session state must be JSON serializable.')
  }
  let serialized: string
  try {
    serialized = JSON.stringify(state)
  } catch {
    throw new Error('Plugin thread session state must be JSON serializable.')
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SESSION_BYTES) {
    throw new Error('Plugin thread session state exceeds 256 KB.')
  }
}

/** Durable state keyed mechanically by both plugin and Copse thread identity. */
export const persistentPluginThreadSessionStore: PluginThreadSessionStore = {
  get(pluginId, threadId) {
    const raw = storageGet(sessionBagKey(pluginId))
    const value = isRecord(raw) ? (raw[threadId] ?? null) : null
    validatePluginThreadSessionState(value)
    return Promise.resolve(value)
  },
  async set(pluginId, threadId, state) {
    validatePluginThreadSessionState(state)
    await storageUpdate(sessionBagKey(pluginId), (raw) => ({
      ...(isRecord(raw) ? raw : {}),
      [threadId]: state,
    }))
  },
  async delete(pluginId, threadId) {
    await storageUpdate(sessionBagKey(pluginId), (raw) => {
      return Object.fromEntries(
        Object.entries(isRecord(raw) ? raw : {}).filter(([key]) => key !== threadId),
      )
    })
  },
}
