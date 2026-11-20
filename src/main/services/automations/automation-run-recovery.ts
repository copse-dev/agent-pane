import type { Thread } from '@shared/types'
import { automationRunBlock } from '@shared/automation-run-state.ts'
import { getThreadMeta, updateMetaIfUnchanged } from '../thread-store.ts'

/** Null means the runtime cannot currently prove whether the run still owns its turn. */
export type AutomationRunLiveness = (projectId: string, threadId: string) => boolean | null

/** A returned prompt can leave an idle transcript while its agent still owns work. */
export function automationRunBlocksAdmission(
  projectId: string,
  thread: Omit<Thread, 'messages'>,
  ownsAgentWork: AutomationRunLiveness | undefined,
): boolean {
  if (automationRunBlock(thread) !== null) return true
  try {
    return ownsAgentWork?.(projectId, thread.id) === true
  } catch {
    // Unknown ownership alone does not turn ordinary settled history into a
    // permanent blocker. Interrupted runs keep the conservative repair below.
    return false
  }
}

/**
 * Reconcile persisted running flags before an automation decides its run slot is busy.
 * A closed project has no renderer to perform the ordinary interrupted-turn repair.
 * The runtime owner must prove absence again at the store's atomic commit boundary.
 */
export async function reconcileInterruptedAutomationRuns(
  projectId: string,
  threads: readonly Omit<Thread, 'messages'>[],
  isActive: AutomationRunLiveness,
  now: () => number,
): Promise<Omit<Thread, 'messages'>[]> {
  const result = [...threads]
  for (const [index, observed] of threads.entries()) {
    if (!observed.automation) continue
    const isAbsent = (): boolean => {
      try {
        return isActive(projectId, observed.id) === false
      } catch {
        return false
      }
    }
    if (observed.status !== 'running') {
      // A new owner may still be publishing its status after an earlier repair.
      // Keep admissions busy without overwriting that owner's pending metadata.
      if (
        observed.interruptedTurnAt !== undefined &&
        automationRunBlock(observed) === null &&
        !isAbsent()
      ) {
        result[index] = { ...observed, status: 'running' }
      }
      continue
    }
    if (!isAbsent()) continue
    const current = await getThreadMeta(projectId, observed.id)
    if (
      !current ||
      current.status !== 'running' ||
      current.currentEpoch !== observed.currentEpoch ||
      current.updatedAt !== observed.updatedAt ||
      current.automation?.scheduleId !== observed.automation.scheduleId ||
      current.automation.triggeredAt !== observed.automation.triggeredAt
    )
      continue
    const interruptedAt = now()
    if (
      !(await updateMetaIfUnchanged(
        projectId,
        observed.id,
        current,
        { status: 'idle', interruptedTurnAt: interruptedAt },
        isAbsent,
      ))
    )
      continue
    const settled = (await getThreadMeta(projectId, observed.id)) ?? observed
    // Runtime ownership can change after the atomic repair but before its status
    // write lands. This is an admission view, never a stale metadata rollback.
    result[index] = isAbsent() ? settled : { ...settled, status: 'running' }
  }
  return result
}
