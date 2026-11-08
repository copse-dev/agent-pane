import { realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import type { AutomationPreparationInput, AutomationPreparationReview } from '@shared/types'
import { resolveToolPermission } from '../security/tool-permissions.ts'
import { getProjectById } from '../workspace.ts'
import {
  containedPreparationPath,
  formatPreparationApproval,
  readWorktreePreparationPlan,
} from '../worktree-preparation-plan.ts'

/** A moved or deleted project folder reads as unavailable, not as a raw ENOENT. */
function canonicalProjectRoot(path: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      throw new Error('This project’s folder is no longer available.', { cause: error })
    throw error
  }
}

/** Resolve from the requested project, never the window's current workspace. */
export function reviewAutomationPreparation(
  projectId: string,
  input: AutomationPreparationInput,
): AutomationPreparationReview {
  const policy = resolveToolPermission('prepare_worktree')?.policy
  if (policy === 'block' || policy === 'ask') {
    throw new Error(
      policy === 'block'
        ? 'Worktree preparation is blocked in tool permissions.'
        : 'Worktree preparation is set to Always ask, so this automation cannot remember it.',
    )
  }
  const project = getProjectById(projectId)
  if (!project) throw new Error('This project is no longer available.')
  if ('sshHost' in project && typeof project.sshHost === 'string')
    throw new Error('Worktree setup review is available for local projects only.')
  if (!isAbsolute(project.path))
    throw new Error('This project does not have an absolute local path.')
  const projectRoot = canonicalProjectRoot(project.path)
  const plan = readWorktreePreparationPlan(
    containedPreparationPath(projectRoot, input.directory ?? '.'),
  )
  if (plan.problems.length > 0)
    throw new Error(`Worktree setup needs attention: ${plan.problems.join(' ')}`)
  const offline = input.offline === true
  return {
    projectId,
    projectName: project.name,
    permission: {
      kind: 'worktree-preparation',
      toolName: 'prepare_worktree',
      directory: relative(projectRoot, plan.root) || '.',
      planFingerprint: plan.contentFingerprint,
      offline,
    },
    ...formatPreparationApproval(plan, offline),
  }
}
