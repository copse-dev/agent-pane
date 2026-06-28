import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  getGhPrListText,
  getGhPrViewText,
  getGhRunListText,
  getGhRunLogText,
} from '../services/gh-service.ts'

export const ghPrListTool = defineTool({
  name: 'gh_pr_list',
  description:
    'List pull requests for the current repository via GitHub CLI (read-only). Prefer over run_shell + gh.',
  parameters: z.object({
    state: z
      .enum(['open', 'closed', 'merged', 'all'])
      .optional()
      .default('open')
      .describe('PR state filter.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .default(20)
      .describe('Maximum number of PRs to return.'),
    head: z
      .string()
      .optional()
      .describe('Filter to PRs whose head branch matches this name (e.g. current feature branch).'),
  }),
  execute: async ({ state, limit, head }) => getGhPrListText({ state, limit, head }),
})

export const ghPrViewTool = defineTool({
  name: 'gh_pr_view',
  description:
    'Show details for one pull request via GitHub CLI (read-only). Omit number for the PR on the current branch.',
  parameters: z.object({
    number: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Pull request number. Omit to view the open PR for the checked-out branch.'),
    include_checks: z
      .boolean()
      .optional()
      .default(true)
      .describe('Include CI/check status in the response.'),
  }),
  execute: async ({ number, include_checks }) =>
    getGhPrViewText({ number, includeChecks: include_checks }),
})

export const ghRunListTool = defineTool({
  name: 'gh_run_list',
  description:
    'List recent CI workflow runs for a branch via GitHub CLI (read-only). Use to find the run id of a failing check before fetching its logs.',
  parameters: z.object({
    branch: z
      .string()
      .optional()
      .describe('Branch to filter runs by. Omit to use the checked-out branch.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .default(20)
      .describe('Maximum number of runs to return.'),
    failed_only: z
      .boolean()
      .optional()
      .default(false)
      .describe('Only return runs that failed (failure, error, or timed out).'),
  }),
  execute: async ({ branch, limit, failed_only }) =>
    getGhRunListText({ branch, limit, failedOnly: failed_only }),
})

export const ghRunViewTool = defineTool({
  name: 'gh_run_view',
  description:
    'Fetch the logs of a CI workflow run via GitHub CLI (read-only). Defaults to only the failed steps; long logs are truncated to the tail. Use after gh_run_list to read why a check failed.',
  parameters: z.object({
    run_id: z.number().int().positive().describe('Workflow run id (databaseId from gh_run_list).'),
    failed_only: z
      .boolean()
      .optional()
      .default(true)
      .describe('Return only the logs of failed steps. Set false for the full run log.'),
  }),
  execute: async ({ run_id, failed_only }) =>
    getGhRunLogText({ runId: run_id, failedOnly: failed_only }),
})
