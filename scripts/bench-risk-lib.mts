// `bench:risk` — does the pull request summary's Low / Medium / High level
// (packages/review/src/pr-summary.ts) match what happened to the change?
// See benchmarks/review-risk/README.md for the corpus, the labelling rules and
// the latest results; the scoring itself is `@copse/review/risk-eval.ts`.
//
//   collect  read merged pull requests from GitHub and local git, find the
//            outcome evidence for each, and write the corpus. Verdicts already
//            in the corpus are kept; new evidence starts `unverified`.
//   run      produce a rating for every case by running the real summary step
//            (`copse-review --summary-only`, read-only, nothing posted) at the
//            case's base and head. Needs a model provider key, or the mock
//            provider for a plumbing check.
//   score    score a rating set (default: the ratings already posted in the
//            descriptions) against the corpus and print the report.
//   compare  score two rating sets and list the cases whose level moved.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { errorMessage } from '@copse/std/errors.ts'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import {
  compareScores,
  decodeRiskCorpus,
  decodeRiskRatingSet,
  outcomeProfile,
  parsePostedRating,
  pathSurfaces,
  postedRatings,
  renderOutcomeProfile,
  renderRiskReport,
  RISK_EVAL_VERSION,
  scoreRatings,
  SIZE_BUCKETS,
  sizeBucket,
  type RiskCase,
  type RiskCorpus,
  type RiskEvidence,
  type RiskRating,
  type RiskRatingSet,
} from '@copse/review/risk-eval.ts'
import { withoutSummaryBlock } from '@copse/review/summary-block.ts'

export const DEFAULT_CORPUS = 'benchmarks/review-risk/corpus.json'
export const DEFAULT_OUT_DIR = 'bench-results/review-risk'
export const DEFAULT_WINDOW_DAYS = 7
const DAY_MS = 86_400_000

export interface BenchIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

// ---------------------------------------------------------------------------
// GitHub

const pullSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  created_at: z.string(),
  merged_at: z.string().nullable(),
  head: z.object({ sha: z.string() }),
  base: z.object({ sha: z.string(), ref: z.string() }),
  user: z.object({ login: z.string() }).nullable(),
})
type Pull = z.infer<typeof pullSchema>

const issueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  created_at: z.string(),
  pull_request: z.unknown().optional(),
})

const timelineEventSchema = z.object({
  event: z.string().optional(),
  source: z
    .object({
      issue: z
        .object({
          number: z.number(),
          title: z.string(),
          created_at: z.string(),
          pull_request: z.unknown().optional(),
        })
        .optional(),
    })
    .optional(),
})

const runsSchema = z.object({
  workflow_runs: z.array(
    z.object({ name: z.string().nullable(), event: z.string(), conclusion: z.string().nullable() }),
  ),
})

export interface GitHubClient {
  readonly get: (path: string) => Promise<unknown>
}

export function githubClient(repo: string, token: string | undefined): GitHubClient {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token !== undefined && token.length > 0) headers['Authorization'] = `Bearer ${token}`
  return {
    get: async (path: string): Promise<unknown> => {
      const url = `https://api.github.com/repos/${repo}/${path}`
      const response = await fetch(url, { headers })
      const text = await response.text()
      if (!response.ok) {
        throw new Error(
          `GitHub returned ${String(response.status)} for ${url}: ${text.slice(0, 200)}`,
        )
      }
      return safeJsonParse(text)
    },
  }
}

async function pages<T>(
  client: GitHubClient,
  path: string,
  decode: (value: unknown) => T | null,
  stop: (item: T) => boolean,
): Promise<T[]> {
  const out: T[] = []
  for (let page = 1; page < 60; page += 1) {
    const raw = await client.get(
      `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${String(page)}`,
    )
    if (!Array.isArray(raw) || raw.length === 0) break
    const items = raw.flatMap((item: unknown) => {
      const decoded = decode(item)
      return decoded === null ? [] : [decoded]
    })
    out.push(...items)
    const last = items.at(-1)
    // A short page is the last one; a full one may have more behind it.
    if (raw.length < 100 || last === undefined || stop(last)) break
  }
  return out
}

// ---------------------------------------------------------------------------
// Local git

function git(repoDir: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: repoDir, encoding: 'utf8', maxBuffer: 64 << 20 })
}

function hasCommit(repoDir: string, sha: string): boolean {
  try {
    git(repoDir, ['cat-file', '-e', `${sha}^{commit}`])
    return true
  } catch {
    return false
  }
}

