import * as fsp from 'node:fs/promises'
import { z } from 'zod'
import { defineTool } from '@shared/types'
import { computeLineDiffStats } from '@shared/diff/line-stats.ts'
import { resolveWorkspacePath } from '../services/workspace.ts'
import { stageFileOp } from '../services/diff-queue.ts'
import { detectLanguage } from '../services/language.ts'

export const deleteFileTool = defineTool({
  name: 'delete_file',
  description:
    'Propose deleting an existing file. Stages the deletion for user approval (shown as a diff removing the file) — the file is not removed until accepted. Use this instead of run_shell rm so the deletion flows through the approval model.',
  parameters: z.object({
    path: z.string().describe('File path relative to workspace root'),
  }),
  async execute({ path }) {
    const absPath = await resolveWorkspacePath(path)
    let before: string
    try {
      before = await fsp.readFile(absPath, 'utf-8')
    } catch {
      return `File not found: ${path}`
    }
    // Report the deletion as all lines removed (additions: 0) so the tool card
    // shows the removed line count rather than a blank, mis-rendered stat.
    const editStats = computeLineDiffStats(before, '')
    const result = await stageFileOp({
      op: 'delete',
      path,
      before,
      after: '',
      language: detectLanguage(path),
    })
    return { result, editStats }
  },
})

export const renameFileTool = defineTool({
  name: 'rename_file',
  description:
    'Propose renaming or moving a file from one path to another. Stages the move for user approval — nothing changes on disk until accepted. Use this instead of run_shell mv so the move flows through the approval model.',
  parameters: z.object({
    from: z.string().describe('Existing file path relative to workspace root'),
    to: z.string().describe('Destination path relative to workspace root'),
  }),
  async execute({ from, to }) {
    if (from === to) return 'Source and destination are the same path.'
    const fromAbs = await resolveWorkspacePath(from)
    // Validate destination resolves inside the workspace before staging.
    await resolveWorkspacePath(to)
    let before: string
    try {
      before = await fsp.readFile(fromAbs, 'utf-8')
    } catch {
      return `File not found: ${from}`
    }
    try {
      await fsp.access(await resolveWorkspacePath(to))
      return `Destination already exists: ${to}`
    } catch {
      /* destination is free */
    }
    return stageFileOp({
      op: 'rename',
      path: from,
      renameTo: to,
      before,
      after: before,
      language: detectLanguage(to),
    })
  },
})

export const makeDirectoryTool = defineTool({
  name: 'make_directory',
  description:
    'Propose creating a directory (including any missing parents). Stages the creation for user approval — the directory is not created until accepted.',
  parameters: z.object({
    path: z.string().describe('Directory path relative to workspace root'),
  }),
  async execute({ path }) {
    const absPath = await resolveWorkspacePath(path)
    try {
      const stat = await fsp.stat(absPath)
      if (stat.isDirectory()) return `Directory already exists: ${path}`
      return `Path already exists and is not a directory: ${path}`
    } catch {
      /* does not exist — proceed to stage */
    }
    return stageFileOp({
      op: 'mkdir',
      path,
      before: '',
      after: `[create directory] ${path}`,
      language: 'plaintext',
    })
  },
})
