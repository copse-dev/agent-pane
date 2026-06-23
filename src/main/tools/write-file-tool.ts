import * as fsp from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '@shared/types'
import { computeLineDiffStats } from '@shared/diff/line-stats.ts'
import { resolveWorkspacePath } from '../services/workspace.ts'
import { applyOrStageDiff } from '../services/diff-queue.ts'
import { detectLanguage } from '../services/language.ts'

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    'Write a complete file. Applies directly when the git worktree is clean or only contains Copse-applied edits from this session; otherwise stages a proposed diff for user approval.',
  parameters: z.object({
    path: z.string().describe('File path relative to workspace root'),
    content: z.string().describe('Complete new file content'),
  }),
  async execute({ path, content }) {
    const absPath = resolveWorkspacePath(path)
    let before = ''
    try {
      before = await fsp.readFile(absPath, 'utf-8')
    } catch {
      /* new file */
    }

    const language = detectLanguage(path)
    const editStats = computeLineDiffStats(before, content)
    const result = await applyOrStageDiff(path, before, content, language)
    return { result, editStats }
  },
}