/** Fetch a pull request's head when its commit is not local (squash merges drop it from `main`). */
export function ensurePullHead(repoDir: string, number: number, sha: string): void {
  if (hasCommit(repoDir, sha)) return
  git(repoDir, ['fetch', '--no-tags', '--quiet', 'origin', `pull/${String(number)}/head`])
  if (!hasCommit(repoDir, sha)) throw new Error(`#${String(number)}: head ${sha} is not fetchable`)
}

/**
 * The commit each pull request landed as on `mainRef`'s first-parent history:
 * a squash commit whose subject ends `(#n)`, or a `Merge pull request #n`
 * commit. GitHub's `merge_commit_sha` is not used: after a history rewrite or
 * a promotion it can name a commit `main` never had.
 */
export function landedCommits(repoDir: string, mainRef: string): Map<number, string> {
  const log = git(repoDir, ['log', '--first-parent', '--format=%H%x09%s', mainRef])
  const landed = new Map<number, string>()
  for (const line of log.split('\n')) {
    const [sha = '', subject = ''] = line.split('\t')
    const match = /\(#(\d+)\)$/.exec(subject) ?? /^Merge pull request #(\d+) from /.exec(subject)
    const number = Number(match?.[1] ?? Number.NaN)
    // The newest commit wins: a later revert-and-reland names the same number.
    if (Number.isInteger(number) && !landed.has(number)) landed.set(number, sha)
  }
  return landed
}

/** Tests, docs, fixtures, screenshots and lockfiles: not counted as source lines. */
export function isLowSignalPath(path: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|e2e|fixtures?|screenshots?|benchmarks?|docs)\//.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /\.(md|mdx|png|jpe?g|gif|svg|snap|txt)$/.test(path) ||
    /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(path)
  )
}

/** The first path segment that names an area: `src/main`, `packages/review`, `.github`. */
export function areaOf(path: string): string {
  const parts = path.split('/')
  if ((parts[0] === 'src' || parts[0] === 'packages') && parts.length > 2) {
    return `${parts[0]}/${parts[1] ?? ''}`
  }
  return parts.length > 1 ? (parts[0] ?? path) : '(root)'
}

interface ChangeShape {
  readonly files: readonly string[]
  readonly size: RiskCase['size']
  readonly areas: readonly string[]
  readonly surfaces: RiskCase['surfaces']
}

/** The change's files and size: head against its merge-base with `base`. */
export function changeShape(repoDir: string, base: string, head: string): ChangeShape {
  const numstat = git(repoDir, ['diff', '--numstat', '--no-renames', `${base}...${head}`])
  let additions = 0
  let deletions = 0
  let sourceLines = 0
  let sourceDeletions = 0
  const files: string[] = []
  for (const line of numstat.split('\n')) {
    const [added = '', deleted = '', path = ''] = line.split('\t')
    if (path === '') continue
    files.push(path)
    const a = added === '-' ? 0 : Number(added)
    const d = deleted === '-' ? 0 : Number(deleted)
    additions += a
    deletions += d
    if (!isLowSignalPath(path)) {
      sourceLines += a + d
      sourceDeletions += d
    }
  }
  const source = files.filter((path) => !isLowSignalPath(path))
  const areas = [...new Set(source.map(areaOf))].sort()
  return {
    files,
    size: { files: files.length, additions, deletions, sourceLines, sourceDeletions },
    areas,
    surfaces: pathSurfaces(source, areas),
  }
}

// ---------------------------------------------------------------------------
// Evidence

const FIX_TITLE =
  /^(fix|stop|restore|revert|repair|keep|don't|do not|never|guard|unbreak|undo|re-?enable|handle|avoid|prevent|make .* (work|again))\b/i

/** A title that reads like a repair rather than a feature. */
export function isFixTitle(title: string): boolean {
  return FIX_TITLE.test(title.trim())
}

/**
 * Mentions `#n`, or this repository's `/pull/n` or `/issues/n` URL, as a whole
 * number. A `#n` inside a path or a link to another repository (a Dependabot
 * body quoting upstream issues) is not a mention.
 */
export function mentionPattern(number: number, repo: string): RegExp {
  const url = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `(?:(?<![\\w/&])#|github\\.com/${url}/(?:pull|issues)/)${String(number)}(?![0-9])`,
  )
}

