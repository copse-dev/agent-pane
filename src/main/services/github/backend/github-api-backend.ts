import { getGithubRepoSlug } from '../git-service.ts'
import { isFailingConclusion } from '../gh-service.ts'
import { detectLanguage } from '../../language.ts'
import { deriveOverallState, rollupToCiChecks } from '../github-ci-service.ts'
import { safeJsonParse } from '@shared/safe-json.ts'
import type {
  GhCliStatus,
  GhIssueSummary,
  GhPrChangedFile,
  GhPrChecksState,
  GhPrDetails,
  GhPrFileDiff,
  GhPrSummary,
  PrActionResult,
} from '@shared/types/git.ts'
import type { GitHubBackend, PrRef } from './backend.ts'
import { resolveGitHubApiToken } from './github-token.ts'
import {
  chooseAutoMergeStrategy,
  type AutoMergeStrategy,
  type RepoMergeConfig,
} from './merge-strategy.ts'
import {
  expectRecord,
  isRecord,
  nonEmptyStringOr,
  recordArrayOrEmpty,
} from '@shared/unknown-value.ts'

/** REST + GraphQL base URLs, honoring GH_HOST for GitHub Enterprise. */
function apiRoots(host = process.env['GH_HOST']?.trim()): { rest: string; graphql: string } {
  if (!host || host === 'github.com') {
    return { rest: 'https://api.github.com', graphql: 'https://api.github.com/graphql' }
  }
  return { rest: `https://${host}/api/v3`, graphql: `https://${host}/api/graphql` }
}

interface RestResponse {
  ok: boolean
  status: number
  json: unknown
  errorMessage: string | null
}

const NO_TOKEN_MESSAGE = 'No GitHub token available. Set GITHUB_TOKEN or run `gh auth login`.'

/** Auth headers, or null when no token is available (callers degrade, never throw). */
async function authHeaders(): Promise<Record<string, string> | null> {
  const token = await resolveGitHubApiToken()
  if (!token) return null
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'copse-panel',
  }
}

function extractErrorMessage(status: number, json: unknown): string {
  if (isRecord(json)) {
    const message = json['message']
    if (typeof message === 'string' && message) return message
  }
  return `GitHub API request failed (HTTP ${String(status)}).`
}

async function rest(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<RestResponse> {
  const headers = await authHeaders()
  if (!headers) return { ok: false, status: 401, json: null, errorMessage: NO_TOKEN_MESSAGE }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  const url = path.startsWith('http') ? path : `${apiRoots().rest}${path}`
  const requestInit: RequestInit = { method: init.method ?? 'GET', headers }
  if (init.body !== undefined) requestInit.body = JSON.stringify(init.body)
  const response = await fetch(url, requestInit)
  const text = await response.text()
  const json: unknown = text ? safeJsonParse(text) : null
  return {
    ok: response.ok,
    status: response.status,
    json,
    errorMessage: response.ok ? null : extractErrorMessage(response.status, json),
  }
}

interface GraphqlResult {
  data: unknown
  errorMessage: string | null
}

async function graphql(query: string, variables: Record<string, unknown>): Promise<GraphqlResult> {
  const headers = await authHeaders()
  if (!headers) return { data: null, errorMessage: NO_TOKEN_MESSAGE }
  headers['Content-Type'] = 'application/json'
  const response = await fetch(apiRoots().graphql, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  })
  const json = safeJsonParse(await response.text())
  const errors = isRecord(json) ? recordArrayOrEmpty(json['errors']) : []
  if (errors.length > 0) {
    return {
      data: null,
      errorMessage:
        errors
          .map((error) => (typeof error['message'] === 'string' ? error['message'] : ''))
          .join('; ') || 'GraphQL error',
    }
  }
  if (!response.ok)
    return { data: null, errorMessage: `GraphQL request failed (HTTP ${String(response.status)}).` }
  return {
    data: isRecord(json) ? (json['data'] ?? null) : null,
    errorMessage: null,
  }
}

