import { z } from 'zod'
import type { ToolDefinition } from '@shared/types'
import { getGitDiffText, getGitLogText, getGitStatusText } from '../services/git-service.ts'

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
  execute: async ({ path, staged }) => getGitDiffText(path, staged),
}

export const gitLogTool: ToolDefinition = {
  name: 'git_log',
  description: 'Show recent commit history.',
  parameters: z.object({
    max_count: z.number().int().min(1).max(50).optional().default(10),
    path: z.string().optional().describe('Limit to commits touching this file.'),
  }),
  execute: async ({ max_count, path }) => getGitLogText(max_count, path),
}
