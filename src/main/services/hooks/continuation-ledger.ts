// Host accessor for the process-wide continuation ledger (decision 5).
//
// The auto-continuation budget is a single counter per turn tree
// ({@link ContinuationLedger} in the Electron-free `packages/agent`). The main
// process owns **one** long-lived instance so the in-run machine-turn mechanisms
// of a single run — todo closeout, the pre-review todo gate, and post-turn
// remediation cycles — share one counter and tighten inside the shared cap. It
// mirrors `async-hook-dispatcher.ts`'s process-wide singleton: the per-run
// orchestration builds a fresh registry each turn, but the budget must outlive
// that so a turn tree's spend is not reset mid-flight.
//
// Cross-surface note (docs/plans/hooks-and-feature-packs.md, C3): the renderer
// is authoritative for **queue-drain** continuations (hook send-now, stop /
// subagent follow-ups) and enforces the drain-time held check on the thread's
// per-turn-tree counter. It passes the already-spent count to the run on the
// payload, which the run {@link ContinuationLedger.seed}s here so the in-run
// tighteners share the same counter (drain → run direction). The run reports
// its in-run spend back with a `continuation_budget` chunk just before the
// terminal `done` (run → drain direction), which the renderer folds onto
// `Thread.continuationUsed` (epoch-guarded, monotonic) — so the shared cap
// holds in both directions within one turn tree.
import { ContinuationLedger } from '@copse/agent/hooks/continuation-budget.ts'

let ledger: ContinuationLedger | null = null

/** The process-wide continuation ledger, created lazily. */
export function getContinuationLedger(): ContinuationLedger {
  ledger ??= new ContinuationLedger()
  return ledger
}
