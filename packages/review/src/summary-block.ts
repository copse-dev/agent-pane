// The markers and ownership rule of Copse Reviewer's summary block in a pull
// request's description (docs/plans/copse-reviewer.md, §PR description
// summary). `pr-summary.ts` writes the block; `pr-conversation.ts` removes it
// before the description reaches a reviewer, so the review never reads its own
// summary as the author's intent.

import { createHash } from 'node:crypto'

export const START_MARKER = '<!-- copse-review-summary -->'
export const END_MARKER = '<!-- /copse-review-summary -->'

/**
 * A hidden line stamping the rendered text between the start marker and itself.
 * An author's edit to any of that text, even one that keeps the layout, changes
 * the digest, so the block becomes theirs.
 */
export function digestLine(body: readonly string[]): string {
  const digest = createHash('sha256').update(body.join('\n')).digest('hex').slice(0, 16)
  return `<!-- copse-review-summary-digest:${digest} -->`
}

/** A line without the carriage return and trailing blanks a web editor leaves. */
export function bareLine(line: string): string {
  return line.replace(/[ \t\r]+$/, '')
}

/** An opening code fence: its character, its length and the line it starts on. */
interface OpenFence {
  readonly char: string
  readonly length: number
  readonly from: number
}

/**
 * The lines inside closed fenced code blocks, and the fence still open at the
 * end of the description, if any.
 */
export function scanFences(lines: readonly string[]): {
  readonly fenced: ReadonlySet<number>
  readonly open: OpenFence | null
} {
  const fenced = new Set<number>()
  let open: OpenFence | null = null
  for (const [index, line] of lines.entries()) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(bareLine(line))
    if (open === null) {
      if (fence === null) continue
      const [, run = '', info = ''] = fence
      if (run.startsWith('`') && info.includes('`')) continue
      open = { char: run.charAt(0), length: run.length, from: index }
      continue
    }
    const run = fence?.[1] ?? ''
    if (fence?.[2]?.trim() === '' && run.charAt(0) === open.char && run.length >= open.length) {
      for (let inside = open.from; inside <= index; inside += 1) fenced.add(inside)
      open = null
    }
  }
  return { fenced, open }
}

/**
 * Indices of the lines inside a closed fenced code block. An unclosed fence
 * runs to the end of the description in rendered Markdown, but it is ignored
 * here: `upsertSummaryBlock` closes it before appending, so the block it writes
 * is always outside.
 */
function fencedLines(lines: readonly string[]): ReadonlySet<number> {
  return scanFences(lines).fenced
}

/**
 * Whether lines `start`..`end` are, line for line, the shape
 * `renderSummaryBlock` writes, with the text its digest line stamped. Anything
 * else between the markers, such as a note the author added or a sentence they
 * reworded, makes the block theirs.
 */
function isBotBlock(lines: readonly string[], start: number, end: number): boolean {
  const inner = lines.slice(start + 1, end).map(bareLine)
  const stamp = inner.pop()
  if (stamp !== digestLine(inner)) return false
  const expect = (at: number, line: RegExp): boolean => line.test(inner[at] ?? '')
  if (!expect(0, /^---$/) || !expect(1, /^$/) || !expect(2, /^> \[!NOTE\]$/)) return false
  if (!expect(3, /^> \*\*(Low|Medium|High) risk\*\*$/) || !expect(4, /^> \S/)) return false
  let at = 5
  if (expect(at, /^>$/) && expect(at + 1, /^> Raised to /)) at += 2
  if (!expect(at, /^>$/) || !expect(at + 1, /^> \*\*Overview\*\*$/)) return false
  at += 2
  const firstPoint = at
  while (expect(at, /^> - \S/)) at += 1
  return (
    at > firstPoint &&
    expect(at, /^>$/) &&
    expect(at + 1, /^> <sup>Summary by Copse Reviewer\b.*<\/sup>$/) &&
    at + 2 === inner.length
  )
}

/**
 * The line range of the summary block this tool wrote, or null. Markers count
 * only as whole lines outside fenced code, so a marker quoted in prose or in
 * an example is text. The block is the last start marker whose next marker is
 * an end marker and whose lines between are still exactly the rendered shape.
 * A marker pair the author wrote, or a block the author edited, is their text
 * and is kept; a new block is appended after it.
 */
export function findBotBlock(
  lines: readonly string[],
): { readonly start: number; readonly end: number } | null {
  const fenced = fencedLines(lines)
  const markers: { readonly index: number; readonly start: boolean }[] = []
  for (const [index, line] of lines.entries()) {
    if (fenced.has(index)) continue
    const bare = bareLine(line)
    if (bare === START_MARKER) markers.push({ index, start: true })
    else if (bare === END_MARKER) markers.push({ index, start: false })
  }
  for (let at = markers.length - 1; at > 0; at -= 1) {
    const open = markers[at - 1]
    const close = markers[at]
    if (open === undefined || close === undefined || !open.start || close.start) continue
    if (isBotBlock(lines, open.index, close.index)) return { start: open.index, end: close.index }
  }
  return null
}

/**
 * `body` without the summary block this tool wrote, or unchanged when it has
 * none. A block the author wrote or edited is their text and stays.
 */
export function withoutSummaryBlock(body: string): string {
  const lines = body.split('\n')
  const found = findBotBlock(lines)
  if (found === null) return body
  const before = lines.slice(0, found.start).join('\n').trimEnd()
  const after = lines
    .slice(found.end + 1)
    .join('\n')
    .replace(/^\s*\n/, '')
    .trimEnd()
  return before.length === 0 || after.length === 0 ? before + after : `${before}\n\n${after}`
}
