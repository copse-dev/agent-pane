import type { CommandPhase, ToolCall } from '@copse/agent/wire-types.ts'

/** What a command card says about where its command is (#3956). */
export interface CommandPhaseLabel {
  text: string
  /** Longer explanation for the label's tooltip, when there is one. */
  detail?: string
}

/**
 * The short label beside a command card's title, or null when the card's own
 * status already says everything: a clean exit is the green check alone.
 */
export function commandPhaseLabel(phase: CommandPhase | undefined): CommandPhaseLabel | null {
  if (!phase) return null
  switch (phase.state) {
    case 'queued':
      return { text: 'Queued' }
    case 'awaiting_approval':
      return { text: 'Waiting for approval' }
    case 'starting':
      return { text: 'Starting' }
    case 'running':
      return phase.backgroundTaskId === undefined
        ? { text: 'Running' }
        : {
            text: `Background task ${phase.backgroundTaskId}`,
            detail: 'Its output is under Background tasks.',
          }
    case 'exited':
      if (phase.exitCode === undefined) return { text: 'Exited' }
      return phase.exitCode === 0 ? null : { text: `Exit ${String(phase.exitCode)}` }
    case 'timed_out':
      return { text: 'Timed out' }
    case 'cancelled':
      return { text: phase.launched ? 'Stopped' : 'Cancelled before start' }
    case 'not_started':
      return {
        text: 'Did not start',
        ...(phase.reason !== undefined && phase.reason !== '' ? { detail: phase.reason } : {}),
      }
  }
}

/**
 * The stage of the newest command still in flight among `calls`. A collapsed
 * rollup or group shows it in its own header, so a command waiting on approval
 * or still starting is visible without opening the disclosure. Settled calls
 * are left to their own cards.
 */
export function liveCommandPhase(
  calls: readonly Pick<ToolCall, 'status' | 'commandPhase'>[],
): CommandPhase | undefined {
  for (let index = calls.length - 1; index >= 0; index--) {
    const call = calls[index]
    if (call?.status === 'running' && call.commandPhase) return call.commandPhase
  }
  return undefined
}
