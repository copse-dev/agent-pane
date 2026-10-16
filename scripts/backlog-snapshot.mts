/**
 * Read-only backlog snapshot: one bounded view of the open pull requests,
 * grouped by what blocks each one, shared as JSON plus Markdown.
 *
 * The snapshot is evidence collected at one moment, not a source of truth.
 * Nothing here writes to GitHub: no labels, comments, statuses or branches.
 * Every request is a `gh api` GET. See docs/backlog-snapshot.md.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { isDirectExecution } from './lib/direct-execution.mts'
import { decodeWithSchema, safeJsonParse } from './lib/safe-json.mts'
import { parseScreenshotStack } from './screenshot-stack.mts'

const DEFAULT_REPOSITORY = 'copse-dev/agent-pane'
const DEFAULT_OUT = '.tmp/backlog-snapshot'
const DEFAULT_COMMENT_DAYS = 14
const DEFAULT_LIMIT = 200
const DEFAULT_CONCURRENCY = 4
const PAGE = 100
const COMMENT_PAGES = 5
const CI_CHECK = 'CI Passed'
const BASE_CHECK = 'Base Current'
const SCREENSHOT_CONTEXT = 'Screenshot review'
const CLA_CONTEXT = 'CLA'
const NEEDS_REVIEW_LABEL = 'screenshots-need-review'
const SHA = /^[0-9a-f]{40}$/
const DAY = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// GitHub REST decoders (zod, via safeJsonParse: untrusted API text never
// becomes a typed value without validation).

const shaSchema = z.string().regex(SHA)
const actorSchema = z.object({ login: z.string(), type: z.string().optional() }).nullable()
const pullListItemSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  draft: z.boolean(),
  state: z.enum(['open', 'closed']),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  merged_at: z.string().nullable().optional(),
  merge_commit_sha: z.string().nullable().optional(),
  labels: z.array(z.object({ name: z.string() })),
  user: actorSchema,
  head: z.object({
    ref: z.string(),
    sha: shaSchema,
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({ ref: z.string(), sha: shaSchema }),
})
const pullListSchema = z.array(pullListItemSchema)
const pullDetailSchema = pullListItemSchema.extend({
  mergeable: z.boolean().nullable(),
  mergeable_state: z.string(),
})
const checkRunsSchema = z.object({
  check_runs: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      html_url: z.string().nullable(),
      details_url: z.string().nullable(),
      output: z.object({ title: z.string().nullable() }).optional(),
    }),
  ),
})
const combinedStatusSchema = z.object({
  state: z.string(),
  statuses: z.array(
    z.object({
      context: z.string(),
      state: z.string(),
      description: z.string().nullable(),
    }),
  ),
})
const commitSchema = z.object({
  sha: shaSchema,
  commit: z.object({ committer: z.object({ date: z.string() }).nullable() }),
})
const reviewsSchema = z.array(
  z.object({
    id: z.number().int(),
    state: z.string(),
    submitted_at: z.string().nullable().optional(),
    user: actorSchema,
  }),
)
const commentsSchema = z.array(
  z.object({
    id: z.number().int(),
    body: z.string().nullable(),
    html_url: z.string(),
    issue_url: z.string(),
    created_at: z.string(),
    user: actorSchema,
  }),
)
type PullListItem = z.infer<typeof pullListItemSchema>
type CheckRun = z.infer<typeof checkRunsSchema>['check_runs'][number]
type Comment = z.infer<typeof commentsSchema>[number]

// ---------------------------------------------------------------------------
// Snapshot shape. The schema is also the cache decoder, so a stale or edited
// snapshot file is rejected rather than trusted.

const GROUPS = [
  'ready',
  'failing-checks',
  'missing-visual-decision',
  'acceptance-hold',
  'superseded',
  'in-progress',
] as const
const HOLD_CATEGORIES = [
  'security',
  'native',
  'product',
  'review',
  'verification',
  'unspecified',
] as const
const checkSummarySchema = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  runId: z.string().nullable(),
  url: z.string().nullable(),
})
const statusSummarySchema = z.object({
  state: z.enum(['none', 'pending', 'success', 'error', 'failure']),
  description: z.string(),
})
const holdSchema = z.object({
  kind: z.enum(['changes-requested', 'label', 'body', 'comment']),
  category: z.enum(HOLD_CATEGORIES),
  evidence: z.string(),
  url: z.string().optional(),
})
const linkSchema = z.object({
  number: z.number().int().positive(),
  kind: z.enum(['pinned-head', 'recovery-clause', 'self-declared']),
  state: z.enum(['open', 'draft', 'merged', 'closed', 'unknown']),
  evidence: z.string(),
  pinnedSha: z.string().optional(),
})
const commentEvidenceSchema = z.object({
  id: z.number().int(),
  kind: z.enum(['supersession', 'hold']),
  url: z.string(),
  createdAt: z.string(),
  excerpt: z.string(),
  author: z.string(),
})
const observationSchema = z.object({
  headSha: shaSchema,
  baseSha: shaSchema,
  updatedAt: z.string(),
  observedAt: z.string(),
  headCommittedAt: z.string().nullable(),
  mergeable: z.boolean().nullable(),
  mergeableState: z.string(),
  ci: checkSummarySchema.nullable(),
  failingChecks: z.array(checkSummarySchema),
  pendingChecks: z.number().int(),
  baseCurrent: z.object({ conclusion: z.string().nullable(), title: z.string() }).nullable(),
  screenshot: statusSummarySchema,
  cla: statusSummarySchema,
  changesRequestedBy: z.array(z.string()),
  approvedBy: z.array(z.string()),
  errors: z.array(z.string()),
})
const pullRecordSchema = observationSchema.extend({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  draft: z.boolean(),
  baseRef: z.string(),
  headRef: z.string(),
  sameRepository: z.boolean(),
  createdAt: z.string(),
  labels: z.array(z.string()),
  reused: z.boolean(),
  previousHead: z
    .object({ headSha: shaSchema, ci: checkSummarySchema.nullable(), observedAt: z.string() })
    .nullable(),
  holds: z.array(holdSchema),
  stack: z
    .object({
      tip: z.number().int().positive(),
      members: z.array(z.object({ number: z.number().int().positive(), sha: shaSchema })),
      isTip: z.boolean(),
      pinnedSha: z.string().nullable(),
      pinMatchesHead: z.boolean().nullable(),
      digest: z.string(),
      malformed: z.string().nullable(),
    })
    .nullable(),
  supersededBy: z.array(linkSchema),
  supersedes: z.array(linkSchema),
  commentEvidence: z.array(commentEvidenceSchema),
  group: z.enum(GROUPS),
  flags: z.array(z.string()),
  nextAction: z.string(),
})
const closedBatchSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  mergedAt: z.string(),
  mergeCommit: z.string().nullable(),
  supersedes: z.array(linkSchema),
})
export const snapshotSchema = z.object({
  version: z.literal(1),
  repository: z.string(),
  generatedAt: z.string(),
  commentsSince: z.string(),
  since: z.string().nullable(),
  apiCalls: z.number().int(),
  reused: z.number().int(),
  truncated: z.boolean(),
  pulls: z.array(pullRecordSchema),
  closedBatches: z.array(closedBatchSchema),
})

export type Snapshot = z.infer<typeof snapshotSchema>
export type PullRecord = z.infer<typeof pullRecordSchema>
export type Observation = z.infer<typeof observationSchema>
export type Hold = z.infer<typeof holdSchema>
export type SupersessionLink = z.infer<typeof linkSchema>
export type CheckSummary = z.infer<typeof checkSummarySchema>
export type Group = (typeof GROUPS)[number]
type HoldCategory = (typeof HOLD_CATEGORIES)[number]
type CommentEvidence = z.infer<typeof commentEvidenceSchema>
type ClosedBatch = z.infer<typeof closedBatchSchema>

export function parseSnapshot(text: string): Snapshot | null {
  return safeJsonParse(text, decodeWithSchema(snapshotSchema))
}

// ---------------------------------------------------------------------------
// GitHub access. The only capability the collector receives is GET.

export interface BacklogApi {
  /** `path` is relative to the API root, e.g. `repos/o/r/pulls?state=open`. */
  get(path: string): Promise<string>
}

