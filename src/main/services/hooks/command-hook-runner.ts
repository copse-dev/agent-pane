/**
 * App binding for the command-hook runner in `@copse/hooks-dialects`. The
 * package runner reports each execution to a caller-supplied sink; this wrapper
 * keeps the app's original API, where fire sites hand over a recording
 * *snapshot* and the spine recorder is implied: a detached async fire site
 * passes the context it captured before `endHookRunRecording` (decision 3/6),
 * a blocking hook passes nothing and records against the live context.
 */
import './hooks-dialects-environment.ts'
import { createCommandHookRunner as createPackageRunner } from '@copse/hooks-dialects/command-hook-runner.ts'
import { recordCommandHookRun, type HookRunRecordingSnapshot } from '../hook-run-recorder.ts'

export {
  applySandboxBlock,
  type CommandHookRunInput,
  type RecordCommandHookRun,
} from '@copse/hooks-dialects/command-hook-runner.ts'

export function createCommandHookRunner(opts?: {
  /**
   * Recording context captured synchronously at a detached fire site (`stop`,
   * `subagentStop`, …). When set, command-hook spine lines record against it so
   * they survive `endHookRunRecording` (decision 3/6). Omit for blocking hooks,
   * which record against the live context.
   */
  recordingSnapshot?: HookRunRecordingSnapshot | null
}): ReturnType<typeof createPackageRunner> {
  const snapshot = opts?.recordingSnapshot
  return createPackageRunner({
    record: (input) => {
      recordCommandHookRun(input, snapshot)
    },
  })
}
