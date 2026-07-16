// Host-owned shared detached async executor (C1).
//
// `packages/agent` defines the *policy* (`AsyncHookDispatcher`: per-thread
// concurrency cap + pending FIFO + drop, decision 13; never awaited, decision 3;
// turn-tree epoch on every dispatch, decision 16). The per-thread accounting
// must outlive the fresh-per-event registries the orchestrators build
// (`stop.ts`, and the async events D2/F2 wire later), so the app owns a single
// long-lived instance here and wires its drop sink to the spine recorder
// (execution-guidance rule 4: host services live in `src/main/services/hooks/`).
//
// Tests build their own dispatcher with small caps rather than poking this
// singleton, so its config stays the production default.
import { AsyncHookDispatcher } from '@copse/agent/hooks/async-dispatcher.ts'
import { recordDroppedAsyncDispatch } from '../hook-run-recorder.ts'

let shared: AsyncHookDispatcher | null = null

/**
 * The process-wide detached async executor. Lazily created with the decision-13
 * default caps; its drop sink records a `hook_run` spine line so an over-cap
 * drop is observable (never silent). Shared across every async fire site so the
 * concurrency cap is genuinely per-thread across events, not per-emit.
 */
export function getAsyncHookDispatcher(): AsyncHookDispatcher {
  if (shared) return shared
  shared = new AsyncHookDispatcher({
    onDrop: (record): void => {
      recordDroppedAsyncDispatch({
        event: record.event,
        hookId: record.hookId,
        executor: record.executor,
      })
    },
  })
  return shared
}