/** Exact `gh` invocation: a GET, never a mutation, never a GraphQL query. */
export function ghApiArguments(path: string): string[] {
  if (path.startsWith('/') || path.includes('..') || path.startsWith('graphql')) {
    throw new Error(`Refusing non-REST or absolute API path: ${path}`)
  }
  return ['api', '--method', 'GET', path]
}

const execFileAsync = promisify(execFile)

export function createGhApi(cwd: string): BacklogApi & { calls(): number } {
  let calls = 0
  return {
    calls: (): number => calls,
    async get(path: string): Promise<string> {
      calls += 1
      const { stdout } = await execFileAsync('gh', ghApiArguments(path), {
        cwd,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GH_PAGER: '', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
      })
      return stdout
    },
  }
}

/** Replay recorded responses keyed by request path; unknown paths fail loudly. */
export function recordedApi(responses: Record<string, string>): BacklogApi & {
  requested: string[]
} {
  const requested: string[] = []
  return {
    requested,
    get: async (path: string): Promise<string> => {
      requested.push(path)
      const body = responses[path]
      if (body === undefined) throw new Error(`No recorded response for ${path}`)
      return await Promise.resolve(body)
    },
  }
}

async function pool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  async function run(): Promise<void> {
    while (next < items.length) {
      const index = next
      next += 1
      const item = items[index]
      if (item === undefined) continue
      results[index] = await worker(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run))
  return results
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    // gh prints the API error on stderr; keep the first line only.
    const stderr: unknown = Reflect.get(error, 'stderr')
    const detail = typeof stderr === 'string' ? stderr.trim().split('\n')[0] : undefined
    return detail && detail.length > 0 ? detail : (error.message.split('\n')[0] ?? 'error')
  }
  return String(error)
}

// ---------------------------------------------------------------------------
// Pure signal extraction. Each heuristic names its evidence so a reader can
// judge it; docs/backlog-snapshot.md lists them.

/** Drop the reviewer bot's appended summary and quoted lines before scanning. */
export function stripBotSummary(body: string | null): string {
  if (!body) return ''
  const start = body.indexOf('<!-- copse-review-summary -->')
  const stripped = start === -1 ? body : body.slice(0, start)
  return stripped
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
}

