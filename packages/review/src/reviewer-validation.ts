import type { ReviewContext } from './context.ts'
import type { CheckRun, Stage0Report } from './stage0.ts'

/** The trusted Stage 0 fields a model reviewer may use as prior evidence. */
export type ReviewerValidation = Pick<
  Stage0Report,
  'headCommit' | 'dirtyWorkingTree' | 'execution' | 'checks' | 'coverage'
>

function describeRun(run: CheckRun | null): string {
  if (run === null) return 'not run'
  const exit = run.exitCode === null ? 'no exit code' : `exit ${String(run.exitCode)}`
  return `${run.status} (${exit}, ${String(run.durationMs)} ms)`
}

/**
 * Keep Stage 0 evidence in the trusted system message, but copy no command,
 * output or free-form reason from the repository-controlled execution.
 */
export function renderReviewerValidation(validation: ReviewerValidation): string {
  const head =
    validation.headCommit === null
      ? 'unknown head'
      : `${validation.headCommit.slice(0, 10)}${validation.dirtyWorkingTree ? ' plus working-tree changes' : ''}`
  const lines = [
    'Trusted Stage 0 validation (already run outside this model turn):',
    `- checkout: ${head}.`,
    validation.execution.decision.execute
      ? `- execution: aggregate checks ran with ${validation.execution.strength} isolation.`
      : '- execution: aggregate checks did not run.',
  ]
  for (const check of validation.checks) {
    lines.push(
      `- ${check.kind}: head ${describeRun(check.head)}; base ${describeRun(check.base)}; verdict ${check.verdict}.`,
    )
  }
  const gaps = [...new Set(validation.coverage.notChecked.map((note) => note.kind))]
  lines.push(
    gaps.length === 0
      ? '- Stage 0 coverage gaps: none.'
      : `- Stage 0 coverage gaps: ${gaps.join(', ')}.`,
    '',
    'Treat these typed orchestration results as existing evidence for this exact checkout. A passed head check is verified: do not rerun its aggregate command merely to reconfirm it, and do not list that successful check as unverified. Base not run after a passing head check is expected and is not a coverage gap. Aggregate success does not prove a narrower semantic path was exercised; when executable code changed, use run_command for the smallest relevant focused test or probe that adds evidence.',
  )
  return lines.join('\n')
}

/** A stale Stage 0 artefact must never be presented as evidence for another diff. */
export function assertReviewerValidationMatches(
  validation: ReviewerValidation,
  context: ReviewContext,
): void {
  if (validation.headCommit !== null && validation.headCommit !== context.headCommit) {
    throw new Error(
      `Stage 0 validation is for ${validation.headCommit}, but review context is for ${context.headCommit}`,
    )
  }
  if (validation.dirtyWorkingTree !== context.dirtyWorkingTree) {
    throw new Error('Stage 0 validation and review context disagree about working-tree changes')
  }
}