/** The sentence-sized text around the first mention, flattened to one line. */
export function excerptAround(text: string, pattern: RegExp, radius = 160): string {
  const match = pattern.exec(text)
  if (match === null) return ''
  const from = Math.max(0, match.index - radius)
  const to = Math.min(text.length, match.index + match[0].length + radius)
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`
}

interface Mentioner {
  readonly kind: 'pr' | 'issue'
  readonly number: number
  readonly title: string
  readonly body: string
  readonly createdAt: string
  readonly mergedAt: string | null
  readonly files: readonly string[]
}

export interface EvidenceInput {
  readonly repo: string
  readonly number: number
  readonly title: string
  readonly mergedAt: string
  readonly files: readonly string[]
  readonly windowDays: number
  readonly mentioners: readonly Mentioner[]
  /** Source files touched by so many merged changes that sharing one says nothing. */
  readonly hotFiles: ReadonlySet<string>
}

function daysBetween(from: string, to: string): number {
  return Math.round(((Date.parse(to) - Date.parse(from)) / DAY_MS) * 10) / 10
}

/**
 * The evidence local data can find for one merged change: later pull requests
 * and issues that name it, reverts, and fix-titled changes that touched one of
 * its (not hot) source files within the window. Every item starts unverified.
 */
export function localEvidence(input: EvidenceInput): RiskEvidence[] {
  const pattern = mentionPattern(input.number, input.repo)
  const within = (at: string): boolean => {
    const days = (Date.parse(at) - Date.parse(input.mergedAt)) / DAY_MS
    return days > 0 && days <= input.windowDays
  }
  const own = new Set(
    input.files.filter((path) => !isLowSignalPath(path) && !input.hotFiles.has(path)),
  )
  const evidence: RiskEvidence[] = []
  for (const later of input.mentioners) {
    if (later.number === input.number || !within(later.createdAt)) continue
    const text = `${later.title}\n${withoutSummaryBlock(later.body)}`
    const days = daysBetween(input.mergedAt, later.createdAt)
    const ref = `#${String(later.number)}`
    if (
      later.kind === 'pr' &&
      /^revert\b/i.test(later.title) &&
      (pattern.test(text) || later.title.includes(input.title))
    ) {
      evidence.push({
        source: 'revert',
        ref,
        title: later.title,
        daysAfterMerge: days,
        excerpt: excerptAround(text, pattern),
        verdict: 'unverified',
      })
      continue
    }
    if (pattern.test(text)) {
      evidence.push({
        source: 'reference',
        ref,
        title: later.title,
        daysAfterMerge: days,
        excerpt: excerptAround(text, pattern),
        verdict: 'unverified',
      })
      continue
    }
    if (later.kind !== 'pr' || later.mergedAt === null || !isFixTitle(later.title)) continue
    const shared = later.files.filter((path) => own.has(path))
    if (shared.length === 0) continue
    evidence.push({
      source: 'fix-overlap',
      ref,
      title: later.title,
      daysAfterMerge: days,
      excerpt: `shares ${shared.slice(0, 4).join(', ')}${shared.length > 4 ? ` and ${String(shared.length - 4)} more` : ''}`,
      verdict: 'unverified',
    })
  }
  return evidence
}

/** Keep verdicts and notes a person already recorded for the same item. */
export function mergeVerdicts(
  fresh: readonly RiskEvidence[],
  previous: readonly RiskEvidence[],
): RiskEvidence[] {
  const known = new Map(previous.map((item) => [`${item.source} ${item.ref}`, item]))
  const merged = fresh.map((item) => {
    const before = known.get(`${item.source} ${item.ref}`)
    if (before === undefined) return item
    return {
      ...item,
      verdict: before.verdict,
      ...(before.note === undefined ? {} : { note: before.note }),
    }
  })
  // An item found before but not now (say, a cross-reference seen only in the
  // timeline) keeps its place, so a re-collect never silently drops a verdict.
  const seen = new Set(merged.map((item) => `${item.source} ${item.ref}`))
  for (const item of previous) if (!seen.has(`${item.source} ${item.ref}`)) merged.push(item)
  return merged
}

// ---------------------------------------------------------------------------
// collect

export interface CollectOptions {
  readonly repo: string
  readonly repoDir: string
  /** The ref whose first-parent history says which commit each change landed as. */
  readonly mainRef: string
  readonly client: GitHubClient
  readonly corpusPath: string
  readonly windowDays: number
  /** Mature cases are drawn from changes merged in [matureFrom, matureTo). */
  readonly matureFrom: string
  readonly matureTo: string
  readonly matureCount: number
  /** Pull requests always included (open ones become case studies). */
  readonly include: readonly number[]
  readonly now: Date
  readonly io: BenchIo
}

/** A stable pseudo-random order, so a re-collect picks the same sample. */
function sampleKey(number: number): string {
  return createHash('sha256')
    .update(`risk-sample:${String(number)}`)
    .digest('hex')
}

