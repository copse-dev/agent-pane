import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import type { PermissionSnapshot, SupervisedTaskMeta } from '@shared/supervisor/task-schema.ts'
import { isTerminalTaskState } from '@shared/supervisor/task-schema.ts'
import type { ThreadExecutionOwner } from '../thread-execution-context.ts'
import { runWithAgentRunReadonly } from '../agent-run-readonly.ts'
import type { TaskSupervisor } from '../supervisor/task-supervisor.ts'

export const READONLY_WORKER_LIMIT = 2
export const READONLY_WORKER_MAX_DURATION_MS = 120_000
export const READONLY_WORKER_CONCURRENCY_CLASS = 'native_readonly_worker'

export interface ReadonlyWorkerRequest {
  agent: string
  prompt: string
}

export interface ReadonlyWorkerResult {
  workerId: string
  agent: string
  state: SupervisedTaskMeta['state']
  report?: string
  error?: string
}

function settled(task: SupervisedTaskMeta): boolean {
  return isTerminalTaskState(task.state) || task.state === 'blocked'
}

/** Subscribe before checking, so a fast completion cannot strand the waiter. */
function waitForWorker(
  supervisor: TaskSupervisor,
  owner: ThreadExecutionOwner,
  workerId: string,
): Promise<SupervisedTaskMeta> {
  return new Promise((resolve) => {
    const unsubscribe = supervisor.subscribe((task) => {
      if (task.projectId === owner.projectId && task.taskId === workerId && settled(task)) {
        unsubscribe()
        resolve(task)
      }
    })
    const task = supervisor.get(owner.projectId, workerId)
    if (task && settled(task)) {
      unsubscribe()
      resolve(task)
    }
  })
}

/** One live parent turn's allowance. The supervisor remains the only scheduler. */
export function createReadonlyWorkerTurn(supervisor: TaskSupervisor): {
  run: (options: {
    owner: ThreadExecutionOwner
    permissionSnapshot: PermissionSnapshot
    requests: readonly ReadonlyWorkerRequest[]
    signal: AbortSignal
    execute: (
      request: ReadonlyWorkerRequest,
      workerId: string,
      signal: AbortSignal,
    ) => Promise<string>
  }) => Promise<ReadonlyWorkerResult[]>
} {
  let admitted = 0
  return {
    async run({
      owner,
      permissionSnapshot,
      requests,
      signal,
      execute,
    }): Promise<ReadonlyWorkerResult[]> {
      signal.throwIfAborted()
      if (requests.length < 1 || requests.length > READONLY_WORKER_LIMIT - admitted) {
        throw new Error('At most two read-only workers may run over one parent turn.')
      }
      // Reserve synchronously before the first await, including concurrent tool calls.
      admitted += requests.length
      const handler = `native_readonly_worker:${randomUUID()}`
      const reports = new Map<string, string>()
      const workers = requests.map((request) => ({ request, id: randomUUID() }))
      const runInParentContext = AsyncLocalStorage.snapshot()
      const unregister = supervisor.registerHandler(handler, async (task, context) => {
        const worker = workers.find(({ id }) => id === task.taskId)
        if (!worker || task.projectId !== owner.projectId || task.threadId !== owner.threadId) {
          throw new Error('Worker does not belong to this parent turn.')
        }
        context.signal.throwIfAborted()
        signal.throwIfAborted()
        const report = await runInParentContext(() =>
          runWithAgentRunReadonly(true, () => execute(worker.request, worker.id, context.signal)),
        )
        context.signal.throwIfAborted()
        reports.set(worker.id, report)
        return { resultRef: { kind: 'handler', ref: `tool-call:${worker.id}` } }
      })
      const cancelOwned = async (): Promise<void> => {
        await Promise.all(workers.map(({ id }) => supervisor.cancel(owner.projectId, id)))
      }
      // Keep cancellation failures observed; the awaited cleanup below retries them.
      const onAbort = (): void => {
        void cancelOwned().catch(() => undefined)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        for (const worker of workers) {
          await supervisor.enqueueOnce(worker.id, {
            ...owner,
            handler,
            agentId: worker.request.agent,
            provenance: 'agent',
            trigger: { kind: 'immediate' },
            permissionSnapshot,
            reapproveOnWake: false,
            concurrencyClass: READONLY_WORKER_CONCURRENCY_CLASS,
            maxAttempts: 1,
            restartPolicy: 'block',
            resourceBudget: { maxDurationMs: READONLY_WORKER_MAX_DURATION_MS, maxAttempts: 1 },
            contentHash: createHash('sha256').update(JSON.stringify(worker.request)).digest('hex'),
          })
          // Abort can win while the enqueue write is pending, before cancel can see it.
          if (signal.aborted) await supervisor.cancel(owner.projectId, worker.id)
        }
        return await Promise.all(
          workers.map(async (worker) => {
            const task = await waitForWorker(supervisor, owner, worker.id)
            const report = reports.get(worker.id)
            return {
              workerId: worker.id,
              agent: worker.request.agent,
              state: task.state,
              ...(task.state === 'completed' && report !== undefined ? { report } : {}),
              ...(task.state !== 'completed'
                ? { error: task.lastError ?? `Worker ${task.state}` }
                : {}),
            }
          }),
        )
      } finally {
        signal.removeEventListener('abort', onAbort)
        try {
          await cancelOwned()
        } finally {
          unregister()
        }
      }
    },
  }
}
