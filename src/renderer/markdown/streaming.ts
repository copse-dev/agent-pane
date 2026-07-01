import { renderMarkdown } from './renderer.ts'
import { getIncompleteTableSource, pendingLineBelongsInTable } from './block-tokenizer.ts'
import {
  pendingListMarkerLength,
  pendingListOrderedMarker,
  renderPendingLine,
} from './render-pending-line.ts'
import { splitForStreaming } from './streaming-split.ts'
import { escapeHtml } from './escape.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import {
  buildFormingTableHtml,
  clearFormingTableDom,
  removePendingTableRow,
  syncFormingTableDom,
  syncPendingTableRowDom,
} from './streaming-table-dom.ts'

export { pendingHoldIndex } from './inline-emphasis.ts'
export { splitAtLastNewline, splitForStreaming } from './streaming-split.ts'
export {
  completeEndsInOpenTable,
  getIncompleteTableSource,
  isAmbiguousBlockLine,
  isPotentialTableStart,
  pendingLineBelongsInTable,
  splitTableRow,
  tokenizeBlocks,
} from './block-tokenizer.ts'

function renderPendingInlineMarkdown(pending: string): string {
  return renderPendingLine(pending)
}

function pendingSpanHtml(pending: string, pendingHtml: string): string {
  if (pendingListMarkerLength(pending) === null) {
    return `<span class="stream-pending">${pendingHtml}</span>`
  }
  const ordered = pendingListOrderedMarker(pending)
  const classes = ordered
    ? 'stream-pending stream-pending-list-item stream-pending-ordered-item'
    : 'stream-pending stream-pending-list-item'
  const markerAttr = ordered ? ` data-ordered-marker="${escapeHtml(ordered)}"` : ''
  return `<span class="${classes}"${markerAttr}>${pendingHtml}</span>`
}

function syncPendingListPresentation(
  pendingEl: HTMLSpanElement,
  pending: string,
  active: boolean,
): void {
  const isList = active && pendingListMarkerLength(pending) !== null
  pendingEl.classList.toggle('stream-pending-list-item', isList)
  const ordered = isList ? pendingListOrderedMarker(pending) : null
  pendingEl.classList.toggle('stream-pending-ordered-item', ordered !== null)
  if (ordered !== null) pendingEl.dataset['orderedMarker'] = ordered
  else delete pendingEl.dataset['orderedMarker']
}

function formingTableSource(content: string, pending: string): string | null {
  const fromTokens = getIncompleteTableSource(content)
  if (fromTokens) return fromTokens
  const trimmed = pending.trimStart()
  if (trimmed.startsWith('|') && trimmed.includes('|', 1)) return pending
  return null
}

/**
 * Render assistant text while it is still streaming.
 * Completed blocks (per the block tokenizer) are markdown-rendered; the pending
 * tail only renders safe inline markdown once its block context is unambiguous.
 */
export function renderStreamingMarkdown(content: string): string {
  const { complete, pending } = splitForStreaming(content)
  const rendered = complete ? sanitizeRenderedMarkdown(renderMarkdown(complete)) : ''
  const formingSource = formingTableSource(content, pending)
  const formingHtml = formingSource ? buildFormingTableHtml(formingSource) : ''

  if (formingSource) {
    return `${rendered}${formingHtml}`
  }
  if (!pending) return rendered
  if (pendingLineBelongsInTable(complete, pending)) return rendered
  const pendingHtml = sanitizeRenderedMarkdown(renderPendingInlineMarkdown(pending))
  if (!pendingHtml) return rendered
  return `${rendered}${pendingSpanHtml(pending, pendingHtml)}`
}

/**
 * Incremental streaming renderer.
 *
 * Committed markdown is re-rendered when the safe prefix grows. Forming tables
 * and in-progress table rows are updated via forward-pass DOM appends (no full
 * re-parse of the table skeleton on each token).
 */
export class StreamingMarkdownRenderer {
  private completedEl: HTMLElement | null = null
  private formingEl: HTMLElement | null = null
  private pendingEl: HTMLSpanElement | null = null
  private lastComplete = ''
  private readonly host: HTMLElement

  constructor(host: HTMLElement) {
    this.host = host
  }

  /** Render `content` (the full message text so far) into the host incrementally. */
  update(content: string): void {
    const { complete, pending } = splitForStreaming(content)
    const { completedEl, formingEl, pendingEl } = this.ensureNodes()

    if (complete !== this.lastComplete) {
      completedEl.innerHTML = complete ? sanitizeRenderedMarkdown(renderMarkdown(complete)) : ''
      this.lastComplete = complete
    }

    const formingSource = formingTableSource(content, pending)
    if (formingSource) {
      syncFormingTableDom(formingEl, formingSource)
      formingEl.hidden = false
      const committed = this.findLastCommittedTable()
      if (committed) removePendingTableRow(committed)
    } else {
      clearFormingTableDom(formingEl)
      formingEl.hidden = true
      this.syncCommittedTableRow(complete, pending)
    }

    const pendingInTable = pendingLineBelongsInTable(complete, pending)
    const pendingHtml =
      pending && !pendingInTable && formingSource === null
        ? sanitizeRenderedMarkdown(renderPendingInlineMarkdown(pending))
        : ''
    pendingEl.innerHTML = pendingHtml
    const pendingVisible =
      pending !== '' && !pendingInTable && formingSource === null && pendingHtml !== ''
    pendingEl.hidden = !pendingVisible
    syncPendingListPresentation(pendingEl, pending, pendingVisible)
  }

  private syncCommittedTableRow(complete: string, pending: string): void {
    const table = this.findLastCommittedTable()
    if (!table) return

    if (pendingLineBelongsInTable(complete, pending)) {
      syncPendingTableRowDom(table, pending)
      return
    }
    removePendingTableRow(table)
  }

  private findLastCommittedTable(): HTMLTableElement | null {
    const tables = this.completedEl?.querySelectorAll('table')
    const last = tables?.[tables.length - 1]
    if (last instanceof Element && last.tagName === 'TABLE') {
      return last
    }
    return null
  }

  private ensureNodes(): {
    completedEl: HTMLElement
    formingEl: HTMLElement
    pendingEl: HTMLSpanElement
  } {
    if (
      this.completedEl &&
      this.formingEl &&
      this.pendingEl &&
      this.host.contains(this.completedEl)
    ) {
      return {
        completedEl: this.completedEl,
        formingEl: this.formingEl,
        pendingEl: this.pendingEl,
      }
    }
    this.host.replaceChildren()
    const completedEl = document.createElement('div')
    completedEl.className = 'stream-complete'
    const formingEl = document.createElement('div')
    formingEl.className = 'stream-forming'
    formingEl.hidden = true
    const pendingEl = document.createElement('span')
    pendingEl.className = 'stream-pending'
    this.host.append(completedEl, formingEl, pendingEl)
    this.completedEl = completedEl
    this.formingEl = formingEl
    this.pendingEl = pendingEl
    this.lastComplete = ''
    return { completedEl, formingEl, pendingEl }
  }
}
