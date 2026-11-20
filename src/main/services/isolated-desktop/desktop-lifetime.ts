import { AsyncLocalStorage } from 'node:async_hooks'

const lifetime = new AsyncLocalStorage<AbortSignal>()

/** ACP desktop authority belongs to the bound turn, not an individual HTTP request. */
export function runWithIsolatedDesktopLifetime<T>(signal: AbortSignal, run: () => T): T {
  signal.throwIfAborted()
  return lifetime.run(signal, run)
}

export function getIsolatedDesktopLifetime(): AbortSignal | undefined {
  return lifetime.getStore()
}
