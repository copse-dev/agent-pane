// The risk-rating eval (benchmarks/review-risk/README.md): how well the Low /
// Medium / High level in the pull request summary (`pr-summary.ts`) matches
// what actually happened to the change after it merged.
//
// The truth is outcome-based, not surface-based. Each case carries evidence
// items the collector found — a revert, a later pull request or issue that
// names the change, a fix-titled pull request that touched the same source
// file soon after, `main` CI going red on the merge commit — and a person's
// verdict on each: the later change repaired a regression this one caused, it
// completed something this one left incomplete, or it is unrelated. A case with
// an unverified item has no truth yet and is not scored.
//
// Outcomes are a noisy proxy for ex-ante risk: a risky change handled well
// leaves no trace. So the report separates the two errors. A Low or Medium
// rating on a change that caused a regression is a clear miss; a High rating on
// a change with a clean history is only weak evidence of over-rating, and is
// read beside how the rating tracks the change's size and shape.
import { z } from 'zod'
import { decodeWithSchema } from '@copse/std/safe-json.ts'
import { SUMMARY_RISKS, type SummaryRisk } from './pr-summary.ts'
import { bareLine, findBotBlock } from './summary-block.ts'

/** Increment when the labelling rules or the meaning of a scored cell change. */
export const RISK_EVAL_VERSION = 1

export const EVIDENCE_SOURCES = ['revert', 'reference', 'fix-overlap', 'main-ci'] as const
/**
 * A person's ruling on one evidence item (the rules are in
 * benchmarks/review-risk/README.md):
 * - `regression`: something that worked before stopped working because of
 *   this change — product behaviour, data, a security property, or a CI,
 *   deploy or release pipeline.
 * - `cosmetic`: a regression visible only as copy or styling, with no loss of
 *   function.
 * - `incomplete`: the change needed a correction to finish its own intent, or
 *   left only the test suite red on `main` (a stale expectation or reference).
 * - `unrelated`: the later change mentions this one without blaming it.
 */
export const EVIDENCE_VERDICTS = [
  'regression',
  'cosmetic',
  'incomplete',
  'unrelated',
  'unverified',
] as const
export type EvidenceVerdict = (typeof EVIDENCE_VERDICTS)[number]
export const CASE_COHORTS = ['rated', 'mature', 'case-study'] as const

/** The high-risk clauses of `summarySystemPrompt`'s rubric, as the model tends to cite them. */
export const RUBRIC_CLAUSES = [
  'security',
  'permissions-sandboxing',
  'auth-secrets',
  'persisted-data',
  'process-ipc',
  'concurrency',
  'dependency-build',
  'cross-cutting',
] as const
export type RubricClause = (typeof RUBRIC_CLAUSES)[number]

const evidenceSchema = z.object({
  source: z.enum(EVIDENCE_SOURCES),
  /** `#123` for a pull request or issue, a commit SHA for a revert or CI run. */
  ref: z.string().min(1),
  title: z.string(),
  daysAfterMerge: z.number(),
  /** The text around the mention, so a verdict can be checked without a network. */
  excerpt: z.string(),
  verdict: z.enum(EVIDENCE_VERDICTS),
  note: z.string().optional(),
})
export type RiskEvidence = z.infer<typeof evidenceSchema>

const postedRatingSchema = z.object({
  /** The level shown, after the evidence floor. */
  risk: z.enum(SUMMARY_RISKS),
  /** The model's own level, before a review's findings raised it. */
  modelRisk: z.enum(SUMMARY_RISKS),
  reason: z.string(),
  raisedBecause: z.string().nullable(),
  commit: z.string().nullable(),
  /** Issues the accompanying review reported; null for a summary-only block. */
  reviewIssues: z.number().int().nonnegative().nullable(),
})
export type PostedRating = z.infer<typeof postedRatingSchema>

const riskCaseSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['merged', 'open', 'closed']),
  mergedAt: z.string().nullable(),
  cohort: z.enum(CASE_COHORTS),
  /** The landed commit's parent when the change merged, else the pull request's base. */
  base: z.string().regex(/^[0-9a-f]{40}$/),
  /** What the summary step reads: the commit a merged change landed as, else the pull request's head. */
  head: z.string().regex(/^[0-9a-f]{40}$/),
  size: z.object({
    files: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    /** Added plus deleted lines outside tests, docs, fixtures and lockfiles. */
    sourceLines: z.number().int().nonnegative(),
    /** The deleted lines within `sourceLines`: how much existing code the change rewrote. */
    sourceDeletions: z.number().int().nonnegative(),
  }),
  /** The rubric's high-risk surfaces the changed paths touch (`pathSurfaces`). */
  surfaces: z.array(z.enum(RUBRIC_CLAUSES)),
  areas: z.array(z.string()),
  posted: postedRatingSchema.nullable(),
  /** Days of history after the merge the evidence covers, capped at the window. */
  observedDays: z.number().nonnegative(),
  evidence: z.array(evidenceSchema),
  note: z.string().optional(),
})
export type RiskCase = z.infer<typeof riskCaseSchema>

const riskCorpusSchema = z.object({
  version: z.literal(RISK_EVAL_VERSION),
  repo: z.string(),
  collectedAt: z.string(),
  /** Days after the merge in which a later change counts as evidence. */
  windowDays: z.number().int().positive(),
  cases: z.array(riskCaseSchema),
})
export type RiskCorpus = z.infer<typeof riskCorpusSchema>
export const decodeRiskCorpus = decodeWithSchema(riskCorpusSchema)

const ratingSchema = z.object({
  number: z.number().int().positive(),
  risk: z.enum(SUMMARY_RISKS).optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
})
export type RiskRating = z.infer<typeof ratingSchema>

const ratingSetSchema = z.object({
  kind: z.literal('copse-risk-ratings'),
  /** `posted` for the levels already in pull request descriptions, else a run's label. */
  label: z.string().min(1),
  /** Where the levels came from: `posted`, or the provider and model that produced them. */
  source: z.string().min(1),
  /** The reviewer revision (commit) that produced the levels; null for posted ones. */
  reviewerRevision: z.string().nullable(),
  /** A digest of the summary system prompt the run used; null for posted ones. */
  promptDigest: z.string().nullable(),
  generatedAt: z.string(),
  ratings: z.array(ratingSchema),
})
export type RiskRatingSet = z.infer<typeof ratingSetSchema>
export const decodeRiskRatingSet = decodeWithSchema(ratingSetSchema)

/**
 * The rating in the summary block Copse Reviewer wrote into `body`, or null.
 * Only a block the tool still owns counts (`findBotBlock`), so an author's
 * edited or quoted block is not read as the tool's rating.
 */
export function parsePostedRating(body: string | null): PostedRating | null {
  const lines = (body ?? '').split('\n')
  const found = findBotBlock(lines)
  if (found === null) return null
  const block = lines.slice(found.start + 1, found.end).map(bareLine)
  const level = /^> \*\*(Low|Medium|High) risk\*\*$/.exec(block[3] ?? '')?.[1]?.toLowerCase()
  const risk = SUMMARY_RISKS.find((candidate) => candidate === level)
  if (risk === undefined) return null
  const reason = (block[4] ?? '').replace(/^> /, '')
  let raisedBecause: string | null = null
  const raised = block.find((line) => line.startsWith('> Raised to '))
  if (raised !== undefined) {
    raisedBecause = /because (.*)\.$/.exec(raised)?.[1] ?? raised.replace(/^> /, '')
  }
  let commit: string | null = null
  let reviewIssues: number | null = null
  for (const line of block) {
    const footer =
      /^> <sup>Summary by Copse Reviewer(?: for commit ([0-9a-f]{12}))?\.(.*)<\/sup>$/.exec(line)
    if (footer === null) continue
    commit = footer[1] ?? null
    const tail = footer[2] ?? ''
    if (tail.includes('The review reported no issues.')) reviewIssues = 0
    const count = /The review reported (\d+) issues?\./.exec(tail)
    if (count !== null) reviewIssues = Number(count[1])
  }
  return {
    risk,
    modelRisk: raisedBecause === null ? risk : modelRiskBeforeFloor(risk, raisedBecause),
    reason,
    raisedBecause,
    commit,
    reviewIssues,
  }
}

