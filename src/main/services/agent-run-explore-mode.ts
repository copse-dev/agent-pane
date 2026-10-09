import { AsyncLocalStorage } from 'node:async_hooks'

const store = new AsyncLocalStorage<boolean>()

/**
 * Scopes "explore mode" to an agent run (and everything it awaits): true when
 * subagents are enabled, so the parent's context-gathering tools (`read_file`
 * among them, see `PARENT_DELEGATED_TOOLS`) are delegated to the `explore`
 * subagent and withheld from the parent. Tools whose failure messages name a
 * remedy read this so they never tell the model to call a tool it does not
 * have (#1433).
 */
export function runWithAgentRunExploreMode<T>(exploreMode: boolean, fn: () => T): T {
  return store.run(exploreMode, fn)
}

export function isAgentRunExploreMode(): boolean {
  return store.getStore() ?? false
}
