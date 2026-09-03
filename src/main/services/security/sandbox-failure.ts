import type { ShellPromptParts } from './permission-policy.ts'
import { flattenShellPromptParts } from './permission-policy.ts'

// The detection itself lives in `@copse/hooks-dialects` (the hook runner is one of
// its two callers); re-exported so the shell tool and the gate keep their import.
export {
  detectSandboxFailure,
  type SandboxFailureDetection,
  type SandboxFailureSignals,
} from '@copse/hooks-dialects/sandbox-failure-detection.ts'

export function formatUnsandboxedPromptBody(command: string, reasons: string[]): string {
  return flattenShellPromptParts(formatUnsandboxedPromptParts(command, reasons))
}

export function formatUnsandboxedPromptParts(command: string, reasons: string[]): ShellPromptParts {
  const detail = reasons.length ? reasons.join('; ') : 'sandbox restriction suspected'
  return {
    command,
    bodyAdvice: `This command failed inside the project sandbox (${detail}).`,
    bodyFooter: 'Allow running it once without sandbox restrictions?',
  }
}
