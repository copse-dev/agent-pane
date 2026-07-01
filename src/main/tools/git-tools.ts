import { errorMessage } from '@shared/errors.ts'
import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  commitWithAttribution,
  getGitDiffText,
  getGitLogText,
  getGitShowText,
  getGitStatusText,
} from '../services/git-service.ts'
import { resolveWorkspacePath } from '../services/workspace.ts'
import { getActiveRunThread, getThreadModels } from '../services/thread-models.ts'

/** Reject paths that escape the workspace (absolute, `..`, symlink-out) before handing them to git. */
function validateGitPath(path: string | undefined): { ok: true } | { ok: false; error: string } {
  if (path === undefined) return { ok: true }
  try {
    resolveWorkspacePath(path)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

export const gitStatusTool = defineTool({
  name: 'git_status',
  description: 'Show working tree status: staged, unstaged, and untracked files.',
  parameters: z.object({}),
  execute: async () => getGitStatusText(),
})

export const gitDiffTool = defineTool({
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
})

export const gitCommitTool = defineTool({
  name: 'git_commit',
  description:
    'Create a git commit. Copse automatically appends a "Co-Authored-By: Copse" trailer and a "Copse-Models" line naming the model(s) used in this thread — prefer this over `run_shell git commit` so attribution is added reliably. Local only; it never pushes.',
  parameters: z.object({
    message: z
      .string()
      .min(1)
      .describe(
        'Commit message. First line is the subject; add body paragraphs after a blank line.',
      ),
    stage_all: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Run `git add -A` to stage all changes before committing. Omit to commit only what is already staged.',
      ),
  }),
  execute: async ({ message, stage_all }) => {
    const threadId = getActiveRunThread()
    const models = threadId ? getThreadModels(threadId) : []
    return commitWithAttribution(message, models, stage_all)
  },
})

export const gitShowTool = defineTool({
  name: 'git_show',
  description:
    "Show a file's contents at a specific commit/ref, or view a commit (message + diff). Read-only and scoped to the workspace.",
  parameters: z.object({
    ref: z
      .string()
      .min(1)
      .describe('Commit, tag, or branch to show (e.g. HEAD, HEAD~2, a branch name, or a SHA).'),
    path: z
      .string()
      .optional()
      .describe(
        "File path relative to workspace root. When set, shows that file's contents at `ref`. Omit to show the whole commit (message + diff), limited to the workspace.",
      ),
  }),
  execute: async ({ ref, path }) => {
    const valid = validateGitPath(path)
    if (!valid.ok) return valid.error
    return getGitShowText(ref, path)
  },
})

export const gitLogTool = defineTool({
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
})
