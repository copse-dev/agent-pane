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
    'Read-only Copse source-worktree readiness check. Reports the pinned Node and pnpm state, dependency fingerprint, Electron runtime, matching ChromeDriver, gortex binary, and remote-E2E configuration. Use before running project tests/builds when a fresh or changed worktree may not be prepared. Set offline=true to verify that the current prepared state is usable without downloads.',
  parameters: z.object({
    offline: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Report unavailable-offline when matching prepared inputs are not already present.',
      ),
  }),
  execute({ offline }) {
    const root = getAgentExecutionRoot()
    if (!root) return 'No workspace open.'
    return formatWorktreePreparationReport(inspectWorktreePreparation(root, { offline }))
  },
})

export const prepareWorktreeTool = defineTool({
  name: 'prepare_worktree',
  description:
    'Prepare a Copse source worktree through one bounded, approval-gated operation. Uses Copse-managed Corepack, pnpm, Electron, ChromeDriver, and gortex caches; installs lockfile-pinned packages through Socket Firewall with all dependency lifecycle scripts disabled; then runs only the repository-declared prepare:native entry point. Reuses the worktree dependency fingerprint, so unchanged prepared worktrees are a no-op. Set offline=true to forbid downloads and fail with concise cache remediation.',
  parameters: z.object({
    offline: z
      .boolean()
      .optional()
      .default(false)
      .describe('Forbid downloads and use only matching inputs already in Copse-managed caches.'),
  }),
  async execute({ offline }, signal) {
    const root = getAgentExecutionRoot()
    if (!root) return 'No workspace open.'
    return formatWorktreePreparationReport(await prepareWorktree(root, { offline, signal }))
  },
})