const HOLD_MARKERS: { pattern: RegExp; category: HoldCategory }[] = [
  { pattern: /\bindependent security review\b/i, category: 'security' },
  { pattern: /\bsecurity (?:review|hold|acceptance)\b/i, category: 'security' },
  {
    pattern: /\b(?:native|supported-platform|hardware)(?: runtime| platform)? acceptance\b/i,
    category: 'native',
  },
  { pattern: /\bproduct decision\b/i, category: 'product' },
  { pattern: /\bowner[’']?s decision\b/i, category: 'product' },
  { pattern: /\bdo not merge\b/i, category: 'product' },
  { pattern: /\bblocking acceptance\b/i, category: 'unspecified' },
  { pattern: /(?:^|[^A-Za-z])HOLD(?::|\b)/, category: 'unspecified' },
]

const HOLD_LABELS: Record<string, HoldCategory> = {
  security: 'security',
  'area:security': 'security',
  'status:needs-verification': 'verification',
  'ga-blocker': 'product',
  'review-has-feedback': 'review',
}

function refineCategory(line: string, category: HoldCategory): HoldCategory {
  if (category !== 'unspecified') return category
  if (/\b(?:security|vault|credential|permission|sandbox)/i.test(line)) return 'security'
  if (/\b(?:native|macos|windows|hardware|platform)\b/i.test(line)) return 'native'
  if (/\b(?:product|owner|design)\b/i.test(line)) return 'product'
  return category
}

function excerpt(line: string, max = 140): string {
  const trimmed = line.replace(/\s+/g, ' ').trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

/** Lines that read as an explicit acceptance hold; one entry per line. */
export function detectHoldMarkers(text: string): { category: HoldCategory; evidence: string }[] {
  const found: { category: HoldCategory; evidence: string }[] = []
  for (const line of text.split('\n')) {
    const marker = HOLD_MARKERS.find(({ pattern }) => pattern.test(line))
    if (!marker) continue
    // "remain" / "no longer" sentences describe lifted or historical holds.
    if (/\b(?:no longer|lifted|resolved|cleared)\b/i.test(line)) continue
    found.push({ category: refineCategory(line, marker.category), evidence: excerpt(line) })
  }
  return found
}

const SELF_SUPERSEDED =
  /\b(?:superseded by|folded into|recovered (?:in|by)|retired (?:in|by)|landed (?:in|via|as part of))\b[^#\n]{0,80}?#([1-9][0-9]*)/gi

/** "Superseded by … #N" written on the original itself (body or comment). */
export function detectSelfSupersession(text: string): { number: number; evidence: string }[] {
  const found: { number: number; evidence: string }[] = []
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(SELF_SUPERSEDED)) {
      const number = Number(match[1])
      if (Number.isSafeInteger(number) && number > 0)
        found.push({ number, evidence: excerpt(line) })
    }
  }
  return found
}

const PINNED_HEAD = /#([1-9][0-9]*)(?:'s)?[\s:|`]{1,6}([0-9a-f]{40})\b/g
const RECOVERY_VERB =
  // Verbs only: the noun "recovery" also names plans and batches in passing.
  /\b(?:recover(?:s|ed|ing)?|supersed(?:es|ed|ing)|fold(?:s|ed|ing)?|retir(?:es|ed|ing))\b/i
const NEGATED = /\b(?:exclud\w*|not|neither|deferred|stays? open|remains? open|retain\w*|other)\b/i

export interface BatchReference {
  number: number
  kind: 'pinned-head' | 'recovery-clause'
  evidence: string
  pinnedSha?: string
}

/**
 * PRs a batch body says it carries. A `#N` directly followed by a 40-hex SHA is
 * a pinned original head (strong). A sentence with a recovery verb that names
 * PRs, and no exclusion wording, is a weaker clause-level reference.
 */
export function detectBatchReferences(body: string | null, self: number): BatchReference[] {
  const text = stripBotSummary(body)
  const seen = new Map<number, BatchReference>()
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(PINNED_HEAD)) {
      const number = Number(match[1])
      const sha = match[2]
      if (!Number.isSafeInteger(number) || number <= 0 || number === self || !sha) continue
      seen.set(number, { number, kind: 'pinned-head', evidence: excerpt(line), pinnedSha: sha })
    }
  }
  for (const segment of text.split(/(?<=[.;])\s|\n/)) {
    const verb = RECOVERY_VERB.exec(segment)
    if (!verb || NEGATED.test(segment)) continue
    // "Recovers #N …": the verb governs the PRs named after it. A PR named
    // before the verb ("so #N's author can fold it in") is not being carried.
    for (const match of segment.slice(verb.index).matchAll(/#([1-9][0-9]*)/g)) {
      const number = Number(match[1])
      if (!Number.isSafeInteger(number) || number <= 0 || number === self || seen.has(number))
        continue
      seen.set(number, { number, kind: 'recovery-clause', evidence: excerpt(segment) })
    }
  }
  return [...seen.values()]
}

function runIdOf(url: string | null): string | null {
  const match = url ? /\/actions\/runs\/([0-9]+)/.exec(url) : null
  return match?.[1] ?? null
}

function summarizeCheck(run: CheckRun): CheckSummary {
  return {
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    runId: runIdOf(run.html_url ?? run.details_url),
    url: run.html_url ?? run.details_url,
  }
}

const FAILED_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'stale',
])

export function summarizeChecks(runs: readonly CheckRun[]): {
  ci: CheckSummary | null
  failingChecks: CheckSummary[]
  pendingChecks: number
  baseCurrent: Observation['baseCurrent']
} {
  // One SHA accumulates check runs from every workflow run on it (label
  // re-triggers, reruns). Keep the newest run per check name, and drop every
  // job of a CI workflow run that a newer `CI Passed` run has superseded.
  const latestByName = new Map<string, CheckRun>()
  for (const run of runs) {
    const current = latestByName.get(run.name)
    if (!current || run.id > current.id) latestByName.set(run.name, run)
  }
  const ci = latestByName.get(CI_CHECK)
  const ciRunId = ci ? runIdOf(ci.html_url ?? ci.details_url) : null
  const staleRuns = new Set(
    runs
      .filter((run) => run.name === CI_CHECK && run !== ci)
      .map((run) => runIdOf(run.html_url ?? run.details_url))
      .filter((id) => id !== null && id !== ciRunId),
  )
  const live = [...latestByName.values()].filter(
    (run) => !staleRuns.has(runIdOf(run.html_url ?? run.details_url)),
  )
  const base = latestByName.get(BASE_CHECK)
  return {
    ci: ci ? summarizeCheck(ci) : null,
    failingChecks: live
      .filter(
        (run) =>
          run.name !== BASE_CHECK &&
          run.status === 'completed' &&
          run.conclusion !== null &&
          FAILED_CONCLUSIONS.has(run.conclusion) &&
          // A cancelled job outside the current CI run is a superseded
          // attempt, not a failure of this head.
          (run.conclusion !== 'cancelled' ||
            (ciRunId !== null && runIdOf(run.html_url ?? run.details_url) === ciRunId)),
      )
      .sort((a, b) => (a.name === CI_CHECK ? -1 : b.name === CI_CHECK ? 1 : a.id - b.id))
      .map(summarizeCheck),
    pendingChecks: live.filter((run) => run.status !== 'completed').length,
    baseCurrent: base ? { conclusion: base.conclusion, title: base.output?.title ?? '' } : null,
  }
}

type StatusSummary = z.infer<typeof statusSummarySchema>

function statusOf(
  statuses: readonly { context: string; state: string; description: string | null }[],
  context: string,
): StatusSummary {
  // The combined endpoint already returns the latest status per context.
  const status = statuses.find((entry) => entry.context === context)
  if (!status) return { state: 'none', description: '' }
  const state = statusSummarySchema.shape.state.safeParse(status.state)
  return {
    state: state.success ? state.data : 'error',
    description: status.description ?? '',
  }
}

export function latestReviewStates(reviews: z.infer<typeof reviewsSchema>): {
  changesRequestedBy: string[]
  approvedBy: string[]
} {
  const latest = new Map<string, { at: string; state: string }>()
  for (const review of reviews) {
    const login = review.user?.login
    if (!login || review.state === 'COMMENTED' || review.state === 'PENDING') continue
    const at = review.submitted_at ?? ''
    const previous = latest.get(login)
    if (!previous || at >= previous.at) latest.set(login, { at, state: review.state })
  }
  const by = (state: string): string[] =>
    [...latest.entries()].filter(([, entry]) => entry.state === state).map(([login]) => login)
  return { changesRequestedBy: by('CHANGES_REQUESTED'), approvedBy: by('APPROVED') }
}

