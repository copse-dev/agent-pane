// Stage 5 — Report (docs/plans/copse-reviewer.md, §Pipeline and §The quality
// bar). Stage 0's confirmed findings, the reviewers' candidates (clustered by
// Stage 3) and Stage 4's verdicts become one ranked list: refuted findings
// never reach the human, executable evidence earns a bonus, a finding that
// survived a challenge earns a smaller one, an uncorroborated unverified claim
// pays a penalty, and the surfaced list is capped; the rest go to an appendix.
import type { HeadlessOutcome, HeadlessStopReason } from '@copse/agent/headless-contract.ts'
import { clusterFindings } from './cluster.ts'
import { readCheckoutFile } from './checkout-fs.ts'
import type { ReviewContext } from './context.ts'
import {
  findingId,
  type Evidence,
  type Finding,
  type FindingConfidence,
  type FindingSeverity,
} from './finding.ts'
import type { CellCommandResult } from './isolation.ts'
import type { ReportedCandidate } from './reviewer-tools.ts'
import type { Stage0Report } from './stage0.ts'
import type { Stage2Result } from './stage2.ts'
import type { Stage4Result, VerificationRecord } from './stage4.ts'
import type { TurnUsage } from './turn.ts'

export const REVIEW_REPORT_VERSION = 2
/** The hard cap on surfaced findings: a forty-item list is a denial of service. */
export const MAX_SURFACED_FINDINGS = 7
const EVIDENCE_EXCERPT_CHARS = 4 * 1024

export interface ReviewerSummary {
  readonly model: string
  readonly lens: string
  readonly turnId: string
  readonly outcome: HeadlessOutcome
  readonly stopReason: HeadlessStopReason
  readonly candidates: number
  readonly toolCalls: number
  readonly usage: TurnUsage
  readonly summary: string
  readonly error?: string
}

export interface VerificationSummary {
  readonly counts: Stage4Result['counts']
  readonly records: readonly VerificationRecord[]
  /** Reproducers that confirmed a finding: the artefact a human can keep. */
  readonly reproducers: readonly {
    readonly findingId: string
    readonly path: string
    readonly argv: readonly string[]
    readonly content: string
  }[]
  readonly usage: TurnUsage
}

export interface ReviewReport {
  readonly version: typeof REVIEW_REPORT_VERSION
  readonly stage0: Stage0Report
  readonly context: {
    readonly files: number
    readonly dropped: readonly { readonly path: string; readonly reason: string }[]
    readonly truncated: readonly string[]
    readonly budgetChars: number
    readonly usedChars: number
  } | null
  readonly reviews: readonly ReviewerSummary[]
  readonly verification: VerificationSummary | null
  /** Ranked, capped at {@link MAX_SURFACED_FINDINGS}. */
  readonly findings: readonly Finding[]
  /** Everything that ranked below the cap, in order. */
  readonly appendix: readonly Finding[]
  /** Findings verification refuted; kept so a reader can see what was dropped and why. */
  readonly refuted: readonly Finding[]
  readonly durationMs: number
}

const SEVERITY_WEIGHT: Record<FindingSeverity, number> = { low: 1, medium: 2, high: 3, critical: 4 }
const CONFIDENCE_WEIGHT: Record<FindingConfidence, number> = { low: 1, medium: 2, high: 3 }

/**
 * Rank score: severity × confidence, plus a bonus for executable evidence, a
 * confirmed verdict and a survived challenge, minus a penalty for a finding one
 * reviewer raised, nobody corroborated and nothing verified. Refuted findings
 * score nothing because they are dropped before ranking.
 */
export function findingScore(finding: Finding): number {
  let score = SEVERITY_WEIGHT[finding.severity] * CONFIDENCE_WEIGHT[finding.confidence]
  if (
    finding.evidence.some(
      (evidence) => evidence.kind === 'command' || evidence.kind === 'reproducer',
    )
  ) {
    score += 3
  }
  if (finding.verdict.status === 'confirmed') score += 4
  if (finding.provenance.challengedBy.length > 0) score += 2
  if (
    finding.verdict.status === 'unverified' &&
    finding.provenance.raisedBy.length === 1 &&
    finding.provenance.corroboratedBy.length === 0 &&
    finding.provenance.challengedBy.length === 0
  ) {
    score -= 2
  }
  return score
}

function compareFindings(a: Finding, b: Finding): number {
  const byScore = findingScore(b) - findingScore(a)
  if (byScore !== 0) return byScore
  const byPath = a.anchor.path.localeCompare(b.anchor.path)
  if (byPath !== 0) return byPath
  return (a.anchor.startLine ?? 0) - (b.anchor.startLine ?? 0)
}

/** Stage 3 over the raw lists. Kept as the older name too. */
export const mergeFindings = clusterFindings

/** Rank the canonical findings and split at the cap; refuted are reported separately. */
export function rankFindings(findings: readonly Finding[]): {
  surfaced: Finding[]
  appendix: Finding[]
  refuted: Finding[]
} {
  const refuted = findings.filter((finding) => finding.verdict.status === 'refuted')
  const live = [...findings.filter((finding) => finding.verdict.status !== 'refuted')]
  live.sort(compareFindings)
  return {
    surfaced: live.slice(0, MAX_SURFACED_FINDINGS),
    appendix: live.slice(MAX_SURFACED_FINDINGS),
    refuted,
  }
}

