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
  PrCreateResult,
} from '@shared/types/git.ts'
import { extractGithubPrUrls } from '@shared/git/github-pr-url.ts'
import type { GitHubBackend, PrCreateInput, PrRef } from './backend.ts'
import { chooseAutoMergeStrategy, type RepoMergeConfig } from './merge-strategy.ts'
import {
  decodeGitHubFileContent,
  emptyGitHubFileContent,
  type GitHubFileContent,
} from '../pr-file-content.ts'
import { isNonNull } from '@shared/nullish.ts'
import { PR_ACTIVITY_QUERY, parsePrActivity, unavailablePrActivity } from './pr-activity.ts'

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
  mergedAt?: string | undefined
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
  'mergedAt',
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

/**
 * Run `gh` in the checkout the caller named. Most calls name `-R owner/repo`
 * and do not depend on it, but `gh` still needs a directory to run in and the
 * caller's is the only one that is theirs; it is never the window's workspace
 * (#3958).
 */
function gh(
  root: string | null,
  args: string[],
  opts: Omit<Parameters<typeof runGh>[1], 'cwd'> = {},
): ReturnType<typeof runGh> {
  return runGh(args, { ...opts, cwd: root })
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
  if (pr.headRefOid) details.headRefOid = pr.headRefOid
  if (pr.mergedAt) details.mergedAt = pr.mergedAt
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

async function listPrFiles(
  root: string | null,
  ref: PrRef,
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
    .filter(isNonNull)
  if (fromView.length > 0) return fromView

  const { stdout, code } = await gh(root, [
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
    .filter(isNonNull)
}

async function fetchRepoFileAtRef(
  root: string | null,
  ref: PrRef,
  path: string,
  gitRef: string,
): Promise<GitHubFileContent> {
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  const { stdout, code } = await gh(root, [
    'api',
    `repos/${ref.owner}/${ref.repo}/contents/${encodedPath}?ref=${encodeURIComponent(gitRef)}`,
  ])
  if (code !== 0) return emptyGitHubFileContent()
  const payload = safeJsonParse(stdout.trim(), decodeWithSchema(ghApiContentSchema))
  if (!payload?.content || payload.encoding !== 'base64') return emptyGitHubFileContent()
  return decodeGitHubFileContent(path, payload.content)
}

/** Read the repo's allowed merge methods so auto-merge picks a permitted one. */
async function repoMergeConfig(root: string | null, ref: PrRef): Promise<RepoMergeConfig> {
  const { stdout, code } = await gh(root, [
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

  async getStatus(root: string | null): Promise<GhCliStatus> {
    // Startup registers IPC handlers while the tool probe is still in flight.
    // Wait here so a first-paint PR/settings request cannot turn the temporary
    // `null` availability state into a durable "gh is not installed" result.
    await whenToolAvailabilityProbed('gh')
    if (!isGhAvailable()) {
      return {
        installed: false,
        authenticated: false,
        username: null,
        message: 'GitHub CLI (gh) is not installed or not on PATH.',
      }
    }
    const auth = await gh(root, ['auth', 'status'])
    if (auth.code !== 0) {
      return {
        installed: true,
        authenticated: false,
        username: null,
        message: auth.stderr.trim() || 'Run `gh auth login` to connect your GitHub account.',
      }
    }
    const user = await gh(root, ['api', '--cache', '60s', 'user', '--jq', '.login'])
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

  async listMyOpenPrs(root: string | null, limit: number): Promise<GhPrSummary[] | null> {
    if (!isGhAvailable()) return null
    const status = await this.getStatus(root)
    if (!status.authenticated) return null
    const { stdout, stderr, code } = await gh(root, [
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
      .filter(isNonNull)
  },

  async listWorkspaceOpenPrs(root: string | null, limit: number): Promise<GhPrSummary[]> {
    const slug = await getGithubRepoSlug(root)
    if (!slug) return []
    const [owner, repo] = slug.split('/')
    if (!owner || !repo || !isGhAvailable()) return []
    const { stdout, stderr, code } = await gh(root, [
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
      .filter(isNonNull)
  },

  async listWorkspaceOpenIssues(root: string | null, page: number, pageSize: number) {
    const slug = await getGithubRepoSlug(root)
    if (!slug) return { issues: [], hasMore: false }
    const [owner, repo] = slug.split('/')
    if (!owner || !repo || !isGhAvailable()) return { issues: [], hasMore: false }
    // Use the paginated REST endpoint rather than `gh issue list --limit N`:
    // the latter has no cursor, turning its output limit into a product-wide
    // ceiling. Slim each page inside gh so runCommand's 100 KiB stdout cap is
    // a per-request safety boundary only.
    const { stdout, stderr, code } = await gh(root, [
      'api',
      '--cache',
      '20s',
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
            labels: (entry.labels ?? []).filter((name) => typeof name === 'string'),
            state: 'open',
          }
          if (entry.updatedAt) summary.updatedAt = entry.updatedAt
          return summary
        })
        .filter(isNonNull),
      hasMore: result.rawCount === pageSize,
    }
  },

  async getIssue(root: string | null, ref: PrRef): Promise<GhIssueSummary | null> {
    if (!isGhAvailable()) return null
    const { stdout, stderr, code } = await gh(root, [
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
      labels: (entry.labels ?? []).map((l) => l.name).filter((name) => typeof name === 'string'),
    }
    if (entry.state === 'OPEN' || entry.state === 'open') summary.state = 'open'
    else if (entry.state === 'CLOSED' || entry.state === 'closed') summary.state = 'closed'
    if (entry.updatedAt) summary.updatedAt = entry.updatedAt
    return summary
  },

  async searchWorkspaceIssues(
    root: string | null,
    query: string,
    limit: number,
  ): Promise<GhIssueSummary[]> {
    const slug = await getGithubRepoSlug(root)
    if (!slug || !isGhAvailable()) return []
    const [owner, repo] = slug.split('/')
    if (!owner || !repo) return []
    const trimmed = query.trim()
    if (!trimmed) return []
    const { stdout, stderr, code } = await gh(root, [
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
            .filter((name) => typeof name === 'string'),
        }
        if (entry.state === 'OPEN' || entry.state === 'open') summary.state = 'open'
        else if (entry.state === 'CLOSED' || entry.state === 'closed') summary.state = 'closed'
        if (entry.updatedAt) summary.updatedAt = entry.updatedAt
        return summary
      })
      .filter(isNonNull)
  },

  async getPrDetails(root: string | null, ref: PrRef): Promise<GhPrDetails | null> {
    if (!isGhAvailable()) return null
    const { stdout, stderr, code } = await gh(root, [
      'pr',
      'view',
      ...prRefToArgs(ref),
      '--json',
      PR_VIEW_FIELDS.join(','),
    ])
    if (code !== 0) throw new Error(formatGhError(stderr, code))
    const pr = safeJsonParse(stdout.trim(), decodeWithSchema(ghPrViewSchema))
    if (!pr || typeof pr.number !== 'number' || !pr.url) return null
    const files = await listPrFiles(root, ref, pr)
    const details = toGhPrDetails(ref, { ...pr, number: pr.number, url: pr.url }, files)
    try {
      const activity = await gh(root, [
        'api',
        'graphql',
        '-f',
        `query=${PR_ACTIVITY_QUERY}`,
        '-f',
        `owner=${ref.owner}`,
        '-f',
        `repo=${ref.repo}`,
        '-F',
        `number=${String(ref.number)}`,
      ])
      const response = safeJsonParse(
        activity.stdout,
        decodeWithSchema(
          z.object({ data: z.unknown().optional(), errors: z.unknown().optional() }),
        ),
      )
      details.activity =
        activity.code === 0 && !response?.errors
          ? parsePrActivity(response?.data)
          : unavailablePrActivity()
    } catch {
      details.activity = unavailablePrActivity()
    }
    return details
  },

  async getPrFileDiff(root: string | null, ref: PrRef, path: string): Promise<GhPrFileDiff | null> {
    if (!isGhAvailable()) return null
    const { stdout, stderr, code } = await gh(root, [
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
    let beforeContent = emptyGitHubFileContent()
    let afterContent = emptyGitHubFileContent()
    if (status !== 'added') {
      beforeContent = await fetchRepoFileAtRef(root, ref, path, pr.baseRefOid)
    }
    if (status !== 'removed') {
      afterContent = await fetchRepoFileAtRef(root, ref, path, pr.headRefOid)
    }
    return {
      path,
      before: beforeContent.text,
      after: afterContent.text,
      language: detectLanguage(path),
      beforeImage: beforeContent.image,
      afterImage: afterContent.image,
      deleted: status === 'removed',
    }
  },

  async getPrChecksState(root: string | null, ref: PrRef): Promise<GhPrChecksState> {
    if (!isGhAvailable()) return 'no_checks'
    const { stdout, code } = await gh(root, [
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

  async rerunFailedRuns(root: string | null, ref: PrRef): Promise<PrActionResult> {
    // Only the head branch is needed here — a slim `gh pr view --json headRefName`
    // avoids the full details fetch (20 fields + a possible paginated files call).
    const view = await gh(root, [
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
    const { stdout, stderr, code } = await gh(root, [
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
      const rerun = await gh(root, [
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

  async createPr(root: string | null, input: PrCreateInput): Promise<PrCreateResult> {
    const args = [
      'pr',
      'create',
      '-R',
      `${input.owner}/${input.repo}`,
      '--base',
      input.base,
      '--head',
      input.head,
      '--title',
      input.title,
      '--body',
      input.body,
    ]
    if (input.draft) args.push('--draft')
    const { stdout, stderr, code } = await gh(root, args)
    if (code !== 0) {
      // "a pull request for branch X already exists: <url>" — the desired end
      // state holds, and gh hands back the URL of the PR that satisfies it.
      const existing = /already exists/i.test(stderr) ? extractGithubPrUrls(stderr)[0] : undefined
      if (existing) {
        return {
          ok: true,
          noop: true,
          backend: 'cli',
          url: existing.url,
          number: existing.number,
          message: `A pull request for ${input.head} already exists: ${existing.url}`,
        }
      }
      return { ok: false, backend: 'cli', message: formatGhError(stderr, code) }
    }
    // `gh pr create` has no `--json`; success is a bare URL on stdout.
    const ref = extractGithubPrUrls(stdout)[0]
    if (!ref) {
      return {
        ok: true,
        backend: 'cli',
        message: `Opened the pull request, but gh printed no URL: ${stdout.trim()}`,
      }
    }
    return {
      ok: true,
      backend: 'cli',
      url: ref.url,
      number: ref.number,
      message: `Opened PR #${String(ref.number)}: ${ref.url}`,
    }
  },

  async approvePr(root: string | null, ref: PrRef): Promise<PrActionResult> {
    const { stderr, code } = await gh(root, ['pr', 'review', ...prRefToArgs(ref), '--approve'])
    if (code !== 0) return { ok: false, backend: 'cli', message: formatGhError(stderr, code) }
    return { ok: true, backend: 'cli', message: `Approved PR #${String(ref.number)}.` }
  },

  async markPrReady(root: string | null, ref: PrRef): Promise<PrActionResult> {
    const view = await gh(root, [
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
    const { stderr, code } = await gh(root, ['pr', 'ready', ...prRefToArgs(ref)])
    if (code !== 0) return { ok: false, backend: 'cli', message: formatGhError(stderr, code) }
    return {
      ok: true,
      backend: 'cli',
      message: `Marked PR #${String(ref.number)} ready for review.`,
    }
  },

  async enableAutoMerge(root: string | null, ref: PrRef): Promise<PrActionResult> {
    const strategy = chooseAutoMergeStrategy(await repoMergeConfig(root, ref))
    if (!strategy) {
      return {
        ok: false,
        backend: 'cli',
        message: 'No merge method is enabled on this repository.',
      }
    }
    const { stderr, code } = await gh(root, [
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
