import { errorMessage } from '@shared/errors.ts'
import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  appendCommitAttribution,
  DEFAULT_GIT_ATTRIBUTION_ENABLED,
  GIT_ATTRIBUTION_SETTING,
} from '@shared/git/commit-attribution.ts'
import {
  getGitDiffText,
  getGitLogText,
  getGitShowText,
  getGitStatusText,
} from '../services/github/git-service.ts'
import { resolvePathWithinRoot } from '../services/workspace.ts'
import { getAgentExecutionRoot } from '../services/execution-root.ts'
import { getActiveRunThread, getThreadModels } from '../services/thread-models.ts'
import { isGitAvailableForTarget } from '../services/tool-availability.ts'
import { ensureGitCommitPermitted } from '../services/security/permission-gate.ts'
import { posixQuote } from '../services/security/safe-install.ts'
import { isProjectSandboxEnabled } from '../project-sandbox/index.ts'
import {
  isActiveSshWorkspace,
  resolveSshExecutionTargetForCwd,
} from '../services/ssh-workspace/execution-target.ts'
import { runCommand } from '../services/exec/command-runner.ts'
import { leaseGitSigningBroker } from '../services/security/git-signing-broker.ts'
import { getSetting } from '../services/storage/settings.ts'

/** Reject paths that escape the workspace (absolute, `..`, symlink-out) before handing them to git. */
async function validateGitPath(
  path: string | undefined,
  root: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (path === undefined) return { ok: true }
  try {
    await resolvePathWithinRoot(path, root)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

export const gitStatusTool = defineTool({
  name: 'git_status',
  description: 'Show working tree status: staged, unstaged, and untracked files.',
  parameters: z.object({}),
  execute: async () => getGitStatusText(getAgentExecutionRoot()),
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
    const root = getAgentExecutionRoot()
    if (!root) return 'No workspace open.'
    const valid = await validateGitPath(path, root)
    if (!valid.ok) return valid.error
    return getGitDiffText(path, staged, root)
  },
})

export const gitCommitTool = defineTool({
  name: 'git_commit',
  description:
    'Create a git commit. When Git attribution is enabled in Settings (the default), Copse appends a "Co-Authored-By: Copse" trailer and a "Copse-Models" line naming the model(s) used in this thread. Local only; it never pushes.',
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
  execute: async ({ message, stage_all }, signal) => {
    const root = getAgentExecutionRoot()
    if (!root) return 'No workspace open.'
    if (!(await isGitAvailableForTarget())) return 'git is not available on this system.'

    const threadId = getActiveRunThread()
    const models = threadId ? getThreadModels(threadId) : []
    const fullMessage = getSetting<boolean>(
      GIT_ATTRIBUTION_SETTING,
      DEFAULT_GIT_ATTRIBUTION_ENABLED,
    )
      ? appendCommitAttribution(message, models)
      : message
    const commit = `git commit -m ${posixQuote(fullMessage)}`
    const command = stage_all ? `git add -A && ${commit}` : commit

    // A requested commit must honor hooks/signing, unlike automatic snapshots.
    // Apply shell authorization before staging. Execution still uses literal
    // argv on every platform, retains the sandbox, and never retries unsigned
    // or silently escapes confinement when a configured helper fails.
    const remote = isActiveSshWorkspace() || resolveSshExecutionTargetForCwd(root) !== null
    const sandboxEnabled = isProjectSandboxEnabled() && !remote
    const permitted = await ensureGitCommitPermitted(command, root, sandboxEnabled, signal)
    if (!permitted) return 'User rejected git commit.'
    const steps = stage_all
      ? [
          ['add', '-A'],
          ['commit', '-m', fullMessage],
        ]
      : [['commit', '-m', fullMessage]]
    const signing = sandboxEnabled ? await leaseGitSigningBroker(root, signal, command) : null
    let output = ''
    try {
      for (const args of steps) {
        const result = await runCommand('git', args, {
          cwd: root,
          signal,
          requireSandbox: sandboxEnabled,
          gitConfig: 'user-command',
          ...(signing ? { gitSigning: signing.signing, sandboxConfig: signing.sandboxConfig } : {}),
        })
        if (result.code !== 0) {
          throw new Error(
            result.stderr.trim() ||
              result.stdout.trim() ||
              `Git exited with code ${String(result.code)}`,
          )
        }
        output = result.stdout.trim()
      }
      return output || '(committed)'
    } finally {
      await signing?.release()
    }
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
    const root = getAgentExecutionRoot()
    if (!root) return 'No workspace open.'
    const valid = await validateGitPath(path, root)
    if (!valid.ok) return valid.error
    return getGitShowText(ref, path, root)
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
    const root = getAgentExecutionRoot()
    if (!root) return 'No workspace open.'
    const valid = await validateGitPath(path, root)
    if (!valid.ok) return valid.error
    return getGitLogText(max_count, path, root)
  },
})
