// The measurement (docs/plans/copse-reviewer.md, P6 and B8): a review scored
// against a case's known defects. Precision on SURFACED findings is the
// metric — a finding that reaches a human and is wrong is the failure the
// whole design exists to prevent — with the reproducer rate and the tokens
// spent per confirmed finding beside it. Recall is reported and explicitly
// secondary: the plan trades it away on purpose.
//
// A case says what is wrong with its head, as anchors; the pipeline says what
// it found, as findings. The two meet the way Stage 3 clusters candidates:
// same path, line ranges overlapping within the same slack. A Stage 0
// regression is the one finding that cannot anchor at the defect (it anchors
// at the script that failed), so a defect may also declare which regression
// it causes, and a Stage 0 finding of that kind is a hit.
import { z } from 'zod'
import { decodeWithSchema } from '@copse/std/safe-json.ts'
import { ANCHOR_SLACK_LINES } from './cluster.ts'
import { FINDING_CLASSES, type Finding, type FindingClass } from './finding.ts'
import type { ReviewReport } from './stage5.ts'

export const REGRESSION_KINDS = ['build', 'typecheck', 'test'] as const
export type RegressionKind = (typeof REGRESSION_KINDS)[number]

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
      )
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
}

export interface CaseScore {
  readonly caseId: string
  readonly surfaced: number
  readonly truePositives: number
  readonly falsePositives: number
  readonly defects: number
  /** Distinct defects at least one surfaced finding hit. */
  readonly found: number
  /** Surfaced findings with a confirmed verdict (Stage 0 or a reproducer). */
  readonly confirmed: number
  /** Surfaced findings carrying reproducer evidence. */
  readonly confirmedByReproducer: number
  readonly findings: readonly ScoredFinding[]
}

/** Score one review against its case's truth. Only surfaced findings count; the appendix and the refuted do not reach a human. */
export function scoreCase(
  caseId: string,
  report: ReviewReport,
  truth: readonly TruthDefect[],
): CaseScore {
  const findings = report.findings.map((finding): ScoredFinding => {
    const match = matchDefect(finding, truth)
    return {
      findingId: finding.id,
      path: finding.anchor.path,
      claim: finding.claim,
      verdict: finding.verdict.status,
      defectId: match?.defect.id ?? null,
      how: match?.how ?? null,
      classAgrees: match !== null && match.defect.class === finding.class,
    }
  })
  const truePositives = findings.filter((finding) => finding.defectId !== null).length
  return {
    caseId,
    surfaced: findings.length,
    truePositives,
    falsePositives: findings.length - truePositives,
    defects: truth.length,
    found: new Set(
      findings.flatMap((finding) => (finding.defectId === null ? [] : [finding.defectId])),
    ).size,
    confirmed: report.findings.filter((finding) => finding.verdict.status === 'confirmed').length,
    confirmedByReproducer: report.findings.filter((finding) =>
      finding.evidence.some((evidence) => evidence.kind === 'reproducer'),
    ).length,
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
  /** The metric. `null` when nothing was surfaced. */
  readonly precision: number | null
  readonly defects: number
  readonly found: number
  /** Secondary, by design. `null` when the corpus declares no defect. */
  readonly recall: number | null
  readonly confirmed: number
  readonly confirmedByReproducer: number
  /** Surfaced findings a reproducer confirmed, over surfaced findings. */
  readonly reproducerRate: number | null
  readonly inputTokens: number
  readonly outputTokens: number
  /** Cost per confirmed finding, in the unit every provider reports. */
  readonly outputTokensPerConfirmed: number | null
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 1000
}

export function aggregateScores(
  scores: readonly CaseScore[],
  usages: readonly BenchUsage[],
): BenchMetrics {
  const sum = (pick: (score: CaseScore) => number): number =>
    scores.reduce((total, score) => total + pick(score), 0)
  const surfaced = sum((score) => score.surfaced)
  const truePositives = sum((score) => score.truePositives)
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
    falsePositives: surfaced - truePositives,
    precision: ratio(truePositives, surfaced),
    defects,
    found,
    recall: ratio(found, defects),
    confirmed,
    confirmedByReproducer,
    reproducerRate: ratio(confirmedByReproducer, surfaced),
    inputTokens,
    outputTokens,
    outputTokensPerConfirmed: confirmed === 0 ? null : Math.round(outputTokens / confirmed),
  }
}
