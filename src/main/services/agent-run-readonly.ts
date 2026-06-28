import { AsyncLocalStorage } from 'node:async_hooks'

const store = new AsyncLocalStorage<boolean>()

/** Scopes the read-only flag to an agent run (and everything it awaits). */
export function runWithAgentRunReadonly<T>(readonly: boolean, fn: () => T): T {
  return store.run(readonly, fn)
}

export function isAgentRunReadonly(): boolean {
  return store.getStore() ?? false
}