/**
 * What the model said before `applyEvidenceFloor` raised it. A raise to High
 * from a Low or a Medium cannot be told apart from the block alone; Medium is
 * the conservative reading (it is the smaller correction).
 */
function modelRiskBeforeFloor(shown: SummaryRisk, raisedBecause: string): SummaryRisk {
  if (shown === 'medium') return 'low'
  return /high-severity/.test(raisedBecause) ? 'medium' : shown
}

export type TruthLevel = SummaryRisk
export type CaseTruth =
  | { readonly labelled: true; readonly level: TruthLevel; readonly because: readonly string[] }
  | { readonly labelled: false; readonly pending: readonly string[] }

/**
 * The outcome-based truth for one merged case. An unmerged change has no
 * outcome window, and any unverified evidence leaves a merged change
 * unlabelled. A functional regression the change caused is High; a cosmetic
 * regression, or a correction to something it left incomplete, is Medium;
 * nothing, or only unrelated mentions, is Low.
 */
export function caseTruth(riskCase: RiskCase): CaseTruth {
  if (riskCase.state !== 'merged') return { labelled: false, pending: ['not merged'] }
  if (riskCase.mergedAt === null) {
    return { labelled: false, pending: ['missing merge timestamp'] }
  }
  const pending = riskCase.evidence
    .filter((item) => item.verdict === 'unverified')
    .map((item) => `${item.source} ${item.ref}`)
  if (pending.length > 0) return { labelled: false, pending }
  const because = (verdict: EvidenceVerdict): string[] =>
    riskCase.evidence
      .filter((item) => item.verdict === verdict)
      .map((item) => `${item.source} ${item.ref}`)
  const regressions = because('regression')
  if (regressions.length > 0) return { labelled: true, level: 'high', because: regressions }
  const medium = [...because('cosmetic'), ...because('incomplete')]
  if (medium.length > 0) return { labelled: true, level: 'medium', because: medium }
  return { labelled: true, level: 'low', because: [] }
}

const CLAUSE_PATTERNS: Record<RubricClause, RegExp> = {
  security: /\b(secur\w*|trust\w*|untrusted|injection|csp|exfiltrat\w*|attack\w*|vulnerab\w*)\b/i,
  'permissions-sandboxing':
    /\b(permission\w*|sandbox\w*|approv\w*|escalat\w*|allowlist\w*|policy|policies|containment|guarded|gate)\b/i,
  'auth-secrets': /\b(auth\w*|oauth|token\w*|secret\w*|credential\w*|login|encrypt\w*|keychain)\b/i,
  'persisted-data':
    /\b(persist\w*|migrat\w*|stored|storage|store|schema|database|on-disk|settings file|thread store|saved)\b/i,
  'process-ipc':
    /\b(ipc|renderer-to-main|main-process|main process|preload|process boundar\w*|child process\w*|spawn\w*|protocol|subprocess\w*)\b/i,
  concurrency: /\b(concurren\w*|race\w*|parallel\w*|lock\w*|timing|ordering|async\w*)\b/i,
  'dependency-build':
    /\b(dependenc\w*|build\w*|package\w*|lockfile|ci|workflow\w*|release\w*|packag\w*|bundl\w*|toolchain|electron-builder|github actions)\b/i,
  'cross-cutting': /\b(cross-cutting|broad\w*|wide-ranging|many (files|areas|surfaces)|across)\b/i,
}

/** The rubric clauses a rating's one-sentence reason cites (a keyword match, not a parse). */
export function rubricClauses(reason: string): RubricClause[] {
  return RUBRIC_CLAUSES.filter((clause) => CLAUSE_PATTERNS[clause].test(reason))
}

