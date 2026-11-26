import type { GitLineSelection } from '@shared/types/git.ts'

/**
 * Picks the hunks of a zero-context `git diff` that a line selection touches,
 * so the Changes pane can stage or unstage part of a file. The result is a
 * patch for `git apply --cached --unidiff-zero` (forward to stage, `--reverse`
 * to unstage).
 *
 * Hunks are the unit: with `-U0` each hunk is one contiguous run of removed
 * and added lines, so selecting any line of a change takes the whole change.
 *
 * With no context lines, `git apply` places a hunk by its result-side line
 * number, which counts every earlier hunk of the full diff. Once some of those
 * are left out, the result side of each kept hunk is renumbered from the side
 * the patch applies to (the index), shifted only by the kept hunks before it.
 * Without that, a later insertion lands a few lines off and still "succeeds".
 */

type DiffSide = GitLineSelection['side']

interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: string[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function parse(patch: string): { header: string[]; hunks: Hunk[] } | null {
  const header: string[] = []
  const hunks: Hunk[] = []
  let files = 0
  const lines = patch.split('\n')
  // A trailing newline leaves one empty element that is not part of any hunk.
  if (lines.at(-1) === '') lines.pop()
  for (const line of lines) {
    // More than one file means the diff was not limited to one path.
    if (line.startsWith('diff --git ') && ++files > 1) return null
    const match = HUNK_HEADER.exec(line)
    if (match) {
      hunks.push({
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: [line],
      })
      continue
    }
    const current = hunks.at(-1)
    if (current) current.lines.push(line)
    else header.push(line)
  }
  return files === 1 ? { header, hunks } : null
}

/**
 * The lines a hunk occupies on one side. A hunk with no lines on that side
 * (a pure insertion seen from the old side, or a pure deletion from the new
 * side) sits between lines, so it is treated as the line after its anchor:
 * that is where the editor shows the change.
 */
function span(hunk: Hunk, side: DiffSide): [number, number] {
  const start = side === 'old' ? hunk.oldStart : hunk.newStart
  const count = side === 'old' ? hunk.oldCount : hunk.newCount
  if (count === 0) return [start + 1, start + 1]
  return [start, start + count - 1]
}

/** A hunk's position as "lines before it" on one side (a 0-count start already is). */
function anchor(start: number, count: number): number {
  return count === 0 ? start : start - 1
}

function fromAnchor(position: number, count: number): number {
  return count === 0 ? position : position + 1
}

function headerFor(hunk: Hunk): string {
  return `@@ -${String(hunk.oldStart)},${String(hunk.oldCount)} +${String(hunk.newStart)},${String(hunk.newCount)} @@`
}

/**
 * Renumber the result side of the kept hunks. Applied forward (staging), the
 * index is the old side and the new side is rebuilt; reversed (unstaging), the
 * index is the new side and the old side is rebuilt.
 */
function rebase(hunks: Hunk[], reverse: boolean): Hunk[] {
  let shift = 0
  return hunks.map((hunk) => {
    const next = { ...hunk }
    if (reverse) {
      next.oldStart = fromAnchor(anchor(hunk.newStart, hunk.newCount) - shift, hunk.oldCount)
      shift += hunk.newCount - hunk.oldCount
    } else {
      next.newStart = fromAnchor(anchor(hunk.oldStart, hunk.oldCount) + shift, hunk.newCount)
      shift += hunk.newCount - hunk.oldCount
    }
    next.lines = [headerFor(next), ...hunk.lines.slice(1)]
    return next
  })
}

/**
 * Returns the patch limited to the touched hunks, renumbered for the direction
 * it will be applied in (`reverse` to unstage), or null when none is touched.
 */
export function selectHunks(
  patch: string,
  selection: GitLineSelection,
  reverse: boolean,
): string | null {
  const parsed = parse(patch)
  if (!parsed) return null
  const lo = Math.min(selection.startLine, selection.endLine)
  const hi = Math.max(selection.startLine, selection.endLine)
  const chosen = parsed.hunks.filter((hunk) => {
    const [start, end] = span(hunk, selection.side)
    return start <= hi && end >= lo
  })
  if (chosen.length === 0) return null
  const kept = rebase(chosen, reverse)
  return [...parsed.header, ...kept.flatMap((hunk) => hunk.lines), ''].join('\n')
}
