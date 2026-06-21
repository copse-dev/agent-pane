import { z } from 'zod'
import type { ToolDefinition } from '@shared/types'
import { getGitDiffText, getGitLogText, getGitStatusText } from '../services/git-service.ts'
import { resolveWorkspacePath } from '../services/workspace.ts'

/** Reject paths that escape the workspace (absolute, `..`, symlink-out) before handing them to git. */
function validateGitPath(path: string | undefined): { ok: true } | { ok: false; error: string } {
  if (path === undefined) return { ok: true }
  try {
    resolveWorkspacePath(path)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export const gitStatusTool: ToolDefinition = {
  name: 'git_status',
  description: 'Show working tree status: staged, unstaged, and untracked files.',
  parameters: z.object({}),
  execute: async () => getGitStatusText(),
}

export const gitDiffTool: ToolDefinition = {
  name: 'git_diff',
  description: 'Show file changes as a unified diff.',
  parameters: z.object({
    path: z
      .string()
      .optional()
      .describe('File path relative to workspace root. Omit for all changes.'),
    staged: z
      .boolean()
      .optional()
      .default(false)
      .describe('Show staged (cached) diff instead of unstaged.'),
  }),
  execute: async ({ path, staged }) => {
    const valid = validateGitPath(path)
    if (!valid.ok) return valid.error
    return getGitDiffText(path, staged)
  },
}

export const gitLogTool: ToolDefinition = {
  name: 'git_log',
  description: 'Show recent commit history.',
  parameters: z.object({
    max_count: z.number().int().min(1).max(50).optional().default(10),
    path: z.string().optional().describe('Limit to commits touching this file.'),
  }),
  execute: async ({ max_count, path }) => {
    const valid = validateGitPath(path)
    if (!valid.ok) return valid.error
    return getGitLogText(max_count, path)
  },
}
