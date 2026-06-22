import * as fsp from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '@shared/types'
import { resolveWorkspacePath } from '../services/workspace.ts'
import { getPendingAfterContent, applyOrStageDiff } from '../services/diff-queue.ts'
import { detectLanguage } from '../services/language.ts'

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let idx = 0
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++
    idx += needle.length
  }
  return count
}

export const strReplaceTool: ToolDefinition = {
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

    const absPath = resolveWorkspacePath(path)
    let before = getPendingAfterContent(path)
    if (before === null) {
      try {
        before = await fsp.readFile(absPath, 'utf-8')
      } catch {
        return `File not found: ${path}`
      }
    }

    const occurrences = countOccurrences(before, old_string)
    if (occurrences === 0) {
      return 'old_string was not found in the file. Re-read the file and copy the exact snippet to replace.'
    }
    if (!replace_all && occurrences > 1) {
      return `old_string appears ${occurrences} times; include more surrounding context so it is unique, or set replace_all to true.`
    }

    const after = replace_all
      ? before.split(old_string).join(new_string)
      : before.replace(old_string, new_string)

    if (after === before) {
      return 'No change: new_string is identical to old_string.'
    }

    const language = detectLanguage(path)
    return applyOrStageDiff(path, before, after, language)
  },
}
