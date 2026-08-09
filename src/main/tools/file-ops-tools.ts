import { z } from 'zod'
import { defineTool } from '@shared/types'
import { computeLineDiffStats } from '@shared/diff/line-stats.ts'
import { resolvePathWithinRoot } from '../services/workspace.ts'
import { requireAgentExecutionRoot } from '../services/execution-root.ts'
import { getActiveWorkspaceFs } from '../services/workspace-fs/get-workspace-fs.ts'
import { applyOrStageFileOp } from '../services/diff-queue.ts'
import { detectLanguage } from '../services/language.ts'

export const deleteFileTool = defineTool({
  name: 'delete_file',
  description:
    'Delete an existing file. Applies directly when this thread runs in its own isolated worktree; otherwise stages the deletion for user approval (shown as a diff removing the file) and the file is not removed until accepted. Use this instead of run_shell rm so the deletion flows through the approval model.',
  parameters: z.object({
    path: z.string().describe('File path relative to workspace root'),
  }),
  async execute({ path }) {
    const root = requireAgentExecutionRoot()
    const absPath = await resolvePathWithinRoot(path, root)
    let before: string
    try {
      before = await getActiveWorkspaceFs().readFile(absPath, 'utf-8')
    } catch {
      return `File not found: ${path}`
    }
    // Report the deletion as all lines removed (additions: 0) so the tool card
    // shows the removed line count rather than a blank, mis-rendered stat.
    const editStats = computeLineDiffStats(before, '')
    const result = await applyOrStageFileOp({
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
    'Rename or move a file from one path to another. Applies directly when this thread runs in its own isolated worktree; otherwise stages the move for user approval and nothing changes on disk until accepted. Use this instead of run_shell mv so the move flows through the approval model.',
  parameters: z.object({
    from: z.string().describe('Existing file path relative to workspace root'),
    to: z.string().describe('Destination path relative to workspace root'),
  }),
  async execute({ from, to }) {
    if (from === to) return 'Source and destination are the same path.'
    const root = requireAgentExecutionRoot()
    const fromAbs = await resolvePathWithinRoot(from, root)
    // Validate destination resolves inside the workspace before staging.
    await resolvePathWithinRoot(to, root)
    let before: string
    try {
      before = await getActiveWorkspaceFs().readFile(fromAbs, 'utf-8')
    } catch {
      return `File not found: ${from}`
    }
    try {
      await getActiveWorkspaceFs().access(await resolvePathWithinRoot(to, root))
      return `Destination already exists: ${to}`
    } catch {
      /* destination is free */
    }
    return applyOrStageFileOp({
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
    'Create a directory (including any missing parents). Applies directly when this thread runs in its own isolated worktree; otherwise stages the creation for user approval and the directory is not created until accepted.',
  parameters: z.object({
    path: z.string().describe('Directory path relative to workspace root'),
  }),
  async execute({ path }) {
    const absPath = await resolvePathWithinRoot(path, requireAgentExecutionRoot())
    try {
      const stat = await getActiveWorkspaceFs().stat(absPath)
      if (stat.isDirectory()) return `Directory already exists: ${path}`
      return `Path already exists and is not a directory: ${path}`
    } catch {
      /* does not exist — proceed to stage */
    }
    return applyOrStageFileOp({
      op: 'mkdir',
      path,
      before: '',
      after: `[create directory] ${path}`,
      language: 'plaintext',
    })
  },
})
