import { AsyncLocalStorage } from 'node:async_hooks'
import type { ExploredSpan } from '@copse/agent/explore-excerpts.ts'

/**
 * Collects the exact spans `read_file` returns while an explore subagent runs
 * (#1433, Fix 0). The subagent's summary is a retelling; these are the bytes
 * the harness already held, which `runExploreSubagent` renders after the
 * summary so the parent can prepare `str_replace` from them.
 *
 * AsyncLocalStorage, not a module slot: the parent loop runs several explore
 * calls concurrently, and each subagent must only see its own reads. Outside
 * an explore subagent there is no recorder and `recordExploredSpan` is a no-op.
 */
const recorderStorage = new AsyncLocalStorage<(span: ExploredSpan) => void>()

export function runWithExploredSpanRecorder<T>(
  record: (span: ExploredSpan) => void,
  fn: () => Promise<T>,
): Promise<T> {
  return recorderStorage.run(record, fn)
}

export function recordExploredSpan(span: ExploredSpan): void {
  recorderStorage.getStore()?.(span)
}
