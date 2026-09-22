// The measurement (docs/plans/copse-reviewer.md, P6 and B8): a review scored
// against a case's known defects. Precision on SURFACED findings is the
// metric — a finding that reaches a human and is wrong is the failure the
// whole design exists to prevent — with the reproducer rate and the tokens
// spent per confirmed finding beside it. Recall is reported and explicitly
// secondary: the plan trades it away on purpose.
//
// A case says what is wrong with its head, as anchors; the pipeline says what
// it found, as findings. An anchored hit requires both an overlapping source
// range and the case author's semantic claim signals. A Stage 0 regression is
// the one finding that cannot anchor at the defect (it anchors at the script
// that failed), so a defect may also declare which regression it causes, and
// a Stage 0 finding of that kind is a hit.
import { z } from 'zod'
import { decodeWithSchema } from '@copse/std/safe-json.ts'
import { ANCHOR_SLACK_LINES, claimTokens, sameFinding } from './cluster.ts'
import { FINDING_CLASSES, type Finding, type FindingClass } from './finding.ts'
import type { ReviewReport } from './stage5.ts'

export const REGRESSION_KINDS = ['build', 'typecheck', 'test'] as const
export type RegressionKind = (typeof REGRESSION_KINDS)[number]
/** Increment when the meaning of a scored hit changes. Baseline identity includes it. */
export const REVIEW_EVAL_VERSION = 2

/** The finding class Stage 0 mints for each regression kind. */
const REGRESSION_CLASS: Record<RegressionKind, FindingClass> = {
  build: 'build',
  typecheck: 'type',
  test: 'test',
}

export const truthAnchorSchema = z.object({
  /** Repo-relative, forward-slashed; lines are the head's. No lines means the whole file. */
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
})
export type TruthAnchor = z.infer<typeof truthAnchorSchema>

export const truthDefectSchema = z.object({
  id: z.string().min(1),
  class: z.enum(FINDING_CLASSES),
  /** Where a reviewer would anchor it; any one overlapping is a hit. */
  anchors: z.array(truthAnchorSchema).min(1),
  /** The Stage 0 checks this defect makes regress, when it does. */
  regressions: z.array(z.enum(REGRESSION_KINDS)).optional(),
  /**
   * AND-of-OR semantic signals for an anchored hit. Every outer group must
   * match one alternative; a multi-word alternative requires all its words.
   */
  claimSignals: z.array(z.array(z.string().min(1)).min(1)).min(1),
  note: z.string().optional(),
})
export type TruthDefect = z.infer<typeof truthDefectSchema>

/** `case.json` beside a case's `base/` and `head/` trees. */
export const reviewCaseSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  /** Empty for a clean change: every surfaced finding is then a false positive. */
  truth: z.array(truthDefectSchema),
})
export type ReviewCaseSpec = z.infer<typeof reviewCaseSchema>
export const decodeReviewCase = decodeWithSchema(reviewCaseSchema)

export interface DefectMatch {
  readonly defect: TruthDefect
  readonly how: 'anchor' | 'regression'
}

function normalisePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Line ranges overlap within `slack`; a range without lines covers the whole file. */
export function anchorsOverlap(
  a: { readonly startLine?: number | undefined; readonly endLine?: number | undefined },
  b: { readonly startLine?: number | undefined; readonly endLine?: number | undefined },
  slack = ANCHOR_SLACK_LINES,
): boolean {
  if (a.startLine === undefined || b.startLine === undefined) return true
  const aEnd = a.endLine ?? a.startLine
  const bEnd = b.endLine ?? b.startLine
  return a.startLine <= bEnd + slack && b.startLine <= aEnd + slack
}

/** Whether a claim satisfies a defect's hand-authored semantic signals. */
export function claimMatchesSignals(
  claim: string,
  signalGroups: readonly (readonly string[])[],
): boolean {
  const tokens = claimTokens(claim)
  return signalGroups.every((alternatives) =>
    alternatives.some((alternative) => {
      const required = claimTokens(alternative)
      return required.size > 0 && [...required].every((token) => tokens.has(token))
    }),
  )
}

