import { z } from 'zod'
import { defineTool } from '@shared/types'
import { computeLineDiffStats } from '@shared/diff/line-stats.ts'
import { resolvePathWithinRoot } from '../services/workspace.ts'
import { requireAgentExecutionRoot } from '../services/execution-root.ts'
import { getActiveWorkspaceFs } from '../services/workspace-fs/get-workspace-fs.ts'
import { getPendingAfterContent, applyOrStageDiff } from '../services/diff-queue.ts'
import { detectLanguage } from '../services/language.ts'
import { applyLfViewEdits, toLfView } from '@shared/line-endings.ts'
import { isAgentRunExploreMode } from '../services/agent-run-explore-mode.ts'
import { EXPLORE_EXCERPTS_HEADING } from '@copse/agent/explore-excerpts.ts'

/** Non-overlapping match offsets, left to right. */
function matchOffsets(haystack: string, needle: string): number[] {
  if (needle === '') return []
  const offsets: number[] = []
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    offsets.push(at)
  }
  return offsets
}

/**
 * explore returns a prose summary with approximate line numbers, not verbatim
 * bytes, so telling the model to "re-read" is ambiguous — it was satisfied by
 * calling explore again (#1433). Name the remedy the run actually has: outside
 * explore mode, read_file returns the exact text; in explore mode read_file is
 * delegated away from the parent (see `PARENT_DELEGATED_TOOLS`), and the exact
 * text is the verbatim-excerpt half of an explore result (Fix 0).
 */
export function oldStringNotFoundMessage(path: string, exploreMode: boolean): string {
  if (exploreMode) {
    return `old_string was not found in the file. Copy old_string byte-for-byte from a "${EXPLORE_EXCERPTS_HEADING}" block for ${path} in an explore result, not from the prose summary above it. If no excerpt covers those lines, call explore with paths: ["${path}"] naming the function or lines you will change.`
  }
  return `old_string was not found in the file. Call read_file on ${path} and copy the exact text from its output — explore returns a summary, not verbatim bytes.`
}

export const strReplaceTool = defineTool({
  name: 'str_replace',
  description:
    'Replace text in an existing file. Applies directly when the git worktree is clean or only contains Copse-applied edits from this session; otherwise stages a proposed diff for user approval. If the file already has a pending staged diff, the replacement is applied to that pending proposed content so edits compose.',
  parameters: z.object({
    path: z.string().describe('File path relative to workspace root'),
    old_string: z.string().describe('Exact text to find in the file'),
    new_string: z.string().describe('Replacement text'),
    replace_all: z
      .boolean()
      .optional()
      .default(false)
      .describe('Replace every occurrence; default requires exactly one match'),
  }),
  async execute({ path, old_string, new_string, replace_all }) {
    if (!old_string) return 'old_string must not be empty'

    const absPath = await resolvePathWithinRoot(path, requireAgentExecutionRoot())
    let before = getPendingAfterContent(path)
    if (before === null) {
      try {
        before = await getActiveWorkspaceFs().readFile(absPath, 'utf-8')
      } catch {
        return `File not found: ${path}`
      }
    }

    // Match against the same LF view read_file shows (a CRLF file's lines are
    // shown with `\n`), then write back with the file's own line breaks.
    const view = toLfView(before)
    const oldString = toLfView(old_string).text
    const newString = toLfView(new_string).text
    const matches = matchOffsets(view.text, oldString)
    const occurrences = matches.length
    if (occurrences === 0) return oldStringNotFoundMessage(path, isAgentRunExploreMode())
    if (!replace_all && occurrences > 1) {
      return `old_string appears ${String(occurrences)} times; include more surrounding context so it is unique, or set replace_all to true.`
    }

    // The replacement is spliced in by offset, never through `String#replace`,
    // which expands `$$`, `$&`, `` $` `` and `$'` inside a replacement string:
    // `` `Total: $${price}` `` used to land as `` `Total: ${price}` ``.
    // Compared in the LF view: rewriting identical text would otherwise still
    // normalise the line breaks inside the match.
    if (newString === oldString) {
      return 'No change: new_string is identical to old_string.'
    }
    const after = applyLfViewEdits(
      view,
      (replace_all ? matches : matches.slice(0, 1)).map((start) => ({
        start,
        end: start + oldString.length,
        replacement: newString,
      })),
    )

    const language = detectLanguage(path)
    const editStats = computeLineDiffStats(before, after)
    const result = await applyOrStageDiff(path, before, after, language)
    return { result, editStats }
  },
})
