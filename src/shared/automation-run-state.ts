import type { Thread } from '@shared/types'

/** Existing persisted metadata that can prove an earlier submitted turn. */
export type ThreadRunEvidence = Partial<
  Pick<Thread, 'lastPromptAt' | 'usage' | 'workingBrief' | 'autoTitleCount'>
>

/**
 * Whether a thread has run, without loading its transcript. Legacy threads
 * without a prompt timestamp can instead carry usage, a working brief or an
 * auto-title pass in metadata.
 */
export function hasThreadRun(thread: ThreadRunEvidence): boolean {
  if (thread.lastPromptAt !== undefined) return true
  if (thread.workingBrief !== undefined || thread.autoTitleCount !== undefined) return true
  return (thread.usage?.inputTokens ?? 0) + (thread.usage?.outputTokens ?? 0) > 0
}

/**
 * What an earlier automation run means for the schedule's next trigger.
 *
 * - `running`: the agent is mid-turn; the next trigger must not overlap it.
 * - `pending-start`: the prompt was created but never sent (the project is not
 *   open, or the renderer is still preparing it).
 * - `null`: the run is finished, has a human follow-up draft, or its start
 *   failed. A failed start keeps its prompt for the user to send by hand,
 *   but it must not hold the
 *   schedule hostage: nothing will ever start it automatically, so the next
 *   trigger would otherwise be skipped forever.
 */
export function automationRunBlock(
  thread: Pick<Thread, 'status' | 'draftPrompt'> &
    ThreadRunEvidence & { automation?: Thread['automation'] },
): 'running' | 'pending-start' | null {
  if (thread.status === 'running') return 'running'
  if (
    Boolean(thread.draftPrompt?.trim()) &&
    thread.automation?.startFailedAt === undefined &&
    !hasThreadRun(thread)
  ) {
    return 'pending-start'
  }
  return null
}