function quoteArgv(argv: readonly string[]): string {
  return argv.map((arg) => (/[\s"'$`\\]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')
}

function tail(text: string, chars: number): string {
  return text.length <= chars ? text : `…${text.slice(text.length - chars)}`
}

/** A reported candidate as a Finding: anchored, identified by content, unverified. */
export function candidateToFinding(
  reported: ReportedCandidate,
  origin: { readonly model: string; readonly lens: string },
  commandRuns: ReadonlyMap<string, CellCommandResult>,
): Finding {
  const { candidate } = reported
  const endLine = candidate.endLine ?? candidate.startLine
  const evidence: Evidence[] = [
    { kind: 'citation', path: candidate.path, startLine: candidate.startLine, endLine },
  ]
  for (const id of candidate.commandCallIds ?? []) {
    const run = commandRuns.get(id)
    if (run === undefined) continue
    evidence.push({
      kind: 'command',
      command: quoteArgv(run.argv),
      target: run.target,
      exitCode: run.exitCode,
      excerpt: tail(run.output, EVIDENCE_EXCERPT_CHARS),
    })
  }
  return {
    id: findingId({
      class: candidate.class,
      path: candidate.path,
      anchoredText: reported.anchoredText,
      claim: candidate.claim,
    }),
    anchor: { path: candidate.path, startLine: candidate.startLine, endLine },
    claim: candidate.claim,
    class: candidate.class,
    severity: candidate.severity,
    confidence: candidate.confidence,
    provenance: {
      raisedBy: [{ kind: 'model', id: origin.model, lens: origin.lens }],
      corroboratedBy: [],
      challengedBy: [],
    },
    evidence,
    verdict: { status: 'unverified', reason: candidate.reason },
  }
}

/**
 * Stage 0's findings and every reviewer's candidates, clustered into
 * canonical findings (Stage 3). Stage 0 goes first so a candidate that
 * duplicates a confirmed finding corroborates it rather than replacing it.
 */
export function canonicalFindings(
  stage0: Stage0Report,
  reviews: readonly Stage2Result[],
): Finding[] {
  const candidates = reviews.flatMap((review) =>
    review.candidates.map((reported) =>
      candidateToFinding(reported, { model: review.model, lens: review.lens }, review.commandRuns),
    ),
  )
  return clusterFindings([...stage0.findings, ...candidates])
}

export function summarizeReview(review: Stage2Result): ReviewerSummary {
  return {
    model: review.model,
    lens: review.lens,
    turnId: review.turnId,
    outcome: review.outcome,
    stopReason: review.stopReason,
    candidates: review.candidates.length,
    toolCalls: review.toolCalls,
    usage: review.usage,
    summary: review.summary,
    ...(review.error !== undefined ? { error: review.error } : {}),
  }
}

export interface AssembleReportInput {
  readonly stage0: Stage0Report
  readonly context: ReviewContext | null
  readonly reviews: readonly Stage2Result[]
  readonly verification: Stage4Result | null
  /** The canonical findings after verification (or straight from {@link canonicalFindings}). */
  readonly findings: readonly Finding[]
  readonly startedAt: number
  readonly now?: () => number
}

export function assembleReviewReport(input: AssembleReportInput): ReviewReport {
  const now = input.now ?? Date.now
  const { surfaced, appendix, refuted } = rankFindings(input.findings)
  return {
    version: REVIEW_REPORT_VERSION,
    stage0: input.stage0,
    context:
      input.context === null
        ? null
        : {
            files: input.context.files.length,
            dropped: input.context.files
              .filter((file) => file.dropped !== undefined)
              .map((file) => ({ path: file.path, reason: file.dropped ?? '' })),
            truncated: input.context.files
              .filter((file) => file.truncated)
              .map((file) => file.path),
            budgetChars: input.context.budgetChars,
            usedChars: input.context.usedChars,
          },
    reviews: input.reviews.map(summarizeReview),
    verification:
      input.verification === null
        ? null
        : {
            counts: input.verification.counts,
            records: input.verification.records,
            reproducers: input.verification.reproducers.map(({ findingId: id, run }) => ({
              findingId: id,
              path: run.path,
              argv: run.argv,
              content: run.content,
            })),
            usage: input.verification.usage,
          },
    findings: surfaced,
    appendix,
    refuted,
    durationMs: now() - input.startedAt,
  }
}

/** The source lines a finding is anchored to, for a renderer that wants to quote them. */
export function anchoredSource(headCheckout: string, finding: Finding): string | null {
  if (finding.anchor.startLine === undefined) return null
  try {
    const lines = readCheckoutFile(headCheckout, finding.anchor.path).split(/\r?\n/)
    return lines
      .slice(finding.anchor.startLine - 1, finding.anchor.endLine ?? finding.anchor.startLine)
      .join('\n')
  } catch {
    return null
  }
}
