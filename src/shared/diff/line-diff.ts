import { splitIntoLines } from './line-stats.ts'

export type LineDiffKind = 'context' | 'add' | 'del'

export interface LineDiffLine {
  kind: LineDiffKind
  text: string
}

/** A run of unchanged lines folded out of a hunked diff. */
export interface LineDiffGap {
  kind: 'gap'
  count: number
}

/**
 * Ceiling on the LCS table, in cells. The table is built in the renderer while
 * a transcript paints, so a large rewrite must not allocate or loop without
 * bound; past this the changed middle is shown as a block replacement, which is
 * still a correct (if not minimal) edit script.
 */
const MAX_TABLE_CELLS = 1_000_000

/**
 * A line-level edit script from `before` to `after`, in display order: each
 * run of deletions precedes the additions that replace it.
 *
 * Identical head and tail lines are matched first, so the usual case — a small
 * edit inside a larger snippet — only runs the LCS over the changed middle.
 */
export function computeLineDiff(before: string, after: string): LineDiffLine[] {
  const a = splitIntoLines(before)
  const b = splitIntoLines(after)

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let aEnd = a.length
  let bEnd = b.length
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd -= 1
    bEnd -= 1
  }

  const context = (text: string): LineDiffLine => ({ kind: 'context', text })
  const del = (text: string): LineDiffLine => ({ kind: 'del', text })
  const add = (text: string): LineDiffLine => ({ kind: 'add', text })
  const head = a.slice(0, start).map(context)
  const tail = a.slice(aEnd).map(context)
  const oldMiddle = a.slice(start, aEnd)
  const newMiddle = b.slice(start, bEnd)
  const n = oldMiddle.length
  const m = newMiddle.length

  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_TABLE_CELLS) {
    return [...head, ...oldMiddle.map(del), ...newMiddle.map(add), ...tail]
  }

  // lcs[i * (m + 1) + j] = LCS length of oldMiddle[i:] and newMiddle[j:].
  // An LCS is at most min(n, m), which MAX_TABLE_CELLS keeps under 1000, so Uint16 holds it.
  const width = m + 1
  const lcs = new Uint16Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        oldMiddle[i] === newMiddle[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0)
    }
  }

  const middle: LineDiffLine[] = []
  let dels: LineDiffLine[] = []
  let adds: LineDiffLine[] = []
  const flush = (): void => {
    middle.push(...dels, ...adds)
    dels = []
    adds = []
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    const oldLine = oldMiddle[i]
    const newLine = newMiddle[j]
    if (i < n && j < m && oldLine === newLine) {
      flush()
      middle.push(context(oldLine ?? ''))
      i += 1
      j += 1
    } else if (
      j >= m ||
      (i < n && (lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0))
    ) {
      dels.push(del(oldLine ?? ''))
      i += 1
    } else {
      adds.push(add(newLine ?? ''))
      j += 1
    }
  }
  flush()
  return [...head, ...middle, ...tail]
}

/**
 * Keep `contextLines` unchanged lines around each change and fold longer
 * unchanged runs into a gap marker, like a unified diff's hunks. A gap is only
 * emitted when it hides more than one line — folding a single line would cost
 * as much space as showing it.
 */
export function foldLineDiff(
  lines: readonly LineDiffLine[],
  contextLines = 3,
): (LineDiffLine | LineDiffGap)[] {
  const keep = new Uint8Array(lines.length)
  lines.forEach((line, index) => {
    if (line.kind === 'context') return
    const from = Math.max(0, index - contextLines)
    const to = Math.min(lines.length - 1, index + contextLines)
    for (let k = from; k <= to; k += 1) keep[k] = 1
  })

  const out: (LineDiffLine | LineDiffGap)[] = []
  let index = 0
  while (index < lines.length) {
    if (keep[index]) {
      const line = lines[index]
      if (line) out.push(line)
      index += 1
      continue
    }
    let end = index
    while (end < lines.length && !keep[end]) end += 1
    if (end - index === 1) {
      const line = lines[index]
      if (line) out.push(line)
    } else {
      out.push({ kind: 'gap', count: end - index })
    }
    index = end
  }
  return out
}
