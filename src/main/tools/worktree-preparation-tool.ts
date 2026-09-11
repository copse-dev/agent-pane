import { containedPreparationPath } from '../services/worktree-preparation-plan.ts'
import { z } from 'zod'
import { defineTool } from '@shared/types'
import { getAgentExecutionRoot } from '../services/execution-root.ts'
import {
  formatWorktreePreparationReport,
  inspectWorktreePreparation,
  prepareWorktree,
} from '../services/worktree-preparation.ts'

export const preflightWorktreeTool = defineTool({
  name: 'preflight_worktree',
  description:
    'Read-only project readiness check. Detects npm, pnpm, Yarn (Classic and modern), or Bun from packageManager and lockfiles. Other ecosystems and optional native setup use .copse/worktree-preparation.json. Reports runtime requirements, dependency state, declared checks, exact setup commands, and a plan fingerprint. Unknown or conflicting projects get configuration guidance. Checks run offline in the OS sandbox.',
  parameters: z.object({
    directory: z
      .string()
      .optional()
      .default('.')
      .describe(
        'Project directory relative to the execution root, for nested projects. Must stay inside the worktree.',
      ),
    offline: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Report unavailable-offline when matching prepared inputs are not already present.',
      ),
  }),
  async execute({ offline, directory }) {
    const executionRoot = getAgentExecutionRoot()
    if (!executionRoot) return 'No workspace open.'
    const root = containedPreparationPath(executionRoot, directory)
    return formatWorktreePreparationReport(await inspectWorktreePreparation(root, { offline }))
  },
})

export const prepareWorktreeTool = defineTool({
  name: 'prepare_worktree',
  description:
    'Prepare the active project using the plan fingerprint returned by preflight_worktree. Approval displays the exact install and project-declared setup commands. Automatic JavaScript installs use frozen lockfiles and disabled lifecycle scripts through Socket Firewall. Declared setup runs in the same bounded OS sandbox; no repository-specific native scripts run implicitly. Writes stay in this worktree and managed caches. Offline mode blocks network for every subprocess.',
  parameters: z.object({
    directory: z
      .string()
      .optional()
      .default('.')
      .describe(
        'Project directory relative to the execution root, for nested projects. Must stay inside the worktree.',
      ),
    planFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe(
        'Exact plan fingerprint returned by preflight_worktree; changed plans require a new approval.',
      ),
    offline: z
      .boolean()
      .optional()
      .default(false)
      .describe('Forbid downloads and use only matching inputs already in Copse-managed caches.'),
  }),
  async execute({ offline, planFingerprint, directory }, signal) {
    const executionRoot = getAgentExecutionRoot()
    if (!executionRoot) return 'No workspace open.'
    const root = containedPreparationPath(executionRoot, directory)
    return formatWorktreePreparationReport(
      await prepareWorktree(root, { offline, signal, planFingerprint }),
    )
  },
})
