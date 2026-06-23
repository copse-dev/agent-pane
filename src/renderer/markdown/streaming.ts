import { escapeHtml, renderMarkdown } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'

const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

/** Split streamed content at the last newline so completed lines can be rendered. */
export function splitAtLastNewline(content: string): { complete: string; pending: string } {
  const lastNl = content.lastIndexOf('\n')
  if (lastNl === -1) return { complete: '', pending: content }
  return {
    complete: content.slice(0, lastNl + 1),
    pending: content.slice(lastNl + 1),
  }
}

/** Split a GFM table row into cell strings (leading/trailing pipes optional). */
export function splitTableRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

/** True when `complete` ends inside a GFM table that may still receive body rows. */
export function completeEndsInOpenTable(complete: string): boolean {
  if (!complete) return false
  const lines = complete.replace(/\n$/, '').split('\n')
  let i = lines.length - 1
  while (i >= 0 && lines[i]!.trim() === '') i--
  if (i < 0 || !lines[i]!.includes('|')) return false

  while (i >= 0 && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
    if (TABLE_SEP_RE.test(lines[i]!)) {
      return i > 0 && lines[i - 1]!.includes('|')
    }
    i--
  }
  return false
}

export function pendingLineBelongsInTable(complete: string, pending: string): boolean {
  return pending.includes('|') && completeEndsInOpenTable(complete)
}

/**
 * Render assistant text while it is still streaming.
 * Completed lines (up to the last newline) are markdown-rendered; the
 * in-progress tail stays as plain escaped text until its line ends.
 * Full constructs like tables are finalized on message_done via renderMarkdown().
 */
export function renderStreamingMarkdown(content: string): string {
  const { complete, pending } = splitAtLastNewline(content)
  const rendered = complete ? sanitizeRenderedMarkdown(renderMarkdown(complete)) : ''
  if (!pending) return rendered
  if (pendingLineBelongsInTable(complete, pending)) return rendered
  return `${rendered}<span class="stream-pending">${escapeHtml(pending)}</span>`
}

/**
 * Incremental streaming renderer.
 *
 * Re-running `renderStreamingMarkdown` + assigning `innerHTML` on every token is
 * O(n²) (the whole message is reparsed per token) and wipes text selection and
 * scroll/`<details>` state. Instead we keep two stable regions inside the host:
 * a completed-markdown `<div>` that is only re-rendered when a newline arrives
 * (i.e. the completed prefix actually grew), and a live `<span>` whose
 * `textContent` is updated for the in-progress line — cheap and DOM-preserving.
 */
export class StreamingMarkdownRenderer {
  private completedEl: HTMLElement | null = null
  private pendingEl: HTMLSpanElement | null = null
  private lastComplete = ''

  constructor(private readonly host: HTMLElement) {}

  /** Render `content` (the full message text so far) into the host incrementally. */
  update(content: string): void {
    const { complete, pending } = splitAtLastNewline(content)
    this.ensureNodes()

    if (complete !== this.lastComplete) {
      this.completedEl!.innerHTML = complete
        ? sanitizeRenderedMarkdown(renderMarkdown(complete))
        : ''
      this.lastComplete = complete
    }

    this.syncPendingTableRow(complete, pending)

    const pendingInTable = pendingLineBelongsInTable(complete, pending)
    this.pendingEl!.textContent = pendingInTable ? '' : pending
    this.pendingEl!.hidden = pending === '' || pendingInTable
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
      const tbody = table.querySelector('tbody') ?? table.appendChild(document.createElement('tbody'))
      tbody.appendChild(row)
    }

    row.querySelectorAll('td').forEach((td, i) => {
      td.textContent = cells[i] ?? ''
    })
  }

  private findLastTable(): HTMLTableElement | null {
    const tables = this.completedEl?.querySelectorAll('table')
    if (!tables?.length) return null
    return tables[tables.length - 1] as HTMLTableElement
  }

  private ensureNodes(): void {
    if (this.completedEl && this.host.contains(this.completedEl)) return
    this.host.replaceChildren()
    this.completedEl = document.createElement('div')
    this.completedEl.className = 'stream-complete'
    this.pendingEl = document.createElement('span')
    this.pendingEl.className = 'stream-pending'
    this.host.append(this.completedEl, this.pendingEl)
    this.lastComplete = ''
  }
}
