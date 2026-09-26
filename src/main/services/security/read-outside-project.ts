/**
 * App binding for the outside-project read classifier, which lives in
 * `@copse/shell-guard`. The analysis (`analyzeReadOutsideProject`,
 * `readOutsideProjectGrantTargets`, `sensitiveTargetReason`) is re-exported
 * unchanged; the approval-prompt copy
 * below is product UX and stays here with the other prompt formatters.
 */
import './shell-guard-environment.ts'
import type { ReadOutsideProjectAnalysis } from '@copse/shell-guard/read-outside-project.ts'
import type { ShellPromptParts } from './permission-policy.ts'

export * from '@copse/shell-guard/read-outside-project.ts'

export const READ_OUTSIDE_PROJECT_TITLE = 'Allow read access outside of the project?'

/**
 * The warning stays on the prompt even though the shape is a read: a grant does
 * widen what the agent can see, and the user is the one who knows whether the
 * paths in question are sensitive.
 */
export const READ_OUTSIDE_PROJECT_WARNING =
  'A listed directory can contain sensitive files. Approving it also covers files nested inside it.'

export function formatReadOutsideProjectPromptParts(
  command: string,
  analysis: ReadOutsideProjectAnalysis,
): ShellPromptParts {
  return {
    command,
    bodyAdvice:
      `The agent requests read access to ${analysis.targets.length === 1 ? 'this path' : 'these paths'} for this thread:\n` +
      analysis.targets.map((target) => `• ${target}`).join('\n') +
      `\n\n⚠️ ${READ_OUTSIDE_PROJECT_WARNING}`,
    bodyFooter:
      'Approve grants reads of the listed paths and files within listed directories for the rest of this thread. ' +
      'Other paths ask again. Writes, installs, and network access are not approved. ' +
      'Commands naming credential files or directories directly also ask again.',
  }
}
