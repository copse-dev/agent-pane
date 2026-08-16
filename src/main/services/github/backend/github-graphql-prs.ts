/**
 * GraphQL selections that replace N REST round-trips for PR lists and CI dots.
 *
 * `gh pr list --json statusCheckRollup` already does this (one GraphQL query).
 * The REST backend used to list pulls, then hit `/check-runs` per PR — that
 * spends the REST hourly budget on work GraphQL can do in one point-costed
 * query. Cross-repo "my PRs" also leaves the Search API (30 req/min) and uses
 * `viewer.pullRequests` instead.
 */
import { deriveOverallState, rollupToCiChecks } from '../github-ci-service.ts'
import type { GhStatusCheckRollup } from '../gh-json-schemas.ts'
import { isRecord, nonEmptyStringOr, recordArrayOrEmpty } from '@shared/unknown-value.ts'
import type { GhPrChecksState, GhPrSummary } from '@shared/types/git.ts'

const CHECK_CONTEXT_NODES = `__typename
              ... on CheckRun { name status conclusion detailsUrl }
              ... on StatusContext { context state targetUrl }`

const ROLLUP_SELECTION = `statusCheckRollup {
          state
          contexts(first: 80) {
            nodes {
              ${CHECK_CONTEXT_NODES}
            }
          }
        }`

const PULL_SUMMARY_FIELDS = `number
        title
        url
        state
        createdAt
        updatedAt
        headRefName
        author { login }
        ${ROLLUP_SELECTION}`

export const WORKSPACE_OPEN_PRS_QUERY = `query($owner: String!, $repo: String!, $limit: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: $limit, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        ${PULL_SUMMARY_FIELDS}
      }
    }
  }
}`

export const MY_OPEN_PRS_QUERY = `query($limit: Int!) {
  viewer {
    pullRequests(states: OPEN, first: $limit, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        ${PULL_SUMMARY_FIELDS}
        repository { name owner { login } }
      }
    }
  }
}`

export const PR_CHECKS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      ${ROLLUP_SELECTION}
    }
  }
}`

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function mapCheckContext(
  node: Record<string, unknown>,
): NonNullable<GhStatusCheckRollup>[number] | null {
  const typename = optionalString(node['__typename'])
  if (typename === 'StatusContext' || optionalString(node['context'])) {
    const context = optionalString(node['context'])
    const item: NonNullable<GhStatusCheckRollup>[number] = {}
    if (context) {
      item.context = context
      item.name = context
    }
    const state = optionalString(node['state'])
    if (state) item.state = state
    const details = optionalString(node['targetUrl']) ?? optionalString(node['detailsUrl'])
    if (details) item.detailsUrl = details
    return item.name || item.context ? item : null
  }
  if (typename === 'CheckRun' || optionalString(node['name'])) {
    const item: NonNullable<GhStatusCheckRollup>[number] = {}
    const name = optionalString(node['name'])
    if (name) item.name = name
    const status = optionalString(node['status'])
    if (status) item.status = status
    const conclusion = optionalString(node['conclusion'])
    if (conclusion) item.conclusion = conclusion
    const details = optionalString(node['detailsUrl'])
    if (details) item.detailsUrl = details
    return item.name ? item : null
  }
  return null
}

/** Flatten GraphQL `statusCheckRollup.contexts.nodes` into the `gh pr view` rollup array. */
export function flattenGraphqlCheckRollup(raw: unknown): NonNullable<GhStatusCheckRollup> {
  if (Array.isArray(raw)) {
    return raw
      .filter(isRecord)
      .map(mapCheckContext)
      .filter((item) => item !== null)
  }
  if (!isRecord(raw)) return []
  const contexts = raw['contexts']
  const nodes = isRecord(contexts) ? contexts['nodes'] : raw['nodes']
  return recordArrayOrEmpty(nodes)
    .map(mapCheckContext)
    .filter((item) => item !== null)
}

export function checksFromGraphqlRollup(raw: unknown): GhPrChecksState {
  const checks = rollupToCiChecks(flattenGraphqlCheckRollup(raw))
  if (checks.length > 0) return deriveOverallState(checks)
  if (isRecord(raw)) {
    const state = optionalString(raw['state'])?.toUpperCase()
    if (state === 'PENDING' || state === 'EXPECTED') return 'pending'
    if (state === 'FAILURE' || state === 'ERROR') return 'failure'
    if (state === 'SUCCESS') return 'success'
  }
  return 'no_checks'
}

function repositoryOwnerRepo(
  node: Record<string, unknown>,
): { owner: string; repo: string } | null {
  const repository = node['repository']
  if (!isRecord(repository)) return null
  const name = optionalString(repository['name'])
  const ownerNode = repository['owner']
  const owner = isRecord(ownerNode) ? optionalString(ownerNode['login']) : undefined
  if (!owner || !name) return null
  return { owner, repo: name }
}

/** Map a GraphQL pull-request node into the PR-pane summary shape. */
export function graphqlPullToSummary(
  node: Record<string, unknown>,
  fallback: { owner: string; repo: string } | null,
): GhPrSummary | null {
  const number = optionalNumber(node['number'])
  const url = optionalString(node['url'])
  const fromRepo = repositoryOwnerRepo(node)
  const owner = fromRepo?.owner ?? fallback?.owner
  const repo = fromRepo?.repo ?? fallback?.repo
  if (number === undefined || !url || !owner || !repo) return null
  const author = node['author']
  const summary: GhPrSummary = {
    owner,
    repo,
    number,
    title: nonEmptyStringOr(optionalString(node['title'])?.trim(), `PR #${String(number)}`),
    url,
    state: (optionalString(node['state']) ?? 'OPEN').toUpperCase(),
  }
  const headRefName = optionalString(node['headRefName'])
  if (headRefName) summary.headRefName = headRefName
  const login = isRecord(author) ? optionalString(author['login']) : undefined
  if (login) summary.authorLogin = login
  const createdAt = optionalString(node['createdAt'])
  if (createdAt) summary.createdAt = createdAt
  const updatedAt = optionalString(node['updatedAt'])
  if (updatedAt) summary.updatedAt = updatedAt
  summary.checks = checksFromGraphqlRollup(node['statusCheckRollup'])
  return summary
}

export function graphqlPullNodesToSummaries(
  nodes: unknown,
  fallback: { owner: string; repo: string } | null,
): GhPrSummary[] {
  return recordArrayOrEmpty(nodes)
    .map((node) => graphqlPullToSummary(node, fallback))
    .filter((entry): entry is GhPrSummary => entry !== null)
}

export function workspacePullNodes(data: unknown): unknown {
  if (!isRecord(data)) return []
  const repository = data['repository']
  if (!isRecord(repository)) return []
  const pullRequests = repository['pullRequests']
  return isRecord(pullRequests) ? pullRequests['nodes'] : []
}

export function viewerPullNodes(data: unknown): unknown {
  if (!isRecord(data)) return []
  const viewer = data['viewer']
  if (!isRecord(viewer)) return []
  const pullRequests = viewer['pullRequests']
  return isRecord(pullRequests) ? pullRequests['nodes'] : []
}

export function pullRequestRollup(data: unknown): unknown {
  if (!isRecord(data)) return null
  const repository = data['repository']
  if (!isRecord(repository)) return null
  const pullRequest = repository['pullRequest']
  if (!isRecord(pullRequest)) return null
  return pullRequest['statusCheckRollup']
}
