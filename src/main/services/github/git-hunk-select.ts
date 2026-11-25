import type { GitLineSelection } from '@shared/types/git.ts'

/**
 * Picks the hunks of a zero-context `git diff` that a line selection touches,
 * so the Changes pane can stage or unstage part of a file. The result is a
 * patch for `git apply --cached --unidiff-zero` (forward to stage, `--reverse`
 * to unstage).
 *
 * Hunks are the unit: with `-U0` each hunk is one contiguous run of removed
 * and added lines, so selecting any line of a change takes the whole change.
 * Skipping a hunk never shifts the others, because every header counts lines
 * in the file the patch is applied to (the index), which only the chosen hunks
 * change.
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

/** Returns the patch limited to the touched hunks, or null when none is. */
export function selectHunks(patch: string, selection: GitLineSelection): string | null {
  const parsed = parse(patch)
  if (!parsed) return null
  const lo = Math.min(selection.startLine, selection.endLine)
  const hi = Math.max(selection.startLine, selection.endLine)
  const chosen = parsed.hunks.filter((hunk) => {
    const [start, end] = span(hunk, selection.side)
    return start <= hi && end >= lo
  })
  if (chosen.length === 0) return null
  return [...parsed.header, ...chosen.flatMap((hunk) => hunk.lines), ''].join('\n')
}
