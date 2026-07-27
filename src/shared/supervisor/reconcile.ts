import {
  isTerminalTaskState,
  type SupervisedTaskAuditEvent,
  type SupervisedTaskMeta,
  type TaskState,
} from './task-schema.ts'

/**
 * Pure restart-shaped reconcile for supervised tasks (#1081 P1).
 *
 * Callers inject already-loaded metas + optional process-handle liveness.
 * No fs/Electron — P2 owns the singleton that reads disk and advances clocks.
 *
 * Rules (exit-gate coverage in reconcile.test.ts):
 * 1. Terminal states are unchanged.
 * 2. `running` + missing/dead `processHandleId` for shell handlers → `failed`.
 * 3. `running` agent/non-shell without a live handle → `waiting` (wake_at future)
 *    or `queued` (ready to resume).
 * 4. `waiting` + `wake_at` + `wakeAt <= now` → eligible wake id (no auto-start).
 * 5. `blocked` stays blocked.
 * 6. Empty input ⇒ `hasActiveWork: false` (inert when unused).
 */

export type ProcessHandleLiveness = ReadonlyMap<string, boolean>

export type ReconcileInput = {
  tasks: readonly SupervisedTaskMeta[]
  now: number
  processHandles?: ProcessHandleLiveness
}

export type ReconcilePatch = {
  taskId: string
  next: SupervisedTaskMeta
  audit: SupervisedTaskAuditEvent
}

export type ReconcileResult = {
  patches: ReconcilePatch[]
  /** Tasks whose wake_at has elapsed (or immediate) once a scheduler exists (P2). */
  eligibleWakeTaskIds: string[]
  /** Any non-terminal task remains. */
  hasActiveWork: boolean
}

const SHELL_HANDLER = 'shell_process'

function handleAlive(
  task: SupervisedTaskMeta,
  processHandles: ProcessHandleLiveness | undefined,
): boolean {
  const handleId = task.processHandleId
  if (!handleId) return false
  if (!processHandles) return false
  return processHandles.get(handleId) === true
}

function makeAudit(
  task: SupervisedTaskMeta,
  toState: TaskState,
  now: number,
  reason: string,
  detail?: Record<string, unknown>,
): SupervisedTaskAuditEvent {
  return {
    v: 1,
    id: `reconcile-${task.taskId}-${String(now)}`,
    taskId: task.taskId,
    action: toState === 'failed' ? 'fail' : 'reconcile',
    at: now,
    fromState: task.state,
    toState,
    actor: 'system',
    reason,
    detail,
  }
}

function patchTask(
  task: SupervisedTaskMeta,
  toState: TaskState,
  now: number,
  reason: string,
  extra?: Partial<SupervisedTaskMeta> & { clearProcessHandle?: boolean },
): ReconcilePatch {
  const { clearProcessHandle, ...rest } = extra ?? {}
  const base: SupervisedTaskMeta = {
    ...task,
    ...rest,
    state: toState,
    updatedAt: now,
    ...(toState === 'failed' || toState === 'completed' || toState === 'cancelled'
      ? { finishedAt: now }
      : {}),
  }
  const next: SupervisedTaskMeta = clearProcessHandle
    ? (() => {
        const { processHandleId: _drop, ...withoutHandle } = base
        return withoutHandle
      })()
    : base
  return {
    taskId: task.taskId,
    next,
    audit: makeAudit(
      task,
      toState,
      now,
      reason,
      rest.lastError ? { lastError: rest.lastError } : undefined,
    ),
  }
}

function isWakeEligible(task: SupervisedTaskMeta, now: number): boolean {
  if (task.state !== 'waiting' && task.state !== 'queued') return false
  if (task.trigger.kind === 'immediate') return task.state === 'queued' || task.state === 'waiting'
  if (task.trigger.kind === 'wake_at') return task.trigger.wakeAt <= now
  return false
}

/**
 * Reconcile persisted tasks after a main-process start (or fake-clock advance).
 * Does not flip eligible wakes to `running` — that requires the P2 executor.
 */
export function reconcileSupervisedTasks(input: ReconcileInput): ReconcileResult {
  const { tasks, now, processHandles } = input
  const patches: ReconcilePatch[] = []
  const eligibleWakeTaskIds: string[] = []

  const byId = new Map<string, SupervisedTaskMeta>()
  for (const task of tasks) {
    byId.set(task.taskId, task)
  }

  for (const task of tasks) {
    if (isTerminalTaskState(task.state)) {
      continue
    }

    if (task.state === 'running') {
      const alive = handleAlive(task, processHandles)
      if (!alive) {
        if (task.handler === SHELL_HANDLER || task.processHandleId) {
          const lost = patchTask(task, 'failed', now, 'process handle lost on restart', {
            lastError: 'process handle lost on restart',
            clearProcessHandle: true,
          })
          patches.push(lost)
          byId.set(task.taskId, lost.next)
          continue
        }
        // Agent-turn / deterministic jobs: demote to waiting/queued for P2 resume.
        const toState: TaskState =
          task.trigger.kind === 'wake_at' && task.trigger.wakeAt > now ? 'waiting' : 'queued'
        const demoted = patchTask(task, toState, now, 'running task had no live process handle after restart')
        patches.push(demoted)
        byId.set(task.taskId, demoted.next)
        continue
      }
    }

    // blocked stays blocked; waiting/queued may become eligible below.
  }

  for (const task of byId.values()) {
    if (isTerminalTaskState(task.state)) continue
    if (task.state === 'blocked') continue
    if (isWakeEligible(task, now)) {
      eligibleWakeTaskIds.push(task.taskId)
    }
  }

  let hasActiveWork = false
  for (const task of byId.values()) {
    if (!isTerminalTaskState(task.state)) {
      hasActiveWork = true
      break
    }
  }

  return { patches, eligibleWakeTaskIds, hasActiveWork }
}