export function formatAge(from: string | null, now: Date): string {
  if (!from) return '?'
  const ms = now.getTime() - new Date(from).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '?'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${String(hours)}h`
  const days = Math.floor(hours / 24)
  return `${String(days)}d ${String(hours % 24)}h`
}

// ---------------------------------------------------------------------------
// Classification. Precedence: superseded, failing checks, acceptance hold,
// missing visual decision, ready, in progress. Every other signal still shows
// in `flags`, so the group is a triage pointer rather than the whole state.

export function classify(
  record: Omit<PullRecord, 'group' | 'nextAction' | 'flags'>,
): Pick<PullRecord, 'group' | 'nextAction' | 'flags'> {
  const flags: string[] = []
  const ciFailed =
    record.ci?.status === 'completed' &&
    record.ci.conclusion !== null &&
    FAILED_CONCLUSIONS.has(record.ci.conclusion)
  const ciGreen = record.ci?.status === 'completed' && record.ci.conclusion === 'success'
  const statusFailures = [
    ...(record.screenshot.state === 'error' || record.screenshot.state === 'failure'
      ? [`${SCREENSHOT_CONTEXT}: ${record.screenshot.description || record.screenshot.state}`]
      : []),
    ...(record.cla.state === 'error' || record.cla.state === 'failure'
      ? [`${CLA_CONTEXT}: ${record.cla.description || record.cla.state}`]
      : []),
  ]
  const failing = [
    ...record.failingChecks.map(
      (check) =>
        `${check.name} (${check.conclusion ?? 'unknown'}${check.runId ? `, run ${check.runId}` : ''})`,
    ),
    ...statusFailures,
  ]
  const needsVisual =
    record.screenshot.state === 'pending' || record.labels.includes(NEEDS_REVIEW_LABEL)

  if (record.draft) flags.push('draft')
  if (record.mergeable === false) flags.push(`conflicts with ${record.baseRef}`)
  if (record.mergeable === null) flags.push('mergeability unknown')
  if (record.baseCurrent && record.baseCurrent.conclusion !== 'success' && record.baseCurrent.title)
    flags.push(record.baseCurrent.title)
  if (record.pendingChecks > 0) flags.push(`${String(record.pendingChecks)} checks pending`)
  if (!record.ci) flags.push('no CI on head')
  if (needsVisual) flags.push('screenshots await decision')
  if (record.screenshot.state === 'none' && ciGreen) flags.push('no Screenshot review status')
  for (const hold of record.holds) flags.push(`hold: ${hold.category}`)
  if (record.stack)
    flags.push(record.stack.isTip ? 'stack tip' : `stack → #${String(record.stack.tip)}`)
  if (record.errors.length) flags.push(`${String(record.errors.length)} API errors`)
  if (record.supersedes.length)
    flags.push(`batch of ${record.supersedes.map((link) => `#${String(link.number)}`).join(' ')}`)
  if (!record.sameRepository) flags.push('fork head')

  const unique = [...new Set(flags)]
  if (record.supersededBy.length) {
    const merged = record.supersededBy.filter((link) => link.state === 'merged')
    const open = record.supersededBy.filter(
      (link) => link.state === 'open' || link.state === 'draft',
    )
    const list = (links: SupersessionLink[]): string =>
      links
        .map((link) => `#${String(link.number)}${link.state === 'draft' ? ' (draft)' : ''}`)
        .join(', ')
    const nextAction = merged.length
      ? `Verify the changes landed through merged ${list(merged)}, then close as superseded`
      : open.length
        ? `Folded into open batch ${list(open)}; do not restack, retire after the batch lands`
        : `Named by closed ${list(record.supersededBy)}; confirm whether it still needs an owner`
    return { group: 'superseded', flags: unique, nextAction }
  }
  if (ciFailed || failing.length) {
    const named =
      ciFailed && !failing.length ? [`${CI_CHECK} (${record.ci?.conclusion ?? ''})`] : failing
    const shown = named.slice(0, 4)
    const more = named.length - shown.length
    return {
      group: 'failing-checks',
      flags: unique,
      nextAction: `Fix on current head: ${shown.join('; ')}${more > 0 ? ` and ${String(more)} more` : ''}`,
    }
  }
  if (record.holds.length) {
    const categories = [...new Set(record.holds.map((hold) => hold.category))]
    return {
      group: 'acceptance-hold',
      flags: unique,
      nextAction: `Resolve ${categories.join('/')} hold: ${record.holds.at(0)?.evidence ?? ''}`,
    }
  }
  if (needsVisual) {
    return {
      group: 'missing-visual-decision',
      flags: unique,
      nextAction:
        record.screenshot.description ||
        `Decide screenshots: label accept-screenshots or decline-screenshots`,
    }
  }
  if (
    !record.draft &&
    record.mergeable === true &&
    ciGreen &&
    record.screenshot.state === 'success' &&
    record.cla.state === 'success' &&
    record.pendingChecks === 0 &&
    record.sameRepository &&
    record.errors.length === 0
  ) {
    return {
      group: 'ready',
      flags: unique,
      nextAction:
        'Ready by snapshot signals: recheck live state, then land through the repository landing path',
    }
  }
  const reasons: string[] = []
  if (record.errors.length) reasons.push('incomplete observation; retry failed GitHub reads')
  if (record.draft) reasons.push('draft; mark ready for review when complete')
  if (record.mergeable === false) reasons.push(`resolve conflicts with ${record.baseRef}`)
  if (!record.ci) {
    reasons.push(
      record.previousHead?.ci
        ? `no CI on current head (previous head ${record.previousHead.headSha.slice(0, 7)} ${record.previousHead.ci.conclusion ?? record.previousHead.ci.status})`
        : 'no CI on current head; push or rerun CI',
    )
  } else if (record.ci.status !== 'completed') {
    reasons.push(`wait for ${CI_CHECK}${record.ci.runId ? ` run ${record.ci.runId}` : ''}`)
  }
  if (record.pendingChecks > 0 && record.ci?.status === 'completed')
    reasons.push(`${String(record.pendingChecks)} checks still running`)
  if (ciGreen && record.screenshot.state === 'none')
    reasons.push('no Screenshot review status on head; check the publisher run')
  if (record.cla.state !== 'success') reasons.push(`${CLA_CONTEXT} status ${record.cla.state}`)
  if (record.mergeable === null) reasons.push('mergeability not computed; rerun the snapshot')
  if (!record.sameRepository) reasons.push('fork head; needs a same-repository branch')
  return {
    group: 'in-progress',
    flags: unique,
    nextAction: reasons.length ? reasons.join('; ') : 'Recheck live state',
  }
}

// ---------------------------------------------------------------------------
// Collection.

export interface CollectOptions {
  repository: string
  now: Date
  cache: Snapshot | null
  since: Date | null
  commentDays: number
  limit: number
  concurrency: number
}

function repoPath(repository: string, rest: string): string {
  return `repos/${repository}/${rest}`
}

async function fetchDecoded<T>(
  api: BacklogApi,
  path: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<T> {
  const text = await api.get(path)
  const value = safeJsonParse(text, decodeWithSchema(schema))
  if (value === null) throw new Error(`Unexpected response shape from ${path}`)
  return value
}

async function listPulls(
  api: BacklogApi,
  repository: string,
  query: string,
  maxPages: number,
): Promise<{ pulls: PullListItem[]; truncated: boolean }> {
  const pulls: PullListItem[] = []
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await fetchDecoded(
      api,
      repoPath(repository, `pulls?${query}&per_page=${String(PAGE)}&page=${String(page)}`),
      pullListSchema,
    )
    pulls.push(...batch)
    if (batch.length < PAGE) return { pulls, truncated: false }
  }
  return { pulls, truncated: true }
}

async function listComments(
  api: BacklogApi,
  repository: string,
  since: string,
): Promise<Comment[]> {
  const comments: Comment[] = []
  for (let page = 1; page <= COMMENT_PAGES; page += 1) {
    const batch = await fetchDecoded(
      api,
      repoPath(
        repository,
        `issues/comments?sort=updated&direction=desc&since=${since}&per_page=${String(PAGE)}&page=${String(page)}`,
      ),
      commentsSchema,
    )
    comments.push(...batch)
    if (batch.length < PAGE) break
  }
  return comments
}

function settled(observation: Observation, draft: boolean): boolean {
  return (
    observation.errors.length === 0 &&
    observation.mergeable !== null &&
    observation.pendingChecks === 0 &&
    (observation.ci ? observation.ci.status === 'completed' : draft)
  )
}

function reusable(cached: PullRecord, live: PullListItem, since: Date | null): boolean {
  if (
    cached.headSha !== live.head.sha ||
    cached.baseSha !== live.base.sha ||
    cached.updatedAt !== live.updated_at
  )
    return false
  // --since: refresh exactly the PRs updated after the cutoff; reuse the rest.
  if (since) return new Date(live.updated_at) <= since
  return settled(cached, live.draft)
}

async function observe(
  api: BacklogApi,
  repository: string,
  live: PullListItem,
  cached: PullRecord | undefined,
  now: Date,
): Promise<Observation> {
  const errors: string[] = []
  const attempt = async <T,>(label: string, work: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await work()
    } catch (error) {
      errors.push(`${label}: ${errorMessage(error)}`)
      return fallback
    }
  }
  const sha = live.head.sha
  const [detail, checks, combined, commit, reviews] = await Promise.all([
    attempt(
      'pull',
      () =>
        fetchDecoded(api, repoPath(repository, `pulls/${String(live.number)}`), pullDetailSchema),
      null,
    ),
    attempt(
      'check-runs',
      () =>
        fetchDecoded(
          api,
          repoPath(repository, `commits/${sha}/check-runs?per_page=${String(PAGE)}`),
          checkRunsSchema,
        ),
      { check_runs: [] },
    ),
    attempt(
      'status',
      () => fetchDecoded(api, repoPath(repository, `commits/${sha}/status`), combinedStatusSchema),
      { state: 'unknown', statuses: [] },
    ),
    cached?.headSha === sha && cached.headCommittedAt
      ? Promise.resolve({ sha, commit: { committer: { date: cached.headCommittedAt } } })
      : attempt(
          'commit',
          () => fetchDecoded(api, repoPath(repository, `commits/${sha}`), commitSchema),
          null,
        ),
    attempt(
      'reviews',
      () =>
        fetchDecoded(
          api,
          repoPath(repository, `pulls/${String(live.number)}/reviews?per_page=${String(PAGE)}`),
          reviewsSchema,
        ),
      [],
    ),
  ])
  const summary = summarizeChecks(checks.check_runs)
  const reviewStates = latestReviewStates(reviews)
  return {
    headSha: sha,
    baseSha: live.base.sha,
    updatedAt: live.updated_at,
    observedAt: now.toISOString(),
    headCommittedAt: commit?.commit.committer?.date ?? null,
    mergeable: detail ? detail.mergeable : null,
    mergeableState: detail ? detail.mergeable_state : 'unknown',
    ...summary,
    screenshot: statusOf(combined.statuses, SCREENSHOT_CONTEXT),
    cla: statusOf(combined.statuses, CLA_CONTEXT),
    ...reviewStates,
    errors,
  }
}

