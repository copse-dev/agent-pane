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
  canClose: boolean
}

interface DelimiterMatch {
  openIndex: number
  closeIndex: number
  openLen: number
  closeLen: number
  openRunLen: number
  char: '*' | '_'
}

/** True when a matched emphasis span includes an internal newline. */
export function emphasisSpansNewline(s: string): boolean {
  const { mask } = scanCodeSpans(s)
  const matches = scanDelimiterMatches(s, mask)
  return matches.some((m) => s.slice(m.openIndex, m.closeIndex + m.closeLen).includes('\n'))
}

function emphasisMatchAllowed(
  open: OpenDelimiter,
  closeLen: number,
  canOpen: boolean,
  canClose: boolean,
): boolean {
  if (!(canOpen || canClose)) return true
  if (closeLen % 3 === 0) return true
  return (open.len + closeLen) % 3 !== 0
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
      const openRunLen = open.len
      const used = Math.min(open.len, len)
      const remainingPrefixLen = openRunLen - used
      if (!emphasisMatchAllowed(open, len, canOpen, open.canClose)) {
        if (canOpen) stack.push({ index: i, char: ch, len, canClose })
        i = j
        continue
      }
      matches.push({
        openIndex: open.index + remainingPrefixLen,
        closeIndex: i,
        openLen: used,
        closeLen: used,
        openRunLen,
        char: ch,
      })
      stack.length = matched
      if (remainingPrefixLen > 0) {
        stack.push({
          index: open.index,
          char: ch,
          len: remainingPrefixLen,
          canClose: open.canClose,
        })
      }
      const remainder = len - used
      if (remainder > 0) {
        const remIndex = i + used
        const remPrev = remIndex > 0 ? (s[remIndex - 1] ?? '') : ''
        const remNext = remIndex + remainder < s.length ? (s[remIndex + remainder] ?? '') : ''
        const remLf = isLeftFlanking(remPrev, remNext)
        const remRf = isRightFlanking(remPrev, remNext)
        const remCanOpen = ch === '*' ? remLf : remLf && (!remRf || isFlankingPunctuation(remPrev))
        const remCanClose = ch === '*' ? remRf : remRf && (!remLf || isFlankingPunctuation(remNext))

        let remMatched = -1
        if (remCanClose) {
          for (let t = stack.length - 1; t >= 0; t--) {
            if (stack[t]?.char === ch) {
              remMatched = t
              break
            }
          }
        }
        const remOpen = remMatched >= 0 ? stack[remMatched] : undefined
        if (remOpen) {
          const remOpenRunLen = remOpen.len
          const remUsed = Math.min(remOpen.len, remainder)
          const remPrefix = remOpenRunLen - remUsed
          if (emphasisMatchAllowed(remOpen, remainder, remCanOpen, remOpen.canClose)) {
            matches.push({
              openIndex: remOpen.index + remPrefix,
              closeIndex: remIndex,
              openLen: remUsed,
              closeLen: remUsed,
              openRunLen: remOpenRunLen,
              char: ch,
            })
            stack.length = remMatched
            if (remPrefix > 0) {
              stack.push({
                index: remOpen.index,
                char: ch,
                len: remPrefix,
                canClose: remOpen.canClose,
              })
            }
            const remRemainder = remainder - remUsed
            if (remRemainder > 0 && remCanOpen) {
              stack.push({
                index: remIndex + remUsed,
                char: ch,
                len: remRemainder,
                canClose: remRf,
              })
            }
          } else if (remCanOpen) {
            stack.push({ index: remIndex, char: ch, len: remainder, canClose: remRf })
          }
        } else if (remCanOpen) {
          stack.push({ index: remIndex, char: ch, len: remainder, canClose: remRf })
        }
      }
    } else if (canOpen) {
      stack.push({ index: i, char: ch, len, canClose })
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
  while (remaining >= 2) {
    out = `<strong>${out}</strong>`
    remaining -= 2
  }
  if (remaining >= 1) {
    out = `<em>${out}</em>`
  }
  return out
}

function matchEnd(m: DelimiterMatch): number {
  return m.closeIndex + m.closeLen
}

function isNestedIn(child: DelimiterMatch, parent: DelimiterMatch): boolean {
  const childEnd = matchEnd(child)
  const parentEnd = matchEnd(parent)
  if (childEnd > parentEnd) return false
  if (child.openIndex >= parent.openIndex && childEnd <= parentEnd) return true
  return child.openIndex < parent.openIndex && childEnd > parent.openIndex
}

function findRootMatches(matches: DelimiterMatch[]): DelimiterMatch[] {
  const sorted = [...matches].sort((a, b) => matchEnd(b) - matchEnd(a) || a.openIndex - b.openIndex)
  const roots: DelimiterMatch[] = []
  for (const m of sorted) {
    if (!roots.some((root) => isNestedIn(m, root))) roots.push(m)
  }
  return roots.sort((a, b) => a.openIndex - b.openIndex)
}

function assembleMatch(s: string, m: DelimiterMatch, allMatches: DelimiterMatch[]): string {
  const contentStart = m.openIndex + m.openLen
  const contentEnd = m.closeIndex
  const children = allMatches
    .filter((c) => c !== m && isNestedIn(c, m))
    .sort((a, b) => a.openIndex - b.openIndex)

  let out = ''
  let cursor = contentStart
  for (const child of children) {
    out += s.slice(cursor, child.openIndex)
    out += assembleMatch(s, child, allMatches)
    cursor = matchEnd(child)
  }
  out += s.slice(cursor, contentEnd)
  return wrapEmphasis(out.replace(/\n/g, ' '), m.openLen, m.closeLen)
}

function delimitersToSkip(s: string, matches: DelimiterMatch[]): boolean[] {
  const skip = new Array<boolean>(s.length).fill(false)
  for (const m of matches) {
    for (let i = m.openIndex; i < m.openIndex + m.openLen; i++) skip[i] = true
    for (let i = m.closeIndex; i < matchEnd(m); i++) skip[i] = true
  }
  return skip
}

function renderEmphasisSegment(s: string, mask: boolean[]): string {
  const matches = scanDelimiterMatches(s, mask)
  if (matches.length === 0) return s

  const roots = findRootMatches(matches)
  const skip = delimitersToSkip(s, matches)

  let out = ''
  let i = 0
  let rootIdx = 0
  while (i < s.length) {
    const root = roots[rootIdx]
    if (root && i === root.openIndex) {
      out += assembleMatch(s, root, matches)
      i = matchEnd(root)
      rootIdx++
      continue
    }
    if (skip[i]) {
      i++
      continue
    }
    let next = s.length
    if (root) next = Math.min(next, root.openIndex)
    for (let j = i + 1; j < next; j++) {
      if (skip[j]) {
        next = j
        break
      }
    }
    out += s.slice(i, next)
    i = next
  }
  return out
}

/**
 * Resolve `*`/`_` emphasis in a plain-text segment (may include `\n` for soft
 * breaks). Code spans in the source should already be rendered as `<code>`.
 */
export function renderEmphasisDelimiters(s: string): string {
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
      const remainingPrefixLen = open.len - used
      if (remainingPrefixLen > 0) {
        stack.push({
          index: open.index,
          char: ch,
          len: remainingPrefixLen,
          canClose: open.canClose,
        })
      }
      if (j === s.length) trailingConsumed = true
    } else if (canOpen) {
      stack.push({ index: i, char: ch, len, canClose })
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

export const INLINE_HTML_SHIELD_RE = /(<code>[\s\S]*?<\/code>|<a\b[\s\S]*?<\/a>|<img\b[^>]*>)/g

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