const PATH_PATTERNS: Record<RubricClause, RegExp | null> = {
  security: /(^|\/)(security|shell-guard|pii|redact\w*|csp|trust\w*)(\/|[.-])/i,
  'permissions-sandboxing': /(sandbox|permission|approval|seatbelt|escalat|allowlist|policy)/i,
  // Not a bare `token`: design tokens (`tokens.css`) are styling.
  'auth-secrets':
    /(oauth|(^|[/._-])auth([/._-]|$)|secret|credential|keychain|encrypt|safe-storage|api-key|access-token)/i,
  'persisted-data': /(storage|thread-store|store-kit|migrat|persist|settings-schema|config-store)/i,
  'process-ipc':
    /(^|\/)(ipc[\w-]*|preload|api-protocol|[\w-]*-ipc|child-process|process-\w+)(\/|\.)/i,
  concurrency: null,
  'dependency-build':
    /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.nvmrc|Makefile|electron-builder[\w.-]*|tsconfig[\w.-]*\.json)$|^\.github\/|^scripts\/(build|release|ci)/,
  'cross-cutting': null,
}

/** Four or more areas: the rubric's "broad cross-cutting change", measured by path. */
export const CROSS_CUTTING_AREAS = 4

/**
 * The rubric's high-risk surfaces a change touches, judged from its source
 * paths alone (tests, docs and fixtures excluded by the caller). This is what
 * a purely surface-based rubric would see; concurrency has no path signature.
 */
export function pathSurfaces(
  sourcePaths: readonly string[],
  areas: readonly string[],
): RubricClause[] {
  return RUBRIC_CLAUSES.filter((clause) => {
    if (clause === 'cross-cutting') return areas.length >= CROSS_CUTTING_AREAS
    const pattern = PATH_PATTERNS[clause]
    return pattern !== null && sourcePaths.some((path) => pattern.test(path))
  })
}

export const SIZE_BUCKETS = ['small', 'medium', 'large'] as const
export type SizeBucket = (typeof SIZE_BUCKETS)[number]

/** Source lines changed: under 100 is small, under 500 medium, else large. */
export function sizeBucket(sourceLines: number): SizeBucket {
  if (sourceLines < 100) return 'small'
  if (sourceLines < 500) return 'medium'
  return 'large'
}

const RANK: Record<SummaryRisk, number> = { low: 0, medium: 1, high: 2 }

type Matrix = Record<SummaryRisk, Record<SummaryRisk, number>>

function emptyMatrix(): Matrix {
  return {
    low: { low: 0, medium: 0, high: 0 },
    medium: { low: 0, medium: 0, high: 0 },
    high: { low: 0, medium: 0, high: 0 },
  }
}

export interface ScoredCase {
  readonly number: number
  readonly title: string
  readonly cohort: RiskCase['cohort']
  readonly mature: boolean
  readonly predicted: SummaryRisk
  readonly truth: TruthLevel
  readonly because: readonly string[]
  readonly reason: string
  readonly clauses: readonly RubricClause[]
  readonly size: SizeBucket
  readonly sourceLines: number
}

export interface CalibrationCounts {
  readonly scored: number
  /** `matrix[predicted][truth]`. */
  readonly matrix: Matrix
  readonly exact: number
  readonly over: number
  readonly under: number
  /** Changes that caused a regression but were rated below High. */
  readonly missedRegressions: number
  readonly regressions: number
}

export interface ClauseStat {
  readonly clause: RubricClause
  readonly cited: number
  readonly ratedHigh: number
  readonly overRated: number
  readonly underRated: number
  readonly smallChanges: number
}

export interface RiskScore {
  readonly evalVersion: number
  readonly label: string
  readonly source: string
  readonly windowDays: number
  readonly cases: readonly ScoredCase[]
  readonly unrated: readonly number[]
  readonly unlabelled: readonly { readonly number: number; readonly pending: readonly string[] }[]
  readonly all: CalibrationCounts
  readonly mature: CalibrationCounts
  readonly clauses: readonly ClauseStat[]
  /** `bySize[bucket][predicted]`, over every scored case. */
  readonly bySize: Record<SizeBucket, Record<SummaryRisk, number>>
  /** `truthBySize[bucket][truth]`: whether size itself predicts outcomes. */
  readonly truthBySize: Record<SizeBucket, Record<TruthLevel, number>>
}

