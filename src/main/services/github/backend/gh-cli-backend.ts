import { isFailingConclusion, runGh } from '../gh-service.ts'
import { getGithubRepoSlug } from '../git-service.ts'
import { isGhAvailable, whenToolAvailabilityProbed } from '../../tool-availability.ts'
import { detectLanguage } from '../../language.ts'
import { deriveOverallState, rollupToCiChecks } from '../github-ci-service.ts'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { z } from 'zod'
import {
  ghPrViewListSchema,
  ghPrViewSchema,
  optionalNumber,
  optionalString,
} from '../gh-json-schemas.ts'
import { nonEmptyStringOr } from '@shared/unknown-value.ts'
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

interface GhPrViewJson {
  state?: string | undefined
  number?: number | undefined
  title?: string | undefined
  url?: string | undefined
  body?: string | undefined
  headRefName?: string | undefined
  baseRefName?: string | undefined
  baseRefOid?: string | undefined
  headRefOid?: string | undefined
  author?: { login?: string | undefined } | undefined
  mergeable?: string | undefined
  mergeStateStatus?: string | undefined
  additions?: number | undefined
  deletions?: number | undefined
  changedFiles?: number | undefined
  createdAt?: string | undefined
  updatedAt?: string | undefined
  isDraft?: boolean | undefined
  reviewDecision?: string | undefined
  autoMergeRequest?: { enabledAt?: string | undefined } | null | undefined
  statusCheckRollup?:
    | Array<{
        __typename?: string | undefined
        name?: string | undefined
        context?: string | undefined
        status?: string | undefined
        conclusion?: string | undefined
        state?: string | undefined
        detailsUrl?: string | undefined
      }>
    | undefined
  files?:
    | Array<{
        path?: string | undefined
        additions?: number | undefined
        deletions?: number | undefined
        changeType?: string | undefined
      }>
    | undefined
}

const ghSearchPrListSchema = z.array(
  ghPrViewSchema.extend({
    repository: z
      .object({
        name: optionalString,
        nameWithOwner: optionalString,
        owner: z.object({ login: optionalString }).optional(),
      })
      .optional(),
  }),
)
const ghApiPullFilesSchema = z.array(
  z.object({
    filename: optionalString,
    status: optionalString,
    additions: optionalNumber,
    deletions: optionalNumber,
  }),
)
const ghApiContentSchema = z.object({ content: optionalString, encoding: optionalString })
const repoMergeConfigSchema = z.object({
  squash: z.boolean().optional(),
  merge: z.boolean().optional(),
  rebase: z.boolean().optional(),
})
const flatIssueSchema = z.object({
  number: optionalNumber,
  title: optionalString,
  url: optionalString,
  body: optionalString,
  labels: z.array(z.string()).optional(),
  updatedAt: optionalString,
})
const pagedIssueSchema = z.object({
  rawCount: z.number().int().nonnegative(),
  issues: z.array(flatIssueSchema),
})
const issueSchema = z.object({
  number: optionalNumber,
  title: optionalString,
  url: optionalString,
  body: optionalString,
  labels: z.array(z.object({ name: optionalString })).optional(),
  updatedAt: optionalString,
  state: optionalString,
})
const ghRunListSchema = z.array(
  z.object({ databaseId: optionalNumber, conclusion: optionalString }),
)

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
    title: nonEmptyStringOr(entry.title?.trim(), `PR #${String(ref.number)}`),
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
    title: nonEmptyStringOr(pr.title?.trim(), `PR #${String(pr.number)}`),
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
  const apiFiles = safeJsonParse(stdout.trim(), decodeWithSchema(ghApiPullFilesSchema))
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
  const payload = safeJsonParse(stdout.trim(), decodeWithSchema(ghApiContentSchema))
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
  return safeJsonParse(stdout.trim(), decodeWithSchema(repoMergeConfigSchema)) ?? {}
}

/**
 * The `gh` CLI backend: every operation shells out through {@link runGh}, which
 * inherits the app's sandbox/auth/token handling. This is the default backend
 * whenever a working `gh` is present.
 */
