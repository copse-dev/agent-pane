import { renderMarkdown } from './renderer.ts'
import {
  getIncompleteFenceSource,
  getIncompleteTableSource,
  isAmbiguousBlockLine,
  pendingLineBelongsInTable,
} from './block-tokenizer.ts'
import {
  isListContinuationPending,
  isPendingBlockquoteLine,
  listPendingIndent,
  pendingAtxHeadingLevel,
  pendingListMarkerLength,
  pendingListOrderedMarker,
  renderPendingLine,
} from './render-pending-line.ts'
import { splitForStreaming, type StreamingSplit } from './streaming-split.ts'
import { escapeHtml } from './escape.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import {
  appendPendingTableRowHtml,
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
const TRAILING_OPEN_LI_CLOSE_RE = /(<li(?:\s[^>]*)?>)([\s\S]*?)(<\/li>\s*<\/(?:ul|ol)>)\s*$/

function insertBeforeTrailingListClose(rendered: string, insertHtml: string): string | null {
  const liClose = rendered.match(TRAILING_OPEN_LI_CLOSE_RE)?.[3]
  if (!liClose) return null
  return `${rendered.slice(0, -liClose.length)}${insertHtml}${liClose}`
}

type BlockPendingCleanup = 'continuation' | 'list-items' | 'direct-blocks' | 'non-list-direct'

function clearBlockPendingDom(completedEl: HTMLElement, parts: BlockPendingCleanup[]): void {
  if (parts.includes('continuation')) clearListContinuationDom(completedEl)
  if (parts.includes('list-items')) completedEl.querySelector(`li.${BLOCK_PENDING_CLASS}`)?.remove()
  if (parts.includes('direct-blocks')) {
    completedEl.querySelector(`:scope > .${BLOCK_PENDING_CLASS}`)?.remove()
  }
  if (parts.includes('non-list-direct')) {
    completedEl.querySelector(`:scope > .${BLOCK_PENDING_CLASS}:not(li)`)?.remove()
  }
}

function renderPendingInlineMarkdown(pending: string, openListItemFirstLine?: string): string {
  if (openListItemFirstLine === undefined) return renderPendingLine(pending)
  return renderPendingLine(pending, { openListItemFirstLine })
}

/** Block-level pending tail (open paragraph or list line) — rendered inside stream-complete. */
export function isBlockLevelPending(pending: string, openListItemFirstLine?: string): boolean {
  if (!pending.trim() || pending.includes('\n')) return false
  if (pendingListMarkerLength(pending) !== null) return true
  if (pendingAtxHeadingLevel(pending) !== null) return true
  if (isPendingBlockquoteLine(pending)) return true
  if (isListContinuationPending(pending, openListItemFirstLine)) return true
  return !isAmbiguousBlockLine(pending)
}

function blockPendingTag(
  pending: string,
  openListItemFirstLine?: string,
): 'p' | 'div' | 'span' | 'blockquote' | 'li' {
  if (isListContinuationPending(pending, openListItemFirstLine)) return 'span'
  if (pendingListMarkerLength(pending) !== null) return 'li'
  if (pendingAtxHeadingLevel(pending) !== null) return 'div'
  if (isPendingBlockquoteLine(pending)) return 'blockquote'
  return 'p'
}

function pendingListTag(pending: string): 'ul' | 'ol' {
  return pendingListOrderedMarker(pending) !== null ? 'ol' : 'ul'
}

function blockPendingLiHtml(
  pending: string,
  pendingInner: string,
  openListItemFirstLine?: string,
): string {
  const inner = wrapBlockPendingInner(pending, pendingInner)
  return `<li class="${blockPendingClassName(pending, openListItemFirstLine)}"${blockPendingAttrs(pending)}>${inner}</li>`
}

function appendListPendingHtml(
  rendered: string,
  pending: string,
  pendingInner: string,
  openListItemFirstLine?: string,
): string {
  const listTag = pendingListTag(pending)
  const liHtml = blockPendingLiHtml(pending, pendingInner, openListItemFirstLine)
  const indent = listPendingIndent(pending)

  if (indent > 0) {
    const nested = insertBeforeTrailingListClose(rendered, `<${listTag}>${liHtml}</${listTag}>`)
    if (nested) return nested
  }

  const close = `</${listTag}>`
  const closeIndex = rendered.lastIndexOf(close)
  if (closeIndex !== -1) {
    const openNeedle = `<${listTag}`
    const beforeClose = rendered.slice(0, closeIndex)
    if (beforeClose.lastIndexOf(openNeedle) !== -1) {
      return `${beforeClose}${liHtml}${rendered.slice(closeIndex)}`
    }
  }

  const ordered = pendingListOrderedMarker(pending)
  const startAttr = ordered !== null && listTag === 'ol' ? ` start="${escapeHtml(ordered)}"` : ''
  return `${rendered}<${listTag}${startAttr}>${liHtml}</${listTag}>`
}

function findTrailingListHost(completedEl: HTMLElement, listTag: 'ul' | 'ol'): HTMLElement | null {
  const last = completedEl.lastElementChild
  if (last instanceof Element && last.tagName === listTag.toUpperCase()) {
    return last as HTMLElement
  }
  return null
}

