import type { CheckRun } from './stage0.ts'
import { parseTscDiagnostics } from './tsc-diagnostics.ts'

export interface InconclusiveCheckFailure {
  readonly kind: 'timeout' | 'termination' | 'resource' | 'setup' | 'missing-diagnostic'
  readonly reason: string
}

/** A failed checker is not necessarily a failed check of the product. */
export function inconclusiveCheckFailure(run: CheckRun): InconclusiveCheckFailure | null {
  if (run.status === 'passed') return null
  if (run.status === 'timed-out') {
    return { kind: 'timeout', reason: `timed out after ${String(run.durationMs)} ms` }
  }
  if (/^FATAL ERROR:.*(?:heap|allocation)|^JavaScript heap out of memory/im.test(run.output)) {
    return { kind: 'resource', reason: 'the checker exhausted its memory' }
  }
  if (run.signal || run.exitCode === null || (run.exitCode > 128 && run.exitCode <= 192)) {
    return {
      kind: 'termination',
      reason: run.signal
        ? `the checker was terminated by ${run.signal}`
        : `the checker terminated with exit ${String(run.exitCode)} without a completed check`,
    }
  }
  if (
    run.exitCode === 126 ||
    run.exitCode === 127 ||
    /\bERR_PNPM_(?:NO_SCRIPT|NO_IMPORTER_MANIFEST_FOUND)\b|\bCommand "[^"]+" not found\b|\bspawn \S+ ENOENT\b/.test(
      run.output,
    )
  ) {
    return {
      kind: 'setup',
      reason: 'the checker could not start with the available tools or setup',
    }
  }
  if (run.kind === 'typecheck' && parseTscDiagnostics(run.output).length === 0) {
    return {
      kind: 'missing-diagnostic',
      reason: `typecheck exited ${String(run.exitCode)} without a TypeScript diagnostic`,
    }
  }
  return null
}

export function inconclusiveCheckReason(run: CheckRun): string | null {
  const failure = inconclusiveCheckFailure(run)
  return failure === null
    ? null
    : `${failure.reason} on ${run.target}; a code regression was not established`
}
