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

export const READ_OUTSIDE_PROJECT_TITLE = 'Allow read access outside of the project?'

/**
 * The warning stays on the prompt even though the shape is a read: a grant does
 * widen what the agent can see, and the user is the one who knows whether the
 * paths in question are sensitive.
 */
export const READ_OUTSIDE_PROJECT_WARNING =
  'This may allow the agent to read from sensitive locations on your computer.'

export function formatReadOutsideProjectPromptParts(
  command: string,
  analysis: ReadOutsideProjectAnalysis,
): ShellPromptParts {
  return {
    command,
    bodyAdvice:
      `The agent wants to read outside the project: ${describeReadOutsideTargets(analysis.targets)}\n\n` +
      `⚠️ ${READ_OUTSIDE_PROJECT_WARNING}`,
    bodyFooter:
      'Approving allows reads outside the project for the rest of this thread. ' +
      'It does not allow writing, installing, or network access, and credential ' +
      'files (.env, ~/.ssh, ~/.aws) always ask again.',
  }
}
