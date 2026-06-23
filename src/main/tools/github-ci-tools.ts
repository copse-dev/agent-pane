import { z } from 'zod'
import type { ToolDefinition } from '@shared/types'
import { getCiFailureLogs, getCiStatus, waitForCiChecks } from '../services/github-ci-service.ts'
const prNumberSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('Pull request number. Omit to use the open PR for the current branch.')

export const getCiStatusTool: ToolDefinition = {
  name: 'get_ci_status',
  description:
    'Read GitHub pull request CI check status for the current branch or a specific PR number. ' +
    'Use after pushing to see whether remote checks are pending, passing, or failing.',
  parameters: z.object({
    pr_number: prNumberSchema,
  }),
  execute: async ({ pr_number }, _signal) => {
    const status = await getCiStatus(pr_number)
    return JSON.stringify(status, null, 2)
  },
}

export const waitForCiChecksTool: ToolDefinition = {
  name: 'wait_for_ci_checks',
  description:
    'Block until GitHub CI checks finish for a pull request. Use once after push instead of polling with shell sleep loops.',
  parameters: z.object({
    pr_number: prNumberSchema,
    timeout_seconds: z
      .number()
      .int()
      .min(30)
      .max(7_200)
      .optional()
      .default(1_800)
      .describe('Maximum time to wait in seconds (default 1800 / 30 minutes).'),
    poll_interval_seconds: z
      .number()
      .int()
      .min(5)
      .max(120)
      .optional()
      .default(15)
      .describe('Seconds between GitHub status refreshes while waiting (default 15).'),
  }),
  execute: async ({ pr_number, timeout_seconds, poll_interval_seconds }, signal) => {
    const status = await waitForCiChecks(
      {
        prNumber: pr_number,
        timeoutMs: timeout_seconds * 1_000,
        pollIntervalSec: poll_interval_seconds,
      },
      signal,
    )
    return JSON.stringify(status, null, 2)
  },
}

export const getCiFailureLogsTool: ToolDefinition = {
  name: 'get_ci_failure_logs',
  description:
    'Fetch failed GitHub Actions log output for a pull request workflow run. ' +
    'Use after get_ci_status or wait_for_ci_checks reports failure.',
  parameters: z.object({
    pr_number: prNumberSchema,
    run_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Workflow run database id. Omit to use the latest run for the PR head commit.'),
  }),
  execute: async ({ pr_number, run_id }, _signal) => {
    return getCiFailureLogs({ prNumber: pr_number, runId: run_id })
  },
}
