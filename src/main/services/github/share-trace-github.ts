import { safeJsonParse } from '@shared/safe-json.ts'
import { COPSE_PRODUCT_REPO_NAME, COPSE_PRODUCT_REPO_OWNER } from '@shared/github/product-repo.ts'
import { resolveGitHubApiToken } from './backend/github-token.ts'
import type { ShareTraceFile } from './share-trace-files.ts'

const API_ROOT = 'https://api.github.com'
const NO_TOKEN_MESSAGE =
  'No GitHub token available. Run `gh auth login` or set GITHUB_TOKEN, then retry Share trace.'

interface RestResponse {
  ok: boolean
  status: number
  json: unknown
  errorMessage: string | null
}

export interface CreatedShareTracePr {
  prUrl: string
  prNumber: number
  branch: string
}

function extractErrorMessage(status: number, json: unknown): string {
  const record = asRecord(json)
  const message = record?.['message']
  if (typeof message === 'string' && message) return message
  return `GitHub API request failed (HTTP ${String(status)}).`
}

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

async function rest(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<RestResponse> {
  const headers = await authHeaders()
  if (!headers) return { ok: false, status: 401, json: null, errorMessage: NO_TOKEN_MESSAGE }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  const url = path.startsWith('http') ? path : `${API_ROOT}${path}`
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

function repoPath(suffix: string): string {
  return `/repos/${COPSE_PRODUCT_REPO_OWNER}/${COPSE_PRODUCT_REPO_NAME}${suffix}`
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Unexpected GitHub response: missing ${label}.`)
  }
  return value
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Unexpected GitHub response: missing ${label}.`)
  }
  return value
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

function readPath(value: unknown, keys: string[]): unknown {
  let current: unknown = value
  for (const key of keys) {
    const record = asRecord(current)
    if (!record) return null
    current = record[key]
  }
  return current
}

/**
 * Create a branch on copse-dev/agent-pane, commit the share-trace files in one
 * Git Data API commit, and open a draft PR against the default branch.
 */
export async function createShareTracePullRequest(opts: {
  branch: string
  title: string
  body: string
  files: ShareTraceFile[]
}): Promise<CreatedShareTracePr> {
  const repo = await rest(repoPath(''))
  if (!repo.ok) {
    throw new Error(repo.errorMessage ?? 'Could not read the product repository.')
  }
  const defaultBranch = requireString(readPath(repo.json, ['default_branch']), 'default_branch')

  const ref = await rest(repoPath(`/git/ref/heads/${encodeURIComponent(defaultBranch)}`))
  if (!ref.ok) {
    throw new Error(ref.errorMessage ?? `Could not resolve ${defaultBranch}.`)
  }
  const baseSha = requireString(readPath(ref.json, ['object', 'sha']), 'base sha')

  const baseCommit = await rest(repoPath(`/git/commits/${encodeURIComponent(baseSha)}`))
  if (!baseCommit.ok) {
    throw new Error(baseCommit.errorMessage ?? 'Could not read the base commit.')
  }
  const baseTreeSha = requireString(readPath(baseCommit.json, ['tree', 'sha']), 'base tree sha')

  const treeEntries: Array<{ path: string; mode: string; type: 'blob'; sha: string }> = []
  for (const file of opts.files) {
    const blob = await rest(repoPath('/git/blobs'), {
      method: 'POST',
      body: { content: file.content, encoding: 'utf-8' },
    })
    if (!blob.ok) {
      throw new Error(blob.errorMessage ?? `Could not upload ${file.path}.`)
    }
    const blobSha = requireString(readPath(blob.json, ['sha']), `blob sha for ${file.path}`)
    treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha: blobSha })
  }

  const tree = await rest(repoPath('/git/trees'), {
    method: 'POST',
    body: { base_tree: baseTreeSha, tree: treeEntries },
  })
  if (!tree.ok) {
    throw new Error(tree.errorMessage ?? 'Could not create the share-trace tree.')
  }
  const treeSha = requireString(readPath(tree.json, ['sha']), 'tree sha')

  const commit = await rest(repoPath('/git/commits'), {
    method: 'POST',
    body: {
      message: opts.title,
      tree: treeSha,
      parents: [baseSha],
    },
  })
  if (!commit.ok) {
    throw new Error(commit.errorMessage ?? 'Could not create the share-trace commit.')
  }
  const commitSha = requireString(readPath(commit.json, ['sha']), 'commit sha')

  const createdRef = await rest(repoPath('/git/refs'), {
    method: 'POST',
    body: { ref: `refs/heads/${opts.branch}`, sha: commitSha },
  })
  if (!createdRef.ok) {
    throw new Error(createdRef.errorMessage ?? `Could not create branch ${opts.branch}.`)
  }

  const pr = await rest(repoPath('/pulls'), {
    method: 'POST',
    body: {
      title: opts.title,
      body: opts.body,
      head: opts.branch,
      base: defaultBranch,
      draft: true,
    },
  })
  if (!pr.ok) {
    throw new Error(pr.errorMessage ?? 'Could not open the share-trace pull request.')
  }
  const prUrl = requireString(readPath(pr.json, ['html_url']), 'pr url')
  const prNumber = requireNumber(readPath(pr.json, ['number']), 'pr number')

  return { prUrl, prNumber, branch: opts.branch }
}
