import { PRIOR_DENIAL_MARKER } from './denied-operations.ts'
import type { ShellPromptParts } from './permission-policy.ts'
import { truncateShellCommandForApproval } from './permission-policy.ts'

// The detection itself lives in `@copse/hooks-dialects` (the hook runner is one of
// its two callers); re-exported so the shell tool and the gate keep their import.
export {
  detectSandboxFailure,
  type SandboxFailureDetection,
  type SandboxFailureSignals,
} from '@copse/hooks-dialects/sandbox-failure-detection.ts'

/**
 * Reasons that are prior-denial prose (from `cachedDenialAdvice`) must stay out
 * of the parenthetical failure detail — they get their own section above it so
 * a long prior script never runs into the live command under review.
 */
function isPriorDenialReason(reason: string): boolean {
  return reason.includes(PRIOR_DENIAL_MARKER)
}

function splitFailureDetail(reasons: readonly string[]): {
  priorDenial: string | null
  detailReasons: string[]
} {
  const priorDenialParts: string[] = []
  const detailReasons: string[] = []
  for (const reason of reasons) {
    if (isPriorDenialReason(reason)) priorDenialParts.push(reason)
    else detailReasons.push(reason)
  }
  return {
    priorDenial: priorDenialParts.length ? priorDenialParts.join('\n\n') : null,
    detailReasons,
  }
}

export function formatUnsandboxedPromptParts(command: string, reasons: string[]): ShellPromptParts {
  const { priorDenial, detailReasons } = splitFailureDetail(reasons)
  const detail = detailReasons.length ? detailReasons.join('; ') : 'sandbox restriction suspected'
  const failureLine = `This command failed inside the project sandbox (${detail}).`
  return {
    command: truncateShellCommandForApproval(command),
    bodyAdvice: priorDenial ? `${priorDenial}\n\n${failureLine}` : failureLine,
    bodyFooter: 'Allow running it once without sandbox restrictions?',
  }
}