export const ghCliBackend: GitHubBackend = {
  kind: 'cli',

  async getStatus(): Promise<GhCliStatus> {
    // Startup registers IPC handlers while the tool probe is still in flight.
    // Wait here so a first-paint PR/settings request cannot turn the temporary
    // `null` availability state into a durable "gh is not installed" result.
    await whenToolAvailabilityProbed()
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
    const list = safeJsonParse(stdout.trim(), decodeWithSchema(ghSearchPrListSchema))
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
    const list = safeJsonParse(stdout.trim(), decodeWithSchema(ghPrViewListSchema))
    if (!Array.isArray(list)) return []
    return list
      .map((entry) => {
        if (typeof entry.number !== 'number' || !entry.url) return null
        return toGhPrSummary({ owner, repo, number: entry.number }, { ...entry, url: entry.url })
      })
      .filter((entry): entry is GhPrSummary => entry != null)
  },

  async listWorkspaceOpenIssues(page: number, pageSize: number) {
    const slug = await getGithubRepoSlug()
    if (!slug) return { issues: [], hasMore: false }
    const [owner, repo] = slug.split('/')
    if (!owner || !repo || !isGhAvailable()) return { issues: [], hasMore: false }
    // Use the paginated REST endpoint rather than `gh issue list --limit N`:
    // the latter has no cursor, turning its output limit into a product-wide
    // ceiling. Slim each page inside gh so runCommand's 100 KiB stdout cap is
    // a per-request safety boundary only.
    const { stdout, stderr, code } = await runGh([
      'api',
      `repos/${slug}/issues`,
      '--method',
      'GET',
      '-f',
      'state=open',
      '-f',
      `per_page=${String(pageSize)}`,
      '-f',
      `page=${String(page)}`,
      '--jq',
      '{rawCount: length, issues: [.[] | select(has("pull_request") | not) | {number, title, url: .html_url, updatedAt: .updated_at, body: ((.body // "")[0:2000]), labels: [.labels[].name]}]}',
    ])
    if (code !== 0) throw new Error(formatGhError(stderr, code))
    const result = safeJsonParse(stdout.trim(), decodeWithSchema(pagedIssueSchema))
    if (!result) {
      // Never report unparseable output as "no issues" — surface it.
      throw new Error(
        `Unexpected \`gh api\` issue output: ${stdout.trim().slice(0, 200) || '(empty)'}`,
      )
    }
    return {
      issues: result.issues
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
            state: 'open',
          }
          if (entry.updatedAt) summary.updatedAt = entry.updatedAt
          return summary
        })
        .filter((entry): entry is GhIssueSummary => entry != null),
      hasMore: result.rawCount === pageSize,
    }
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
      'number,title,url,body,labels,updatedAt,state',
    ])
    if (code !== 0) {
      // `gh issue view` exits non-zero for a missing number; treat as absent.
      if (/could not find|no issues? found|not found/i.test(stderr)) return null
      throw new Error(formatGhError(stderr, code))
    }
    const entry = safeJsonParse(stdout.trim(), decodeWithSchema(issueSchema))
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
    if (entry.state === 'OPEN' || entry.state === 'open') summary.state = 'open'
    else if (entry.state === 'CLOSED' || entry.state === 'closed') summary.state = 'closed'
    if (entry.updatedAt) summary.updatedAt = entry.updatedAt
    return summary
  },

  async searchWorkspaceIssues(query: string, limit: number): Promise<GhIssueSummary[]> {
    const slug = await getGithubRepoSlug()
    if (!slug || !isGhAvailable()) return []
    const [owner, repo] = slug.split('/')
    if (!owner || !repo) return []
    const trimmed = query.trim()
    if (!trimmed) return []
    const { stdout, stderr, code } = await runGh([
      'search',
      'issues',
      trimmed,
      '--repo',
      slug,
      '--limit',
      String(limit),
      '--json',
      'number,title,url,body,labels,updatedAt,state',
    ])
    if (code !== 0) throw new Error(formatGhError(stderr, code))
    const list = safeJsonParse(stdout.trim(), decodeWithSchema(z.array(issueSchema)))
    if (!Array.isArray(list)) return []
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
          labels: (entry.labels ?? [])
            .map((l) => l.name)
            .filter((name): name is string => typeof name === 'string'),
        }
        if (entry.state === 'OPEN' || entry.state === 'open') summary.state = 'open'
        else if (entry.state === 'CLOSED' || entry.state === 'closed') summary.state = 'closed'
        if (entry.updatedAt) summary.updatedAt = entry.updatedAt
        return summary
      })
      .filter((entry): entry is GhIssueSummary => entry != null)
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
    const pr = safeJsonParse(stdout.trim(), decodeWithSchema(ghPrViewSchema))
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
    const pr = safeJsonParse(stdout.trim(), decodeWithSchema(ghPrViewSchema))
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
    const pr = safeJsonParse(stdout.trim(), decodeWithSchema(ghPrViewSchema))
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
    const runs = safeJsonParse(stdout.trim(), decodeWithSchema(ghRunListSchema)) ?? []
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