// --- REST payload shapes (only the fields we read). ---
interface RestPull {
  number?: number | undefined
  title?: string | undefined
  html_url?: string | undefined
  state?: string | undefined
  body?: string | null | undefined
  draft?: boolean | undefined
  /** True once the PR has been merged (REST reports these as state=closed). */
  merged?: boolean | undefined
  node_id?: string | undefined
  additions?: number | undefined
  deletions?: number | undefined
  changed_files?: number | undefined
  mergeable?: boolean | null | undefined
  mergeable_state?: string | undefined
  created_at?: string | undefined
  updated_at?: string | undefined
  auto_merge?: unknown
  user?: { login?: string | undefined } | undefined
  head?: { ref?: string | undefined; sha?: string | undefined } | undefined
  base?: { ref?: string | undefined; sha?: string | undefined } | undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function optionalNullableBoolean(value: unknown): boolean | null | undefined {
  return value === null ? null : optionalBoolean(value)
}

function nestedRef(
  value: unknown,
): { ref?: string | undefined; sha?: string | undefined } | undefined {
  if (!isRecord(value)) return undefined
  return { ref: optionalString(value['ref']), sha: optionalString(value['sha']) }
}

function parseRestPull(value: unknown): RestPull {
  if (!isRecord(value)) return {}
  const user = isRecord(value['user'])
    ? { login: optionalString(value['user']['login']) }
    : undefined
  const body = value['body']
  return {
    number: optionalNumber(value['number']),
    title: optionalString(value['title']),
    html_url: optionalString(value['html_url']),
    state: optionalString(value['state']),
    body: typeof body === 'string' || body === null ? body : undefined,
    draft: optionalBoolean(value['draft']),
    merged: optionalBoolean(value['merged']),
    node_id: optionalString(value['node_id']),
    additions: optionalNumber(value['additions']),
    deletions: optionalNumber(value['deletions']),
    changed_files: optionalNumber(value['changed_files']),
    mergeable: optionalNullableBoolean(value['mergeable']),
    mergeable_state: optionalString(value['mergeable_state']),
    created_at: optionalString(value['created_at']),
    updated_at: optionalString(value['updated_at']),
    auto_merge: value['auto_merge'],
    user,
    head: nestedRef(value['head']),
    base: nestedRef(value['base']),
  }
}

function issueLabels(value: unknown): string[] {
  return recordArrayOrEmpty(value)
    .map((label) => optionalString(label['name']))
    .filter((name): name is string => name !== undefined)
}

/** REST uses open/closed; promote closed+merged to MERGED so callers match gh CLI. */
function restPullState(pull: RestPull): string {
  if (pull.merged) return 'MERGED'
  return (pull.state ?? 'open').toUpperCase()
}

function mapMergeable(pull: RestPull): string | undefined {
  if (pull.mergeable === true) return 'MERGEABLE'
  if (pull.mergeable === false) return 'CONFLICTING'
  return undefined
}

function mapFileStatus(raw: string | undefined): GhPrChangedFile['status'] {
  switch ((raw ?? '').toLowerCase()) {
    case 'added':
      return 'added'
    case 'removed':
      return 'removed'
    case 'renamed':
      return 'renamed'
    default:
      return 'modified'
  }
}

function pullToSummary(ref: PrRef, pull: RestPull): GhPrSummary | null {
  if (!pull.html_url) return null
  const summary: GhPrSummary = {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: nonEmptyStringOr(pull.title?.trim(), `PR #${String(ref.number)}`),
    url: pull.html_url,
    state: restPullState(pull),
  }
  if (pull.head?.ref) summary.headRefName = pull.head.ref
  if (pull.user?.login) summary.authorLogin = pull.user.login
  if (pull.created_at) summary.createdAt = pull.created_at
  if (pull.updated_at) summary.updatedAt = pull.updated_at
  return summary
}

async function getPull(ref: PrRef): Promise<RestResponse> {
  return rest(`/repos/${ref.owner}/${ref.repo}/pulls/${String(ref.number)}`)
}

/** PR review decision (APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED), GraphQL-only; null on any error. */
async function fetchReviewDecision(ref: PrRef): Promise<string | null> {
  const result = await graphql(
    'query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewDecision } } }',
    { owner: ref.owner, repo: ref.repo, number: ref.number },
  )
  if (result.errorMessage || !isRecord(result.data)) return null
  const repository = result.data['repository']
  const pullRequest = isRecord(repository) ? repository['pullRequest'] : undefined
  const decision = isRecord(pullRequest) ? pullRequest['reviewDecision'] : undefined
  return typeof decision === 'string' ? decision : null
}

async function listPullFiles(ref: PrRef): Promise<GhPrChangedFile[]> {
  const result = await rest(
    `/repos/${ref.owner}/${ref.repo}/pulls/${String(ref.number)}/files?per_page=100`,
  )
  if (!result.ok || !Array.isArray(result.json)) return []
  return recordArrayOrEmpty(result.json)
    .map((file) =>
      typeof file['filename'] === 'string'
        ? {
            path: file['filename'],
            status: mapFileStatus(optionalString(file['status'])),
            additions: optionalNumber(file['additions']) ?? 0,
            deletions: optionalNumber(file['deletions']) ?? 0,
          }
        : null,
    )
    .filter((entry): entry is GhPrChangedFile => entry != null)
}

async function fileAtRef(ref: PrRef, path: string, gitRef: string): Promise<string> {
  const encoded = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  const result = await rest(
    `/repos/${ref.owner}/${ref.repo}/contents/${encoded}?ref=${encodeURIComponent(gitRef)}`,
  )
  if (!result.ok) return ''
  if (!isRecord(result.json)) return ''
  const content = result.json['content']
  if (typeof content !== 'string' || !content || result.json['encoding'] !== 'base64') return ''
  return Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf8')
}

function restError(response: RestResponse): PrActionResult {
  return {
    ok: false,
    backend: 'api',
    message: response.errorMessage ?? 'GitHub API request failed.',
  }
}

const STRATEGY_TO_GQL: Record<AutoMergeStrategy, string> = {
  squash: 'SQUASH',
  merge: 'MERGE',
  rebase: 'REBASE',
}

/**
 * The GitHub REST + GraphQL backend. Talks to `api.github.com` directly (no
 * `gh` subprocess), authenticating with an env token or `gh auth token`. Used
 * when the user selects the `api` backend, or automatically when `gh` is not
 * installed but a token is present.
 */
export const githubApiBackend: GitHubBackend = {
  kind: 'api',

  async getStatus(): Promise<GhCliStatus> {
    const token = await resolveGitHubApiToken()
    if (!token) {
      // installed:true — the API backend is "present"; it just needs a token.
      // Reporting installed:false would send the renderer down the misleading
      // "install GitHub CLI" path for a user who explicitly chose this backend.
      return { installed: true, authenticated: false, username: null, message: NO_TOKEN_MESSAGE }
    }
    const me = await rest('/user')
    if (!me.ok) {
      return { installed: true, authenticated: false, username: null, message: me.errorMessage }
    }
    const login =
      isRecord(me.json) && typeof me.json['login'] === 'string' ? me.json['login'] : null
    return { installed: true, authenticated: true, username: login, message: null }
  },

  async listMyOpenPrs(limit: number): Promise<GhPrSummary[] | null> {
    const status = await this.getStatus()
    if (!status.authenticated || !status.username) return null
    const query = encodeURIComponent(`is:open is:pr author:${status.username}`)
    const result = await rest(`/search/issues?q=${query}&per_page=${String(limit)}`)
    if (!result.ok) throw new Error(result.errorMessage ?? 'Search failed.')
    const items = isRecord(result.json) ? recordArrayOrEmpty(result.json['items']) : []
    return items
      .map((item) => {
        const url = typeof item['html_url'] === 'string' ? item['html_url'] : null
        const number = typeof item['number'] === 'number' ? item['number'] : null
        const repositoryUrl =
          typeof item['repository_url'] === 'string' ? item['repository_url'] : null
        if (!url || number == null || !repositoryUrl) return null
        const [repo, owner] = repositoryUrl.split('/').reverse()
        if (!owner || !repo) return null
        const pull = parseRestPull({ ...item, html_url: url })
        return pullToSummary({ owner, repo, number }, pull)
      })
      .filter((entry): entry is GhPrSummary => entry != null)
  },

  async listWorkspaceOpenPrs(limit: number): Promise<GhPrSummary[]> {
    const slug = await getGithubRepoSlug()
    if (!slug) return []
    const [owner, repo] = slug.split('/')
    if (!owner || !repo) return []
    const result = await rest(`/repos/${owner}/${repo}/pulls?state=open&per_page=${String(limit)}`)
    if (!result.ok) throw new Error(result.errorMessage ?? 'Could not list pull requests.')
    const pulls = recordArrayOrEmpty(result.json).map(parseRestPull)
    return pulls
      .map((pull) =>
        typeof pull.number === 'number'
          ? pullToSummary({ owner, repo, number: pull.number }, pull)
          : null,
      )
      .filter((entry): entry is GhPrSummary => entry != null)
  },

  async listWorkspaceOpenIssues(limit: number): Promise<GhIssueSummary[]> {
    const slug = await getGithubRepoSlug()
    if (!slug) return []
    const [owner, repo] = slug.split('/')
    if (!owner || !repo) return []
    const result = await rest(`/repos/${owner}/${repo}/issues?state=open&per_page=${String(limit)}`)
    if (!result.ok) throw new Error(result.errorMessage ?? 'Could not list issues.')
    const items = recordArrayOrEmpty(result.json)
    return (
      items
        // The REST /issues listing includes pull requests; keep real issues only.
        .filter((item) => !('pull_request' in item))
        .map((item) => {
          const number = typeof item['number'] === 'number' ? item['number'] : null
          const title = typeof item['title'] === 'string' ? item['title'] : null
          const url = typeof item['html_url'] === 'string' ? item['html_url'] : null
          if (number == null || !title || !url) return null
          const body = typeof item['body'] === 'string' ? item['body'].slice(0, 4000) : ''
          const labels = issueLabels(item['labels'])
          const summary: GhIssueSummary = {
            owner,
            repo,
            number,
            title,
            url,
            body,
            labels,
            state: 'open',
          }
          if (typeof item['updated_at'] === 'string') summary.updatedAt = item['updated_at']
          return summary
        })
        .filter((entry): entry is GhIssueSummary => entry != null)
    )
  },

  async getIssue(ref: PrRef): Promise<GhIssueSummary | null> {
    const result = await rest(`/repos/${ref.owner}/${ref.repo}/issues/${String(ref.number)}`)
    if (result.status === 404) return null
    if (!result.ok) throw new Error(result.errorMessage ?? 'Could not load issue.')
    const item = expectRecord(result.json)
    // The issues endpoint also serves PRs; a roadmap pin must be a real issue.
    if ('pull_request' in item) return null
    const title = typeof item['title'] === 'string' ? item['title'] : null
    const url = typeof item['html_url'] === 'string' ? item['html_url'] : null
    if (!title || !url) return null
    const summary: GhIssueSummary = {
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      title,
      url,
      body: typeof item['body'] === 'string' ? item['body'].slice(0, 8000) : '',
      labels: issueLabels(item['labels']),
    }
    if (item['state'] === 'open' || item['state'] === 'closed') summary.state = item['state']
    if (typeof item['updated_at'] === 'string') summary.updatedAt = item['updated_at']
    return summary
  },

  async searchWorkspaceIssues(query: string, limit: number): Promise<GhIssueSummary[]> {
    const slug = await getGithubRepoSlug()
    if (!slug) return []
    const [owner, repo] = slug.split('/')
    if (!owner || !repo) return []
    const trimmed = query.trim()
    if (!trimmed) return []
    const q = encodeURIComponent(`repo:${slug} ${trimmed}`)
    const result = await rest(`/search/issues?q=${q}&per_page=${String(limit)}`)
    if (!result.ok) throw new Error(result.errorMessage ?? 'Issue search failed.')
    const items = isRecord(result.json) ? recordArrayOrEmpty(result.json['items']) : []
    return items
      .filter((item) => !('pull_request' in item))
      .map((item) => {
        const number = typeof item['number'] === 'number' ? item['number'] : null
        const title = typeof item['title'] === 'string' ? item['title'] : null
        const url = typeof item['html_url'] === 'string' ? item['html_url'] : null
        if (number == null || !title || !url) return null
        const body = typeof item['body'] === 'string' ? item['body'].slice(0, 4000) : ''
        const labels = issueLabels(item['labels'])
        const summary: GhIssueSummary = { owner, repo, number, title, url, body, labels }
        if (item['state'] === 'open' || item['state'] === 'closed') {
          summary.state = item['state']
        }
        if (typeof item['updated_at'] === 'string') summary.updatedAt = item['updated_at']
        return summary
      })
      .filter((entry): entry is GhIssueSummary => entry != null)
  },

  async getPrDetails(ref: PrRef): Promise<GhPrDetails | null> {
    // The pull, its files, and its review decision are independent — fetch
    // concurrently rather than serially. reviewDecision is GraphQL-only (the
    // REST pulls payload omits it) and best-effort: a failure just drops the
    // Approved badge, it never fails the details load.
    const [result, files, reviewDecision] = await Promise.all([
      getPull(ref),
      listPullFiles(ref),
      fetchReviewDecision(ref),
    ])
    if (result.status === 404) return null
    if (!result.ok) throw new Error(result.errorMessage ?? 'Could not load pull request.')
    const pull = parseRestPull(result.json)
    if (!pull.html_url) return null
    const details: GhPrDetails = {
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      title: nonEmptyStringOr(pull.title?.trim(), `PR #${String(ref.number)}`),
      url: pull.html_url,
      state: restPullState(pull),
      body: pull.body?.trim() ?? '',
      files,
    }
    if (pull.head?.ref) details.headRefName = pull.head.ref
    if (pull.base?.ref) details.baseRefName = pull.base.ref
    if (pull.user?.login) details.authorLogin = pull.user.login
    const mergeable = mapMergeable(pull)
    if (mergeable) details.mergeable = mergeable
    if (pull.mergeable_state) details.mergeStateStatus = pull.mergeable_state.toUpperCase()
    if (typeof pull.additions === 'number') details.additions = pull.additions
    if (typeof pull.deletions === 'number') details.deletions = pull.deletions
    if (typeof pull.changed_files === 'number') details.changedFiles = pull.changed_files
    if (pull.created_at) details.createdAt = pull.created_at
    if (pull.updated_at) details.updatedAt = pull.updated_at
    if (typeof pull.draft === 'boolean') details.isDraft = pull.draft
    if (pull.auto_merge) details.autoMergeEnabled = true
    if (reviewDecision) details.reviewDecision = reviewDecision
    return details
  },

  async getPrFileDiff(ref: PrRef, path: string): Promise<GhPrFileDiff | null> {
    const pull = await getPull(ref)
    if (!pull.ok) return null
    const data = parseRestPull(pull.json)
    const baseSha = data.base?.sha
    const headSha = data.head?.sha
    if (!baseSha || !headSha) return null
    const files = await listPullFiles(ref)
    const status = files.find((file) => file.path === path)?.status ?? 'modified'
    const before = status === 'added' ? '' : await fileAtRef(ref, path, baseSha)
    const after = status === 'removed' ? '' : await fileAtRef(ref, path, headSha)
    return { path, before, after, language: detectLanguage(path), deleted: status === 'removed' }
  },

  async getPrChecksState(ref: PrRef): Promise<GhPrChecksState> {
    // Contract: this read never throws — a missing token or network error
    // degrades to 'no_checks', matching the CLI backend and the old service.
    try {
      const pull = await getPull(ref)
      if (!pull.ok) return 'no_checks'
      const headSha = parseRestPull(pull.json).head?.sha
      if (!headSha) return 'no_checks'
      const runs = await rest(
        `/repos/${ref.owner}/${ref.repo}/commits/${headSha}/check-runs?per_page=100`,
      )
      if (!runs.ok) return 'no_checks'
      const checkRuns = isRecord(runs.json) ? recordArrayOrEmpty(runs.json['check_runs']) : []
      const rollup = checkRuns.map((run) => {
        const item: { name?: string; status?: string; conclusion?: string } = {
          status: (optionalString(run['status']) ?? '').toUpperCase(),
          conclusion: (optionalString(run['conclusion']) ?? '').toUpperCase(),
        }
        if (typeof run['name'] === 'string') item.name = run['name']
        return item
      })
      return deriveOverallState(rollupToCiChecks(rollup))
    } catch {
      return 'no_checks'
    }
  },

  async rerunFailedRuns(ref: PrRef): Promise<PrActionResult> {
    const pull = await getPull(ref)
    if (!pull.ok) return restError(pull)
    const branch = parseRestPull(pull.json).head?.ref
    if (!branch)
      return {
        ok: false,
        backend: 'api',
        message: `Could not resolve the head branch for #${String(ref.number)}.`,
      }
    const list = await rest(
      `/repos/${ref.owner}/${ref.repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=25`,
    )
    if (!list.ok) return restError(list)
    const runs = isRecord(list.json) ? recordArrayOrEmpty(list.json['workflow_runs']) : []
    const failed = runs.filter((run) => isFailingConclusion(optionalString(run['conclusion'])))
    if (failed.length === 0) {
      return {
        ok: true,
        backend: 'api',
        noop: true,
        rerunCount: 0,
        message: `No failed runs to re-run on ${branch}.`,
      }
    }
    let reran = 0
    for (const run of failed) {
      const runId = run['id']
      if (typeof runId !== 'number') continue
      const rerun = await rest(
        `/repos/${ref.owner}/${ref.repo}/actions/runs/${String(runId)}/rerun-failed-jobs`,
        {
          method: 'POST',
        },
      )
      if (rerun.ok) reran++
    }
    return {
      ok: reran > 0,
      backend: 'api',
      rerunCount: reran,
      message:
        reran > 0
          ? `Re-ran ${String(reran)} failed run${reran === 1 ? '' : 's'} on ${branch}.`
          : `Found ${String(failed.length)} failed runs but could not re-run them.`,
    }
  },

  async approvePr(ref: PrRef): Promise<PrActionResult> {
    const result = await rest(
      `/repos/${ref.owner}/${ref.repo}/pulls/${String(ref.number)}/reviews`,
      {
        method: 'POST',
        body: { event: 'APPROVE' },
      },
    )
    if (!result.ok) return restError(result)
    return { ok: true, backend: 'api', message: `Approved PR #${String(ref.number)}.` }
  },

  async markPrReady(ref: PrRef): Promise<PrActionResult> {
    const pull = await getPull(ref)
    if (!pull.ok) return restError(pull)
    const data = parseRestPull(pull.json)
    if (!data.draft) {
      return {
        ok: true,
        backend: 'api',
        noop: true,
        message: `PR #${String(ref.number)} is already ready for review.`,
      }
    }
    if (!data.node_id)
      return { ok: false, backend: 'api', message: 'Could not resolve the PR node id.' }
    const mutation = await graphql(
      'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
      { id: data.node_id },
    )
    if (mutation.errorMessage) return { ok: false, backend: 'api', message: mutation.errorMessage }
    return {
      ok: true,
      backend: 'api',
      message: `Marked PR #${String(ref.number)} ready for review.`,
    }
  },

  async enableAutoMerge(ref: PrRef): Promise<PrActionResult> {
    const repo = await rest(`/repos/${ref.owner}/${ref.repo}`)
    if (!repo.ok) return restError(repo)
    const repoData = isRecord(repo.json) ? repo.json : {}
    const mergeConfig: RepoMergeConfig = {}
    if (typeof repoData['allow_squash_merge'] === 'boolean')
      mergeConfig.squash = repoData['allow_squash_merge']
    if (typeof repoData['allow_merge_commit'] === 'boolean')
      mergeConfig.merge = repoData['allow_merge_commit']
    if (typeof repoData['allow_rebase_merge'] === 'boolean')
      mergeConfig.rebase = repoData['allow_rebase_merge']
    const strategy = chooseAutoMergeStrategy(mergeConfig)
    if (!strategy)
      return {
        ok: false,
        backend: 'api',
        message: 'No merge method is enabled on this repository.',
      }
    const pull = await getPull(ref)
    if (!pull.ok) return restError(pull)
    const nodeId = parseRestPull(pull.json).node_id
    if (!nodeId) return { ok: false, backend: 'api', message: 'Could not resolve the PR node id.' }
    const mutation = await graphql(
      'mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { pullRequest { number } } }',
      { id: nodeId, method: STRATEGY_TO_GQL[strategy] },
    )
    if (mutation.errorMessage) {
      if (mutation.errorMessage.toLowerCase().includes('already')) {
        return {
          ok: true,
          backend: 'api',
          noop: true,
          strategy,
          message: `Auto-merge already enabled for #${String(ref.number)}.`,
        }
      }
      return { ok: false, backend: 'api', message: mutation.errorMessage }
    }
    return {
      ok: true,
      backend: 'api',
      strategy,
      message: `Enabled auto-merge (${strategy}) for #${String(ref.number)}.`,
    }
  },
}
