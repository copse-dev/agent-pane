// The terminal projection of a Stage 0 report. "Clean" is a complete answer
// and is one line; a finding shows its anchor, its claim and the exit codes
// that back it; and what was NOT checked is always said (§The quality bar).
import type { Finding } from './finding.ts'
import type { CheckOutcome, Stage0Report } from './stage0.ts'
import type { ReviewReport } from './stage5.ts'

const MARK: Record<CheckOutcome['verdict'], string> = {
  clean: '✓',
  fixed: '✓ (was failing on base)',
  regressed: '✗ regressed',
  'failing-on-base': '✗ (already failing on base)',
  undetermined: '?',
  'not-run': '–',
}

export function renderStage0Report(report: Stage0Report): string {
  const lines: string[] = []
  const { decision } = report.execution
  lines.push(
    `Copse Reviewer · Stage 0 · ${report.execution.backend} (${report.execution.strength})`,
  )
  if (!decision.execute) {
    lines.push(`Not executed: ${decision.reason}`)
    return lines.join('\n')
  }
  const head = report.dirtyWorkingTree
    ? `${short(report.headCommit)} + working tree`
    : short(report.headCommit)
  lines.push(`head ${head} against ${report.baseRef} (merge-base ${short(report.mergeBase)})`)

  if (report.checks.length > 0) {
    lines.push(
      `checked: ${report.checks.map((check) => `${check.kind} ${MARK[check.verdict]}`).join(', ')}`,
    )
  }

  if (report.findings.length === 0 && report.coverage.notChecked.length === 0) {
    lines.push('Clean.')
  } else if (report.findings.length === 0) {
    lines.push('No findings.')
  } else {
    lines.push(`${String(report.findings.length)} finding(s):`)
    report.findings.forEach((finding, index) => {
      const where =
        finding.anchor.startLine === undefined
          ? finding.anchor.path
          : `${finding.anchor.path}:${String(finding.anchor.startLine)}`
      lines.push(`${String(index + 1)}. [${finding.class}] ${where} — ${finding.claim}`)
      lines.push(`   ${finding.verdict.status}: ${finding.verdict.reason} (id ${finding.id})`)
    })
  }

  for (const note of report.coverage.notChecked) {
    lines.push(`not checked: ${note.kind === 'all' ? '' : `${note.kind} — `}${note.reason}`)
  }
  for (const target of ['head', 'base'] as const) {
    const prepare = report.preparation[target]
    if (prepare === null || prepare.status === 'passed') continue
    lines.push(`prepare on ${target} ${prepare.status} (exit ${String(prepare.exitCode)}):`)
    for (const line of lastLines(prepare.output, 8)) lines.push(`  ${line}`)
  }
  return lines.join('\n')
}

function findingLines(finding: Finding, index: number): string[] {
  const where =
    finding.anchor.startLine === undefined
      ? finding.anchor.path
      : `${finding.anchor.path}:${String(finding.anchor.startLine)}`
  const raised = finding.provenance.raisedBy
    .map((ref) =>
      ref.kind === 'stage0' ? 'stage 0' : `${ref.id}${ref.lens ? ` / ${ref.lens}` : ''}`,
    )
    .join(', ')
  const corroborated =
    finding.provenance.corroboratedBy.length > 0
      ? `; corroborated by ${finding.provenance.corroboratedBy.map((ref) => ref.id).join(', ')}`
      : ''
  const executed = finding.evidence.filter((evidence) => evidence.kind === 'command').length
  const reproducer = finding.evidence.find((evidence) => evidence.kind === 'reproducer')
  return [
    `${String(index + 1)}. [${finding.class} · ${finding.severity} · ${finding.confidence}] ${where} — ${finding.claim}`,
    `   ${finding.verdict.status}: ${finding.verdict.reason}`,
    `   raised by ${raised}${corroborated}${executed > 0 ? `; ${String(executed)} command(s) as evidence` : ''}${reproducer?.kind === 'reproducer' ? `; reproducer ${reproducer.testPath}` : ''} (id ${finding.id})`,
  ]
}

/** The terminal projection of a full review: Stage 0, the reviewers, verification, the ranked list. */
export function renderReviewReport(report: ReviewReport): string {
  const lines: string[] = [renderStage0Report(report.stage0)]
  const incompleteReviews = report.reviews.filter((review) => review.outcome !== 'completed')
  for (const review of report.reviews) {
    const usage = `${String(review.usage.inputTokens)} in / ${String(review.usage.outputTokens)} out${review.usage.estimated ? ' (estimated)' : ''}`
    lines.push('')
    lines.push(
      `reviewer ${review.model} under ${review.lens} — ${review.outcome} (${review.stopReason}), ${String(review.toolCalls)} tool call(s), ${String(review.candidates)} candidate(s), ${usage}`,
    )
    if (review.error !== undefined) lines.push(`  error: ${review.error}`)
    if (review.summary.length > 0) lines.push(`  ${review.summary.replace(/\s+/g, ' ')}`)
  }
  if (report.verification !== null) {
    const { counts } = report.verification
    lines.push('')
    lines.push(
      `verification: ${String(counts.attempted)} attempted — ${String(counts.confirmed)} confirmed by reproducer, ${String(counts.refuted)} refuted, ${String(counts.survived)} survived challenge, ${String(counts.undetermined)} undetermined${counts.skipped > 0 ? `, ${String(counts.skipped)} beyond the cap` : ''}`,
    )
  }
  if (report.context !== null) {
    const { context } = report
    const notes: string[] = []
    if (context.dropped.length > 0) {
      notes.push(`${String(context.dropped.length)} low-signal file(s) omitted from the diff`)
    }
    if (context.truncated.length > 0)
      notes.push(`${String(context.truncated.length)} file diff(s) truncated`)
    if (notes.length > 0) lines.push(`context: ${notes.join('; ')}`)
  }
  lines.push('')
  if (incompleteReviews.length > 0) {
    lines.push(
      `Review incomplete: ${String(incompleteReviews.length)} of ${String(report.reviews.length)} reviewer run(s) did not complete; this is not a clean result.`,
    )
  }
  if (report.findings.length === 0) {
    lines.push(
      report.reviews.length === 0
        ? 'No findings from Stage 0.'
        : incompleteReviews.length > 0
          ? 'No findings were produced before the incomplete review stopped.'
          : 'No findings.',
    )
  } else {
    lines.push(`${String(report.findings.length)} finding(s):`)
    report.findings.forEach((finding, index) => lines.push(...findingLines(finding, index)))
  }
  if (report.appendix.length > 0) {
    lines.push(`${String(report.appendix.length)} more below the cap, in the JSON appendix.`)
  }
  if (report.refuted.length > 0) {
    lines.push(
      `${String(report.refuted.length)} refuted by verification and dropped (kept in the JSON).`,
    )
  }
  return lines.join('\n')
}

function lastLines(text: string, count: number): string[] {
  return text.trimEnd().split(/\r?\n/).slice(-count)
}

function short(commit: string | null): string {
  return commit === null ? '?' : commit.slice(0, 10)
}