/** The defect a surfaced finding hits, or `null` for a false positive. */
export function matchDefect(
  finding: Finding,
  truth: readonly TruthDefect[],
  slack = ANCHOR_SLACK_LINES,
): DefectMatch | null {
  const fromStage0 = finding.provenance.raisedBy.some((ref) => ref.kind === 'stage0')
  const path = normalisePath(finding.anchor.path)
  for (const defect of truth) {
    if (
      fromStage0 &&
      (defect.regressions ?? []).some((kind) => REGRESSION_CLASS[kind] === finding.class)
    ) {
      return { defect, how: 'regression' }
    }
    if (
      defect.anchors.some(
        (anchor) =>
          normalisePath(anchor.path) === path && anchorsOverlap(anchor, finding.anchor, slack),
      ) &&
      claimMatchesSignals(finding.claim, defect.claimSignals)
    ) {
      return { defect, how: 'anchor' }
    }
  }
  return null
}

export interface ScoredFinding {
  readonly findingId: string
  readonly path: string
  readonly claim: string
  readonly verdict: Finding['verdict']['status']
  readonly defectId: string | null
  readonly how: DefectMatch['how'] | null
  /** The finding's class equals the defect's; informational. */
  readonly classAgrees: boolean
  /** The first equivalent surfaced finding, when this one is a duplicate. */
  readonly duplicateOf: string | null
}

export interface CaseScore {
  readonly caseId: string
  readonly surfaced: number
  readonly truePositives: number
  readonly falsePositives: number
  /** Repeated surfaced findings excluded from both precision counts. */
  readonly duplicates: number
  readonly defects: number
  /** Distinct defects at least one surfaced finding hit. */
  readonly found: number
  /** Unique surfaced findings with a confirmed verdict (Stage 0 or a reproducer). */
  readonly confirmed: number
  /** Unique surfaced findings carrying reproducer evidence. */
  readonly confirmedByReproducer: number
  readonly findings: readonly ScoredFinding[]
}

/** Score one review against its case's truth. Only surfaced findings count; the appendix and the refuted do not reach a human. */
export function scoreCase(
  caseId: string,
  report: ReviewReport,
  truth: readonly TruthDefect[],
): CaseScore {
  interface FindingGroup {
    readonly firstFindingId: string
    readonly representative: Finding
    readonly match: DefectMatch | null
    confirmed: boolean
    reproduced: boolean
  }
  const groups: FindingGroup[] = []
  const matchedGroups = new Map<string, FindingGroup>()
  const findings: ScoredFinding[] = []
  for (const finding of report.findings) {
    const match = matchDefect(finding, truth)
    const matchKey =
      match === null
        ? null
        : JSON.stringify(
            match.how === 'anchor'
              ? ['anchor', match.defect.id]
              : ['regression', match.defect.id, finding.class],
          )
    const existing =
      matchKey === null
        ? groups.find((group) => group.match === null && sameFinding(group.representative, finding))
        : matchedGroups.get(matchKey)
    const reproduced = finding.evidence.some((evidence) => evidence.kind === 'reproducer')
    const confirmed = finding.verdict.status === 'confirmed'
    if (existing === undefined) {
      const group: FindingGroup = {
        firstFindingId: finding.id,
        representative: finding,
        match,
        confirmed,
        reproduced,
      }
      groups.push(group)
      if (matchKey !== null) matchedGroups.set(matchKey, group)
    } else {
      existing.confirmed ||= confirmed
      existing.reproduced ||= reproduced
    }
    findings.push({
      findingId: finding.id,
      path: finding.anchor.path,
      claim: finding.claim,
      verdict: finding.verdict.status,
      defectId: match?.defect.id ?? null,
      how: match?.how ?? null,
      classAgrees: match !== null && match.defect.class === finding.class,
      duplicateOf: existing?.firstFindingId ?? null,
    })
  }
  const truePositives = groups.filter((group) => group.match !== null).length
  const falsePositives = groups.length - truePositives
  return {
    caseId,
    surfaced: findings.length,
    truePositives,
    falsePositives,
    duplicates: findings.length - groups.length,
    defects: truth.length,
    found: new Set(groups.flatMap((group) => (group.match === null ? [] : [group.match.defect.id])))
      .size,
    confirmed: groups.filter((group) => group.confirmed).length,
    confirmedByReproducer: groups.filter((group) => group.reproduced).length,
    findings,
  }
}