function observationOf(record: PullRecord): Observation {
  return observationSchema.parse(record)
}

function issueNumber(comment: Comment): number | null {
  const match = /\/issues\/([1-9][0-9]*)$/.exec(comment.issue_url)
  const number = Number(match?.[1])
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function commentSignals(comments: readonly Comment[]): Map<number, CommentEvidence[]> {
  const byIssue = new Map<number, CommentEvidence[]>()
  for (const comment of comments) {
    const number = issueNumber(comment)
    // Quoted lines restate someone else's words; a reply that quotes a hold or
    // a supersession note is not itself one.
    const body = stripBotSummary(comment.body)
    if (number === null || !body.trim()) continue
    const author = comment.user?.login ?? 'unknown'
    const bot = comment.user?.type === 'Bot' || author.endsWith('[bot]')
    const signals: CommentEvidence[] = []
    for (const { evidence } of detectSelfSupersession(body)) {
      signals.push({
        id: comment.id,
        kind: 'supersession',
        url: comment.html_url,
        createdAt: comment.created_at,
        excerpt: evidence,
        author,
      })
    }
    if (!bot) {
      for (const { evidence } of detectHoldMarkers(body)) {
        signals.push({
          id: comment.id,
          kind: 'hold',
          url: comment.html_url,
          createdAt: comment.created_at,
          excerpt: evidence,
          author,
        })
      }
    }
    if (signals.length) byIssue.set(number, [...(byIssue.get(number) ?? []), ...signals])
  }
  return byIssue
}

function stackOf(body: string | null, number: number, headSha: string): PullRecord['stack'] {
  let declaration: ReturnType<typeof parseScreenshotStack>
  try {
    declaration = parseScreenshotStack(body)
  } catch (error) {
    return {
      tip: number,
      members: [],
      isTip: false,
      pinnedSha: null,
      pinMatchesHead: null,
      digest: '',
      malformed: errorMessage(error),
    }
  }
  if (!declaration) return null
  const pin = declaration.members.find((member) => member.number === number)
  return {
    tip: declaration.tip,
    members: declaration.members,
    isTip: declaration.tip === number,
    pinnedSha: pin?.sha ?? null,
    pinMatchesHead: pin ? pin.sha === headSha : null,
    digest: declaration.digest,
    malformed: null,
  }
}

export async function collectBacklogSnapshot(
  api: BacklogApi & { calls?(): number },
  options: CollectOptions,
): Promise<Snapshot> {
  const { repository, now, cache, since } = options
  const cachedByNumber = new Map((cache?.pulls ?? []).map((record) => [record.number, record]))
  const commentsSince = new Date(now.getTime() - options.commentDays * DAY).toISOString()

  const { pulls: open, truncated } = await listPulls(
    api,
    repository,
    'state=open&sort=updated&direction=desc',
    Math.max(1, Math.ceil(options.limit / PAGE)),
  )
  const bounded = open.slice(0, options.limit)
  const openNumbers = new Set(bounded.map((pull) => pull.number))

  const { pulls: closed } = await listPulls(
    api,
    repository,
    'state=closed&sort=updated&direction=desc',
    1,
  )
  const comments = await listComments(api, repository, commentsSince)
  const signals = commentSignals(comments)

  let reused = 0
  const observations = await pool(bounded, options.concurrency, async (live) => {
    const cached = cachedByNumber.get(live.number)
    if (cached && reusable(cached, live, since)) {
      reused += 1
      return { live, observation: observationOf(cached), reusedEntry: true }
    }
    return {
      live,
      observation: await observe(api, repository, live, cached, now),
      reusedEntry: false,
    }
  })

  // Batch → original links from open bodies and recently merged bodies.
  const supersededBy = new Map<number, SupersessionLink[]>()
  const supersedes = new Map<number, SupersessionLink[]>()
  const link = (
    from: number,
    to: number,
    entry: SupersessionLink,
    fromState: SupersessionLink['state'],
  ): void => {
    supersedes.set(from, [...(supersedes.get(from) ?? []), entry])
    const back: SupersessionLink = { ...entry, number: from, state: fromState }
    supersededBy.set(to, [...(supersededBy.get(to) ?? []), back])
  }
  const headRefByNumber = new Map(bounded.map((pull) => [pull.number, pull.head.ref]))
  for (const pull of bounded) {
    for (const reference of detectBatchReferences(pull.body, pull.number)) {
      if (!openNumbers.has(reference.number)) continue
      // A PR based on another PR's branch is its stacked child, never a batch
      // that carries it, whatever its body says about folding work in.
      if (headRefByNumber.get(reference.number) === pull.base.ref) continue
      const entry: SupersessionLink = {
        number: reference.number,
        kind: reference.kind,
        state: 'open',
        evidence: reference.evidence,
        ...(reference.pinnedSha ? { pinnedSha: reference.pinnedSha } : {}),
      }
      link(pull.number, reference.number, entry, pull.draft ? 'draft' : 'open')
    }
  }
  const closedBatches = new Map<number, ClosedBatch>(
    (cache?.closedBatches ?? []).map((batch) => [batch.number, batch]),
  )
  for (const pull of closed) {
    if (!pull.merged_at || new Date(pull.merged_at) < new Date(commentsSince)) continue
    const references = detectBatchReferences(pull.body, pull.number).filter(
      (reference) => reference.kind === 'pinned-head' || openNumbers.has(reference.number),
    )
    if (!references.length) continue
    closedBatches.set(pull.number, {
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      mergedAt: pull.merged_at,
      mergeCommit: pull.merge_commit_sha ?? null,
      supersedes: references.map((reference) => ({
        number: reference.number,
        kind: reference.kind,
        state: 'open',
        evidence: reference.evidence,
        ...(reference.pinnedSha ? { pinnedSha: reference.pinnedSha } : {}),
      })),
    })
  }
  for (const batch of closedBatches.values()) {
    for (const entry of batch.supersedes) {
      if (!openNumbers.has(entry.number)) continue
      supersededBy.set(entry.number, [
        ...(supersededBy.get(entry.number) ?? []),
        { ...entry, number: batch.number, state: 'merged' },
      ])
    }
  }

  const pulls: PullRecord[] = observations.map(({ live, observation, reusedEntry }) => {
    const cached = cachedByNumber.get(live.number)
    const body = stripBotSummary(live.body)
    const labels = live.labels.map((label) => label.name)
    const fresh = signals.get(live.number) ?? []
    const retained = (cached?.commentEvidence ?? []).filter(
      (evidence) => !fresh.some((candidate) => candidate.id === evidence.id),
    )
    const commentEvidence = [...fresh, ...retained].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    )
    const holds: Hold[] = [
      ...observation.changesRequestedBy.map((login): Hold => ({
        kind: 'changes-requested',
        category: 'review',
        evidence: `changes requested by ${login}`,
      })),
      ...labels.flatMap((label): Hold[] => {
        const category = Object.hasOwn(HOLD_LABELS, label) ? HOLD_LABELS[label] : undefined
        return category ? [{ kind: 'label', category, evidence: `label ${label}` }] : []
      }),
      ...detectHoldMarkers(body).map((hold): Hold => ({ kind: 'body', ...hold })),
      ...commentEvidence
        .filter((evidence) => evidence.kind === 'hold')
        .map((evidence): Hold => ({
          kind: 'comment',
          category: refineCategory(evidence.excerpt, 'unspecified'),
          evidence: `${evidence.author}: ${evidence.excerpt}`,
          url: evidence.url,
        })),
    ]
    const selfDeclared: SupersessionLink[] = [
      ...detectSelfSupersession(body).map((found): SupersessionLink => ({
        number: found.number,
        kind: 'self-declared',
        state: openNumbers.has(found.number)
          ? 'open'
          : closedBatches.has(found.number)
            ? 'merged'
            : 'unknown',
        evidence: found.evidence,
      })),
      ...commentEvidence
        .filter((evidence) => evidence.kind === 'supersession')
        .flatMap((evidence) =>
          detectSelfSupersession(evidence.excerpt).map((found): SupersessionLink => ({
            number: found.number,
            kind: 'self-declared',
            state: openNumbers.has(found.number)
              ? 'open'
              : closedBatches.has(found.number)
                ? 'merged'
                : 'unknown',
            evidence: `${evidence.author}: ${found.evidence}`,
          })),
        ),
    ].filter((entry) => entry.number !== live.number)
    const previousHead =
      cached && cached.headSha !== live.head.sha
        ? { headSha: cached.headSha, ci: cached.ci, observedAt: cached.observedAt }
        : (cached?.previousHead ?? null)
    const base: Omit<PullRecord, 'group' | 'nextAction' | 'flags'> = {
      ...observation,
      number: live.number,
      title: live.title,
      url: live.html_url,
      author: live.user?.login ?? 'unknown',
      draft: live.draft,
      baseRef: live.base.ref,
      headRef: live.head.ref,
      sameRepository: live.head.repo?.full_name === repository,
      createdAt: live.created_at,
      labels,
      reused: reusedEntry,
      previousHead,
      holds,
      stack: stackOf(live.body, live.number, live.head.sha),
      supersededBy: dedupeLinks([...(supersededBy.get(live.number) ?? []), ...selfDeclared]),
      supersedes: dedupeLinks(supersedes.get(live.number) ?? []),
      commentEvidence,
    }
    return { ...base, ...classify(base) }
  })

  return {
    version: 1,
    repository,
    generatedAt: now.toISOString(),
    commentsSince,
    since: since ? since.toISOString() : null,
    apiCalls: api.calls?.() ?? 0,
    reused,
    truncated: truncated || open.length > options.limit,
    pulls: pulls.sort((a, b) => b.number - a.number),
    closedBatches: [...closedBatches.values()].sort((a, b) => b.number - a.number),
  }
}

