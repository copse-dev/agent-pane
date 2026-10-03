import type { Thread } from '@shared/types'

/**
 * What an earlier automation run means for the schedule's next trigger.
 *
 * - `running`: the agent is mid-turn; the next trigger must not overlap it.
 * - `pending-start`: the prompt was created but never sent (the project is not
 *   open, or the renderer is still preparing it).
 * - `null`: the run is finished, or its start failed. A failed start keeps its
 *   prompt as a draft for the user to send by hand, but it must not hold the
 *   schedule hostage: nothing will ever start it automatically, so the next
 *   trigger would otherwise be skipped forever.
 */
export function automationRunBlock(
  thread: Pick<Thread, 'status' | 'draftPrompt' | 'automation'>,
): 'running' | 'pending-start' | null {
  if (thread.status === 'running') return 'running'
  if (Boolean(thread.draftPrompt?.trim()) && thread.automation?.startFailedAt === undefined) {
    return 'pending-start'
  }
  return null
}
