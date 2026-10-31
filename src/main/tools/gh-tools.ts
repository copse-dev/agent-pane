import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  getGhPrFilesText,
  getGhPrListText,
  getGhPrViewText,
  getGhRunListText,
  getGhRunLogText,
  runGh,
  type GhToolContext,
} from '../services/github/gh-service.ts'
import { getAgentExecutionRoot } from '../services/execution-root.ts'
import { getThreadExecutionContext } from '../services/thread-execution-context.ts'
import {
  GH_API_READ_MAX_OUTPUT_BYTES,
  GH_API_READ_MAX_PAGES,
  parseGhApiReadArgs,
  runGhApiRead,
} from '../services/github/gh-api-read.ts'

/**
 * The running turn's checkout and project, passed explicitly so a `gh_*` call
 * never reads the window's active project (#3958). Outside a turn there is no
 * project, so PR provenance reports itself unavailable.
 */
function ghToolContext(): GhToolContext {
  return {
    root: getAgentExecutionRoot(),
    projectId: getThreadExecutionContext()?.projectId ?? null,
  }
}

export const ghPrListTool = defineTool({
  name: 'gh_pr_list',
  provenance: 'external',
  description:
    'List pull requests via the host GitHub CLI without a shell approval. Use details: true for branch, review, merge, label, SHA, author, and update status; supports up to 200 PRs. Prefer over run_shell + gh.',
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
      .max(200)
      .optional()
      .default(20)
      .describe('Maximum number of PRs to return.'),
    head: z
      .string()
      .optional()
      .describe('Filter to PRs whose head branch matches this name (e.g. current feature branch).'),
    repo: z.string().optional().describe('Repository as owner/name. Defaults to the current repo.'),
    details: z.boolean().optional().default(false).describe('Include PR review and merge details.'),
  }),
  execute: async ({ state, limit, head, repo, details }) =>
    getGhPrListText({ state, limit, head, repo, details }, ghToolContext()),
})

export const ghPrViewTool = defineTool({
  name: 'gh_pr_view',
  provenance: 'external',
  description:
    'Show details for one pull request via GitHub CLI (read-only), plus local producing/related threads and exact recorded commit provenance. Missing commit evidence is unknown. Omit number for the PR on the current branch.',
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
    getGhPrViewText({ number, includeChecks: include_checks }, ghToolContext()),
})

export const ghPrFilesTool = defineTool({
  name: 'gh_pr_files',
  provenance: 'external',
  description:
    'List the files changed in a pull request, with per-file change type and +/- line counts, via GitHub CLI (read-only). Use this to answer "what files changed" instead of run_shell + gh/curl. Omit number for the PR on the current branch.',
  parameters: z.object({
    number: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Pull request number. Omit to use the open PR for the checked-out branch.'),
  }),
  execute: async ({ number }) => getGhPrFilesText({ number }, ghToolContext()),
})

export const ghRunListTool = defineTool({
  name: 'gh_run_list',
  provenance: 'external',
  description:
    'List recent CI workflow runs for a branch via GitHub CLI (read-only). Prefer over run_shell + gh. Use to find the run id of a failing check before fetching its logs.',
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
    getGhRunListText({ branch, limit, failedOnly: failed_only }, ghToolContext()),
})

export const ghRunViewTool = defineTool({
  name: 'gh_run_view',
  provenance: 'external',
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
    getGhRunLogText({ runId: run_id, failedOnly: failed_only }, ghToolContext()),
})

export const ghApiReadTool = defineTool({
  name: 'gh_api_read',
  provenance: 'external',
  description:
    "Read any GitHub data the user's gh login can read, without a shell approval: a REST GET (endpoint) or a single GraphQL query (graphql + variables). " +
    'Use this instead of run_shell + `gh api` / `gh api graphql`, which runs in the network-less sandbox and prompts. ' +
    'Copse builds the gh command itself: GET only, queries only (no mutations or subscriptions), no headers, flags, hosts or full URLs. ' +
    `Optional jq filters the response (env/$ENV are refused). Output is capped at ${String(GH_API_READ_MAX_OUTPUT_BYTES / 1024)} KiB; ` +
    `paginate follows up to ${String(GH_API_READ_MAX_PAGES)} pages (GraphQL pagination needs \`$endCursor: String\` and \`pageInfo { hasNextPage endCursor }\`).`,
  parameters: z.strictObject({
    endpoint: z
      .string()
      .optional()
      .describe(
        'REST path relative to the API root, with an optional query string, e.g. "repos/{owner}/{repo}/rules/branches/main" or "search/issues?q=repo:o/r+is:open". {owner}/{repo}/{branch} resolve from the current repository.',
      ),
    graphql: z
      .string()
      .optional()
      .describe('A GraphQL document with exactly one query operation (fragments allowed).'),
    variables: z
      .record(z.string(), z.json())
      .optional()
      .describe('GraphQL variables as a JSON object. GraphQL only.'),
    jq: z.string().optional().describe('jq filter applied to each response page, as gh --jq.'),
    paginate: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        `Follow pagination (REST Link headers or GraphQL pageInfo), up to ${String(GH_API_READ_MAX_PAGES)} pages.`,
      ),
  }),
  execute: async (args, signal) => {
    const input = parseGhApiReadArgs(args)
    if (!input.ok) return `gh_api_read refused: ${input.error}`
    const { root } = ghToolContext()
    return runGhApiRead(
      input.value,
      (ghArgs, opts) => runGh(ghArgs, { ...opts, cwd: root }),
      signal,
    )
  },
})
