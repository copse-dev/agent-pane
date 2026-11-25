import type { ExternalSessionSource, Thread } from '@shared/types'
import { el } from '../dom/helpers.ts'

export function externalSessionSourceLabel(source: ExternalSessionSource): string {
  return source === 'claude-code' ? 'Claude Code' : 'Codex'
}

/**
 * The line above an imported thread's transcript. The earlier turns did not
 * run under Copse's sandbox or approvals, and the transcript must not let
 * them read as though they had.
 */
export function importedSessionNotice(thread: Thread): HTMLElement | null {
  const imported = thread.importedSession
  if (!imported) return null
  const source = externalSessionSourceLabel(imported.source)
  return el(
    'div',
    { class: 'imported-session-notice', role: 'note', 'data-source': imported.source },
    el('strong', {}, `Imported from ${source}.`),
    ` Earlier messages and tool calls ran in ${source}, outside Copse’s sandbox and approvals.`,
  )
}
