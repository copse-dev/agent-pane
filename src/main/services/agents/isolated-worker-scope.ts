import { AsyncLocalStorage } from 'node:async_hooks'
import type { ThreadExecutionOwner } from '../thread-execution-context.ts'

/** Set only after a manager-owned worker checkout has been validated. */
export const isolatedWorkerScope = new AsyncLocalStorage<true>()

interface WorkerDispatchSlots {
  run: <T>(owner: ThreadExecutionOwner, execute: () => Promise<T>) => Promise<T>
}
const workerDispatchSlots = new AsyncLocalStorage<WorkerDispatchSlots>()

/** The owning dispatcher supplies its existing primary-turn exclusion boundary. */
export function runWithWorkerDispatchSlots<T>(slots: WorkerDispatchSlots, execute: () => T): T {
  return workerDispatchSlots.run(slots, execute)
}

export function withIsolatedWorkerDispatchSlot<T>(
  owner: ThreadExecutionOwner,
  execute: () => Promise<T>,
): Promise<T> {
  const slots = workerDispatchSlots.getStore()
  if (!slots) return Promise.reject(new Error('Isolated workers require an owning dispatcher.'))
  return slots.run(owner, execute)
}
