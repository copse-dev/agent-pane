// Stage 5 — Report (docs/plans/copse-reviewer.md, §Pipeline and §The quality
// bar). Stage 0's confirmed findings and Stage 2's candidates become one
// ranked list: refuted findings never reach the human, executable evidence
// earns a bonus, an uncorroborated unverified claim pays a penalty, and the
// surfaced list is capped; the rest go to an appendix. Phase 1 has no
// verification stage, so every model candidate is `unverified` and ranks
// below anything Stage 0 proved.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HeadlessOutcome, HeadlessStopReason } from '@copse/agent/headless-contract.ts'
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
import type { Stage2Result, Stage2Usage } from './stage2.ts'

export const REVIEW_REPORT_VERSION = 1
/** The hard cap on surfaced findings: a forty-item list is a denial of service. */
export const MAX_SURFACED_FINDINGS = 7
const EVIDENCE_EXCERPT_CHARS = 4 * 1024

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
  readonly review: {
    readonly model: string
    readonly lens: string
    readonly outcome: HeadlessOutcome
    readonly stopReason: HeadlessStopReason
    readonly candidates: number
    readonly toolCalls: number
    readonly usage: Stage2Usage
    readonly summary: string
    readonly error?: string
  } | null
  /** Ranked, capped at {@link MAX_SURFACED_FINDINGS}. */
  readonly findings: readonly Finding[]
  /** Everything that ranked below the cap, in order. */
  readonly appendix: readonly Finding[]
  readonly durationMs: number
}

const SEVERITY_WEIGHT: Record<FindingSeverity, number> = { low: 1, medium: 2, high: 3, critical: 4 }
const CONFIDENCE_WEIGHT: Record<FindingConfidence, number> = { low: 1, medium: 2, high: 3 }

/**
 * Rank score: severity × confidence, plus a bonus for executable evidence and
 * a confirmed verdict, minus a penalty for a finding one reviewer raised,
 * nobody corroborated and nothing verified. Refuted findings score nothing
 * because they are dropped before ranking.
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
  if (
    finding.verdict.status === 'unverified' &&
    finding.provenance.raisedBy.length === 1 &&
    finding.provenance.corroboratedBy.length === 0
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

function overlaps(a: Finding, b: Finding): boolean {
  if (a.anchor.path !== b.anchor.path || a.class !== b.class) return false
  const aStart = a.anchor.startLine ?? 0
  const aEnd = a.anchor.endLine ?? aStart
  const bStart = b.anchor.startLine ?? 0
  const bEnd = b.anchor.endLine ?? bStart
  return aStart <= bEnd && bStart <= aEnd
}

/**
 * Merge findings that are the same finding: identical id, or the same class on
 * overlapping lines of one file. The first (higher-ranked once sorted, since
 * Stage 0 comes first) keeps its evidence; the other's raisers corroborate it.
 * Phase 2's clustering replaces this with claim equivalence (P2).
 */
export function mergeFindings(findings: readonly Finding[]): Finding[] {
  const merged: Finding[] = []
  for (const finding of findings) {
    const existing = merged.findIndex(
      (other) => other.id === finding.id || overlaps(other, finding),
    )
    if (existing === -1) {
      merged.push(finding)
      continue
    }
    const target = merged[existing]
    if (target === undefined) continue
    const known = new Set(
      [...target.provenance.raisedBy, ...target.provenance.corroboratedBy].map(
        (ref) => `${ref.kind}:${ref.id}:${ref.lens ?? ''}`,
      ),
    )
    const corroboratedBy = [
      ...target.provenance.corroboratedBy,
      ...finding.provenance.raisedBy.filter(
        (ref) => !known.has(`${ref.kind}:${ref.id}:${ref.lens ?? ''}`),
      ),
    ]
    merged[existing] = {
      ...target,
      provenance: { ...target.provenance, corroboratedBy },
      evidence: [
        ...target.evidence,
        ...finding.evidence.filter((evidence) => evidence.kind !== 'citation'),
      ],
    }
  }
  return merged
}

/** Drop refuted, merge duplicates, rank, and split at the cap. */
export function rankFindings(findings: readonly Finding[]): {
  surfaced: Finding[]
  appendix: Finding[]
} {
  const live = mergeFindings(findings.filter((finding) => finding.verdict.status !== 'refuted'))
  live.sort(compareFindings)
  return {
    surfaced: live.slice(0, MAX_SURFACED_FINDINGS),
    appendix: live.slice(MAX_SURFACED_FINDINGS),
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

export interface AssembleReportInput {
  readonly stage0: Stage0Report
  readonly context: ReviewContext | null
  readonly stage2: Stage2Result | null
  readonly startedAt: number
  readonly now?: () => number
}

export function assembleReviewReport(input: AssembleReportInput): ReviewReport {
  const now = input.now ?? Date.now
  const candidates =
    input.stage2 === null
      ? []
      : input.stage2.candidates.map((reported) =>
          candidateToFinding(
            reported,
            { model: input.stage2?.model ?? '', lens: input.stage2?.lens ?? '' },
            input.stage2?.commandRuns ?? new Map(),
          ),
        )
  const { surfaced, appendix } = rankFindings([...input.stage0.findings, ...candidates])
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
    review:
      input.stage2 === null
        ? null
        : {
            model: input.stage2.model,
            lens: input.stage2.lens,
            outcome: input.stage2.outcome,
            stopReason: input.stage2.stopReason,
            candidates: input.stage2.candidates.length,
            toolCalls: input.stage2.toolCalls,
            usage: input.stage2.usage,
            summary: input.stage2.summary,
            ...(input.stage2.error !== undefined ? { error: input.stage2.error } : {}),
          },
    findings: surfaced,
    appendix,
    durationMs: now() - input.startedAt,
  }
}

/** The source lines a finding is anchored to, for a renderer that wants to quote them. */
export async function anchoredSource(
  headCheckout: string,
  finding: Finding,
): Promise<string | null> {
  if (finding.anchor.startLine === undefined) return null
  try {
    const lines = (await readFile(join(headCheckout, finding.anchor.path), 'utf8')).split(/\r?\n/)
    return lines
      .slice(finding.anchor.startLine - 1, finding.anchor.endLine ?? finding.anchor.startLine)
      .join('\n')
  } catch {
    return null
  }
}
