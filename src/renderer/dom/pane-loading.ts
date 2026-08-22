import { el } from './helpers.ts'
import { inlineStatus } from './inline-status.ts'

/**
 * The row a list pane shows while its first fetch is still in flight.
 *
 * Panes that render their settled empty state during that window state
 * something false about the workspace — "No changes", "Not a git repository",
 * "No memories yet" — and state it in exactly the shape the true answer takes,
 * so nothing tells the user the pane simply hasn't looked yet. A spinner keeps
 * the wait legible, and (unlike bare "Loading…" text) makes an unusually slow
 * fetch read as work in progress rather than a settled result.
 */
export function paneLoadingRow(text: string): HTMLDivElement {
  return el('div', { class: 'git-changes-empty pane-loading' }, inlineStatus('pending', text))
}
