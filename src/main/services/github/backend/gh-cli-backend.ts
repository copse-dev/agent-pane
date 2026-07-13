import { isFailingConclusion, runGh } from '../gh-service.ts'
import { getGithubRepoSlug } from '../git-service.ts'
import { isGhAvailable } from '../../tool-availability.ts'
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
import { chooseAutoMergeStrategy, type RepoMergeConfig } from './merge-strategy.ts'

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
  isDraft?: boolean
  reviewDecision?: string
  autoMergeRequest?: { enabledAt?: string } | null
  statusCheckRollup?: Array<{
    __typename?: string
    name?: string
    context?: string
    status?: string
    conclusion?: string
    state?: string
    detailsUrl?: string
  }>
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

interface GhRunJson {
  databaseId?: number
  conclusion?: string
}

const PR_VIEW_FIELDS = [
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
  'isDraft',
  'reviewDecision',
  'autoMergeRequest',
  'files',
]

function formatGhError(stderr: string, code: number): string {
  const msg = stderr.trim()
  if (msg) return msg
  if (code === 127) return 'GitHub CLI (gh) is not installed.'
  return `gh exited with code ${String(code)}`
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

function toGhPrSummary(ref: PrRef, entry: GhPrViewJson & { url: string }): GhPrSummary {
  const summary: GhPrSummary = {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: entry.title?.trim() || `PR #${String(ref.number)}`,
    url: entry.url,
    state: entry.state ?? 'OPEN',
  }
  if (entry.headRefName) summary.headRefName = entry.headRefName
  if (entry.author?.login) summary.authorLogin = entry.author.login
  if (entry.createdAt) summary.createdAt = entry.createdAt
  if (entry.updatedAt) summary.updatedAt = entry.updatedAt
  if (entry.statusCheckRollup) {
    summary.checks = deriveOverallState(rollupToCiChecks(entry.statusCheckRollup))
  }
  return summary
}

function prRefToArgs(ref: PrRef): string[] {
  return [String(ref.number), '-R', `${ref.owner}/${ref.repo}`]
}

function toGhPrDetails(
  ref: PrRef,
  pr: GhPrViewJson & { number: number; url: string },
  files: GhPrChangedFile[],
): GhPrDetails {
  const details: GhPrDetails = {
    owner: ref.owner,
    repo: ref.repo,
    number: pr.number,
    title: pr.title?.trim() || `PR #${String(pr.number)}`,
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
  if (typeof pr.isDraft === 'boolean') details.isDraft = pr.isDraft
  if (pr.autoMergeRequest) details.autoMergeEnabled = true
  if (pr.reviewDecision) details.reviewDecision = pr.reviewDecision
  return details
}

async function listPrFiles(ref: PrRef, prView?: GhPrViewJson): Promise<GhPrChangedFile[]> {
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
    `repos/${ref.owner}/${ref.repo}/pulls/${String(ref.number)}/files`,
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

async function fetchRepoFileAtRef(ref: PrRef, path: string, gitRef: string): Promise<string> {
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  const { stdout, code } = await runGh([
    'api',
    `repos/${ref.owner}/${ref.repo}/contents/${encodedPath}?ref=${encodeURIComponent(gitRef)}`,
  ])
  if (code !== 0) return ''
  const payload = safeJsonParse<GhApiContent>(stdout.trim())
  if (!payload?.content || payload.encoding !== 'base64') return ''
  return decodeBase64Content(payload.content)
}

/** Read the repo's allowed merge methods so auto-merge picks a permitted one. */
async function repoMergeConfig(ref: PrRef): Promise<RepoMergeConfig> {
  const { stdout, code } = await runGh([
    'api',
    `repos/${ref.owner}/${ref.repo}`,
    '--jq',
    '{squash: .allow_squash_merge, merge: .allow_merge_commit, rebase: .allow_rebase_merge}',
  ])
  if (code !== 0) return {}
  return safeJsonParse<RepoMergeConfig>(stdout.trim()) ?? {}
}

/**
 * The `gh` CLI backend: every operation shells out through {@link runGh}, which
 * inherits the app's sandbox/auth/token handling. This is the default backend
 * whenever a working `gh` is present.
 */
export const ghCliBackend: GitHubBackend = {
  kind: 'cli',

  async getStatus(): Promise<GhCliStatus> {
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
    return { installed: true, authenticated: true, username: user.stdout.trim(), message: null }
  },

  async listMyOpenPrs(limit: number): Promise<GhPrSummary[] | null> {
    if (!isGhAvailable()) return null
    const status = await this.getStatus()
    if (!status.authenticated) return null
    const { stdout, stderr, code } = await runGh([
      'search',
      'prs',
      '--author=@me',
      '--state=open',
      '--limit',
      String(limit),
      '--json',
      'number,title,url,state,repository,author,createdAt,updatedAt',
    ])
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
  },

  async listWorkspaceOpenPrs(limit: number): Promise<GhPrSummary[]> {
    const slug = await getGithubRepoSlug()
    if (!slug) return []
    const [owner, repo] = slug.split('/')
    if (!owner || !repo || !isGhAvailable()) return []
    const { stdout, stderr, code } = await runGh([
      'pr',
      'list',
      '--repo',
      slug,
      '--state',
      'open',
      '--limit',
      String(limit),
      '--json',
      'number,title,url,state,headRefName,author,createdAt,updatedAt,statusCheckRollup',
    ])
    if (code !== 0) throw new Error(formatGhError(stderr, code))
    const list = safeJsonParse<GhPrViewJson[]>(stdout.trim())
    if (!Array.isArray(list)) return []
    return list
      .map((entry) => {
        if (typeof entry.number !== 'number' || !entry.url) return null
        return toGhPrSummary({ owner, repo, number: entry.number }, { ...entry, url: entry.url })
      })
      .filter((entry): entry is GhPrSummary => entry != null)
  },

  async listWorkspaceOpenIssues(limit: number): Promise<GhIssueSummary[]> {
    const slug = await getGithubRepoSlug()
    if (!slug) return []
    const [owner, repo] = slug.split('/')
    if (!owner || !repo || !isGhAvailable()) return []
    // Slim the payload inside gh itself: full issue bodies on an issue-heavy
    // repo overflow runCommand's 100 KiB stdout cap and truncate the JSON
    // mid-stream. The jq filter bounds each body (drafting only reads the
    // first ~2000 chars anyway) and flattens labels to names.
    const { stdout, stderr, code } = await runGh([
      'issue',
      'list',
      '--repo',
      slug,
      '--state',
      'open',
      '--limit',
      String(limit),
      '--json',
      'number,title,url,body,labels,updatedAt',
      '--jq',
      '[.[] | {number, title, url, updatedAt, body: ((.body // "")[0:2000]), labels: [.labels[].name]}]',
    ])
    if (code !== 0) throw new Error(formatGhError(stderr, code))
    const list = safeJsonParse<
      Array<{
        number?: number
        title?: string
        url?: string
        body?: string
        labels?: string[]
        updatedAt?: string
      }>
    >(stdout.trim())
    if (!Array.isArray(list)) {
      // Never report unparseable output as "no issues" — surface it.
      throw new Error(
        `Unexpected \`gh issue list\` output: ${stdout.trim().slice(0, 200) || '(empty)'}`,
      )
    }
    return list
      .map((entry) => {
        if (typeof entry.number !== 'number' || !entry.title || !entry.url) return null
        const summary: GhIssueSummary = {
          owner,
          repo,
          number: entry.number,
          title: entry.title,
          url: entry.url,
          body: (entry.body ?? '').slice(0, 4000),
          labels: (entry.labels ?? []).filter((name): name is string => typeof name === 'string'),
        }
        if (entry.updatedAt) summary.updatedAt = entry.updatedAt
        return summary
      })
      .filter((entry): entry is GhIssueSummary => entry != null)
  },

  async getIssue(ref: PrRef): Promise<GhIssueSummary | null> {
    if (!isGhAvailable()) return null
    const { stdout, stderr, code } = await runGh([
      'issue',
      'view',
      String(ref.number),
      '--repo',
      `${ref.owner}/${ref.repo}`,
      '--json',
      'number,title,url,body,labels,updatedAt',
    ])
    if (code !== 0) {
      // `gh issue view` exits non-zero for a missing number; treat as absent.
      if (/could not find|no issues? found|not found/i.test(stderr)) return null
      throw new Error(formatGhError(stderr, code))
    }
    const entry = safeJsonParse<{
      number?: number
      title?: string
      url?: string
      body?: string
      labels?: Array<{ name?: string }>
      updatedAt?: string
    }>(stdout.trim())
    if (!entry || typeof entry.number !== 'number' || !entry.title || !entry.url) return null
    const summary: GhIssueSummary = {
      owner: ref.owner,
      repo: ref.repo,
      number: entry.number,
      title: entry.title,
      url: entry.url,
      body: (entry.body ?? '').slice(0, 8000),
      labels: (entry.labels ?? [])
        .map((l) => l.name)
        .filter((name): name is string => typeof name === 'string'),
    }
    if (entry.updatedAt) summary.updatedAt = entry.updatedAt
    return summary
  },

  async getPrDetails(ref: PrRef): Promise<GhPrDetails | null> {
    if (!isGhAvailable()) return null
    const { stdout, stderr, code } = await runGh([
      'pr',
      'view',
      ...prRefToArgs(ref),
      '--json',
      PR_VIEW_FIELDS.join(','),
    ])
    if (code !== 0) throw new Error(formatGhError(stderr, code))
    const pr = safeJsonParse<GhPrViewJson>(stdout.trim())
    if (!pr || typeof pr.number !== 'number' || !pr.url) return null
    const files = await listPrFiles(ref, pr)
    return toGhPrDetails(ref, { ...pr, number: pr.number, url: pr.url }, files)
  },

  async getPrFileDiff(ref: PrRef, path: string): Promise<GhPrFileDiff | null> {
    if (!isGhAvailable()) return null
    const { stdout, stderr, code } = await runGh([
      'pr',
      'view',
      ...prRefToArgs(ref),
      '--json',
      'baseRefOid,headRefOid,files',
    ])
    if (code !== 0) throw new Error(formatGhError(stderr, code))
    const pr = safeJsonParse<GhPrViewJson>(stdout.trim())
    if (!pr?.baseRefOid || !pr.headRefOid) return null
    const fileMeta = (pr.files ?? []).find((file) => file.path === path)
    const status = mapFileStatus(fileMeta?.changeType)
    let before = ''
    let after = ''
    if (status !== 'added') before = await fetchRepoFileAtRef(ref, path, pr.baseRefOid)
    if (status !== 'removed') after = await fetchRepoFileAtRef(ref, path, pr.headRefOid)
    return { path, before, after, language: detectLanguage(path), deleted: status === 'removed' }
  },

  async getPrChecksState(ref: PrRef): Promise<GhPrChecksState> {
    if (!isGhAvailable()) return 'no_checks'
    const { stdout, code } = await runGh([
      'pr',
      'view',
      ...prRefToArgs(ref),
      '--json',
      'statusCheckRollup',
    ])
    if (code !== 0) return 'no_checks'
    const pr = safeJsonParse<GhPrViewJson>(stdout.trim())
    return deriveOverallState(rollupToCiChecks(pr?.statusCheckRollup))
  },

  async rerunFailedRuns(ref: PrRef): Promise<PrActionResult> {
    // Only the head branch is needed here — a slim `gh pr view --json headRefName`
    // avoids the full details fetch (20 fields + a possible paginated files call).
    const view = await runGh([
      'pr',
      'view',
      ...prRefToArgs(ref),
      '--json',
      'headRefName',
      '-q',
      '.headRefName',
    ])
    const branch = view.code === 0 ? view.stdout.trim() : ''
    if (!branch) {
      return {
        ok: false,
        backend: 'cli',
        message: `Could not resolve the head branch for #${String(ref.number)}.`,
      }
    }
    const { stdout, stderr, code } = await runGh([
      'run',
      'list',
      '--repo',
      `${ref.owner}/${ref.repo}`,
      '--branch',
      branch,
      '--limit',
      '25',
      '--json',
      'databaseId,conclusion',
    ])
    if (code !== 0) return { ok: false, backend: 'cli', message: formatGhError(stderr, code) }
    const runs = safeJsonParse<GhRunJson[]>(stdout.trim()) ?? []
    const failed = runs.filter((run) => isFailingConclusion(run.conclusion))
    if (failed.length === 0) {
      return {
        ok: true,
        backend: 'cli',
        noop: true,
        rerunCount: 0,
        message: `No failed runs to re-run on ${branch}.`,
      }
    }
    let reran = 0
    for (const run of failed) {
      if (typeof run.databaseId !== 'number') continue
      const rerun = await runGh([
        'run',
        'rerun',
        String(run.databaseId),
        '--repo',
        `${ref.owner}/${ref.repo}`,
        '--failed',
      ])
      if (rerun.code === 0) reran++
    }
    return {
      ok: reran > 0,
      backend: 'cli',
      rerunCount: reran,
      message:
        reran > 0
          ? `Re-ran ${String(reran)} failed run${reran === 1 ? '' : 's'} on ${branch}.`
          : `Found ${String(failed.length)} failed runs but could not re-run them.`,
    }
  },

  async approvePr(ref: PrRef): Promise<PrActionResult> {
    const { stderr, code } = await runGh(['pr', 'review', ...prRefToArgs(ref), '--approve'])
    if (code !== 0) return { ok: false, backend: 'cli', message: formatGhError(stderr, code) }
    return { ok: true, backend: 'cli', message: `Approved PR #${String(ref.number)}.` }
  },

  async markPrReady(ref: PrRef): Promise<PrActionResult> {
    const view = await runGh([
      'pr',
      'view',
      ...prRefToArgs(ref),
      '--json',
      'isDraft',
      '-q',
      '.isDraft',
    ])
    if (view.code !== 0)
      return { ok: false, backend: 'cli', message: formatGhError(view.stderr, view.code) }
    if (view.stdout.trim() !== 'true') {
      return {
        ok: true,
        backend: 'cli',
        noop: true,
        message: `PR #${String(ref.number)} is already ready for review.`,
      }
    }
    const { stderr, code } = await runGh(['pr', 'ready', ...prRefToArgs(ref)])
    if (code !== 0) return { ok: false, backend: 'cli', message: formatGhError(stderr, code) }
    return {
      ok: true,
      backend: 'cli',
      message: `Marked PR #${String(ref.number)} ready for review.`,
    }
  },

  async enableAutoMerge(ref: PrRef): Promise<PrActionResult> {
    const strategy = chooseAutoMergeStrategy(await repoMergeConfig(ref))
    if (!strategy) {
      return {
        ok: false,
        backend: 'cli',
        message: 'No merge method is enabled on this repository.',
      }
    }
    const { stderr, code } = await runGh([
      'pr',
      'merge',
      ...prRefToArgs(ref),
      '--auto',
      `--${strategy}`,
    ])
    if (code !== 0) {
      const lower = stderr.toLowerCase()
      if (lower.includes('already') && (lower.includes('enabled') || lower.includes('queue'))) {
        return {
          ok: true,
          backend: 'cli',
          noop: true,
          strategy,
          message: `Auto-merge already enabled for #${String(ref.number)}.`,
        }
      }
      return { ok: false, backend: 'cli', message: formatGhError(stderr, code) }
    }
    return {
      ok: true,
      backend: 'cli',
      strategy,
      message: `Enabled auto-merge (${strategy}) for #${String(ref.number)}.`,
    }
  },
}
