// Pack service — P3 of docs/plans/hooks-and-feature-packs.md.
//
// The host wiring for the feature-pack layer:
//  - owns the **shared** `PackRegistry` (first-party packs registered), and
//    installs it via `setDefaultPackRegistry` so `createHookRegistry` (called
//    every turn) reads through the same instance the Settings UI toggles;
//  - applies the persisted disable set from `electron-store` before wiring the
//    provider, so a pack the user turned off stays off across relaunches;
//  - persists pack-scoped settings values under a namespaced storage key so
//    the manifest's declarative `settings` schema round-trips through Settings
//    generically (P3's "the about:addons of Copse");
//  - exposes `list()` / `setEnabled()` / `getSetting()` / `setSetting()` for
//    the `packs:*` IPC handlers.
//
// **Atomic enable/disable (P1 contract).** `setEnabled` flips a single flag on
// the shared registry — every one of the pack's contribution kinds drops from
// the active getters at once (tools, hooks, prompt blocks, panels). There is
// no partial state; persistence is a write-behind snapshot of `registry`.
//
// Storage layout under the shared `electron-store`:
//   `packDisabled`         → readonly string[]   (pack ids the user disabled)
//   `pack.<packId>.settings` → Record<string, unknown> (values keyed by field id)
//
// The disable list stays a plain array (like `mcpDisabledServers`) so it is
// still readable / editable by hand and easy to migrate. Pack settings are
// bagged per pack to keep the top-level key namespace clean and let the P4
// todos pack lift/shift its config into a single record.
import type { PackRegistry } from '@copse/agent/packs/pack-registry.ts'
import { createFirstPartyPackRegistry } from '@copse/agent/packs/first-party-packs.ts'
import { setDefaultPackRegistry } from '@copse/agent/packs/default-pack-registry.ts'
import { summarizePacks, type PackSummaryOut } from '@copse/agent/packs/pack-summary.ts'
import { storageGet, storageUpdate } from '../storage/storage.ts'
import { parseStringList } from '../storage/storage-schema.ts'

/** Storage key holding the ids of packs the user disabled. */
const PACK_DISABLED_KEY = 'packDisabled'

/** Storage key holding one pack's settings values (`packId` scoped). */
function packSettingsKey(packId: string): string {
  return `pack.${packId}.settings`
}

/** Read the persisted disable set. */
function readDisabledIds(): Set<string> {
  return new Set(parseStringList(storageGet(PACK_DISABLED_KEY)))
}

/** Read one pack's persisted settings bag (`{}` when nothing stored). */
function readPackSettings(packId: string): Record<string, unknown> {
  const raw = storageGet(packSettingsKey(packId))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as Record<string, unknown>
}

/**
 * The singleton pack service. Constructed lazily on first `getPackService()` so
 * host boot order (electron-store availability) is respected without an
 * explicit init call, and unit tests can create their own via `createPackService`.
 */
let singleton: PackService | null = null

/** Public shape: what the IPC handlers + tests actually use. */
export interface PackService {
  /** The shared registry, exposed so callers that need typed contributions can read it. */
  readonly registry: PackRegistry
  /** Snapshot every pack for the Settings pack list. */
  list(): readonly PackSummaryOut[]
  /**
   * Toggle a pack's enablement. Persists the change to `electron-store` and
   * flips the flag on the shared registry — atomic, per the P1 contract.
   */
  setEnabled(packId: string, enabled: boolean): Promise<void>
  /** Read one pack-scoped setting value (raw persisted value; renderer coerces). */
  getSetting(packId: string, key: string): unknown
  /** Persist one pack-scoped setting value under the pack's namespaced bag. */
  setSetting(packId: string, key: string, value: unknown): Promise<void>
}

/**
 * Build a pack service backed by the given registry. The persisted disable set
 * is applied before returning, so subsequent `getDefaultPackRegistry()` /
 * `createHookRegistry()` calls see the same enablement the Settings list will
 * show. Exposed for tests; production callers go through `getPackService`.
 */
export function createPackService(registry: PackRegistry): PackService {
  const disabled = readDisabledIds()
  for (const id of disabled) {
    if (registry.has(id)) registry.disable(id)
  }

  return {
    registry,
    list(): readonly PackSummaryOut[] {
      return summarizePacks(registry, (packId, key) => readPackSettings(packId)[key])
    },
    async setEnabled(packId: string, enabled: boolean): Promise<void> {
      if (!registry.has(packId)) return
      if (enabled) registry.enable(packId)
      else registry.disable(packId)
      await storageUpdate(PACK_DISABLED_KEY, (raw) => {
        const set = new Set(parseStringList(raw))
        if (enabled) set.delete(packId)
        else set.add(packId)
        return [...set].sort()
      })
    },
    getSetting(packId: string, key: string): unknown {
      return readPackSettings(packId)[key]
    },
    async setSetting(packId: string, key: string, value: unknown): Promise<void> {
      // Only keys the pack's manifest declares are persistable (P3 review): the
      // IPC caps value size, but without this any renderer bug (or compromise)
      // could grow arbitrary keys in any pack's bag forever.
      const pack = registry.has(packId) ? registry.get(packId) : undefined
      const declared = pack?.manifest.settings
      if (!declared || !(key in declared)) {
        throw new Error(`pack "${packId}" declares no setting "${key}"`)
      }
      await storageUpdate(packSettingsKey(packId), (raw) => {
        const current: Record<string, unknown> =
          raw && typeof raw === 'object' && !Array.isArray(raw)
            ? { ...(raw as Record<string, unknown>) }
            : {}
        current[key] = value
        return current
      })
    },
  }
}

/**
 * Boot the process-wide pack service and install its registry as the loop's
 * default. Safe to call multiple times — the second call returns the existing
 * singleton, which is exactly what the IPC handlers rely on.
 */
export function getPackService(): PackService {
  if (singleton) return singleton
  const registry = createFirstPartyPackRegistry()
  const service = createPackService(registry)
  setDefaultPackRegistry(registry)
  singleton = service
  return service
}

/** Reset for tests. Not exported through the barrel; tests import it directly. */
export function __resetPackServiceForTests(): void {
  singleton = null
  setDefaultPackRegistry(null)
}