export interface BenchUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

/** Every token the report's model turns spent: reviewers and verification. */
export function reportUsage(report: ReviewReport): BenchUsage {
  let inputTokens = 0
  let outputTokens = 0
  for (const review of report.reviews) {
    inputTokens += review.usage.inputTokens
    outputTokens += review.usage.outputTokens
  }
  if (report.verification !== null) {
    inputTokens += report.verification.usage.inputTokens
    outputTokens += report.verification.usage.outputTokens
  }
  return { inputTokens, outputTokens }
}

export interface BenchMetrics {
  readonly cases: number
  readonly surfaced: number
  readonly truePositives: number
  readonly falsePositives: number
  readonly duplicates: number
  /** The metric. `null` when nothing was surfaced. */
  readonly precision: number | null
  /** Wilson score lower bound for precision, using a two-sided 95% interval. */
  readonly precisionLowerBound95: number | null
  readonly defects: number
  readonly found: number
  /** Secondary, by design. `null` when the corpus declares no defect. */
  readonly recall: number | null
  readonly confirmed: number
  readonly confirmedByReproducer: number
  /** Unique surfaced findings a reproducer confirmed, over unique findings. */
  readonly reproducerRate: number | null
  readonly inputTokens: number
  readonly outputTokens: number
  /** Cost per confirmed finding, in the unit every provider reports. */
  readonly outputTokensPerConfirmed: number | null
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 1000
}

/** Wilson score lower bound using z=1.96 (the lower edge of a two-sided 95% interval). */
export function wilsonLowerBound95(successes: number, total: number): number | null {
  if (total === 0) return null
  const z = 1.959963984540054
  const zSquared = z * z
  const proportion = successes / total
  return (
    (proportion +
      zSquared / (2 * total) -
      z * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * total)) / total)) /
    (1 + zSquared / total)
  )
}

export function aggregateScores(
  scores: readonly CaseScore[],
  usages: readonly BenchUsage[],
): BenchMetrics {
  const sum = (pick: (score: CaseScore) => number): number =>
    scores.reduce((total, score) => total + pick(score), 0)
  const surfaced = sum((score) => score.surfaced)
  const truePositives = sum((score) => score.truePositives)
  const falsePositives = sum((score) => score.falsePositives)
  const duplicates = sum((score) => score.duplicates)
  const evaluated = truePositives + falsePositives
  const defects = sum((score) => score.defects)
  const found = sum((score) => score.found)
  const confirmed = sum((score) => score.confirmed)
  const confirmedByReproducer = sum((score) => score.confirmedByReproducer)
  const inputTokens = usages.reduce((total, usage) => total + usage.inputTokens, 0)
  const outputTokens = usages.reduce((total, usage) => total + usage.outputTokens, 0)
  return {
    cases: scores.length,
    surfaced,
    truePositives,
    falsePositives,
    duplicates,
    precision: ratio(truePositives, evaluated),
    precisionLowerBound95: wilsonLowerBound95(truePositives, evaluated),
    defects,
    found,
    recall: ratio(found, defects),
    confirmed,
    confirmedByReproducer,
    reproducerRate: ratio(confirmedByReproducer, evaluated),
    inputTokens,
    outputTokens,
    outputTokensPerConfirmed: confirmed === 0 ? null : Math.round(outputTokens / confirmed),
  }
}
