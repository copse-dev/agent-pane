import { renderMarkdown } from './renderer.ts'
import {
  getIncompleteFenceSource,
  getIncompleteTableSource,
  isAmbiguousBlockLine,
  pendingLineBelongsInTable,
} from './block-tokenizer.ts'
import {
  isListContinuationPending,
  pendingAtxHeadingLevel,
  pendingListMarkerLength,
  pendingListOrderedMarker,
  renderPendingLine,
} from './render-pending-line.ts'
import { splitForStreaming, type StreamingSplit } from './streaming-split.ts'
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
export type { StreamingSplit } from './streaming-split.ts'
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
const LIST_CONTINUATION_CLASS = 'stream-pending-list-continuation'

function renderPendingInlineMarkdown(pending: string, openListItemFirstLine?: string): string {
  if (openListItemFirstLine === undefined) return renderPendingLine(pending)
  return renderPendingLine(pending, { openListItemFirstLine })
}

/** Block-level pending tail (open paragraph or list line) — rendered inside stream-complete. */
export function isBlockLevelPending(pending: string, openListItemFirstLine?: string): boolean {
  if (!pending.trim() || pending.includes('\n')) return false
  if (pendingListMarkerLength(pending) !== null) return true
  if (pendingAtxHeadingLevel(pending) !== null) return true
  if (isListContinuationPending(pending, openListItemFirstLine)) return true
  return !isAmbiguousBlockLine(pending)
}

function blockPendingTag(pending: string, openListItemFirstLine?: string): 'p' | 'div' | 'span' {
  if (isListContinuationPending(pending, openListItemFirstLine)) return 'span'
  if (pendingListMarkerLength(pending) !== null) return 'div'
  if (pendingAtxHeadingLevel(pending) !== null) return 'div'
  return 'p'
}

function blockPendingClassName(pending: string, openListItemFirstLine?: string): string {
  if (isListContinuationPending(pending, openListItemFirstLine)) {
    return `stream-pending ${LIST_CONTINUATION_CLASS} ${BLOCK_PENDING_CLASS}`
  }
  if (pendingListMarkerLength(pending) !== null) {
    const ordered = pendingListOrderedMarker(pending)
    return ordered
      ? `stream-pending stream-pending-list-item stream-pending-ordered-item ${BLOCK_PENDING_CLASS}`
      : `stream-pending stream-pending-list-item ${BLOCK_PENDING_CLASS}`
  }
  const headingLevel = pendingAtxHeadingLevel(pending)
  if (headingLevel !== null) {
    return `stream-pending stream-pending-heading stream-pending-h${String(headingLevel)} ${BLOCK_PENDING_CLASS}`
  }
  return `stream-pending stream-pending-paragraph ${BLOCK_PENDING_CLASS}`
}

function blockPendingAttrs(pending: string): string {
  const ordered = pendingListOrderedMarker(pending)
  const headingLevel = pendingAtxHeadingLevel(pending)
  let attrs = ''
  if (ordered) attrs += ` data-ordered-marker="${escapeHtml(ordered)}"`
  if (headingLevel !== null) attrs += ` data-heading-level="${String(headingLevel)}"`
  return attrs
}

function blockPendingHtml(
  pending: string,
  pendingInner: string,
  openListItemFirstLine?: string,
): string {
  const tag = blockPendingTag(pending, openListItemFirstLine)
  const inner =
    tag === 'span' && pendingInner !== '' && !pendingInner.startsWith(' ')
      ? ` ${pendingInner}`
      : pendingInner
  return `<${tag} class="${blockPendingClassName(pending, openListItemFirstLine)}"${blockPendingAttrs(pending)}>${inner}</${tag}>`
}

function inlinePendingSpanHtml(pendingInner: string): string {
  return `<span class="stream-pending">${pendingInner}</span>`
}

function findOpenListItemHost(completedEl: HTMLElement): HTMLElement | null {
  const li = completedEl.querySelector(
    'ul:last-of-type > li:last-child, ol:last-of-type > li:last-child',
  )
  return li instanceof Element && li.tagName === 'LI' ? (li as HTMLElement) : null
}

function clearListContinuationDom(completedEl: HTMLElement): void {
  completedEl.querySelector(`li .${LIST_CONTINUATION_CLASS}`)?.remove()
}