/** Evidence whose text blames the change outright: a revert, or "regression from #n" and the like. */
export function isBlamingEvidence(item: RiskEvidence): boolean {
  if (item.source === 'revert') return true
  return (
    item.source === 'reference' &&
    /\b(regress\w*|introduced (by|in)|broke|caused by|follow-?up to|failed on its first)\b/i.test(
      item.excerpt,
    )
  )
}

export type SampleTier = 'blamed' | 'evidence' | 'none'

/** Up to `want` of `pool`, spread over the size buckets in the pool's order. */
function spreadBySize<T extends { readonly sourceLines: number }>(
  pool: readonly T[],
  want: number,
): T[] {
  const buckets = SIZE_BUCKETS.map((bucket) =>
    pool.filter((item) => sizeBucket(item.sourceLines) === bucket),
  )
  const out: T[] = []
  for (let round = 0; out.length < want; round += 1) {
    const row = buckets.flatMap((bucket) => bucket.slice(round, round + 1))
    if (row.length === 0) break
    out.push(...row.slice(0, want - out.length))
  }
  return out
}

/**
 * The mature sample: half from changes with candidate evidence, taking the
 * ones a later change blames outright first, and half from changes with none,
 * each spread over the size buckets in a stable pseudo-random order. Changes
 * with evidence are oversampled on purpose, so the corpus has outcomes to
 * miss; base rates in the corpus are therefore not the repository's.
 */
export function pickMature<
  T extends { readonly number: number; readonly tier: SampleTier; readonly sourceLines: number },
>(candidates: readonly T[], count: number): T[] {
  const ordered = [...candidates].sort((a, b) =>
    sampleKey(a.number).localeCompare(sampleKey(b.number)),
  )
  const half = Math.ceil(count / 2)
  const blamed = ordered.filter((candidate) => candidate.tier === 'blamed').slice(0, half)
  const evidence = spreadBySize(
    ordered.filter((candidate) => candidate.tier === 'evidence'),
    half - blamed.length,
  )
  const clean = spreadBySize(
    ordered.filter((candidate) => candidate.tier === 'none'),
    count - blamed.length - evidence.length,
  )
  return [...blamed, ...evidence, ...clean].sort((a, b) => a.number - b.number)
}

function readCorpus(path: string): RiskCorpus | null {
  if (!existsSync(path)) return null
  const corpus = safeJsonParse(readFileSync(path, 'utf8'), decodeRiskCorpus)
  if (corpus === null)
    throw new Error(`${path} is not a risk corpus (eval v${String(RISK_EVAL_VERSION)})`)
  return corpus
}

async function mainCiEvidence(
  client: GitHubClient,
  repoDir: string,
  mergeSha: string,
  mergedAt: string,
): Promise<RiskEvidence[]> {
  const ciOf = async (sha: string): Promise<string | null> => {
    const runs = decodeWithSchema(runsSchema)(
      await client.get(`actions/runs?head_sha=${sha}&per_page=100`),
    )
    const ci = runs?.workflow_runs.find((run) => run.name === 'CI' && run.event === 'push')
    return ci?.conclusion ?? null
  }
  const merged = await ciOf(mergeSha)
  if (merged !== 'failure') return []
  const parent = git(repoDir, ['rev-parse', `${mergeSha}^1`]).trim()
  const before = await ciOf(parent)
  if (before !== 'success') return []
  return [
    {
      source: 'main-ci',
      ref: mergeSha,
      title: 'CI failed on main at the merge commit; it passed on the parent',
      daysAfterMerge: 0,
      excerpt: `merged ${mergedAt}`,
      verdict: 'unverified',
    },
  ]
}

/**
 * Cross-references on the change's timeline (comments and commits that name
 * it), every page of them: a busy pull request's later references can be the
 * only evidence of what happened to it.
 */
export async function timelineEvidence(
  client: GitHubClient,
  number: number,
  mergedAt: string,
  windowDays: number,
  known: ReadonlySet<string>,
): Promise<RiskEvidence[]> {
  const events = await pages(
    client,
    `issues/${String(number)}/timeline`,
    decodeWithSchema(timelineEventSchema),
    () => false,
  )
  const out: RiskEvidence[] = []
  for (const event of events) {
    const issue = event.source?.issue
    if (event.event !== 'cross-referenced' || issue === undefined || issue.number === number)
      continue
    const ref = `#${String(issue.number)}`
    const days = daysBetween(mergedAt, issue.created_at)
    if (known.has(ref) || days <= 0 || days > windowDays) continue
    out.push({
      source: 'reference',
      ref,
      title: issue.title,
      daysAfterMerge: days,
      excerpt: '(cross-referenced from a comment or commit, not the description)',
      verdict: 'unverified',
    })
  }
  return out
}

