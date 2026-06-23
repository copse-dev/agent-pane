import { z } from 'zod'
import type { ToolDefinition } from '@shared/types'
import { getGhPrListText, getGhPrViewText } from '../services/gh-service.ts'

export const ghPrListTool: ToolDefinition = {
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
}

export const ghPrViewTool: ToolDefinition = {
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
}
