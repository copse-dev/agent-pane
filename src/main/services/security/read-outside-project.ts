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
  canonicalTargets: readonly (string | null)[] = [],
  scope: 'thread' | 'project' = 'thread',
): ShellPromptParts {
  const plural = analysis.targets.length === 1 ? 'this path' : 'these paths'
  return {
    command,
    bodyAdvice:
      `The agent requests read access to ${plural} for this thread:\n` +
      analysis.targets
        .map((target, index) => {
          const canonical = canonicalTargets[index]
          const named = analysis.resolvedTargets[index]
          return canonical && named !== canonical ? `• ${target} → ${canonical}` : `• ${target}`
        })
        .join('\n') +
      `\n\n⚠️ ${READ_OUTSIDE_PROJECT_WARNING}`,
    bodyFooter:
      scope === 'project'
        ? 'Approve grants reads of the listed folders for the rest of this thread. ' +
          'Tick the box to keep them readable in every chat in this project instead, including after a restart; ' +
          'remove one in Settings → Permissions → Sandbox read access. ' +
          'In a folder kept for the project, contained commands cannot open .env files, keys or other recognised credential names. ' +
          'Writes, installs, and network access are not approved.'
        : 'Approve grants reads of the listed paths and files within listed directories for the rest of this thread. ' +
          'Other paths ask again. Writes, installs, and network access are not approved. ' +
          'Commands naming credential files or directories directly also ask again.',
  }
}