function calibration(cases: readonly ScoredCase[]): CalibrationCounts {
  const matrix = emptyMatrix()
  let exact = 0
  let over = 0
  let under = 0
  let missedRegressions = 0
  let regressions = 0
  for (const scored of cases) {
    matrix[scored.predicted][scored.truth] += 1
    const delta = RANK[scored.predicted] - RANK[scored.truth]
    if (delta === 0) exact += 1
    else if (delta > 0) over += 1
    else under += 1
    if (scored.truth === 'high') {
      regressions += 1
      if (scored.predicted !== 'high') missedRegressions += 1
    }
  }
  return { scored: cases.length, matrix, exact, over, under, missedRegressions, regressions }
}

function levelCounts(): Record<SummaryRisk, number> {
  return { low: 0, medium: 0, high: 0 }
}

/**
 * Score one set of ratings against the corpus's truth. Cases without a rating
 * or without a verified truth are listed, not scored.
 */
export function scoreRatings(corpus: RiskCorpus, ratings: RiskRatingSet): RiskScore {
  const byNumber = new Map(ratings.ratings.map((rating) => [rating.number, rating]))
  const cases: ScoredCase[] = []
  const unrated: number[] = []
  const unlabelled: { number: number; pending: readonly string[] }[] = []
  for (const riskCase of corpus.cases) {
    const rating = byNumber.get(riskCase.number)
    if (rating?.risk === undefined) {
      unrated.push(riskCase.number)
      continue
    }
    const truth = caseTruth(riskCase)
    if (!truth.labelled) {
      unlabelled.push({ number: riskCase.number, pending: truth.pending })
      continue
    }
    const reason = rating.reason ?? ''
    cases.push({
      number: riskCase.number,
      title: riskCase.title,
      cohort: riskCase.cohort,
      mature: riskCase.state === 'merged' && riskCase.observedDays >= corpus.windowDays,
      predicted: rating.risk,
      truth: truth.level,
      because: truth.because,
      reason,
      clauses: rubricClauses(reason),
      size: sizeBucket(riskCase.size.sourceLines),
      sourceLines: riskCase.size.sourceLines,
    })
  }
  const clauses = RUBRIC_CLAUSES.map((clause): ClauseStat => {
    const citing = cases.filter((scored) => scored.clauses.includes(clause))
    return {
      clause,
      cited: citing.length,
      ratedHigh: citing.filter((scored) => scored.predicted === 'high').length,
      overRated: citing.filter((scored) => RANK[scored.predicted] > RANK[scored.truth]).length,
      underRated: citing.filter((scored) => RANK[scored.predicted] < RANK[scored.truth]).length,
      smallChanges: citing.filter((scored) => scored.size === 'small').length,
    }
  })
  const bySize: Record<SizeBucket, Record<SummaryRisk, number>> = {
    small: levelCounts(),
    medium: levelCounts(),
    large: levelCounts(),
  }
  const truthBySize: Record<SizeBucket, Record<TruthLevel, number>> = {
    small: levelCounts(),
    medium: levelCounts(),
    large: levelCounts(),
  }
  for (const scored of cases) {
    bySize[scored.size][scored.predicted] += 1
    truthBySize[scored.size][scored.truth] += 1
  }
  return {
    evalVersion: RISK_EVAL_VERSION,
    label: ratings.label,
    source: ratings.source,
    windowDays: corpus.windowDays,
    cases,
    unrated,
    unlabelled,
    all: calibration(cases),
    mature: calibration(cases.filter((scored) => scored.mature)),
    clauses,
    bySize,
    truthBySize,
  }
}

/** The ratings already posted in the corpus's pull request descriptions, as a rating set. */
export function postedRatings(corpus: RiskCorpus): RiskRatingSet {
  return {
    kind: 'copse-risk-ratings',
    label: 'posted',
    source: 'posted',
    reviewerRevision: null,
    promptDigest: null,
    generatedAt: corpus.collectedAt,
    ratings: corpus.cases.flatMap((riskCase) =>
      riskCase.posted === null
        ? []
        : [{ number: riskCase.number, risk: riskCase.posted.risk, reason: riskCase.posted.reason }],
    ),
  }
}

