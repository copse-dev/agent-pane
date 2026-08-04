import { LONG_HORIZON_TASKS_PACK_ID } from '@copse/agent/packs/long-horizon-tasks-pack.ts'
import { getDefaultPackRegistry } from '@copse/agent/packs/default-pack-registry.ts'
import type { TurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import { createHash } from 'node:crypto'
import type { MachineAgentDispatchRequest, MachineDispatchResult } from '../agent-dispatcher.ts'
import { abortAgent } from '../agent-service.ts'
import { isProjectSandboxEnabled } from '../../project-sandbox/index.ts'
import { getSetting } from '../storage/settings.ts'
import { resolveSshExecutionTargetForCwd } from '../ssh-workspace/execution-target.ts'
import { loadLongTasksForRoot, taskProgress, type LongTask } from '../storage/long-task-tracker.ts'
import type { ThreadExecutionContext } from '../thread-execution-context.ts'
import { resolveThreadExecutionContext } from '../thread-execution-context.ts'
import type { TaskSupervisor } from './task-supervisor.ts'

export const LONG_TASK_CONTINUE_HANDLER = 'long_horizon_continue'

export interface ScheduleLongTaskWakeRequest {
  context: ThreadExecutionContext
  turnTreeId: TurnTreeId
  longTaskId: string
  delayMs: number
}

export interface ScheduleLongTaskWakeResult {
  taskId: string
  wakeAt: number
}

type LongTaskWakeScheduler = (
  request: ScheduleLongTaskWakeRequest,
) => Promise<ScheduleLongTaskWakeResult>

let scheduler: LongTaskWakeScheduler | null = null

export interface LongTaskWakeDispatcher {
  dispatchMachine(request: MachineAgentDispatchRequest): Promise<MachineDispatchResult>
}

export interface LongTaskWakeDependencies {
  isPackEnabled: () => boolean
  resolveContext: (projectId: string, threadId: string) => Promise<ThreadExecutionContext>
  autoRunSandboxCommands: () => boolean
  projectSandboxEnabled: () => boolean
  workspaceTarget: (executionRoot: string) => {
    kind: 'local' | 'ssh'
    id?: string
  }
  loadTasks: (root: string) => LongTask[]
  now: () => number
  abortThread: (threadId: string) => void
}

const defaultDependencies: LongTaskWakeDependencies = {
  isPackEnabled: () => getDefaultPackRegistry().isEnabled(LONG_HORIZON_TASKS_PACK_ID),
  resolveContext: resolveThreadExecutionContext,
  autoRunSandboxCommands: () => getSetting<boolean>('autoRunSandboxCommands', true),
  projectSandboxEnabled: isProjectSandboxEnabled,
  workspaceTarget: (executionRoot) => {
    const target = resolveSshExecutionTargetForCwd(executionRoot)
    return target?.kind === 'ssh' ? { kind: 'ssh', id: target.hostId } : { kind: 'local' }
  },
  loadTasks: loadLongTasksForRoot,
  now: Date.now,
  abortThread: abortAgent,
}

export function setLongTaskWakeScheduler(next: LongTaskWakeScheduler | null): void {
  scheduler = next
}

export function scheduleLongTaskWake(
  request: ScheduleLongTaskWakeRequest,
): Promise<ScheduleLongTaskWakeResult> {
  if (!scheduler) return Promise.reject(new Error('Long-task wake scheduling is unavailable'))
  return scheduler(request)
}

function continuationPrompt(
  root: string,
  longTaskId: string,
  dependencies: LongTaskWakeDependencies,
): string | null {
  const pending = dependencies
    .loadTasks(root)
    .filter((task) => task.id === longTaskId)
    .map((task) => ({ task, progress: taskProgress(task) }))
    .filter(({ progress }) => !progress.complete)
  if (pending.length === 0) return null
  const checklist = pending
    .map(
      ({ task, progress }) =>
        `- ${task.id}: ${task.title} (${String(progress.done)}/${String(progress.total)}); next: ${progress.nextStep ?? '(none)'}; goal: ${task.goal}`,
    )
    .join('\n')
  return `Continue the opted-in long-horizon work for this project.\n${checklist}\n\nUse track_long_task to record completed steps. Do one bounded useful chunk. Before ending, if checklist work remains and another autonomous turn is justified, call track_long_task with action "continue" to schedule exactly one next wake.`
}

function dispatchResultRef(result: MachineDispatchResult): { kind: 'handler'; ref: string } {
  return { kind: 'handler', ref: `agent-dispatch:${result}` }
}

function executionIdentity(context: ThreadExecutionContext): string {
  return createHash('sha256')
    .update(
      JSON.stringify([context.projectRoot, context.root, context.checkoutMode, context.branch]),
    )
    .digest('hex')
}

export function installLongTaskWakeConsumer(
  supervisor: TaskSupervisor,
  dispatcher: LongTaskWakeDispatcher,
  dependencies: LongTaskWakeDependencies = defaultDependencies,
): () => void {
  const unregister = supervisor.registerHandler(
    LONG_TASK_CONTINUE_HANDLER,
    async (task, { signal }) => {
      signal.throwIfAborted()
      if (!dependencies.isPackEnabled()) {
        return { resultRef: { kind: 'handler', ref: 'pack-disabled' } }
      }
      if (!task.turnId) return { blockedReason: 'Long-task wake is missing its turn-tree epoch' }
      let context: ThreadExecutionContext
      try {
        context = await dependencies.resolveContext(task.projectId, task.threadId)
      } catch (error) {
        return {
          blockedReason:
            error instanceof Error ? error.message : 'Thread execution context is unavailable',
        }
      }
      const snapshot = task.permissionSnapshot
      const workspaceTarget = dependencies.workspaceTarget(context.root)
      const permissionsChanged =
        snapshot.autoRunSandboxCommands !== dependencies.autoRunSandboxCommands() ||
        snapshot.projectSandboxEnabled !== dependencies.projectSandboxEnabled() ||
        snapshot.workspaceTargetKind !== workspaceTarget.kind ||
        snapshot.workspaceTargetId !== workspaceTarget.id ||
        (snapshot.executionRoot !== undefined && snapshot.executionRoot !== context.root)
      if (permissionsChanged || task.contentHash !== executionIdentity(context)) {
        return {
          blockedReason:
            'Execution permissions or workspace changed after this long-task wake was scheduled',
        }
      }
      if (task.reapproveOnWake) {
        return { blockedReason: 'Long-task wake requires explicit approval before dispatch' }
      }
      if (!task.parentTaskId) return { blockedReason: 'Long-task wake has no checklist owner' }
      const prompt = continuationPrompt(context.projectRoot, task.parentTaskId, dependencies)
      if (!prompt) return { resultRef: { kind: 'handler', ref: 'no-incomplete-long-tasks' } }
      signal.throwIfAborted()
      const abort = (): void => {
        dependencies.abortThread(task.threadId)
      }
      signal.addEventListener('abort', abort, { once: true })
      let result: MachineDispatchResult
      try {
        result = await dispatcher.dispatchMachine({
          projectId: task.projectId,
          threadId: task.threadId,
          operationId: task.taskId,
          turnTreeId: task.turnId,
          payload: {
            userContent: prompt,
            invokedSkills: [],
            priorTodos: [],
          },
        })
      } finally {
        signal.removeEventListener('abort', abort)
      }
      if (result === 'stale') {
        return { blockedReason: 'Long-task wake belongs to a stale turn-tree epoch' }
      }
      if (result === 'budget-exhausted') {
        return { blockedReason: 'Long-task wake exhausted the machine-continuation budget' }
      }
      return { resultRef: dispatchResultRef(result) }
    },
  )

  setLongTaskWakeScheduler(async ({ context, turnTreeId, longTaskId, delayMs }) => {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error('Long-task wake delay must be a non-negative number of milliseconds')
    }
    const existing = supervisor
      .list(context.projectId)
      .find(
        (task) =>
          task.threadId === context.threadId &&
          task.handler === LONG_TASK_CONTINUE_HANDLER &&
          task.parentTaskId === longTaskId &&
          (task.state === 'queued' || task.state === 'waiting'),
      )
    if (existing) {
      const wakeAt =
        existing.trigger.kind === 'wake_at' ? existing.trigger.wakeAt : existing.createdAt
      return { taskId: existing.taskId, wakeAt }
    }
    const now = dependencies.now()
    const wakeAt = now + delayMs
    const workspaceTarget = dependencies.workspaceTarget(context.root)
    const task = await supervisor.enqueue({
      projectId: context.projectId,
      threadId: context.threadId,
      parentTaskId: longTaskId,
      handler: LONG_TASK_CONTINUE_HANDLER,
      provenance: 'agent',
      trigger: { kind: 'wake_at', wakeAt },
      permissionSnapshot: {
        capturedAt: now,
        autoRunSandboxCommands: dependencies.autoRunSandboxCommands(),
        projectSandboxEnabled: dependencies.projectSandboxEnabled(),
        workspaceTargetKind: workspaceTarget.kind,
        ...(workspaceTarget.id ? { workspaceTargetId: workspaceTarget.id } : {}),
        executionRoot: context.root,
      },
      reapproveOnWake: false,
      concurrencyClass: 'agent',
      maxAttempts: 1,
      contentHash: executionIdentity(context),
      turnId: turnTreeId,
    })
    return { taskId: task.taskId, wakeAt }
  })

  return () => {
    setLongTaskWakeScheduler(null)
    unregister()
  }
}