export async function collect(options: CollectOptions): Promise<RiskCorpus> {
  const { client, io } = options
  const previous = readCorpus(options.corpusPath)
  const earliest = new Date(Date.parse(options.matureFrom) - DAY_MS).toISOString()
  io.stderr(`bench:risk: reading pull requests and issues created since ${earliest}\n`)
  const pulls = await pages(
    client,
    'pulls?state=all&sort=created&direction=desc',
    decodeWithSchema(pullSchema),
    (pull) => pull.created_at < earliest,
  )
  const issues = (
    await pages(
      client,
      `issues?state=all&sort=created&direction=desc&since=${earliest}`,
      decodeWithSchema(issueSchema),
      (issue) => issue.created_at < earliest,
    )
  ).filter((issue) => issue.pull_request === undefined)
  const landedAt = landedCommits(options.repoDir, options.mainRef)
  const filesOf = new Map<number, readonly string[]>()
  for (const pull of pulls) {
    const commit = landedAt.get(pull.number)
    if (pull.merged_at === null || pull.base.ref !== 'main' || commit === undefined) continue
    const names = git(options.repoDir, [
      'diff',
      '--name-only',
      '--no-renames',
      `${commit}^1`,
      commit,
    ])
    filesOf.set(
      pull.number,
      names.split('\n').filter((line) => line.length > 0),
    )
  }
  const touches = new Map<string, number>()
  for (const files of filesOf.values())
    for (const path of files) touches.set(path, (touches.get(path) ?? 0) + 1)
  const hotThreshold = Math.max(5, Math.round(filesOf.size * 0.02))
  const hotFiles = new Set(
    [...touches].filter(([, count]) => count >= hotThreshold).map(([path]) => path),
  )
  // Dependabot bodies quote upstream changelogs, whose `#n` are other repositories' numbers.
  const mentioners: Mentioner[] = [
    ...pulls
      .filter((pull) => pull.user?.login !== 'dependabot[bot]')
      .map((pull): Mentioner => ({
        kind: 'pr',
        number: pull.number,
        title: pull.title,
        body: pull.body ?? '',
        createdAt: pull.created_at,
        mergedAt: pull.merged_at,
        files: filesOf.get(pull.number) ?? [],
      })),
    ...issues.map((issue): Mentioner => ({
      kind: 'issue',
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      createdAt: issue.created_at,
      mergedAt: null,
      files: [],
    })),
  ]
  const evidenceFor = (pull: Pull): RiskEvidence[] =>
    pull.merged_at === null
      ? []
      : localEvidence({
          repo: options.repo,
          number: pull.number,
          title: pull.title,
          mergedAt: pull.merged_at,
          files: filesOf.get(pull.number) ?? [],
          windowDays: options.windowDays,
          mentioners,
          hotFiles,
        })

  // Only changes that landed on main have a merge commit there to measure from.
  const landedOnMain = (pull: Pull): boolean =>
    pull.merged_at !== null && pull.base.ref === 'main' && filesOf.has(pull.number)
  const rated = pulls.filter((pull) => landedOnMain(pull) && parsePostedRating(pull.body) !== null)
  const ratedNumbers = new Set(rated.map((pull) => pull.number))
  const matureTo = Date.parse(options.matureTo)
  const matureCandidates = pulls
    .filter(
      (pull) =>
        landedOnMain(pull) &&
        !ratedNumbers.has(pull.number) &&
        (pull.merged_at ?? '') >= options.matureFrom &&
        Date.parse(pull.merged_at ?? '') < matureTo,
    )
    .map((pull) => {
      const files = filesOf.get(pull.number) ?? []
      const sourceLines =
        files.filter((path) => !isLowSignalPath(path)).length > 0
          ? changeShape(
              options.repoDir,
              `${landedAt.get(pull.number) ?? ''}^1`,
              landedAt.get(pull.number) ?? '',
            ).size.sourceLines
          : 0
      const found = evidenceFor(pull)
      const tier: SampleTier = found.some(isBlamingEvidence)
        ? 'blamed'
        : found.length > 0
          ? 'evidence'
          : 'none'
      return { number: pull.number, pull, sourceLines, tier }
    })
    // A release promotion or version bump is a merge of changes already in the corpus's population.
    .filter((candidate) => !/^(promote|release)\b/i.test(candidate.pull.title))
  const tiers = (tier: SampleTier): string =>
    String(matureCandidates.filter((candidate) => candidate.tier === tier).length)
  io.stderr(
    `bench:risk: ${String(matureCandidates.length)} mature candidates: ${tiers('blamed')} blamed, ${tiers('evidence')} with other evidence, ${tiers('none')} with none\n`,
  )
  const mature = pickMature(matureCandidates, options.matureCount)
  const chosen: { pull: Pull; cohort: RiskCase['cohort'] }[] = []
  for (const pull of rated) chosen.push({ pull, cohort: 'rated' })
  for (const candidate of mature) chosen.push({ pull: candidate.pull, cohort: 'mature' })
  for (const number of options.include) {
    if (chosen.some((entry) => entry.pull.number === number)) continue
    const pull =
      pulls.find((candidate) => candidate.number === number) ??
      decodeWithSchema(pullSchema)(await client.get(`pulls/${String(number)}`))
    if (pull === null) throw new Error(`#${String(number)} is not a pull request`)
    chosen.push({ pull, cohort: 'case-study' })
  }

  const cases: RiskCase[] = []
  for (const { pull, cohort } of chosen) {
    io.stderr(`bench:risk: #${String(pull.number)} ${pull.title}\n`)
    // A merged change is measured as it landed on main: its parent to itself.
    // The pull request's own head may sit on history main no longer shares.
    const landed = landedAt.get(pull.number)
    const merged = pull.merged_at !== null && landed !== undefined
    const head = merged ? landed : pull.head.sha
    if (!merged) ensurePullHead(options.repoDir, pull.number, head)
    const base = merged ? git(options.repoDir, ['rev-parse', `${landed}^1`]).trim() : pull.base.sha
    if (!hasCommit(options.repoDir, base))
      git(options.repoDir, ['fetch', '--no-tags', '--quiet', 'origin', base])
    const shape = changeShape(options.repoDir, base, head)
    let evidence: RiskEvidence[] = []
    let observedDays = 0
    if (merged && pull.merged_at !== null) {
      evidence = evidenceFor(pull)
      const refs = new Set(evidence.map((item) => item.ref))
      evidence.push(
        ...(await timelineEvidence(client, pull.number, pull.merged_at, options.windowDays, refs)),
      )
      evidence.push(...(await mainCiEvidence(client, options.repoDir, landed, pull.merged_at)))
      observedDays = Math.min(
        options.windowDays,
        Math.round(((options.now.getTime() - Date.parse(pull.merged_at)) / DAY_MS) * 10) / 10,
      )
    }
    const before = previous?.cases.find((riskCase) => riskCase.number === pull.number)
    cases.push({
      number: pull.number,
      title: pull.title,
      state: merged ? 'merged' : pull.state === 'open' ? 'open' : 'closed',
      mergedAt: pull.merged_at,
      cohort,
      base,
      head,
      size: shape.size,
      areas: [...shape.areas],
      surfaces: shape.surfaces,
      posted: parsePostedRating(pull.body),
      observedDays,
      evidence: mergeVerdicts(evidence, before?.evidence ?? []),
      ...(before?.note === undefined ? {} : { note: before.note }),
    })
  }
  // A case a person annotated or ruled on stays, even if this sample would not pick it.
  for (const riskCase of previous?.cases ?? []) {
    if (cases.some((existing) => existing.number === riskCase.number)) continue
    const ruled = riskCase.evidence.some((item) => item.verdict !== 'unverified')
    if (ruled || riskCase.note !== undefined) cases.push(riskCase)
  }
  cases.sort((a, b) => a.number - b.number)
  return {
    version: RISK_EVAL_VERSION,
    repo: options.repo,
    collectedAt: options.now.toISOString(),
    windowDays: options.windowDays,
    cases,
  }
}

