import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  formatExcerptBlock,
  formatLineRange,
  quoteExploredLines,
  type ExploredSpan,
} from '@copse/agent/explore-excerpts.ts'
import { toLfView } from '@shared/line-endings.ts'
import { exploredSpansThisRun } from '../services/agent-run-explore-mode.ts'
import { getAgentRunReadFileLimits } from '../services/agent-run-read-limits.ts'
import { getPendingAfterContent } from '../services/diff-queue.ts'
import { requireAgentExecutionRoot } from '../services/execution-root.ts'
import { resolvePathWithinRoot } from '../services/workspace.ts'
import { getActiveWorkspaceFs } from '../services/workspace-fs/get-workspace-fs.ts'

export const READ_EXPLORED_TOOL = 'read_explored'

/**
 * The text str_replace would match today, as LF-view lines: a pending staged
 * diff's proposed content when there is one, else the file on disk. Null when
 * the file cannot be read.
 */
async function currentLines(path: string): Promise<string[] | null> {
  let content = getPendingAfterContent(path)
  if (content === null) {
    try {
      const abs = await resolvePathWithinRoot(path, requireAgentExecutionRoot())
      content = await getActiveWorkspaceFs().readFile(abs, 'utf-8')
    } catch {
      return null
    }
  }
  const text = toLfView(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content).text
  return text.split('\n')
}

/** A piece ending in a cut line holds only that line's start, so it matches a prefix. */
function stillCurrent(
  piece: ExploredSpan,
  lines: readonly string[] | null,
  cutLine: number | null,
): boolean {
  if (lines === null) return false
  const current = lines.slice(piece.startLine - 1, piece.endLine).join('\n')
  return piece.endLine === cutLine ? current.startsWith(piece.text) : current === piece.text
}

/**
 * Routed reads against what exploration already read (#1433, Fix 0b). In
 * explore mode the parent has no read_file; explore results carry verbatim
 * excerpts, but a bounded number of them. This serves other lines from the
 * spans the explore subagents of this run read, byte-for-byte, so the parent
 * can widen an excerpt or fetch one the budget left out without another
 * summarizing explore. It never reads lines exploration did not: an unread
 * path or range is answered "explore it first", not with a disk fallback,
 * which would quietly restore general browsing. Each quote is checked against
 * the current text str_replace would match, so an edit since exploration
 * yields "explore again" instead of stale bytes.
 */
export const readExploredTool = defineTool({
  name: READ_EXPLORED_TOOL,
  description:
    'Quote exact lines that an explore call in this run already read, byte-for-byte, to copy str_replace old_string from. Serves only lines exploration read; for any other file or lines, call explore first. Omit start_line/end_line for every explored part of the file.',
  parameters: z.object({
    path: z.string().describe('File path relative to workspace root, as explore reported it'),
    start_line: z.number().int().min(1).optional().describe('First line (1-indexed)'),
    end_line: z.number().int().min(1).optional().describe('Last line (inclusive)'),
  }),
  async execute({ path, start_line, end_line }) {
    const normalized = path.replace(/^\.\//, '')
    if (start_line !== undefined && end_line !== undefined && end_line < start_line) {
      return `Invalid range: end_line (${String(end_line)}) must be >= start_line (${String(start_line)}).`
    }
    const lookup = quoteExploredLines(
      exploredSpansThisRun(),
      normalized,
      { startLine: start_line, endLine: end_line },
      getAgentRunReadFileLimits().maxChars,
    )
    if (lookup.kind === 'not-explored') {
      return `Not explored yet: no explore call in this run read ${normalized}. Call explore with paths: ["${normalized}"] first.`
    }
    if (lookup.kind === 'outside') {
      const ranges = lookup.available.map(formatLineRange).join(', ')
      return `Exploration did not read those lines of ${normalized}. Explored: ${ranges}. Call explore with paths: ["${normalized}"] naming what you need from that part of the file.`
    }
    const lines = await currentLines(normalized)
    const stale = lookup.pieces.filter((p) => !stillCurrent(p, lines, lookup.cutLine))
    if (stale.length > 0) {
      return `${normalized} has changed since it was explored (${stale.map(formatLineRange).join(', ')} no longer match). Call explore on it again before editing.`
    }
    const parts = lookup.pieces.map(formatExcerptBlock)
    if (lookup.unread.length > 0) {
      const ranges = lookup.unread
        .map(([s, e]) => formatLineRange({ startLine: s, endLine: e }))
        .join(', ')
      parts.push(`Not read by exploration, so not quoted: ${ranges}.`)
    }
    if (lookup.cutLine !== null) {
      parts.push(
        `Line ${String(lookup.cutLine)} is longer than the read limit, so only its start is quoted; copy old_string from within that part.`,
      )
    }
    if (lookup.nextLine !== null) {
      parts.push(
        `Cut at the read limit; call ${READ_EXPLORED_TOOL} again with start_line=${String(lookup.nextLine)} for the rest.`,
      )
    }
    // Markdown so the card renders the quote as a code block; the model gets
    // the same text either way.
    return { result: parts.join('\n\n'), resultFormat: 'markdown' }
  },
})
