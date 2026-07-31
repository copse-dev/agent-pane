// Default pack-registry seam — P3 of the feature-pack layer.
//
// `createHookRegistry` folds a `PackRegistry` into the hook registry every turn
// (P1: a pack's function hooks register through the same registry the loop
// uses, so disabling a pack removes them from new work atomically). In P1 this
// was a fresh `createFirstPartyPackRegistry()` per call — fine while P1's
// original skeleton pack contributed nothing, but once a pack contributes
// hooks or has a user-persisted disable state, the loop needs to consult the
// **same** registry the Settings UI toggles.
//
// P3 fixes that with a module-level provider: the host boots, builds a shared
// registry (first-party packs registered + persisted `disabledIds` applied),
// and installs it via {@link setDefaultPackRegistry}. Any subsequent call to
// {@link getDefaultPackRegistry} (from `createHookRegistry`) sees the shared
// instance. Uninitialized fallback: a fresh first-party registry, keeping
// tests and the P1 byte-identical behavior when no host is wired.
//
// Electron-free (execution-guidance rule 4): pure module state. The host wires
// this in `src/main/services/packs/pack-service.ts`.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { PackRegistry } from './pack-registry.ts'
import { createFirstPartyPackRegistry } from './first-party-packs.ts'

let installed: PackRegistry | null = null
const scopedRegistry = new AsyncLocalStorage<PackRegistry>()

/** Scope pack enablement/storage to one explicit host run without replacing the desktop registry. */
export function runWithDefaultPackRegistry<T>(registry: PackRegistry, fn: () => T): T {
  return scopedRegistry.run(registry, fn)
}

/**
 * Install the process-wide pack registry the loop consults for enabled packs.
 * The host calls this once at boot after applying persisted enable/disable
 * state. Re-installation (e.g. tests) replaces the previous instance; nothing
 * inspects the outgoing one because the loop reads through this provider each
 * turn, not through a captured reference.
 */
export function setDefaultPackRegistry(registry: PackRegistry | null): void {
  installed = registry
}

/**
 * The current shared pack registry, or a fresh first-party seed when none has
 * been installed yet. The fallback keeps unit tests + `createHookRegistry`
 * callers in `packages/agent` working without host wiring. Post-P4 the seed
 * carries the `copse.todos` pack's typed hooks/tool/panel contributions, so
 * unwired callers see the same shipped surface a fresh install would.
 */
export function getDefaultPackRegistry(): PackRegistry {
  return scopedRegistry.getStore() ?? installed ?? createFirstPartyPackRegistry()
}