function percent(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${String(Math.round((part / whole) * 100))}%`
}

function matrixTable(counts: CalibrationCounts): string[] {
  const lines = [
    '| predicted ↓ / truth → | low | medium | high |',
    '| --------------------- | --: | -----: | ---: |',
  ]
  for (const predicted of SUMMARY_RISKS) {
    const row = counts.matrix[predicted]
    lines.push(
      `| ${predicted} | ${String(row.low)} | ${String(row.medium)} | ${String(row.high)} |`,
    )
  }
  return lines
}

function calibrationLines(title: string, counts: CalibrationCounts): string[] {
  return [
    `### ${title} (${String(counts.scored)} cases)`,
    '',
    ...matrixTable(counts),
    '',
    `- Exact: ${String(counts.exact)} (${percent(counts.exact, counts.scored)}); over-rated: ${String(counts.over)} (${percent(counts.over, counts.scored)}); under-rated: ${String(counts.under)} (${percent(counts.under, counts.scored)}).`,
    `- Changes that caused a regression: ${String(counts.regressions)}; rated below High: ${String(counts.missedRegressions)}.`,
    '',
  ]
}

/** The score as Markdown, for the corpus README and the pull request. */
export function renderRiskReport(score: RiskScore): string {
  const lines = [
    `## Risk-rating calibration: ${score.label}`,
    '',
    `Ratings from ${score.source}; truth from verified outcomes within ${String(score.windowDays)} days of merge (eval v${String(score.evalVersion)}).`,
    `Scored ${String(score.cases.length)}; unrated ${String(score.unrated.length)}; without a truth yet (unmerged or awaiting verdicts) ${String(score.unlabelled.length)}.`,
    '',
    ...calibrationLines('All scored cases', score.all),
    ...calibrationLines(`Mature cases (full ${String(score.windowDays)}-day window)`, score.mature),
    '### Rating by change size (source lines)',
    '',
    '| size | rated low | rated medium | rated high | truth low | truth medium | truth high |',
    '| ---- | --------: | -----------: | ---------: | --------: | -----------: | ---------: |',
  ]
  for (const size of SIZE_BUCKETS) {
    const rated = score.bySize[size]
    const truth = score.truthBySize[size]
    lines.push(
      `| ${size} | ${String(rated.low)} | ${String(rated.medium)} | ${String(rated.high)} | ${String(truth.low)} | ${String(truth.medium)} | ${String(truth.high)} |`,
    )
  }
  lines.push(
    '',
    '### High-risk rubric clauses cited in the reason',
    '',
    '| clause | cited | rated high | over-rated | under-rated | small changes |',
    '| ------ | ----: | ---------: | ---------: | ----------: | ------------: |',
  )
  for (const stat of [...score.clauses].sort((a, b) => b.cited - a.cited)) {
    lines.push(
      `| ${stat.clause} | ${String(stat.cited)} | ${String(stat.ratedHigh)} | ${String(stat.overRated)} | ${String(stat.underRated)} | ${String(stat.smallChanges)} |`,
    )
  }
  lines.push('', '### Cases', '', '| PR | rated | truth | size | clauses | outcome |')
  lines.push('| -- | ----- | ----- | ---- | ------- | ------- |')
  for (const scored of [...score.cases].sort((a, b) => a.number - b.number)) {
    const mark =
      RANK[scored.predicted] > RANK[scored.truth]
        ? ' ↑'
        : RANK[scored.predicted] < RANK[scored.truth]
          ? ' ↓'
          : ''
    lines.push(
      `| #${String(scored.number)} | ${scored.predicted}${mark} | ${scored.truth}${scored.mature ? '' : ' (immature)'} | ${String(scored.sourceLines)} | ${scored.clauses.join(', ') || '—'} | ${scored.because.join('; ') || '—'} |`,
    )
  }
  return `${lines.join('\n')}\n`
}

/** Rewritten when deletions are at least this share of the source lines changed. */
export const REWRITE_SHARE = 0.25

export interface OutcomeRow {
  readonly label: string
  readonly cases: number
  readonly truth: Record<TruthLevel, number>
}

export interface OutcomeProfile {
  readonly scope: string
  readonly cases: number
  readonly rows: readonly OutcomeRow[]
}

/**
 * How outcomes split by what a change touches and how big it is, over every
 * labelled merged case (`matureOnly`: only those with a full window). This
 * needs no rater: it asks whether the rubric's surfaces, size, or rewriting
 * existing code actually predict a regression in this repository.
 */
