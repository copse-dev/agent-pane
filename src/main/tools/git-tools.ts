import { z } from 'zod'
import type { ToolDefinition } from '@shared/types'
import { getWorkspaceRoot } from '../services/workspace.ts'
import { runCommand } from '../services/command-runner.ts'
import { isGitAvailable } from '../services/tool-availability.ts'

async function git(args: string[]): Promise<string> {
  if (!isGitAvailable()) return 'git is not available on this system.'
  const cwd = getWorkspaceRoot()
  if (!cwd) return 'No workspace open.'
  const { stdout, stderr, code } = await runCommand('git', args, { cwd })
  if (code !== 0) return stderr.trim() || `git exited with code ${code}`
  return stdout.trim() || '(no output)'
}

export const gitStatusTool: ToolDefinition = {
  name: 'git_status',
  description: 'Show working tree status: staged, unstaged, and untracked files.',
  parameters: z.object({}),
  execute: async () => git(['status', '--short']),
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
  execute: async ({ path, staged }) =>
    git(['diff', ...(staged ? ['--cached'] : []), '--', ...(path ? [path] : [])]),
}

export const gitLogTool: ToolDefinition = {
  name: 'git_log',
  description: 'Show recent commit history.',
  parameters: z.object({
    max_count: z.number().int().min(1).max(50).optional().default(10),
    path: z.string().optional().describe('Limit to commits touching this file.'),
  }),
  execute: async ({ max_count, path }) =>
    git(['log', `--max-count=${max_count}`, '--oneline', '--', ...(path ? [path] : [])]),
}
