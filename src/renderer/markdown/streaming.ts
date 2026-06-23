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

const PENDING_BLOCK_START_RE =
  /^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+\.\s|>|```|~~~|\|)|^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/

function stripParagraphWrapper(html: string): string {
  const trimmed = html.trim()
  const match = trimmed.match(/^<p>([\s\S]*)<\/p>$/)
  return match?.[1] ?? html
}

// --- Holding unresolved inline markup while streaming -----------------------
//
// CommonMark resolves emphasis at the end of a *block*, not at the delimiter
// that opens it: a `**` only becomes <strong> once a matching closer turns up,
// and which opener a closer pairs with can still change as more text arrives.
// A renderer that commits <strong> the instant it sees `**` therefore shows
// wrong or flickering bold mid-stream (e.g. `**foo **bar` momentarily bolding
// `foo `, or a whitespace-flanked `**` closing emphasis it shouldn't).
//
// Rather than reimplement the full inline parser, we locate the first
// *unresolved* delimiter on the in-progress line and hold everything from there
// onward until a later token resolves it. Resolved markup before that point is
// still rendered. This is intentionally narrow: it only decides where to cut —
// the visible prefix is still rendered through `renderMarkdown`.

const ASCII_PUNCTUATION_RE = /[!-/:-@[-`{-~]/

function isFlankingWhitespace(ch: string): boolean {
  // Start/end of the fragment counts as whitespace, matching the spec's
  // treatment of line boundaries for delimiter-run classification.
  return ch === '' || /\s/.test(ch)
}

function isFlankingPunctuation(ch: string): boolean {
  return ch !== '' && ASCII_PUNCTUATION_RE.test(ch)
}

function isLeftFlanking(prev: string, next: string): boolean {
  return (
    !isFlankingWhitespace(next) &&
    (!isFlankingPunctuation(next) || isFlankingWhitespace(prev) || isFlankingPunctuation(prev))
  )
}

function isRightFlanking(prev: string, next: string): boolean {
  return (
    !isFlankingWhitespace(prev) &&
    (!isFlankingPunctuation(prev) || isFlankingWhitespace(next) || isFlankingPunctuation(next))
  )
}

/**
 * Mark the interior (and delimiters) of every closed inline code span, since a
 * `**` inside backticks is not an emphasis delimiter. If a code span is opened
 * but not yet closed, everything from its opening backtick is itself unresolved.
 */
function scanCodeSpans(s: string): { mask: boolean[]; unresolvedAt: number | null } {
  const mask = new Array<boolean>(s.length).fill(false)
  let i = 0
  while (i < s.length) {
    if (s[i] !== '`') {
      i++
      continue
    }
    let j = i
    while (j < s.length && s[j] === '`') j++
    const runLen = j - i
    let k = j
    let closeEnd = -1
    while (k < s.length) {
      if (s[k] === '`') {
        let m = k
        while (m < s.length && s[m] === '`') m++
        if (m - k === runLen) {
          closeEnd = m
          break
        }
        k = m
      } else {
        k++
      }
    }
    if (closeEnd === -1) return { mask, unresolvedAt: i }
    for (let p = i; p < closeEnd; p++) mask[p] = true
    i = closeEnd
  }
  return { mask, unresolvedAt: null }
}

interface OpenDelimiter {
  index: number
  char: '*' | '_'
  len: number
}

/**
 * Index at which to truncate the visible part of the in-progress line. Anything
 * from this index onward contains an unresolved delimiter and is held until it
 * resolves. Returns `s.length` when nothing needs holding.
 */
export function pendingHoldIndex(s: string): number {
  const { mask, unresolvedAt } = scanCodeSpans(s)
  const limit = unresolvedAt ?? s.length
  const stack: OpenDelimiter[] = []
  let trailingConsumed = false

  let i = 0
  while (i < limit) {
    const ch = s[i]!
    if ((ch !== '*' && ch !== '_') || mask[i]) {
      i++
      continue
    }
    let j = i
    while (j < limit && s[j] === ch && !mask[j]) j++
    const len = j - i
    const prev = i > 0 ? s[i - 1]! : ''
    const next = j < s.length ? s[j]! : ''
    const lf = isLeftFlanking(prev, next)
    const rf = isRightFlanking(prev, next)
    // `_` cannot open/close inside a word (so identifiers like some_var_name are
    // not emphasis); `*` has no such restriction.
    const canOpen = ch === '*' ? lf : lf && (!rf || isFlankingPunctuation(prev))
    const canClose = ch === '*' ? rf : rf && (!lf || isFlankingPunctuation(next))

    let matched = -1
    if (canClose) {
      for (let t = stack.length - 1; t >= 0; t--) {
        if (stack[t]!.char === ch) {
          matched = t
          break
        }
      }
    }
    if (matched >= 0) {
      const open = stack[matched]!
      const used = Math.min(open.len, len)
      // Openers between the match and the top become literal text.
      stack.length = matched
      open.len -= used
      if (open.len > 0) stack.push(open)
      if (j === s.length) trailingConsumed = true
    } else if (canOpen) {
      stack.push({ index: i, char: ch, len })
    }
    i = j
  }

  let cut = s.length
  if (unresolvedAt !== null) cut = Math.min(cut, unresolvedAt)
  if (stack.length > 0) cut = Math.min(cut, stack[0]!.index)

  // A trailing `*`/`**` run can't be classified yet (the lookahead char hasn't
  // streamed in), so hold it unless it already closed earlier emphasis.
  if (!trailingConsumed) {
    let tStart = s.length
    while (tStart > 0 && s[tStart - 1] === '*' && !mask[tStart - 1]) tStart--
    if (tStart < s.length) cut = Math.min(cut, tStart)
  }

  return cut
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
  const { complete, pending } = splitAtLastNewline(content)
  const rendered = complete ? sanitizeRenderedMarkdown(renderMarkdown(complete)) : ''
  if (!pending) return rendered
  return `${rendered}<span class="stream-pending">${renderPendingInlineMarkdown(pending)}</span>`
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

    // The completed region (and any selection within it) is untouched. Pending
    // content is still rendered through the markdown sanitizer before insertion.
    this.pendingEl!.innerHTML = pending ? renderPendingInlineMarkdown(pending) : ''
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
