import { renderMarkdown } from './renderer.ts'
import { pendingLineBelongsInTable, splitTableRow } from './block-tokenizer.ts'
import { renderPendingLine } from './render-pending-line.ts'
import { splitForStreaming } from './streaming-split.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'

export { pendingHoldIndex } from './inline-emphasis.ts'
export { splitAtLastNewline, splitForStreaming } from './streaming-split.ts'
export {
  completeEndsInOpenTable,
  isAmbiguousBlockLine,
  isPotentialTableStart,
  pendingLineBelongsInTable,
  splitTableRow,
  tokenizeBlocks,
} from './block-tokenizer.ts'

function renderPendingInlineMarkdown(pending: string): string {
  return renderPendingLine(pending)
}

/**
 * Render assistant text while it is still streaming.
 * Completed blocks (per the block tokenizer) are markdown-rendered; the pending
 * tail only renders safe inline markdown once its block context is unambiguous.
 */
export function renderStreamingMarkdown(content: string): string {
  const { complete, pending } = splitForStreaming(content)
  const rendered = complete ? sanitizeRenderedMarkdown(renderMarkdown(complete)) : ''
  if (!pending) return rendered
  if (pendingLineBelongsInTable(complete, pending)) return rendered
  return `${rendered}<span class="stream-pending">${sanitizeRenderedMarkdown(renderPendingInlineMarkdown(pending))}</span>`
}

/**
 * Incremental streaming renderer.
 *
 * Re-running `renderStreamingMarkdown` + assigning `innerHTML` on every token is
 * O(n²) (the whole message is reparsed per token) and wipes text selection and
 * scroll/`<details>` state. Instead we keep two stable regions inside the host:
 * a completed-markdown `<div>` that is only re-rendered when the committed prefix
 * grows, and a live `<span>` for the pending tail.
 */
export class StreamingMarkdownRenderer {
  private completedEl: HTMLElement | null = null
  private pendingEl: HTMLSpanElement | null = null
  private lastComplete = ''
  private readonly host: HTMLElement

  constructor(host: HTMLElement) {
    this.host = host
  }

  /** Render `content` (the full message text so far) into the host incrementally. */
  update(content: string): void {
    const { complete, pending } = splitForStreaming(content)
    const { completedEl, pendingEl } = this.ensureNodes()

    if (complete !== this.lastComplete) {
      completedEl.innerHTML = complete ? sanitizeRenderedMarkdown(renderMarkdown(complete)) : ''
      this.lastComplete = complete
    }

    this.syncPendingTableRow(complete, pending)

    const pendingInTable = pendingLineBelongsInTable(complete, pending)
    pendingEl.innerHTML =
      pending && !pendingInTable
        ? sanitizeRenderedMarkdown(renderPendingInlineMarkdown(pending))
        : ''
    pendingEl.hidden = pending === '' || pendingInTable
  }

  private syncPendingTableRow(complete: string, pending: string): void {
    if (!pendingLineBelongsInTable(complete, pending)) {
      this.completedEl?.querySelector('tr.stream-pending-row')?.remove()
      return
    }

    const table = this.findLastTable()
    if (!table) return

    const cells = splitTableRow(pending)
    const colCount = table.querySelectorAll('thead th').length || cells.length || 1
    let row = table.querySelector('tr.stream-pending-row')
    if (!row) {
      row = document.createElement('tr')
      row.className = 'stream-pending-row'
      for (let i = 0; i < colCount; i++) {
        row.appendChild(document.createElement('td'))
      }
      const tbody =
        table.querySelector('tbody') ?? table.appendChild(document.createElement('tbody'))
      tbody.appendChild(row)
    }

    row.querySelectorAll('td').forEach((td, i) => {
      td.textContent = cells[i] ?? ''
    })
  }

  private findLastTable(): HTMLTableElement | null {
    const tables = this.completedEl?.querySelectorAll('table')
    const last = tables?.[tables.length - 1]
    return last instanceof HTMLTableElement ? last : null
  }

  private ensureNodes(): { completedEl: HTMLElement; pendingEl: HTMLSpanElement } {
    if (this.completedEl && this.pendingEl && this.host.contains(this.completedEl)) {
      return { completedEl: this.completedEl, pendingEl: this.pendingEl }
    }
    this.host.replaceChildren()
    const completedEl = document.createElement('div')
    completedEl.className = 'stream-complete'
    const pendingEl = document.createElement('span')
    pendingEl.className = 'stream-pending'
    this.host.append(completedEl, pendingEl)
    this.completedEl = completedEl
    this.pendingEl = pendingEl
    this.lastComplete = ''
    return { completedEl, pendingEl }
  }
}
