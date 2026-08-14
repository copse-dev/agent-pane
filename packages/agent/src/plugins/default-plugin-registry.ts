// Default plugin-registry seam — P3 of the feature-plugin layer.
//
// `createHookRegistry` folds a `PluginRegistry` into the hook registry every turn
// (P1: a plugin's function hooks register through the same registry the loop
// uses, so disabling a plugin removes them from new work atomically). In P1 this
// was a fresh `createFirstPartyPluginRegistry()` per call — fine while P1's
// original skeleton plugin contributed nothing, but once a plugin contributes
// hooks or has a user-persisted disable state, the loop needs to consult the
// **same** registry the Settings UI toggles.
//
// P3 fixes that with a module-level provider: the host boots, builds a shared
// registry (first-party plugins registered + persisted `disabledIds` applied),
// and installs it via {@link setDefaultPluginRegistry}. Any subsequent call to
// {@link getDefaultPluginRegistry} (from `createHookRegistry`) sees the shared
// instance. Uninitialized fallback: a fresh first-party registry, keeping
// tests and the P1 byte-identical behavior when no host is wired.
//
// Electron-free (execution-guidance rule 4): pure module state. The host wires
// this in `src/main/services/plugins/plugin-service.ts`.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { PluginRegistry } from './plugin-registry.ts'
import { createFirstPartyPluginRegistry } from './first-party-plugins.ts'

let installed: PluginRegistry | null = null
const scopedRegistry = new AsyncLocalStorage<PluginRegistry>()

/** Scope plugin enablement/storage to one explicit host run without replacing the desktop registry. */
export function runWithDefaultPluginRegistry<T>(registry: PluginRegistry, fn: () => T): T {
  return scopedRegistry.run(registry, fn)
}

/**
 * Install the process-wide plugin registry the loop consults for enabled plugins.
 * The host calls this once at boot after applying persisted enable/disable
 * state. Re-installation (e.g. tests) replaces the previous instance; nothing
 * inspects the outgoing one because the loop reads through this provider each
 * turn, not through a captured reference.
 */
export function setDefaultPluginRegistry(registry: PluginRegistry | null): void {
  installed = registry
}

/**
 * The current shared plugin registry, or a fresh first-party seed when none has
 * been installed yet. The fallback keeps unit tests + `createHookRegistry`
 * callers in `packages/agent` working without host wiring. Post-P4 the seed
 * carries the `copse.todos` plugin's typed hooks/tool/panel contributions, so
 * unwired callers see the same shipped surface a fresh install would.
 */
export function getDefaultPluginRegistry(): PluginRegistry {
  return scopedRegistry.getStore() ?? installed ?? createFirstPartyPluginRegistry()
}