// ---------------------------------------------------------------------------
// run

export interface RunOptions {
  readonly corpus: RiskCorpus
  /** The repository the cases' commits live in. */
  readonly repoDir: string
  /** The Copse checkout whose `copse-review` and prompt produce the ratings. */
  readonly reviewerDir: string
  readonly label: string
  /** Passed through to `copse-review` as-is: `--provider`, `--model`, `--base-url`, `--mock-script`. */
  readonly reviewerArgs: readonly string[]
  readonly source: string
  readonly cases: readonly number[]
  readonly env: NodeJS.ProcessEnv
  readonly now: Date
  readonly io: BenchIo
}

/**
 * The digest of the summary prompt in the reviewer checkout, so a run names
 * the prompt it measured. Read in a child process: the checkout may be another
 * revision, and its modules must not mix with this one's.
 */
export function promptDigest(reviewerDir: string): string {
  const prompt = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const { summarySystemPrompt } = await import('./packages/review/src/pr-summary.ts'); process.stdout.write(summarySystemPrompt())",
    ],
    { cwd: resolve(reviewerDir), encoding: 'utf8' },
  )
  if (prompt.trim().length === 0) throw new Error(`${reviewerDir} has no summarySystemPrompt`)
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16)
}

function reviewerRevision(reviewerDir: string): string {
  const head = git(reviewerDir, ['rev-parse', 'HEAD']).trim()
  const dirty =
    git(reviewerDir, ['status', '--porcelain', '--', 'packages/review']).trim().length > 0
  return dirty ? `${head}+dirty` : head
}

