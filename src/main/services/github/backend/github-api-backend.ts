import { getGithubRepoSlug } from '../git-service.ts'
import { isFailingConclusion } from '../gh-service.ts'
import { detectLanguage } from '../../language.ts'
import { deriveOverallState, rollupToCiChecks } from '../github-ci-service.ts'
import { safeJsonParse } from '@shared/safe-json.ts'
import type {
  GhCliStatus,
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
  if (json && typeof json === 'object' && 'message' in json) {
    const message = (json as { message?: unknown }).message
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
  const errors =
    json && typeof json === 'object' && 'errors' in json
      ? (json as { errors?: Array<{ message?: string }> }).errors
      : undefined
  if (errors && errors.length > 0) {
    return {
      data: null,
      errorMessage: errors.map((e) => e.message ?? '').join('; ') || 'GraphQL error',
    }
  }
  if (!response.ok)
    return { data: null, errorMessage: `GraphQL request failed (HTTP ${String(response.status)}).` }
  return {
    data: json && typeof json === 'object' ? ((json as { data?: unknown }).data ?? null) : null,
    errorMessage: null,
  }
}

// --- REST payload shapes (only the fields we read). ---
interface RestPull {
  number?: number
  title?: string
  html_url?: string
  state?: string
  body?: string | null
  draft?: boolean
  node_id?: string
  additions?: number
  deletions?: number
  changed_files?: number
  mergeable?: boolean | null
  mergeable_state?: string
  created_at?: string
  updated_at?: string
  auto_merge?: unknown
  user?: { login?: string }
  head?: { ref?: string; sha?: string }
  base?: { ref?: string; sha?: string }
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
    title: pull.title?.trim() || `PR #${String(ref.number)}`,
    url: pull.html_url,
    state: (pull.state ?? 'open').toUpperCase(),
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
  if (result.errorMessage || !result.data || typeof result.data !== 'object') return null
  const decision = (result.data as { repository?: { pullRequest?: { reviewDecision?: unknown } } })
    .repository?.pullRequest?.reviewDecision
  return typeof decision === 'string' ? decision : null
}

async function listPullFiles(ref: PrRef): Promise<GhPrChangedFile[]> {
  const result = await rest(
    `/repos/${ref.owner}/${ref.repo}/pulls/${String(ref.number)}/files?per_page=100`,
  )
  if (!result.ok || !Array.isArray(result.json)) return []
  return (
    result.json as Array<{
      filename?: string
      status?: string
      additions?: number
      deletions?: number
    }>
  )
    .map((file) =>
      file.filename
        ? {
            path: file.filename,
            status: mapFileStatus(file.status),
            additions: file.additions ?? 0,
            deletions: file.deletions ?? 0,
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
  const payload = result.json as { content?: string; encoding?: string }
  if (!payload.content || payload.encoding !== 'base64') return ''
  return Buffer.from(payload.content.replace(/\n/g, ''), 'base64').toString('utf8')
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
    const login = (me.json as { login?: string }).login ?? null
    return { installed: true, authenticated: true, username: login, message: null }
  },

  async listMyOpenPrs(limit: number): Promise<GhPrSummary[] | null> {
    const status = await this.getStatus()
    if (!status.authenticated || !status.username) return null
    const query = encodeURIComponent(`is:open is:pr author:${status.username}`)
    const result = await rest(`/search/issues?q=${query}&per_page=${String(limit)}`)
    if (!result.ok) throw new Error(result.errorMessage ?? 'Search failed.')
    const items = (result.json as { items?: Array<Record<string, unknown>> }).items ?? []
    return items
      .map((item) => {
        const url = typeof item['html_url'] === 'string' ? item['html_url'] : null
        const number = typeof item['number'] === 'number' ? item['number'] : null
        const repositoryUrl =
          typeof item['repository_url'] === 'string' ? item['repository_url'] : null
        if (!url || number == null || !repositoryUrl) return null
        const [repo, owner] = repositoryUrl.split('/').reverse()
        if (!owner || !repo) return null
        const pull: RestPull = { html_url: url }
        if (typeof item['title'] === 'string') pull.title = item['title']
        if (typeof item['state'] === 'string') pull.state = item['state']
        const login = (item['user'] as { login?: unknown } | undefined)?.login
        if (typeof login === 'string') pull.user = { login }
        if (typeof item['created_at'] === 'string') pull.created_at = item['created_at']
        if (typeof item['updated_at'] === 'string') pull.updated_at = item['updated_at']
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
    const pulls = Array.isArray(result.json) ? (result.json as RestPull[]) : []
    return pulls
      .map((pull) =>
        typeof pull.number === 'number'
          ? pullToSummary({ owner, repo, number: pull.number }, pull)
          : null,
      )
      .filter((entry): entry is GhPrSummary => entry != null)
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
    const pull = result.json as RestPull
    if (!pull.html_url) return null
    const details: GhPrDetails = {
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      title: pull.title?.trim() || `PR #${String(ref.number)}`,
      url: pull.html_url,
      state: (pull.state ?? 'open').toUpperCase(),
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
    const data = pull.json as RestPull
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
      const headSha = (pull.json as RestPull).head?.sha
      if (!headSha) return 'no_checks'
      const runs = await rest(
        `/repos/${ref.owner}/${ref.repo}/commits/${headSha}/check-runs?per_page=100`,
      )
      if (!runs.ok) return 'no_checks'
      const checkRuns =
        (
          runs.json as {
            check_runs?: Array<{ name?: string; status?: string; conclusion?: string }>
          }
        ).check_runs ?? []
      const rollup = checkRuns.map((run) => {
        const item: { name?: string; status?: string; conclusion?: string } = {
          status: (run.status ?? '').toUpperCase(),
          conclusion: (run.conclusion ?? '').toUpperCase(),
        }
        if (run.name) item.name = run.name
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
    const branch = (pull.json as RestPull).head?.ref
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
    const runs =
      (list.json as { workflow_runs?: Array<{ id?: number; conclusion?: string }> })
        .workflow_runs ?? []
    const failed = runs.filter((run) => isFailingConclusion(run.conclusion))
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
      if (typeof run.id !== 'number') continue
      const rerun = await rest(
        `/repos/${ref.owner}/${ref.repo}/actions/runs/${String(run.id)}/rerun-failed-jobs`,
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
    const data = pull.json as RestPull
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
    const repoData = repo.json as {
      allow_squash_merge?: boolean
      allow_merge_commit?: boolean
      allow_rebase_merge?: boolean
    }
    const mergeConfig: RepoMergeConfig = {}
    if (typeof repoData.allow_squash_merge === 'boolean')
      mergeConfig.squash = repoData.allow_squash_merge
    if (typeof repoData.allow_merge_commit === 'boolean')
      mergeConfig.merge = repoData.allow_merge_commit
    if (typeof repoData.allow_rebase_merge === 'boolean')
      mergeConfig.rebase = repoData.allow_rebase_merge
    const strategy = chooseAutoMergeStrategy(mergeConfig)
    if (!strategy)
      return {
        ok: false,
        backend: 'api',
        message: 'No merge method is enabled on this repository.',
      }
    const pull = await getPull(ref)
    if (!pull.ok) return restError(pull)
    const nodeId = (pull.json as RestPull).node_id
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
