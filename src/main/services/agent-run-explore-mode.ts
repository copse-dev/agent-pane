import { AsyncLocalStorage } from 'node:async_hooks'
import type { ExploredSpan } from '@copse/agent/explore-excerpts.ts'

interface ExploreModeScope {
  exploreMode: boolean
  /** Every span the run's explore subagents read, for `read_explored` (#1433, Fix 0b). */
  explored: ExploredSpan[]
}

const store = new AsyncLocalStorage<ExploreModeScope>()

/**
 * Scopes "explore mode" to an agent run (and everything it awaits): true when
 * subagents are enabled, so the parent's context-gathering tools (`read_file`
 * among them, see `PARENT_DELEGATED_TOOLS`) are delegated to the `explore`
 * subagent and withheld from the parent. Tools whose failure messages name a
 * remedy read this so they never tell the model to call a tool it does not
 * have (#1433). The scope also retains what this run's explore subagents read,
 * so `read_explored` can quote it without another subagent turn.
 */
export function runWithAgentRunExploreMode<T>(exploreMode: boolean, fn: () => T): T {
  return store.run({ exploreMode, explored: [] }, fn)
}

export function isAgentRunExploreMode(): boolean {
  return store.getStore()?.exploreMode ?? false
}

/** Keeps the spans an explore subagent read for the rest of this run. No-op outside a run. */
export function retainExploredSpans(spans: readonly ExploredSpan[]): void {
  store.getStore()?.explored.push(...spans)
}

/** The spans this run's explore subagents read so far, in read order. */
export function exploredSpansThisRun(): readonly ExploredSpan[] {
  return store.getStore()?.explored ?? []
}
