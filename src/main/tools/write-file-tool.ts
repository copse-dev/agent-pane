import * as fsp from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '@shared/types'
import { resolveWorkspacePath } from '../services/workspace.ts'
import { stageDiff } from '../services/diff-queue.ts'
import { detectLanguage } from '../services/language.ts'

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    'Propose writing content to a file. Shows a diff to the user who must approve before the file is saved. For new files, shows the full content as an addition.',
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
    return stageDiff(path, before, content, language)
  },
}