function dedupeLinks(links: readonly SupersessionLink[]): SupersessionLink[] {
  const byNumber = new Map<number, SupersessionLink>()
  const rank = { 'pinned-head': 0, 'self-declared': 1, 'recovery-clause': 2 }
  for (const entry of links) {
    const current = byNumber.get(entry.number)
    if (!current || rank[entry.kind] < rank[current.kind]) byNumber.set(entry.number, entry)
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number)
}

// ---------------------------------------------------------------------------
// Markdown rendering.

const GROUP_TITLES: Record<Group, string> = {
  ready: 'Ready',
  'failing-checks': 'Failing checks',
  'missing-visual-decision': 'Missing visual decision',
  'acceptance-hold': 'Substantive acceptance holds',
  superseded: 'Superseded originals',
  'in-progress': 'In progress or waiting',
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

export function renderBacklogMarkdown(snapshot: Snapshot): string {
  const now = new Date(snapshot.generatedAt)
  const lines: string[] = []
  const counts = GROUPS.map(
    (group) =>
      `${GROUP_TITLES[group]}: ${String(snapshot.pulls.filter((pull) => pull.group === group).length)}`,
  )
  lines.push(`# Backlog snapshot for ${snapshot.repository}`)
  lines.push('')
  const sinceNote = snapshot.since ? `, --since ${snapshot.since}` : ''
  const truncatedNote = snapshot.truncated
    ? ' **Open PR list truncated at the configured limit.**'
    : ''
  lines.push(
    `Generated ${snapshot.generatedAt} from ${String(snapshot.apiCalls)} GitHub reads` +
      ` (${String(snapshot.reused)} of ${String(snapshot.pulls.length)} PRs reused from cache${sinceNote}).` +
      ` Comments scanned since ${snapshot.commentsSince}.${truncatedNote}`,
  )
  lines.push('')
  lines.push(
    'This is a snapshot, not a source of truth: recheck live PR state before acting. Reused rows carry their original observation time.',
  )
  lines.push('')
  lines.push(counts.join(' · '))
  for (const group of GROUPS) {
    const members = snapshot.pulls.filter((pull) => pull.group === group)
    lines.push('', `## ${GROUP_TITLES[group]} (${String(members.length)})`, '')
    if (!members.length) {
      lines.push('None.')
      continue
    }
    lines.push(
      '| PR | Title | Head | Base | Head age | CI run | Screenshot | Flags | Next action |',
    )
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const pull of members) {
      const ci = pull.ci
        ? `${pull.ci.runId ? `[${pull.ci.runId}](${pull.ci.url ?? ''})` : pull.ci.name} ${pull.ci.status === 'completed' ? (pull.ci.conclusion ?? '') : pull.ci.status}`
        : 'none'
      const observed = pull.reused ? ` (observed ${formatAge(pull.observedAt, now)} ago)` : ''
      lines.push(
        `| [#${String(pull.number)}](${pull.url}) | ${cell(pull.title)} | \`${shortSha(pull.headSha)}\` | ${cell(pull.baseRef)} \`${shortSha(pull.baseSha)}\` | ${formatAge(pull.headCommittedAt, now)} | ${cell(ci)}${observed} | ${pull.screenshot.state} | ${cell(pull.flags.join('; '))} | ${cell(pull.nextAction)} |`,
      )
    }
  }

  const stacks = new Map<string, PullRecord[]>()
  for (const pull of snapshot.pulls) {
    if (!pull.stack) continue
    const key = pull.stack.malformed ? `malformed:${String(pull.number)}` : pull.stack.digest
    stacks.set(key, [...(stacks.get(key) ?? []), pull])
  }
  lines.push('', `## Screenshot stacks (${String(stacks.size)})`, '')
  if (!stacks.size) lines.push('None.')
  for (const [key, members] of stacks) {
    const sample = members[0]?.stack
    if (!sample) continue
    if (sample.malformed) {
      lines.push(`- #${key.split(':')[1] ?? ''}: malformed declaration (${cell(sample.malformed)})`)
      continue
    }
    const open = new Set(snapshot.pulls.map((pull) => pull.number))
    const tip = snapshot.pulls.find((pull) => pull.number === sample.tip)
    const tipState = tip
      ? `${tip.draft ? 'draft' : 'open'}, ${tip.group}`
      : open.has(sample.tip)
        ? 'open'
        : 'not open'
    const memberCells = sample.members.map((member) => {
      const record = snapshot.pulls.find((pull) => pull.number === member.number)
      const pin = record ? (record.headSha === member.sha ? 'pin ok' : 'pin stale') : 'not open'
      return `#${String(member.number)} (${pin})`
    })
    lines.push(
      `- Tip #${String(sample.tip)} (${tipState}); members ${memberCells.join(', ')}; declared on ${members.map((pull) => `#${String(pull.number)}`).join(' ')}`,
    )
  }

  const links = snapshot.pulls.filter((pull) => pull.supersededBy.length || pull.supersedes.length)
  lines.push('', `## Supersession links (${String(links.length)})`, '')
  if (!links.length && !snapshot.closedBatches.length) lines.push('None.')
  for (const pull of links) {
    for (const entry of pull.supersededBy)
      lines.push(
        `- #${String(pull.number)} ← #${String(entry.number)} (${entry.state}, ${entry.kind}): ${cell(entry.evidence)}`,
      )
    for (const entry of pull.supersedes)
      lines.push(
        `- #${String(pull.number)} → #${String(entry.number)} (${entry.kind}${entry.pinnedSha ? `, pinned ${shortSha(entry.pinnedSha)}` : ''})`,
      )
  }
  for (const batch of snapshot.closedBatches) {
    lines.push(
      `- merged #${String(batch.number)} ${cell(batch.title)}${batch.mergeCommit ? ` (${shortSha(batch.mergeCommit)})` : ''} → ${batch.supersedes.map((entry) => `#${String(entry.number)}`).join(', ')}`,
    )
  }

  lines.push('', '## How signals are detected', '')
  lines.push(
    `- CI: the \`${CI_CHECK}\` check run on the head SHA; failing checks are completed check runs on that SHA with a failure, cancelled, timed-out, action-required or stale conclusion, so every failure named here is on the current head. A previous head's result appears only as context when the current head has no CI yet.`,
  )
  lines.push(
    `- Visual decision: the \`${SCREENSHOT_CONTEXT}\` commit status on the head SHA, or the \`${NEEDS_REVIEW_LABEL}\` label.`,
  )
  lines.push(
    `- Holds (conservative): a review whose latest state is changes requested; labels ${Object.keys(
      HOLD_LABELS,
    )
      .map((label) => `\`${label}\``)
      .join(
        ', ',
      )}; and PR body or human comment lines that name an independent security review, native or supported-platform acceptance, a product or owner decision, "do not merge", "blocking acceptance" or an upper-case HOLD. Bot summaries and quoted lines are ignored.`,
  )
  lines.push(
    '- Superseded: a PR whose body or a comment says "superseded by", "folded into", "recovered in" or "retired in" #N, or that an open or recently merged batch body pins by head SHA (`#N` followed by a 40-hex SHA) or names in a sentence with a recovery verb and no exclusion wording.',
  )
  lines.push(
    '- Stacks: the `copse-screenshot-stack` declaration parsed with the same rules as the stack gate; "pin stale" means the member head moved after it was pinned.',
  )
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI.

