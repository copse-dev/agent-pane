import { realpathSync } from 'node:fs'
import {
  AUTO_APPROVAL_LEVEL_SETTING,
  DEFAULT_AUTO_APPROVAL_LEVEL,
  sanitizeAutoApprovalLevel,
} from '@shared/auto-approval.ts'
import { getSetting } from '../storage/settings.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import { isWorkspaceTrusted } from './workspace-trust.ts'
import { configuredGitRemotes } from './git-remotes.ts'
import { assessAutoApproval, type AutoApprovalDecision } from './auto-approval.ts'

export { AUTO_APPROVAL_LEVEL_SETTING } from '@shared/auto-approval.ts'

/**
 * Resolve a shell command's auto-approval decision, applying the gates that make
 * the classifier safe to honour — the same three the trusted-command router uses,
 * for the same reasons:
 *
 *  - **auto-run must be enabled.** Turning off "auto-run shell commands contained
 *    within the sandbox" is the user asking to see every command; a classifier
 *    that silently kept approving would be ignoring that.
 *  - **the workspace must be trusted.** A freshly-cloned, untrusted repository
 *    never gets its commands auto-approved, the same trust model that keeps
 *    project MCP servers inert. This matters more here than for the trusted-command
 *    list: that list is a per-binary grant the user typed out, while these shapes
 *    are granted by class, so an untrusted repo must not benefit from them.
 *  - **the level must cover the command's tier** (enforced inside the classifier).
 *
 * Returns `prompt` whenever any gate is closed, so the caller's existing prompt
 * path is the default.
 *
 * @param executionRoot the resolved execution root for this run, when the caller
 *   already knows it. Falls back to the workspace root.
 */
export function resolveAutoApproval(
  command: string,
  executionRoot?: string | null,
): AutoApprovalDecision {
  if (!getSetting<boolean>('autoRunSandboxCommands', true)) {
    return { action: 'prompt', reasons: ['auto-run disabled'] }
  }
  const workspaceRoot = getWorkspaceRoot()
  if (!isWorkspaceTrusted(workspaceRoot)) {
    return { action: 'prompt', reasons: ['workspace not trusted'] }
  }
  const root = executionRoot ?? workspaceRoot
  return assessAutoApproval(command, {
    workspaceRoot: root,
    level: autoApprovalLevel(),
    // Remotes come from the workspace root's repository: that is the checkout the
    // user opened and trusted. An execution root inside it (a worktree) shares the
    // same common config, which `configuredGitRemotes` resolves.
    configuredRemotes: configuredGitRemotes(workspaceRoot),
    canonicalizePath: realpathSync.native,
  })
}

/** The user's configured auto-approval level, validated on every read. */
export function autoApprovalLevel(): ReturnType<typeof sanitizeAutoApprovalLevel> {
  return sanitizeAutoApprovalLevel(
    getSetting<unknown>(AUTO_APPROVAL_LEVEL_SETTING, DEFAULT_AUTO_APPROVAL_LEVEL),
  )
}
