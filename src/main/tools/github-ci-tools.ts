import { z } from 'zod'
import { defineTool } from '@shared/types'
import { getCiFailureLogs, getCiStatus } from '../services/github/github-ci-service.ts'
import { scheduleCiWatch } from '../services/github/ci-watch-service.ts'
import {
  getThreadExecutionContext,
  requireThreadExecutionOwner,
  resolveThreadExecutionContext,
} from '../services/thread-execution-context.ts'
import { getActiveRunTurnTreeId } from '../services/thread-models.ts'
const prNumberSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('Pull request number. Omit to use the open PR for the current branch.')

export const getCiStatusTool = defineTool({
  name: 'get_ci_status',
  description:
    'Read GitHub pull request CI check status for the current branch or a specific PR number. ' +
    'Use after pushing to see whether remote checks are pending, passing, or failing.',
  parameters: z.object({
    pr_number: prNumberSchema,
  }),
  execute: async ({ pr_number }, _signal) => {
    const context = getThreadExecutionContext()
    const status = await getCiStatus(pr_number, context?.root)
    return JSON.stringify(status, null, 2)
  },
})

export const waitForCiChecksTool = defineTool({
  name: 'wait_for_ci_checks',
  description:
    'Register a durable wait for GitHub CI after a push, then end the current turn. Copse checks in the background and resumes this task once when CI finishes, including after the app is closed and reopened. If CI is already finished, returns its status immediately without scheduling a continuation.',
  parameters: z.object({
    pr_number: prNumberSchema,
    timeout_seconds: z
      .number()
      .int()
      .min(30)
      .max(86_400)
      .optional()
      .default(7_200)
      .describe('Maximum durable watch lifetime in seconds (default 7200 / 2 hours).'),
    poll_interval_seconds: z
      .number()
      .int()
      .min(15)
      .max(300)
      .optional()
      .default(60)
      .describe('Seconds between GitHub status refreshes while Copse is open (default 60).'),
  }),
  execute: async ({ pr_number, timeout_seconds, poll_interval_seconds }, _signal) => {
    const owner = requireThreadExecutionOwner()
    const context =
      getThreadExecutionContext() ??
      (await resolveThreadExecutionContext(owner.projectId, owner.threadId))
    const turnTreeId = getActiveRunTurnTreeId()
    if (!turnTreeId) return 'Cannot register a durable CI watch outside an active turn tree.'
    const result = await scheduleCiWatch({
      context,
      turnTreeId,
      ...(pr_number !== undefined ? { prNumber: pr_number } : {}),
      timeoutMs: timeout_seconds * 1_000,
      pollIntervalMs: poll_interval_seconds * 1_000,
    })
    if (!result.watching) {
      return `CI is already ${result.status.overall}; no continuation was scheduled.\n${JSON.stringify(result.status, null, 2)}`
    }
    return `Durable CI watch ${result.taskId ?? '(existing)'} is armed for PR #${String(result.status.prNumber)} at head ${result.status.headSha ?? '(unknown)'}. End this turn now; do not poll. Copse will resume this task once when CI finishes, or reconcile it immediately after the app is reopened.`
  },
})

export const getCiFailureLogsTool = defineTool({
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
    const context = getThreadExecutionContext()
    return getCiFailureLogs({ prNumber: pr_number, runId: run_id, cwd: context?.root })
  },
})
