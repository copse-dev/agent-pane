import { escapeHtml, renderMarkdown } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'

/** Transient class for one-shot CSS enter animations on newly streamed blocks. */
export const STREAM_ENTER_CLASS = 'stream-enter'

/** Split streamed content at the last newline so completed lines can be rendered. */
export function splitAtLastNewline(content: string): { complete: string; pending: string } {
  const lastNl = content.lastIndexOf('\n')
  if (lastNl === -1) return { complete: '', pending: content }
  return {
    complete: content.slice(0, lastNl + 1),
    pending: content.slice(lastNl + 1),
  }
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
/** Mark tables/rows that just entered the completed streaming region for CSS fade-in. */
export function markStreamingEnterAnimations(
  completedEl: HTMLElement,
  prevHadTable: boolean,
  prevTableBodyRowCount: number,
): { hadTable: boolean; tableBodyRowCount: number } {
  const tables = completedEl.querySelectorAll('table')
  const hadTable = tables.length > 0
  const bodyRows = completedEl.querySelectorAll('table tbody tr')
  const tableBodyRowCount = bodyRows.length

  if (hadTable && !prevHadTable) {
    tables[tables.length - 1]!.classList.add(STREAM_ENTER_CLASS)
  }

  bodyRows.forEach((row, index) => {
    if (index >= prevTableBodyRowCount) {
      row.classList.add(STREAM_ENTER_CLASS)
    }
  })

  return { hadTable, tableBodyRowCount }
}

export class StreamingMarkdownRenderer {
  private completedEl: HTMLElement | null = null
  private pendingEl: HTMLSpanElement | null = null
  private lastComplete = ''
  private lastHadTable = false
  private lastTableBodyRowCount = 0

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
      ;({ hadTable: this.lastHadTable, tableBodyRowCount: this.lastTableBodyRowCount } =
        markStreamingEnterAnimations(
          this.completedEl!,
          this.lastHadTable,
          this.lastTableBodyRowCount,
        ))
    }

    // textContent assignment escapes implicitly and only touches the tail node,
    // so the completed region (and any selection within it) is untouched.
    this.pendingEl!.textContent = pending
    this.pendingEl!.hidden = pending === ''
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
    this.lastHadTable = false
    this.lastTableBodyRowCount = 0
  }
}