function runCli(
  cliPath: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      resolvePromise({ code, stdout, stderr })
    })
  })
}

/** Rate one case with the real summary step: read-only checkouts, one model turn, nothing posted. */
export async function rateCase(options: RunOptions, riskCase: RiskCase): Promise<RiskRating> {
  ensurePullHead(options.repoDir, riskCase.number, riskCase.head)
  const cli = resolve(options.reviewerDir, 'packages/review/bin/copse-review.mjs')
  const args = [
    '--summary-only',
    '--foreign',
    '--base',
    riskCase.base,
    '--head',
    riskCase.head,
    ...options.reviewerArgs,
  ]
  const result = await runCli(cli, args, options.repoDir, options.env)
  const rating = parsePostedRating(result.stdout)
  if (result.code !== 0 || rating === null) {
    const why = result.stderr.trim().split('\n').at(-1) ?? `exit ${String(result.code)}`
    return { number: riskCase.number, error: why }
  }
  return { number: riskCase.number, risk: rating.risk, reason: rating.reason }
}

export async function runRatings(options: RunOptions): Promise<RiskRatingSet> {
  const wanted = new Set(options.cases)
  const cases = options.corpus.cases.filter(
    (riskCase) => wanted.size === 0 || wanted.has(riskCase.number),
  )
  const ratings: RiskRating[] = []
  for (const riskCase of cases) {
    const rating = await rateCase(options, riskCase)
    options.io.stderr(
      `bench:risk: #${String(riskCase.number)} ${rating.risk ?? `error: ${rating.error ?? ''}`}\n`,
    )
    ratings.push(rating)
  }
  return {
    kind: 'copse-risk-ratings',
    label: options.label,
    source: options.source,
    reviewerRevision: reviewerRevision(options.reviewerDir),
    promptDigest: promptDigest(options.reviewerDir),
    generatedAt: options.now.toISOString(),
    ratings,
  }
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = `Usage: pnpm run bench:risk <command> [options]

  collect   --repo owner/name --mature-from <date> --mature-to <date> [--mature-count 36]
            [--include <n>]... [--window-days 7]      (GITHUB_TOKEN or GH_TOKEN)
  run       --label <name> [--reviewer <copse checkout>] [--case <n>]...
            -- <copse-review provider flags: --provider, --model, --base-url, --mock-script>
  score     [--ratings posted|<ratings.json>] [--json <path>]
  compare   <before.json|posted> <after.json>

  --corpus <path>   the corpus (default ${DEFAULT_CORPUS})
  --out <dir>       where run writes ratings (default ${DEFAULT_OUT_DIR})
`

/** `provider/model` from the passthrough flags, for the rating set's `source`. */
export function ratingSource(reviewerArgs: readonly string[]): string {
  const flag = (name: string): string | undefined => {
    const at = reviewerArgs.indexOf(name)
    return at === -1 ? undefined : reviewerArgs[at + 1]
  }
  const parts = [flag('--provider'), flag('--model')].filter((part) => part !== undefined)
  return parts.length === 0 ? 'default provider' : parts.join('/')
}

function loadRatings(corpus: RiskCorpus, spec: string): RiskRatingSet {
  if (spec === 'posted') return postedRatings(corpus)
  const ratings = safeJsonParse(readFileSync(spec, 'utf8'), decodeRiskRatingSet)
  if (ratings === null) throw new Error(`${spec} is not a rating set`)
  return ratings
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function main(
  argv: readonly string[],
  io: BenchIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const split = argv.indexOf('--')
  const own = split === -1 ? argv : argv.slice(0, split)
  const passthrough = split === -1 ? [] : argv.slice(split + 1)
  let parsed
  try {
    parsed = parseArgs({
      args: [...own],
      allowPositionals: true,
      options: {
        corpus: { type: 'string', default: DEFAULT_CORPUS },
        out: { type: 'string', default: DEFAULT_OUT_DIR },
        repo: { type: 'string', default: 'copse-dev/agent-pane' },
        'repo-dir': { type: 'string', default: '.' },
        'main-ref': { type: 'string', default: 'origin/main' },
        reviewer: { type: 'string', default: '.' },
        'mature-from': { type: 'string' },
        'mature-to': { type: 'string' },
        'mature-count': { type: 'string', default: '36' },
        'window-days': { type: 'string', default: String(DEFAULT_WINDOW_DAYS) },
        include: { type: 'string', multiple: true },
        label: { type: 'string' },
        case: { type: 'string', multiple: true },
        ratings: { type: 'string', default: 'posted' },
        json: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    })
  } catch (err) {
    io.stderr(`bench:risk: ${errorMessage(err)}\n${USAGE}`)
    return 2
  }
  const { values, positionals } = parsed
  const [command, ...rest] = positionals
  if (values.help || command === undefined) {
    io.stdout(USAGE)
    return values.help ? 0 : 2
  }
  const numbers = (list: readonly string[] | undefined): number[] =>
    (list ?? []).map((entry) => Number(entry.replace(/^#/, '')))
  try {
    if (command === 'collect') {
      if (values['mature-from'] === undefined || values['mature-to'] === undefined)
        throw new Error('collect needs --mature-from and --mature-to')
      const corpus = await collect({
        repo: values.repo,
        repoDir: values['repo-dir'],
        mainRef: values['main-ref'],
        client: githubClient(values.repo, env['GITHUB_TOKEN'] ?? env['GH_TOKEN']),
        corpusPath: values.corpus,
        windowDays: Number(values['window-days']),
        matureFrom: values['mature-from'],
        matureTo: values['mature-to'],
        matureCount: Number(values['mature-count']),
        include: numbers(values.include),
        now: new Date(),
        io,
      })
      writeJson(values.corpus, corpus)
      const pending = corpus.cases.flatMap((riskCase) =>
        riskCase.evidence.filter((item) => item.verdict === 'unverified'),
      )
      io.stdout(
        `bench:risk: wrote ${String(corpus.cases.length)} cases to ${values.corpus}; ${String(pending.length)} evidence items await a verdict\n`,
      )
      return 0
    }
    const corpus = readCorpus(values.corpus)
    if (corpus === null) throw new Error(`${values.corpus} does not exist; run collect first`)
    if (command === 'run') {
      if (values.label === undefined) throw new Error('run needs --label')
      const ratings = await runRatings({
        corpus,
        repoDir: values['repo-dir'],
        reviewerDir: values.reviewer,
        label: values.label,
        reviewerArgs: passthrough,
        source: ratingSource(passthrough),
        cases: numbers(values.case),
        env,
        now: new Date(),
        io,
      })
      const path = join(values.out, `${values.label}.json`)
      writeJson(path, ratings)
      const failed = ratings.ratings.filter((rating) => rating.error !== undefined).length
      io.stdout(
        `bench:risk: wrote ${String(ratings.ratings.length)} ratings (${String(failed)} failed) to ${path}\n`,
      )
      io.stdout(renderRiskReport(scoreRatings(corpus, ratings)))
      return failed === ratings.ratings.length && failed > 0 ? 1 : 0
    }
    if (command === 'score') {
      const score = scoreRatings(corpus, loadRatings(corpus, values.ratings))
      if (values.json !== undefined) writeJson(values.json, score)
      io.stdout(renderRiskReport(score))
      io.stdout(`\n${renderOutcomeProfile(outcomeProfile(corpus, true))}`)
      io.stdout(`\n${renderOutcomeProfile(outcomeProfile(corpus, false))}`)
      return 0
    }
    if (command === 'compare') {
      const [beforeSpec, afterSpec] = rest
      if (beforeSpec === undefined || afterSpec === undefined)
        throw new Error('compare needs two rating sets')
      const before = scoreRatings(corpus, loadRatings(corpus, beforeSpec))
      const after = scoreRatings(corpus, loadRatings(corpus, afterSpec))
      const summary = (label: string, score: typeof before): string =>
        `${label}: ${String(score.all.scored)} scored, exact ${String(score.all.exact)}, over ${String(score.all.over)}, under ${String(score.all.under)}, regressions rated below High ${String(score.all.missedRegressions)}/${String(score.all.regressions)}\n`
      io.stdout(summary(`before (${before.label})`, before))
      io.stdout(summary(`after (${after.label})`, after))
      for (const delta of compareScores(before, after)) {
        io.stdout(
          `  #${String(delta.number)}: ${delta.before} → ${delta.after} (truth ${delta.truth})\n`,
        )
      }
      return 0
    }
    throw new Error(`unknown command ${command}`)
  } catch (err) {
    io.stderr(`bench:risk: ${errorMessage(err)}\n`)
    return 1
  }
}
