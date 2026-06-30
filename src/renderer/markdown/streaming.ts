import { escapeHtml, renderMarkdown } from './renderer.ts'
import { emphasisSpansNewline, pendingHoldIndex } from './inline-emphasis.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'

export { pendingHoldIndex } from './inline-emphasis.ts'

/** Split streamed content at the last newline so completed lines can be rendered. */
export function splitAtLastNewline(content: string): { complete: string; pending: string } {
  const lastNl = content.lastIndexOf('\n')
  if (lastNl === -1) return { complete: '', pending: content }
  return {
    complete: content.slice(0, lastNl + 1),
    pending: content.slice(lastNl + 1),
  }
}

/** Start index of the current open block (after the last blank line). */
export function findOpenBlockStart(content: string): number {
  const idx = content.lastIndexOf('\n\n')
  return idx === -1 ? 0 : idx + 2
}

/**
 * Split streaming content at a safe commit boundary. Within the current open
 * block, hold from the first unresolved inline delimiter so emphasis can span
 * soft line breaks (CommonMark block-level resolution).
 */
export function splitForStreaming(content: string): { complete: string; pending: string } {
  const blockStart = findOpenBlockStart(content)
  const openBlock = content.slice(blockStart)
  const holdAt = pendingHoldIndex(openBlock)

  if (holdAt < openBlock.length) {
    return {
      complete: content.slice(0, blockStart) + openBlock.slice(0, holdAt),
      pending: openBlock.slice(holdAt),
    }
  }

  // Cross-line emphasis resolved inside the open block must render as one unit —
  // a line split would tear the span apart when each half is markdown-rendered.
  if (emphasisSpansNewline(openBlock) && !openBlock.endsWith('\n\n')) {
    return {
      complete: content.slice(0, blockStart),
      pending: openBlock,
    }
  }

  return splitAtLastNewline(content)
}

const PENDING_BLOCK_START_RE =
  /^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+\.\s|>|```|~~~|\|)|^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/

function stripParagraphWrapper(html: string): string {
  const trimmed = html.trim()
  const match = trimmed.match(/^<p>([\s\S]*)<\/p>$/)
  return match?.[1] ?? html
}

function renderPendingInlineMarkdown(pending: string): string {
  if (!pending || PENDING_BLOCK_START_RE.test(pending)) return escapeHtml(pending)
  const visible = pending.slice(0, pendingHoldIndex(pending))
  if (!visible) return ''
  return stripParagraphWrapper(renderMarkdown(visible))
}

/**
 * Render assistant text while it is still streaming.
 * Completed lines (up to the last newline) are markdown-rendered; the
 * in-progress tail only renders safe inline markdown. Block constructs like
 * lists and tables are finalized on message_done via renderMarkdown().
 */
export function renderStreamingMarkdown(content: string): string {
  const { complete, pending } = splitForStreaming(content)
  const rendered = complete ? sanitizeRenderedMarkdown(renderMarkdown(complete)) : ''
  if (!pending) return rendered
  return `${rendered}<span class="stream-pending">${sanitizeRenderedMarkdown(renderPendingInlineMarkdown(pending))}</span>`
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

    // The completed region (and any selection within it) is untouched. Pending
    // content is still rendered through the markdown sanitizer before insertion.
    pendingEl.innerHTML = pending
      ? sanitizeRenderedMarkdown(renderPendingInlineMarkdown(pending))
      : ''
    pendingEl.hidden = pending === ''
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
