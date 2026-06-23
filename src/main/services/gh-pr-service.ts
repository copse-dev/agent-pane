import { runGh } from './gh-service.ts'
import { getGithubRepoSlug } from './git-service.ts'
import { isGhAvailable } from './tool-availability.ts'
import { detectLanguage } from './language.ts'
import { safeJsonParse } from '@shared/safe-json.ts'
import { parseGithubPrUrl } from '@shared/git/github-pr-url.ts'
import {
  isMockGhEnabled,
  mockGetGhPrDetails,
  mockGetGhPrFileDiff,
  mockGhCliStatus,
  mockListMyOpenPrs,
} from './gh-pr-mock.ts'
import type {
  GhCliStatus,
  GhPrChangedFile,
  GhPrDetails,
  GhPrFileDiff,
  GhPrSummary,
} from '@shared/types/git.ts'

interface GhApiContent {
  content?: string
  encoding?: string
}

interface GhPrViewJson {
  state?: string
  number?: number
  title?: string
  url?: string
  body?: string
  headRefName?: string
  baseRefName?: string
  baseRefOid?: string
  headRefOid?: string
  author?: { login?: string }
  mergeable?: string
  mergeStateStatus?: string
  additions?: number
  deletions?: number
  changedFiles?: number
  createdAt?: string
  updatedAt?: string
  repository?: { name?: string; owner?: { login?: string } }
  files?: Array<{
    path?: string
    additions?: number
    deletions?: number
    changeType?: string
  }>
}

interface GhApiPullFile {
  filename?: string
  status?: string
  additions?: number
  deletions?: number
}

function formatGhError(stderr: string, code: number): string {
  const msg = stderr.trim()
  if (msg) return msg
  if (code === 127) return 'GitHub CLI (gh) is not installed.'
  return `gh exited with code ${code}`
}

