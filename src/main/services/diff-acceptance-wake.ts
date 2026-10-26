import { randomUUID } from 'node:crypto'
import type { ThreadExecutionOwner } from './thread-execution-context.ts'

export interface DiffAcceptance {
  owner: ThreadExecutionOwner
  turnTreeId: string
  operationId: string
  paths: string[]
}

type DiffAcceptanceHandler = (acceptance: DiffAcceptance) => Promise<unknown>
let handler: DiffAcceptanceHandler | null = null

export function setDiffAcceptanceHandler(next: DiffAcceptanceHandler | null): void {
  handler = next
}

/** One wake per originating turn tree, after the whole approval action settles. */
export function notifyDiffAcceptance(
  owner: ThreadExecutionOwner,
  accepted: ReadonlyMap<string, string[]>,
): void {
  const deliver = handler
  if (!deliver) return
  for (const [turnTreeId, paths] of accepted) {
    void Promise.resolve()
      .then(() => deliver({ owner, turnTreeId, paths, operationId: randomUUID() }))
      .catch((error: unknown) => {
        console.warn('[diff-acceptance] Agent notification failed:', error)
      })
  }
}

export function diffAcceptancePrompt(acceptance: DiffAcceptance): string {
  return [
    'The user accepted the following proposed changes in the Changes panel. These changes are now on disk:',
    ...acceptance.paths.map((path) => JSON.stringify(path)),
    'Continue the existing task from this state, including any validation that was waiting for acceptance. Do not acknowledge this internal notification unless there is a useful result or a blocker to report. Acceptance does not authorize additional scope.',
  ].join('\n')
}
