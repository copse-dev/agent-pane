import { randomUUID } from 'node:crypto'
import type { ThreadExecutionOwner } from './thread-execution-context.ts'

export interface DiffAcceptance {
  owner: ThreadExecutionOwner
  turnTreeId: string
  operationId: string
  paths: string[]
}

export interface DiffAcceptanceHandler {
  /** Resolve once the thread runs no turn and no machine wake already dispatched to it. */
  waitForIdle(owner: ThreadExecutionOwner): Promise<void>
  wake(acceptance: DiffAcceptance): Promise<unknown>
}

let handler: DiffAcceptanceHandler | null = null

/**
 * Accepted paths whose wake has not started, by thread and originating epoch.
 * Each wake is charged to the epoch's continuation budget, so approvals that
 * arrive while the thread is still busy join the waiting wake instead of
 * queueing one wake per approval.
 */
const waiting = new Map<string, string[]>()

export function setDiffAcceptanceHandler(next: DiffAcceptanceHandler | null): void {
  handler = next
}

/**
 * At most one wake per originating turn tree for each approval action, sent
 * once the thread is free. Later approvals for that tree join it until it starts.
 */
export function notifyDiffAcceptance(
  owner: ThreadExecutionOwner,
  accepted: ReadonlyMap<string, string[]>,
): void {
  const target = handler
  if (!target) return
  for (const [turnTreeId, paths] of accepted) {
    const key = JSON.stringify([owner.projectId, owner.threadId, turnTreeId])
    const pending = waiting.get(key)
    if (pending) {
      for (const path of paths) if (!pending.includes(path)) pending.push(path)
      continue
    }
    const batch = [...paths]
    waiting.set(key, batch)
    void Promise.resolve()
      .then(() => target.waitForIdle(owner))
      .then(() => {
        // Freeze the batch: an approval from here on waits behind this wake.
        if (waiting.get(key) === batch) waiting.delete(key)
        return target.wake({ owner, turnTreeId, paths: batch, operationId: randomUUID() })
      })
      .catch((error: unknown) => {
        if (waiting.get(key) === batch) waiting.delete(key)
        console.warn('[diff-acceptance] Agent notification failed:', error)
      })
  }
}

export function diffAcceptancePrompt({ paths }: Pick<DiffAcceptance, 'paths'>): string {
  return [
    'The user accepted the following proposed changes in the Changes panel. These changes are now on disk:',
    ...paths.map((path) => JSON.stringify(path)),
    'Continue the existing task from this state, including any validation that was waiting for acceptance. Do not acknowledge this internal notification unless there is a useful result or a blocker to report. Acceptance does not authorize additional scope.',
  ].join('\n')
}
