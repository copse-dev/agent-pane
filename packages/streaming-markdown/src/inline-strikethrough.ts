/**
 * GFM strikethrough (`~~text~~`) as a focused inline pass.
 *
 * The `*`/`_` emphasis engine is a dedicated delimiter stack; rather than widen
 * its run type, strikethrough runs as its own pass that reuses the shared
 * flanking rules and the inline-HTML shield mask. It runs *after* emphasis and
 * *before* links (see `inline-spans.ts`) so a struck span can still contain
 * rendered emphasis and later become the host for link/autolink rendering.
 *
 * Only paired **double** tildes (`~~`) delimit. A lone `~` — date ranges,
 * `20~25`, arithmetic — is never a marker, which keeps word-internal single
 * tildes literal (#613). Runs of one or three-plus tildes are inert.
 */
import { INLINE_HTML_SHIELD_RE, isLeftFlanking, isRightFlanking } from './inline-emphasis.ts'

interface TildeRun {
  start: number
  end: number
  canOpen: boolean
  canClose: boolean
}

/** Mask every character inside rendered inline HTML (`<code>`, `<a>`, `<img>`). */
function inlineHtmlMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false)
  for (const match of text.matchAll(INLINE_HTML_SHIELD_RE)) {
    for (let i = match.index; i < match.index + match[0].length; i++) mask[i] = true
  }
  return mask
}

/** Collect exactly-double `~~` runs, with emphasis-style flanking classification. */
function readTildeRuns(s: string, mask: boolean[]): TildeRun[] {
  const runs: TildeRun[] = []
  let i = 0
  while (i < s.length) {
    if (s[i] !== '~' || mask[i]) {
      i++
      continue
    }
    let j = i
    while (j < s.length && s[j] === '~' && !mask[j]) j++
    const len = j - i
    if (len === 2) {
      const prev = i > 0 ? (s[i - 1] ?? '') : ''
      const next = j < s.length ? (s[j] ?? '') : ''
      runs.push({
        start: i,
        end: j,
        canOpen: isLeftFlanking(prev, next),
        canClose: isRightFlanking(prev, next),
      })
    }
    i = j
  }
  return runs
}

interface StrikeMatch {
  open: number
  close: number
}

/**
 * Pair `~~` runs with a stack (close beats open when both are possible), so
 * nested/sequential spans resolve like other inline delimiters. Returns matches
 * plus any openers still unmatched at the end (used by the streaming hold).
 */
function pairTildeRuns(runs: TildeRun[]): { matches: StrikeMatch[]; open: TildeRun[] } {
  const stack: TildeRun[] = []
  const matches: StrikeMatch[] = []
  for (const run of runs) {
    if (run.canClose && stack.length > 0) {
      const opener = stack.pop()
      if (opener) matches.push({ open: opener.start, close: run.start })
      continue
    }
    if (run.canOpen) stack.push(run)
  }
  return { matches, open: stack }
}

/** Wrap paired `~~…~~` spans in `<del>`, dropping the delimiter tildes. */
export function renderStrikethrough(text: string): string {
  if (!text.includes('~~')) return text
  const mask = inlineHtmlMask(text)
  const { matches } = pairTildeRuns(readTildeRuns(text, mask))
  if (matches.length === 0) return text

  const openAt = new Set(matches.map((m) => m.open))
  const closeAt = new Set(matches.map((m) => m.close))

  let out = ''
  let i = 0
  while (i < text.length) {
    if (openAt.has(i)) {
      out += '<del>'
      i += 2
      continue
    }
    if (closeAt.has(i)) {
      out += '</del>'
      i += 2
      continue
    }
    out += text[i] ?? ''
    i++
  }
  return out
}

/**
 * Streaming: index from which a half-open `~~` should hold. Holds an unmatched
 * opener (`~~foo` mid-stream) and a lone trailing `~` that could grow into a
 * `~~` opener, so no literal marker flashes before the span closes.
 */
export function strikethroughHoldStart(s: string, mask: boolean[]): number {
  const { open } = pairTildeRuns(readTildeRuns(s, mask))
  let cut = s.length
  const firstOpen = open[0]
  if (firstOpen) cut = Math.min(cut, firstOpen.start)

  if (s.length > 0 && s[s.length - 1] === '~' && !mask[s.length - 1]) {
    let t = s.length
    while (t > 0 && s[t - 1] === '~' && !mask[t - 1]) t--
    if (s.length - t === 1) cut = Math.min(cut, t)
  }
  return cut
}
