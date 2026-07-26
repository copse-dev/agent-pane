import type { LLMMessage } from '@shared/types'
import { agentHistoryExists, findThreadOwners, saveAgentHistory } from './thread-store.ts'
import { storageDeleteKeys, storageGet, storageListKeys } from './storage/storage.ts'

/**
 * ONE-TIME migration (issue #993). Moves provider-format history out of
 * electron-store `llm-history:<threadId>` keys into per-thread
 * `agent-history.json` sidecars under `~/.copse/workspace`, then deletes the
 * migrated keys in a single config.json rewrite.
 *
 * Ordering (enforced by the call site in `main/index.ts`):
 *   migrateLlmHistory() → createMainWindow()
 *
 * Idempotent: sidecar writes happen first; an existing sidecar is never
 * overwritten (a restart after interruption, or post-migration agent activity,
 * may already hold fresher history). Legacy keys are removed only after their
 * sidecar is known to exist. Missing or ambiguous ownership stays in legacy
 * storage with a metadata-only warning — never logs history values.
 */

export const LLM_HISTORY_KEY_PREFIX = 'llm-history:'

export interface LlmHistoryMigrationResult {
  scanned: number
  migrated: number
  skippedExistingSidecar: number
  skippedNull: number
  ambiguousOwners: number
  missingOwners: number
  legacyKeysRemoved: number
}

export interface LlmHistoryMigrationDeps {
  listLegacyKeys: () => string[]
  getLegacy: (key: string) => unknown
  deleteLegacyKeys: (keys: string[]) => void
  findOwners: (threadId: string) => Promise<string[]>
  historyExists: (projectId: string, threadId: string) => Promise<boolean>
  saveHistory: (projectId: string, threadId: string, messages: LLMMessage[]) => Promise<void>
  warn: (message: string) => void
}

function defaultDeps(): LlmHistoryMigrationDeps {
  return {
    listLegacyKeys: () => storageListKeys().filter((key) => key.startsWith(LLM_HISTORY_KEY_PREFIX)),
    getLegacy: storageGet,
    deleteLegacyKeys: storageDeleteKeys,
    findOwners: findThreadOwners,
    historyExists: agentHistoryExists,
    saveHistory: saveAgentHistory,
    warn: (message: string): void => {
      console.warn(`[llm-history-migration] ${message}`)
    },
  }
}

function isLlmMessageArray(value: unknown): value is LLMMessage[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { role?: unknown }).role === 'string',
    )
  )
}

/**
 * Migrate every `llm-history:*` key that resolves to exactly one thread owner.
 * Safe to call on every launch.
 */
export async function migrateLlmHistory(
  overrides: Partial<LlmHistoryMigrationDeps> = {},
): Promise<LlmHistoryMigrationResult> {
  const deps: LlmHistoryMigrationDeps = { ...defaultDeps(), ...overrides }
  const keys = deps.listLegacyKeys()
  const result: LlmHistoryMigrationResult = {
    scanned: keys.length,
    migrated: 0,
    skippedExistingSidecar: 0,
    skippedNull: 0,
    ambiguousOwners: 0,
    missingOwners: 0,
    legacyKeysRemoved: 0,
  }
  if (keys.length === 0) return result

  const removable: string[] = []

  for (const key of keys) {
    const threadId = key.slice(LLM_HISTORY_KEY_PREFIX.length)
    if (threadId.length === 0) {
      deps.warn(`skipping empty thread id key`)
      continue
    }

    const owners = await deps.findOwners(threadId)
    if (owners.length === 0) {
      result.missingOwners += 1
      deps.warn(`no owner for thread ${threadId}; leaving legacy key in place`)
      continue
    }
    if (owners.length > 1) {
      result.ambiguousOwners += 1
      deps.warn(
        `ambiguous owners for thread ${threadId} (${String(owners.length)} projects); leaving legacy key in place`,
      )
      continue
    }
    const projectId = owners[0]
    if (projectId === undefined) continue

    if (await deps.historyExists(projectId, threadId)) {
      // Sidecar already present (prior partial run or newer agent write) — do
      // not clobber; just drop the legacy key.
      result.skippedExistingSidecar += 1
      removable.push(key)
      continue
    }

    const stored = deps.getLegacy(key)
    if (stored === null || stored === undefined) {
      // Cleared history: nothing to write; remove the null placeholder.
      result.skippedNull += 1
      removable.push(key)
      continue
    }
    if (!isLlmMessageArray(stored)) {
      deps.warn(`unreadable legacy value for thread ${threadId}; leaving key in place`)
      continue
    }

    await deps.saveHistory(projectId, threadId, stored)
    result.migrated += 1
    removable.push(key)
  }

  if (removable.length > 0) {
    deps.deleteLegacyKeys(removable)
    result.legacyKeysRemoved = removable.length
  }

  return result
}
