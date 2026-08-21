import { getThreadExecutionContext } from '../thread-execution-context.ts'

/**
 * Turn-scoped external-ingestion marker (context-provenance plan, Phase 4).
 *
 * When any external-provenance tool result (web page, MCP output, GitHub/CI
 * text, terminal scrollback) lands during an agent turn, the turn is marked so
 * `remember` can record that the memory was authored with untrusted content in
 * context — the one channel that carries a prompt injection across threads.
 *
 * Keyed on the turn's {@link getThreadExecutionContext} object via a WeakSet:
 * each agent run resolves its own context, so the mark dies with the turn and
 * needs no reset bookkeeping. Recording and surfacing only — nothing blocks,
 * and no permission decision reads this.
 */

const taintedTurns = new WeakSet<object>()

/** Record that the current turn has ingested external-provenance content. */
export function markTurnExternalIngestion(): void {
  const context = getThreadExecutionContext()
  if (context !== null) taintedTurns.add(context)
}

/** Whether the current turn has ingested external-provenance content. */
export function turnIngestedExternalContent(): boolean {
  const context = getThreadExecutionContext()
  return context !== null && taintedTurns.has(context)
}