function decodeBase64Content(raw: string): string {
  return Buffer.from(raw.replace(/\n/g, ''), 'base64').toString('utf8')
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

function toGhPrSummary(
  ref: { owner: string; repo: string; number: number },
  entry: GhPrViewJson & { url: string },
): GhPrSummary {
  const summary: GhPrSummary = {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: entry.title?.trim() || `PR #${ref.number}`,
    url: entry.url,
    state: entry.state ?? 'OPEN',
  }
  if (entry.headRefName) summary.headRefName = entry.headRefName
  if (entry.author?.login) summary.authorLogin = entry.author.login
  if (entry.createdAt) summary.createdAt = entry.createdAt
  if (entry.updatedAt) summary.updatedAt = entry.updatedAt
  return summary
}

function prRefToArgs(ref: { owner: string; repo: string; number: number }): string[] {
  return [String(ref.number), '-R', `${ref.owner}/${ref.repo}`]
}

function toGhPrDetails(
  ref: { owner: string; repo: string; number: number },
  pr: GhPrViewJson & { number: number; url: string },
  files: GhPrChangedFile[],
): GhPrDetails {
  const details: GhPrDetails = {
    owner: ref.owner,
    repo: ref.repo,
    number: pr.number,
    title: pr.title?.trim() || `PR #${pr.number}`,
    url: pr.url,
    state: pr.state ?? 'UNKNOWN',
    body: pr.body?.trim() ?? '',
    files,
  }
  if (pr.headRefName) details.headRefName = pr.headRefName
  if (pr.baseRefName) details.baseRefName = pr.baseRefName
  if (pr.author?.login) details.authorLogin = pr.author.login
  if (pr.mergeable) details.mergeable = pr.mergeable
  if (pr.mergeStateStatus) details.mergeStateStatus = pr.mergeStateStatus
  if (typeof pr.additions === 'number') details.additions = pr.additions
  if (typeof pr.deletions === 'number') details.deletions = pr.deletions
  if (typeof pr.changedFiles === 'number') details.changedFiles = pr.changedFiles
  if (pr.createdAt) details.createdAt = pr.createdAt
  if (pr.updatedAt) details.updatedAt = pr.updatedAt
  return details
}

export async function getGhCliStatus(): Promise<GhCliStatus> {
  if (isMockGhEnabled()) return mockGhCliStatus()
  if (!isGhAvailable()) {
    return {
      installed: false,
      authenticated: false,
      username: null,
      message: 'GitHub CLI (gh) is not installed or not on PATH.',
    }
  }

  const auth = await runGh(['auth', 'status'])
  if (auth.code !== 0) {
    return {
      installed: true,
      authenticated: false,
      username: null,
      message: auth.stderr.trim() || 'Run `gh auth login` to connect your GitHub account.',
    }
  }

  const user = await runGh(['api', 'user', '--jq', '.login'])
  if (user.code !== 0 || !user.stdout.trim()) {
    return {
      installed: true,
      authenticated: false,
      username: null,
      message: user.stderr.trim() || 'Could not read GitHub username.',
    }
  }

  return {
    installed: true,
    authenticated: true,
    username: user.stdout.trim(),
    message: null,
  }
}

export async function listMyOpenPrs(limit = 30): Promise<GhPrSummary[] | null> {
  if (isMockGhEnabled()) {
    const status = mockGhCliStatus()
    return status.authenticated ? mockListMyOpenPrs().slice(0, limit) : null
  }
  if (!isGhAvailable()) return null
  const status = await getGhCliStatus()
  if (!status.authenticated) return null

  const args = [
    'search',
    'prs',
    '--author=@me',
    '--state=open',
    '--limit',
    String(limit),
    '--json',
    'number,title,url,state,repository,author,createdAt,updatedAt',
  ]
  const { stdout, stderr, code } = await runGh(args)
  if (code !== 0) throw new Error(formatGhError(stderr, code))

  const list = safeJsonParse<
    Array<
      GhPrViewJson & {
        repository?: { name?: string; nameWithOwner?: string; owner?: { login?: string } }
      }
    >
  >(stdout.trim())
  if (!Array.isArray(list)) return []

  return list
    .map((entry) => {
      const slug = entry.repository?.nameWithOwner
      const owner = slug?.split('/')[0] ?? entry.repository?.owner?.login
      const repo = slug?.split('/')[1] ?? entry.repository?.name
      if (!owner || !repo || typeof entry.number !== 'number' || !entry.url) return null
      return toGhPrSummary({ owner, repo, number: entry.number }, { ...entry, url: entry.url })
    })
    .filter((entry): entry is GhPrSummary => entry != null)
}

export async function getGhPrDetails(ref: {
  owner: string
  repo: string
  number: number
}): Promise<GhPrDetails | null> {
  if (isMockGhEnabled()) return mockGetGhPrDetails(ref)
  if (!isGhAvailable()) return null
  const args = [
    'pr',
    'view',
    ...prRefToArgs(ref),
    '--json',
    [
      'state',
      'number',
      'title',
      'url',
      'body',
      'headRefName',
      'baseRefName',
      'baseRefOid',
      'headRefOid',
      'author',
      'mergeable',
      'mergeStateStatus',
      'additions',
      'deletions',
      'changedFiles',
      'createdAt',
      'updatedAt',
      'repository',
      'files',
    ].join(','),
  ]
  const { stdout, stderr, code } = await runGh(args)
  if (code !== 0) throw new Error(formatGhError(stderr, code))

  const pr = safeJsonParse<GhPrViewJson>(stdout.trim())
  if (!pr || typeof pr.number !== 'number' || !pr.url) return null

  const files = await listGhPrFiles(ref.owner, ref.repo, ref.number, pr)

  return toGhPrDetails(ref, { ...pr, number: pr.number, url: pr.url }, files)
}

async function listGhPrFiles(
  owner: string,
  repo: string,
  number: number,
  prView?: GhPrViewJson,
): Promise<GhPrChangedFile[]> {
  const fromView = (prView?.files ?? [])
    .map((file) => {
      if (!file.path) return null
      return {
        path: file.path,
        status: mapFileStatus(file.changeType),
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
      } satisfies GhPrChangedFile
    })
    .filter((entry): entry is GhPrChangedFile => entry != null)
  if (fromView.length > 0) return fromView

  const { stdout, code } = await runGh([
    'api',
    `repos/${owner}/${repo}/pulls/${number}/files`,
    '--paginate',
  ])
  if (code !== 0) return []
  const apiFiles = safeJsonParse<GhApiPullFile[]>(stdout.trim())
  if (!Array.isArray(apiFiles)) return []
  return apiFiles
    .map((file) => {
      if (!file.filename) return null
      return {
        path: file.filename,
        status: mapFileStatus(file.status),
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
      } satisfies GhPrChangedFile
    })
    .filter((entry): entry is GhPrChangedFile => entry != null)
}

async function fetchRepoFileAtRef(
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string> {
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  const { stdout, code } = await runGh([
    'api',
    `repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
  ])
  if (code !== 0) return ''
  const payload = safeJsonParse<GhApiContent>(stdout.trim())
  if (!payload?.content || payload.encoding !== 'base64') return ''
  return decodeBase64Content(payload.content)
}

export async function getGhPrFileDiff(
  ref: { owner: string; repo: string; number: number },
  path: string,
): Promise<GhPrFileDiff | null> {
  if (isMockGhEnabled()) return mockGetGhPrFileDiff(ref, path)
  if (!isGhAvailable()) return null

  const viewArgs = ['pr', 'view', ...prRefToArgs(ref), '--json', 'baseRefOid,headRefOid,files']
  const { stdout, stderr, code } = await runGh(viewArgs)
  if (code !== 0) throw new Error(formatGhError(stderr, code))
  const pr = safeJsonParse<GhPrViewJson>(stdout.trim())
  if (!pr?.baseRefOid || !pr.headRefOid) return null

  const fileMeta = (pr.files ?? []).find((file) => file.path === path)
  const status = mapFileStatus(fileMeta?.changeType)

  let before = ''
  let after = ''
  if (status !== 'added') {
    before = await fetchRepoFileAtRef(ref.owner, ref.repo, path, pr.baseRefOid)
  }
  if (status !== 'removed') {
    after = await fetchRepoFileAtRef(ref.owner, ref.repo, path, pr.headRefOid)
  }

  return {
    path,
    before,
    after,
    language: detectLanguage(path),
  }
}

/** Resolve a PR URL against the workspace origin when possible. */
export async function resolveGithubPrRef(
  url: string,
): Promise<{ owner: string; repo: string; number: number } | null> {
  const parsed = parseGithubPrUrl(url)
  if (!parsed) return null
  return { owner: parsed.owner, repo: parsed.repo, number: parsed.number }
}

export async function listWorkspaceOpenPrs(limit = 20): Promise<GhPrSummary[]> {
  const slug = await getGithubRepoSlug()
  if (!slug) return []
  const [owner, repo] = slug.split('/')
  if (!owner || !repo) return []

  if (!isGhAvailable()) return []
  const args = [
    'pr',
    'list',
    '--repo',
    slug,
    '--state',
    'open',
    '--limit',
    String(limit),
    '--json',
    'number,title,url,state,headRefName,author,createdAt,updatedAt',
  ]
  const { stdout, stderr, code } = await runGh(args)
  if (code !== 0) throw new Error(formatGhError(stderr, code))
  const list = safeJsonParse<GhPrViewJson[]>(stdout.trim())
  if (!Array.isArray(list)) return []

  return list
    .map((entry) => {
      if (typeof entry.number !== 'number' || !entry.url) return null
      return toGhPrSummary({ owner, repo, number: entry.number }, { ...entry, url: entry.url })
    })
    .filter((entry): entry is GhPrSummary => entry != null)
}
