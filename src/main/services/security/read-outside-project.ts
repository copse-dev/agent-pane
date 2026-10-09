/**
 * App binding for the outside-project read classifier, which lives in
 * `@copse/shell-guard`. The analysis (`analyzeReadOutsideProject`,
 * `readOutsideProjectGrantTargets`, `sensitiveTargetReason`,
 * `describeReadOutsideTargets`) is re-exported unchanged; the approval-prompt copy
 * below is product UX and stays here with the other prompt formatters.
 */
import './shell-guard-environment.ts'
import {
  describeReadOutsideTargets,
  type ReadOutsideProjectAnalysis,
} from '@copse/shell-guard/read-outside-project.ts'
import type { ShellPromptParts } from './permission-policy.ts'

export * from '@copse/shell-guard/read-outside-project.ts'

export const READ_OUTSIDE_PROJECT_TITLE = 'Read outside the project?'

export function formatReadOutsideProjectPromptParts(
  command: string,
  analysis: ReadOutsideProjectAnalysis,
): ShellPromptParts {
  return {
    command,
    bodyAdvice: `The agent wants to read ${describeReadOutsideTargets(analysis.targets)}.`,
    // A grant does widen what the agent can see, so the footer says what stays
    // off limits instead of leaving that to a separate warning.
    bodyFooter:
      'Approving once runs only this command. “Allow reads for this chat” allows eligible reads of other paths outside the project too, for the rest of this chat. ' +
      'It does not allow writing, installing, or network access, and credential ' +
      'files (.env, ~/.ssh, ~/.aws) always ask again.',
  }
}
