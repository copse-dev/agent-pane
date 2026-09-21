// The terminal projection of a Stage 0 report. "Clean" is a complete answer
// and is one line; a finding shows its anchor, its claim and the exit codes
// that back it; and what was NOT checked is always said (§The quality bar).
import type { CheckOutcome, Stage0Report } from './stage0.ts'

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

function lastLines(text: string, count: number): string[] {
  return text.trimEnd().split(/\r?\n/).slice(-count)
}

function short(commit: string | null): string {
  return commit === null ? '?' : commit.slice(0, 10)
}
