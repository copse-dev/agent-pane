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

const BLOCK_PENDING_CLASS = 'stream-pending-block'

function renderPendingInlineMarkdown(pending: string): string {
  return renderPendingLine(pending)
}

/** Block-level pending tail (open paragraph or list line) — rendered inside stream-complete. */
export function isBlockLevelPending(pending: string): boolean {
  if (!pending.trim() || pending.includes('\n')) return false
  if (pendingListMarkerLength(pending) !== null) return true
  return !isAmbiguousBlockLine(pending)
}

function blockPendingTag(pending: string): 'p' | 'div' {
  return pendingListMarkerLength(pending) !== null ? 'div' : 'p'
}

function blockPendingClassName(pending: string): string {
  if (pendingListMarkerLength(pending) !== null) {
    const ordered = pendingListOrderedMarker(pending)
    return ordered
      ? `stream-pending stream-pending-list-item stream-pending-ordered-item ${BLOCK_PENDING_CLASS}`
      : `stream-pending stream-pending-list-item ${BLOCK_PENDING_CLASS}`
  }
  return `stream-pending stream-pending-paragraph ${BLOCK_PENDING_CLASS}`
}

function blockPendingAttrs(pending: string): string {
  const ordered = pendingListOrderedMarker(pending)
  return ordered ? ` data-ordered-marker="${escapeHtml(ordered)}"` : ''
}

function blockPendingHtml(pending: string, pendingInner: string): string {
  const tag = blockPendingTag(pending)
  return `<${tag} class="${blockPendingClassName(pending)}"${blockPendingAttrs(pending)}>${pendingInner}</${tag}>`
}

function inlinePendingSpanHtml(pendingInner: string): string {
  return `<span class="stream-pending">${pendingInner}</span>`
}

function syncBlockPendingDom(
  completedEl: HTMLElement,
  pending: string,
  pendingInner: string,
  active: boolean,
): void {
  const existing = completedEl.querySelector(`:scope > .${BLOCK_PENDING_CLASS}`)
  if (!active || !pendingInner) {
    existing?.remove()
    return
  }
  const tag = blockPendingTag(pending)
  let el: Element | null = existing
  if (!el || el.tagName.toLowerCase() !== tag) {
    existing?.remove()
    el = document.createElement(tag)
    completedEl.append(el)
  }
  el.className = blockPendingClassName(pending)
  const ordered = pendingListOrderedMarker(pending)
  if (ordered !== null) el.setAttribute('data-ordered-marker', ordered)
  else el.removeAttribute('data-ordered-marker')
  el.innerHTML = pendingInner
}

function syncInlinePendingDom(
  pendingEl: HTMLSpanElement,
  pendingInner: string,
  active: boolean,
): void {
  pendingEl.innerHTML = pendingInner
  pendingEl.hidden = !active
  pendingEl.className = 'stream-pending'
  delete pendingEl.dataset['orderedMarker']
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
  const pendingInner = sanitizeRenderedMarkdown(renderPendingInlineMarkdown(pending))
  if (!pendingInner) return rendered
  const pendingHtml = isBlockLevelPending(pending)
    ? blockPendingHtml(pending, pendingInner)
    : inlinePendingSpanHtml(pendingInner)
  return `${rendered}${pendingHtml}`
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
    const pendingInner =
      pending && !pendingInTable && !formingActive
        ? sanitizeRenderedMarkdown(renderPendingInlineMarkdown(pending))
        : ''
    const pendingVisible =
      pending !== '' && !pendingInTable && !formingActive && pendingInner !== ''

    if (pendingVisible && isBlockLevelPending(pending)) {
      syncBlockPendingDom(completedEl, pending, pendingInner, true)
      syncInlinePendingDom(pendingEl, '', false)
    } else {
      completedEl.querySelector(`:scope > .${BLOCK_PENDING_CLASS}`)?.remove()
      syncInlinePendingDom(pendingEl, pendingInner, pendingVisible)
    }
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
    pendingEl.hidden = true
    this.host.append(completedEl, formingEl, pendingEl)
    this.completedEl = completedEl
    this.formingEl = formingEl
    this.pendingEl = pendingEl
    this.lastComplete = ''
    return { completedEl, formingEl, pendingEl }
  }
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
  clearFormingFenceDom(container)
  clearFormingTableDom(container)
}