export function parseSince(value: string | undefined, now: Date): Date | null {
  if (!value) return null
  const relative = /^([1-9][0-9]*)([hd])$/.exec(value)
  if (relative) {
    const amount = Number(relative[1])
    return new Date(now.getTime() - amount * (relative[2] === 'h' ? 60 * 60 * 1000 : DAY))
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid --since value: ${value}`)
  return date
}

function positive(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error(`${name} must be a positive integer`)
  return number
}

export async function backlogSnapshot(
  args: string[],
  cwd = process.cwd(),
  api?: BacklogApi & { calls?(): number },
  now = new Date(),
): Promise<{ json: string; markdown: string; snapshot: Snapshot }> {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: 'string' },
      out: { type: 'string' },
      cache: { type: 'string' },
      'no-cache': { type: 'boolean' },
      since: { type: 'string' },
      'comment-days': { type: 'string' },
      limit: { type: 'string' },
      concurrency: { type: 'string' },
      quiet: { type: 'boolean' },
    },
  })
  const repository = values['repo'] ?? DEFAULT_REPOSITORY
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error(`Invalid --repo value: ${repository}`)
  const out = resolve(cwd, values['out'] ?? DEFAULT_OUT)
  const json = join(out, 'snapshot.json')
  const markdown = join(out, 'snapshot.md')
  const cachePath = values['cache'] ? resolve(cwd, values['cache']) : json
  let cache: Snapshot | null = null
  if (!values['no-cache']) {
    try {
      cache = parseSnapshot(readFileSync(cachePath, 'utf8'))
      if (cache && cache.repository !== repository) cache = null
    } catch {
      cache = null
    }
  }
  const since = parseSince(values['since'], now)
  if (since && !cache) console.error('No usable cache; --since ignored for this run')
  const snapshot = await collectBacklogSnapshot(api ?? createGhApi(cwd), {
    repository,
    now,
    cache,
    since: cache ? since : null,
    commentDays: positive(values['comment-days'], DEFAULT_COMMENT_DAYS, '--comment-days'),
    limit: positive(values['limit'], DEFAULT_LIMIT, '--limit'),
    concurrency: positive(values['concurrency'], DEFAULT_CONCURRENCY, '--concurrency'),
  })
  const rendered = renderBacklogMarkdown(snapshot)
  mkdirSync(out, { recursive: true })
  writeFileSync(json, `${JSON.stringify(snapshot, null, 2)}\n`)
  writeFileSync(markdown, rendered)
  if (!values['quiet']) console.log(rendered)
  console.error(
    `Wrote ${json} and ${markdown} (${String(snapshot.apiCalls)} API reads, ${String(snapshot.reused)} reused)`,
  )
  return { json, markdown, snapshot }
}

if (isDirectExecution(import.meta.url, 'backlog-snapshot')) {
  backlogSnapshot(process.argv.slice(2)).catch((error: unknown) => {
    console.error(errorMessage(error))
    process.exitCode = 1
  })
}