function syncListPendingDom(
  completedEl: HTMLElement,
  pending: string,
  pendingInner: string,
  active: boolean,
  openListItemFirstLine?: string,
): void {
  clearBlockPendingDom(completedEl, ['continuation', 'non-list-direct'])

  const listTag = pendingListTag(pending)
  const indent = listPendingIndent(pending)
  const existingPendingLi = completedEl.querySelector(`li.${BLOCK_PENDING_CLASS}`)

  if (!active || !pendingInner) {
    existingPendingLi?.remove()
    const emptyList = completedEl.querySelector(`:scope > ${listTag}:empty`)
    emptyList?.remove()
    return
  }

  let list: HTMLElement
  if (indent > 0) {
    const hostLi = findOpenListItemHost(completedEl)
    if (!hostLi) {
      list = document.createElement(listTag)
      completedEl.append(list)
    } else {
      const existingNested = hostLi.querySelector(`:scope > ${listTag}:last-of-type`)
      if (existingNested instanceof Element && existingNested.tagName === listTag.toUpperCase()) {
        list = existingNested as HTMLElement
      } else {
        list = document.createElement(listTag)
        hostLi.append(list)
      }
    }
  } else {
    const trailing = findTrailingListHost(completedEl, listTag)
    list =
      trailing ??
      ((): HTMLElement => {
        const created = document.createElement(listTag)
        const ordered = pendingListOrderedMarker(pending)
        if (ordered !== null && listTag === 'ol') created.setAttribute('start', ordered)
        completedEl.append(created)
        return created
      })()
  }

  let li: HTMLElement
  if (existingPendingLi instanceof HTMLElement && existingPendingLi.parentElement === list) {
    li = existingPendingLi
  } else {
    existingPendingLi?.remove()
    li = document.createElement('li')
    list.append(li)
  }

  li.className = blockPendingClassName(pending, openListItemFirstLine)
  const ordered = pendingListOrderedMarker(pending)
  const headingLevel = pendingAtxHeadingLevel(pending)
  if (ordered !== null) li.setAttribute('data-ordered-marker', ordered)
  else li.removeAttribute('data-ordered-marker')
  if (headingLevel !== null) li.setAttribute('data-heading-level', String(headingLevel))
  else li.removeAttribute('data-heading-level')
  li.innerHTML = wrapBlockPendingInner(pending, pendingInner)
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
  if (isPendingBlockquoteLine(pending)) {
    return `stream-pending stream-pending-blockquote ${BLOCK_PENDING_CLASS}`
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

function wrapBlockPendingInner(pending: string, pendingInner: string): string {
  if (isPendingBlockquoteLine(pending)) {
    return pendingInner ? `<p>${pendingInner}</p>` : ''
  }
  return pendingInner
}

function blockPendingHtml(
  pending: string,
  pendingInner: string,
  openListItemFirstLine?: string,
): string {
  const tag = blockPendingTag(pending, openListItemFirstLine)
  const innerRaw = wrapBlockPendingInner(pending, pendingInner)
  const inner =
    tag === 'span' && innerRaw !== '' && !innerRaw.startsWith(' ') ? ` ${innerRaw}` : innerRaw
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
    clearBlockPendingDom(completedEl, ['continuation', 'list-items', 'non-list-direct'])
    syncListContinuationDom(completedEl, pendingInner, active)
    return
  }

  if (pendingListMarkerLength(pending) !== null) {
    syncListPendingDom(completedEl, pending, pendingInner, active, openListItemFirstLine)
    return
  }

  clearBlockPendingDom(completedEl, ['continuation', 'list-items'])
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
  el.innerHTML = wrapBlockPendingInner(pending, pendingInner)
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
  const tableSource = fenceSource ? null : formingTableSource(complete, content, pending)
  const formingHtml = fenceSource
    ? buildFormingFenceHtml(fenceSource)
    : tableSource
      ? buildFormingTableHtml(tableSource)
      : ''

  if (formingHtml) {
    return `${rendered}${formingHtml}`
  }
  if (!pending) return rendered
  if (pendingLineBelongsInTable(complete, pending)) {
    return appendPendingTableRowHtml(rendered, pending)
  }
  const pendingInner = sanitizeRenderedMarkdown(
    renderPendingInlineMarkdown(pending, openListItemFirstLine),
  )
  if (!pendingInner) return rendered

  if (isListContinuationPending(pending, openListItemFirstLine)) {
    const contHtml = blockPendingHtml(pending, pendingInner, openListItemFirstLine)
    const inserted = insertBeforeTrailingListClose(rendered, contHtml)
    if (inserted) return inserted
  }

  if (pendingListMarkerLength(pending) !== null) {
    return appendListPendingHtml(rendered, pending, pendingInner, openListItemFirstLine)
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
    const tableSource = formingTableSource(complete, content, pending)
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
      clearBlockPendingDom(completedEl, ['continuation', 'direct-blocks'])
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

function formingTableSource(complete: string, content: string, pending: string): string | null {
  if (getIncompleteFenceSource(content)) return null
  if (pendingLineBelongsInTable(complete, pending)) return null
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