export function outcomeProfile(corpus: RiskCorpus, matureOnly: boolean): OutcomeProfile {
  const labelled = corpus.cases.flatMap((riskCase) => {
    if (riskCase.state !== 'merged') return []
    if (matureOnly && riskCase.observedDays < corpus.windowDays) return []
    const truth = caseTruth(riskCase)
    return truth.labelled ? [{ riskCase, level: truth.level }] : []
  })
  const row = (label: string, keep: (riskCase: RiskCase) => boolean): OutcomeRow => {
    const truth = levelCounts()
    let cases = 0
    for (const entry of labelled) {
      if (!keep(entry.riskCase)) continue
      cases += 1
      truth[entry.level] += 1
    }
    return { label, cases, truth }
  }
  const rewrites = (riskCase: RiskCase): boolean =>
    riskCase.size.sourceLines > 0 &&
    riskCase.size.sourceDeletions / riskCase.size.sourceLines >= REWRITE_SHARE
  const rows: OutcomeRow[] = [row('all', () => true)]
  rows.push(row('touches no high-risk surface', (riskCase) => riskCase.surfaces.length === 0))
  rows.push(row('touches a high-risk surface', (riskCase) => riskCase.surfaces.length > 0))
  for (const clause of RUBRIC_CLAUSES) {
    rows.push(row(`  ${clause}`, (riskCase) => riskCase.surfaces.includes(clause)))
  }
  for (const size of SIZE_BUCKETS) {
    rows.push(
      row(`${size} (source lines)`, (riskCase) => sizeBucket(riskCase.size.sourceLines) === size),
    )
  }
  rows.push(row('mostly additive', (riskCase) => !rewrites(riskCase)))
  rows.push(row(`rewrites existing code (≥${String(REWRITE_SHARE * 100)}% deletions)`, rewrites))
  const small = (riskCase: RiskCase): boolean => sizeBucket(riskCase.size.sourceLines) === 'small'
  rows.push(
    row(
      'touches a surface, under 100 source lines',
      (riskCase) => riskCase.surfaces.length > 0 && small(riskCase),
    ),
  )
  rows.push(
    row(
      'touches a surface, 100 or more source lines',
      (riskCase) => riskCase.surfaces.length > 0 && !small(riskCase),
    ),
  )
  return {
    scope: matureOnly ? `mature (full ${String(corpus.windowDays)}-day window)` : 'all merged',
    cases: labelled.length,
    rows,
  }
}

/** The outcome profile as a Markdown table. */
export function renderOutcomeProfile(profile: OutcomeProfile): string {
  const lines = [
    `### What predicts outcomes: ${profile.scope}, ${String(profile.cases)} cases (no rater involved)`,
    '',
    '| changes that… | cases | truth low | truth medium | truth high | medium or high |',
    '| ------------- | ----: | --------: | -----------: | ---------: | -------------: |',
  ]
  for (const entry of profile.rows) {
    if (entry.cases === 0) continue
    const bad = entry.truth.medium + entry.truth.high
    lines.push(
      `| ${entry.label} | ${String(entry.cases)} | ${String(entry.truth.low)} | ${String(entry.truth.medium)} | ${String(entry.truth.high)} | ${percent(bad, entry.cases)} |`,
    )
  }
  return `${lines.join('\n')}\n`
}

export interface RatingDelta {
  readonly number: number
  readonly truth: TruthLevel
  readonly before: SummaryRisk
  readonly after: SummaryRisk
}

/** Case-by-case changes between two scores of the same corpus. */
export function compareScores(before: RiskScore, after: RiskScore): RatingDelta[] {
  const afterByNumber = new Map(after.cases.map((scored) => [scored.number, scored]))
  const deltas: RatingDelta[] = []
  for (const scored of before.cases) {
    const other = afterByNumber.get(scored.number)
    if (other === undefined || other.predicted === scored.predicted) continue
    deltas.push({
      number: scored.number,
      truth: scored.truth,
      before: scored.predicted,
      after: other.predicted,
    })
  }
  return deltas
}
