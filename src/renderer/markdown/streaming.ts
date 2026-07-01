import { renderMarkdown } from './renderer.ts'
import {
  getIncompleteFenceSource,
  getIncompleteTableSource,
  isAmbiguousBlockLine,
  pendingLineBelongsInTable,
} from './block-tokenizer.ts'
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
import {
  buildFormingFenceHtml,
  clearFormingFenceDom,
  syncFormingFenceDom,
} from './streaming-fence-dom.ts'

export { pendingHoldIndex } from './inline-emphasis.ts'
export { splitAtLastNewline, splitForStreaming } from './streaming-split.ts'
export {
  completeEndsInOpenTable,
  getIncompleteFenceSource,
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
    const paragraphLike =
      pending.trim() !== '' && !isAmbiguousBlockLine(pending) && !pending.includes('\n')
    const classes = paragraphLike ? 'stream-pending stream-pending-paragraph' : 'stream-pending'
    return `<span class="${classes}">${pendingHtml}</span>`
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
  const paragraphLike =
    active &&
    !isList &&
    pending.trim() !== '' &&
    !isAmbiguousBlockLine(pending) &&
    !pending.includes('\n')
  pendingEl.classList.toggle('stream-pending-paragraph', paragraphLike)
  if (ordered !== null) pendingEl.dataset['orderedMarker'] = ordered
  else delete pendingEl.dataset['orderedMarker']
}

function formingTableSource(content: string, pending: string): string | null {
  if (getIncompleteFenceSource(content)) return null
  const fromTokens = getIncompleteTableSource(content)
  if (fromTokens) return fromTokens
  const trimmed = pending.trimStart()
  if (trimmed.startsWith('|') && trimmed.includes('|', 1)) return pending
  return null
}

function formingFenceSource(content: string): string | null {
  return getIncompleteFenceSource(content)
}

function clearFormingDom(container: HTMLElement): void {
  clearFormingTableDom(container)
  clearFormingFenceDom(container)
}

/**
 * Render assistant text while it is still streaming.
 * Completed blocks (per the block tokenizer) are markdown-rendered; the pending
 * tail only renders safe inline markdown once its block context is unambiguous.
 */
export function renderStreamingMarkdown(content: string): string {
  const { complete, pending } = splitForStreaming(content)
  const rendered = complete ? sanitizeRenderedMarkdown(renderMarkdown(complete)) : ''
  const fenceSource = formingFenceSource(content)
  const tableSource = fenceSource ? null : formingTableSource(content, pending)
  const formingHtml = fenceSource
    ? buildFormingFenceHtml(fenceSource)
    : tableSource
      ? buildFormingTableHtml(tableSource)
      : ''

  if (formingHtml) {
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

    const fenceSource = formingFenceSource(content)
    const tableSource = formingTableSource(content, pending)
    if (fenceSource) {
      syncFormingFenceDom(formingEl, fenceSource)
      formingEl.hidden = false
      const committed = this.findLastCommittedTable()
      if (committed) removePendingTableRow(committed)
    } else if (tableSource) {
      syncFormingTableDom(formingEl, tableSource)
      formingEl.hidden = false
      const committed = this.findLastCommittedTable()
      if (committed) removePendingTableRow(committed)
    } else {
      clearFormingDom(formingEl)
      formingEl.hidden = true
      this.syncCommittedTableRow(complete, pending)
    }

    const formingActive = fenceSource !== null || tableSource !== null
    const pendingInTable = pendingLineBelongsInTable(complete, pending)
    const pendingHtml =
      pending && !pendingInTable && !formingActive
        ? sanitizeRenderedMarkdown(renderPendingInlineMarkdown(pending))
        : ''
    pendingEl.innerHTML = pendingHtml
    const pendingVisible = pending !== '' && !pendingInTable && !formingActive && pendingHtml !== ''
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
