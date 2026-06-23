import { z } from 'zod'
import type { ToolDefinition } from '@shared/types'
import { getCiInvestigatorRunner } from '../services/ci-investigator-runner.ts'

export const investigateCiTool: ToolDefinition = {
  name: 'investigate_ci',
  description:
    'Investigate failing CI checks for a pull request. Spawns a focused subagent that reads the failing workflow run logs in depth, ties the error back to the source, and returns a structured findings report (root cause + suggested fix) instead of raw logs. Use this when a PR has failing CI before attempting a fix.',
  parameters: z.object({
    focus: z
      .string()
      .optional()
      .describe('Optional hint about which check or symptom to focus the investigation on.'),
    pr_number: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Pull request number. Omit to use the open PR for the checked-out branch.'),
  }),
  async execute({ focus, pr_number }, signal) {
    const runner = getCiInvestigatorRunner()
    if (!runner) {
      return 'Error: CI investigator subagent is not available in this context.'
    }
    const result = await runner({ focus, prNumber: pr_number, signal })
    return result.summary
  },
}