function syncListContinuationDom(
  completedEl: HTMLElement,
  pendingInner: string,
  active: boolean,
): boolean {
  const li = findOpenListItemHost(completedEl)
  if (!li) return false

  const existing = li.querySelector(`:scope > .${LIST_CONTINUATION_CLASS}`)
  if (!active || !pendingInner) {
    existing?.remove()
    return true
  }

  let el: Element | null = existing
  if (!el) {
    el = document.createElement('span')
    li.append(el)
  }
  el.className = `stream-pending ${LIST_CONTINUATION_CLASS} ${BLOCK_PENDING_CLASS}`
  el.innerHTML = pendingInner.startsWith(' ') ? pendingInner : ` ${pendingInner}`
  return true
}

function syncBlockPendingDom(
  completedEl: HTMLElement,
  pending: string,
  pendingInner: string,
  active: boolean,
  openListItemFirstLine?: string,
): void {
  if (isListContinuationPending(pending, openListItemFirstLine)) {
    clearListContinuationDom(completedEl)
    completedEl.querySelector(`:scope > .${BLOCK_PENDING_CLASS}`)?.remove()
    syncListContinuationDom(completedEl, pendingInner, active)
    return
  }

  clearListContinuationDom(completedEl)
  const existing = completedEl.querySelector(`:scope > .${BLOCK_PENDING_CLASS}`)
  if (!active || !pendingInner) {
    existing?.remove()
    return
  }
  const tag = blockPendingTag(pending, openListItemFirstLine)
  let el: Element | null = existing
  if (!el || el.tagName.toLowerCase() !== tag) {
    existing?.remove()
    el = document.createElement(tag)
    completedEl.append(el)
  }
  el.className = blockPendingClassName(pending, openListItemFirstLine)
  const ordered = pendingListOrderedMarker(pending)
  const headingLevel = pendingAtxHeadingLevel(pending)
  if (ordered !== null) el.setAttribute('data-ordered-marker', ordered)
  else el.removeAttribute('data-ordered-marker')
  if (headingLevel !== null) el.setAttribute('data-heading-level', String(headingLevel))
  else el.removeAttribute('data-heading-level')
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

function renderPendingTail(
  split: StreamingSplit,
  complete: string,
  formingActive: boolean,
): { pendingInner: string; pendingVisible: boolean } {
  const { pending, openListItemFirstLine } = split
  const pendingInTable = pendingLineBelongsInTable(complete, pending)
  const pendingInner =
    pending && !pendingInTable && !formingActive
      ? sanitizeRenderedMarkdown(renderPendingInlineMarkdown(pending, openListItemFirstLine))
      : ''
  const pendingVisible = pending !== '' && !pendingInTable && !formingActive && pendingInner !== ''
  return { pendingInner, pendingVisible }
}

/**
 * Render assistant text while it is still streaming.
 * Completed blocks (per the block tokenizer) are markdown-rendered; the pending
 * tail only renders safe inline markdown once its block context is unambiguous.
 */
export function renderStreamingMarkdown(content: string): string {
  const split = splitForStreaming(content)
  const { complete, pending, openListItemFirstLine } = split
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
  const pendingInner = sanitizeRenderedMarkdown(
    renderPendingInlineMarkdown(pending, openListItemFirstLine),
  )
  if (!pendingInner) return rendered

  if (isListContinuationPending(pending, openListItemFirstLine)) {
    const liMatch = rendered.match(/(<li(?:\s[^>]*)?>)([\s\S]*?)(<\/li>\s*<\/(?:ul|ol)>)\s*$/)
    const liClose = liMatch?.[3]
    if (liMatch?.[1] !== undefined && liMatch[2] !== undefined && liClose) {
      const contHtml = blockPendingHtml(pending, pendingInner, openListItemFirstLine)
      return `${rendered.slice(0, -liClose.length)}${liMatch[1]}${liMatch[2]}${contHtml}${liClose}`
    }
  }

  const pendingHtml = isBlockLevelPending(pending, openListItemFirstLine)
    ? blockPendingHtml(pending, pendingInner, openListItemFirstLine)
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
    const split = splitForStreaming(content)
    const { complete, pending, openListItemFirstLine } = split
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
    const { pendingInner, pendingVisible } = renderPendingTail(split, complete, formingActive)

    if (pendingVisible && isBlockLevelPending(pending, openListItemFirstLine)) {
      syncBlockPendingDom(completedEl, pending, pendingInner, true, openListItemFirstLine)
      syncInlinePendingDom(pendingEl, '', false)
    } else {
      clearListContinuationDom(completedEl)
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
