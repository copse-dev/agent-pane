/**
 * CommonMark-style inline emphasis via a delimiter stack (cmark architecture).
 * Shared by the at-rest renderer and the streaming hold logic.
 */

const ASCII_PUNCTUATION_RE = /[!-/:-@[-`{-~]/

function isFlankingWhitespace(ch: string): boolean {
  return ch === '' || /\s/.test(ch)
}

function isFlankingPunctuation(ch: string): boolean {
  return ch !== '' && ASCII_PUNCTUATION_RE.test(ch)
}

export function isLeftFlanking(prev: string, next: string): boolean {
  return (
    !isFlankingWhitespace(next) &&
    (!isFlankingPunctuation(next) || isFlankingWhitespace(prev) || isFlankingPunctuation(prev))
  )
}

export function isRightFlanking(prev: string, next: string): boolean {
  return (
    !isFlankingWhitespace(prev) &&
    (!isFlankingPunctuation(prev) || isFlankingWhitespace(next) || isFlankingPunctuation(next))
  )
}

/** Mark interior of closed inline code spans; unclosed span → unresolvedAt. */
export function scanCodeSpans(s: string): { mask: boolean[]; unresolvedAt: number | null } {
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

interface DelimiterMatch {
  openIndex: number
  closeIndex: number
  openLen: number
  closeLen: number
  char: '*' | '_'
}

/** True when a matched emphasis span includes an internal newline. */
export function emphasisSpansNewline(s: string): boolean {
  const { mask } = scanCodeSpans(s)
  const matches = scanDelimiterMatches(s, mask)
  return matches.some((m) => s.slice(m.openIndex, m.closeIndex + m.closeLen).includes('\n'))
}

function scanDelimiterMatches(s: string, mask: boolean[]): DelimiterMatch[] {
  const matches: DelimiterMatch[] = []
  const stack: OpenDelimiter[] = []
  const limit = s.length
  let i = 0

  while (i < limit) {
    const ch = s[i]
    if (ch === undefined || (ch !== '*' && ch !== '_') || mask[i]) {
      i++
      continue
    }
    let j = i
    while (j < limit && s[j] === ch && !mask[j]) j++
    const len = j - i
    const prev = i > 0 ? (s[i - 1] ?? '') : ''
    const next = j < s.length ? (s[j] ?? '') : ''
    const lf = isLeftFlanking(prev, next)
    const rf = isRightFlanking(prev, next)
    const canOpen = ch === '*' ? lf : lf && (!rf || isFlankingPunctuation(prev))
    const canClose = ch === '*' ? rf : rf && (!lf || isFlankingPunctuation(next))

    let matched = -1
    if (canClose) {
      for (let t = stack.length - 1; t >= 0; t--) {
        if (stack[t]?.char === ch) {
          matched = t
          break
        }
      }
    }
    const open = matched >= 0 ? stack[matched] : undefined
    if (open) {
      const used = Math.min(open.len, len)
      matches.push({
        openIndex: open.index,
        closeIndex: i,
        openLen: used,
        closeLen: used,
        char: ch,
      })
      stack.length = matched
      open.len -= used
      if (open.len > 0) stack.push(open)
      const remainder = len - used
      if (remainder > 0) {
        i += used
        const remPrev = i > 0 ? (s[i - 1] ?? '') : ''
        const remNext = i + remainder < s.length ? (s[i + remainder] ?? '') : ''
        const remLf = isLeftFlanking(remPrev, remNext)
        const remRf = isRightFlanking(remPrev, remNext)
        const remCanOpen = ch === '*' ? remLf : remLf && (!remRf || isFlankingPunctuation(remPrev))
        if (remCanOpen) stack.push({ index: i, char: ch, len: remainder })
      }
    } else if (canOpen) {
      stack.push({ index: i, char: ch, len })
    }
    i = j
  }
  return matches
}

function wrapEmphasis(inner: string, openLen: number, closeLen: number): string {
  const used = Math.min(openLen, closeLen)
  if (used === 0) return inner
  let out = inner
  let remaining = used
  if (remaining >= 2) {
    out = `<strong>${out}</strong>`
    remaining -= 2
  }
  if (remaining >= 1) {
    out = `<em>${out}</em>`
  }
  return out
}

function renderEmphasisSegment(s: string, mask: boolean[]): string {
  const matches = scanDelimiterMatches(s, mask)
  if (matches.length === 0) return s

  const outer = matches.filter(
    (m) =>
      !matches.some(
        (parent) =>
          parent !== m &&
          parent.openIndex < m.openIndex &&
          parent.closeIndex + parent.closeLen > m.closeIndex + m.closeLen,
      ),
  )
  outer.sort((a, b) => a.openIndex - b.openIndex)

  let out = ''
  let cursor = 0
  for (const m of outer) {
    out += s.slice(cursor, m.openIndex)
    const innerStart = m.openIndex + m.openLen
    const innerEnd = m.closeIndex
    const inner = renderEmphasisSegment(
      s.slice(innerStart, innerEnd),
      mask.slice(innerStart, innerEnd),
    )
    out += wrapEmphasis(inner, m.openLen, m.closeLen)
    cursor = m.closeIndex + m.closeLen
  }
  out += s.slice(cursor)
  return out
}

function hasSoftLineBreak(s: string): boolean {
  const trimmed = s.endsWith('\n') ? s.slice(0, -1) : s
  return trimmed.includes('\n')
}

function renderEmphasisSingleLine(s: string): string {
  let t = s
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/_([^_\n]+)_/g, '<em>$1</em>')
  t = t.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
  return t
}

/**
 * Resolve `*`/`_` emphasis in a plain-text segment (may include `\n` for soft
 * breaks). Code spans in the source should already be rendered as `<code>`.
 */
export function renderEmphasisDelimiters(s: string): string {
  if (!hasSoftLineBreak(s)) return renderEmphasisSingleLine(s)
  const { mask } = scanCodeSpans(s)
  return renderEmphasisSegment(s, mask)
}

/**
 * Index at which to truncate visible streaming output. Anything from here holds.
 */
export function pendingHoldIndex(s: string): number {
  const { mask, unresolvedAt } = scanCodeSpans(s)
  const limit = unresolvedAt ?? s.length
  const stack: OpenDelimiter[] = []
  let trailingConsumed = false

  let i = 0
  while (i < limit) {
    const ch = s[i]
    if (ch === undefined || (ch !== '*' && ch !== '_') || mask[i]) {
      i++
      continue
    }
    let j = i
    while (j < limit && s[j] === ch && !mask[j]) j++
    const len = j - i
    const prev = i > 0 ? (s[i - 1] ?? '') : ''
    const next = j < s.length ? (s[j] ?? '') : ''
    const lf = isLeftFlanking(prev, next)
    const rf = isRightFlanking(prev, next)
    const canOpen = ch === '*' ? lf : lf && (!rf || isFlankingPunctuation(prev))
    const canClose = ch === '*' ? rf : rf && (!lf || isFlankingPunctuation(next))

    let matched = -1
    if (canClose) {
      for (let t = stack.length - 1; t >= 0; t--) {
        if (stack[t]?.char === ch) {
          matched = t
          break
        }
      }
    }
    const open = matched >= 0 ? stack[matched] : undefined
    if (open) {
      const used = Math.min(open.len, len)
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
  const firstOpen = stack[0]
  if (firstOpen) cut = Math.min(cut, firstOpen.index)

  if (!trailingConsumed) {
    let tStart = s.length
    while (tStart > 0 && (s[tStart - 1] === '*' || s[tStart - 1] === '_') && !mask[tStart - 1]) {
      tStart--
    }
    if (tStart < s.length) cut = Math.min(cut, tStart)
  }

  return cut
}

const INLINE_HTML_SHIELD_RE = /(<code>[\s\S]*?<\/code>|<a\b[\s\S]*?<\/a>|<img\b[^>]*>)/g

/**
 * Apply delimiter-stack emphasis outside existing inline HTML (`<code>`, `<a>`,
 * `<img>`). Matches CommonMark flanking rules across soft line breaks.
 */
export function renderEmphasisOutsideInlineHtml(text: string): string {
  return text
    .split(INLINE_HTML_SHIELD_RE)
    .map((segment, index) => (index % 2 === 1 ? segment : renderEmphasisDelimiters(segment)))
    .join('')
}
