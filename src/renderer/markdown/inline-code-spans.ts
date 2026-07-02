/** CommonMark inline code spans (`\`…\``). Shared by emphasis masking and HTML render. */

export type CodeSpanBoundary =
  | {
      type: 'closed'
      open: number
      contentStart: number
      close: number
      closeEnd: number
      runLen: number
    }
  | { type: 'unclosed'; open: number; runLen: number }

/** Next code span at or after `from`, or null when no opener remains. */
export function nextCodeSpan(s: string, from: number): CodeSpanBoundary | null {
  let i = from
  while (i < s.length && s[i] !== '`') i++
  if (i >= s.length) return null

  let j = i
  while (j < s.length && s[j] === '`') j++
  const runLen = j - i

  let k = j
  while (k < s.length) {
    if (s[k] !== '`') {
      k++
      continue
    }
    let m = k
    while (m < s.length && s[m] === '`') m++
    if (m - k === runLen) {
      return { type: 'closed', open: i, contentStart: j, close: k, closeEnd: m, runLen }
    }
    k = m
  }
  return { type: 'unclosed', open: i, runLen }
}

/** Mark interior of closed inline code spans; unclosed span → unresolvedAt. */
export function scanCodeSpans(s: string): { mask: boolean[]; unresolvedAt: number | null } {
  const mask = new Array<boolean>(s.length).fill(false)
  let i = 0
  while (i < s.length) {
    const span = nextCodeSpan(s, i)
    if (!span) break
    if (span.type === 'unclosed') return { mask, unresolvedAt: span.open }
    for (let p = span.open; p < span.closeEnd; p++) mask[p] = true
    i = span.closeEnd
  }
  return { mask, unresolvedAt: null }
}

/**
 * CommonMark code spans: a run of N backticks opens a span that closes at the
 * next run of exactly N backticks. Interior line endings collapse to spaces.
 */
export function renderInlineCode(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] !== '`') {
      out += text[i] ?? ''
      i++
      continue
    }
    const span = nextCodeSpan(text, i)
    if (!span) {
      out += text[i] ?? ''
      i++
      continue
    }
    if (span.type === 'unclosed') {
      out += text.slice(span.open, span.open + span.runLen)
      i = span.open + span.runLen
      continue
    }
    let content = text.slice(span.contentStart, span.close).replace(/\n/g, ' ')
    if (
      content.length >= 2 &&
      content.startsWith(' ') &&
      content.endsWith(' ') &&
      /[^ ]/.test(content)
    ) {
      content = content.slice(1, -1)
    }
    out += `<code>${content}</code>`
    i = span.closeEnd
  }
  return out
}
