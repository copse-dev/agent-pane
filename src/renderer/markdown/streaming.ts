import { escapeHtml, renderMarkdown } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'

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
  }
}
