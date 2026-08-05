import { AsyncLocalStorage } from 'node:async_hooks'
import { isProjectSandboxEnabled } from '../../project-sandbox/index.ts'
import { resolveSshExecutionTargetForCwd } from '../ssh-workspace/execution-target.ts'
import { getSetting } from '../storage/settings.ts'
import type { ThreadExecutionOwner } from '../thread-execution-context.ts'
import type { TaskSupervisor } from '../supervisor/task-supervisor.ts'
import {
  startBackgroundProcess,
  stopBackgroundProcess,
  stopBackgroundProcessesForThread,
  type BackgroundProcessCompletion,
  type BackgroundProcessInfo,
  type StartBackgroundProcessOptions,
} from './background-process.ts'

export const BACKGROUND_PROCESS_HANDLER = 'shell_process'

let supervisor: TaskSupervisor | null = null
let disposeCanceller: (() => void) | null = null
let installationReferences = 0
const scopedSupervisor = new AsyncLocalStorage<TaskSupervisor>()
const taskIdsByProcess = new Map<string, string>()

function activeSupervisor(): TaskSupervisor | null {
  return scopedSupervisor.getStore() ?? supervisor
}

export function runWithBackgroundProcessSupervisor<T>(next: TaskSupervisor, fn: () => T): T {
  return scopedSupervisor.run(next, fn)
}

function processKey(owner: ThreadExecutionOwner, processId: string): string {
  return `${owner.projectId}:${owner.threadId}:${processId}`
}

export function installBackgroundProcessSupervisor(next: TaskSupervisor): () => void {
  if (supervisor && supervisor !== next) {
    throw new Error('A different background process supervisor is already installed')
  }
  if (!supervisor) {
    supervisor = next
    disposeCanceller = next.registerExternalCanceller(BACKGROUND_PROCESS_HANDLER, (task) => {
      if (!task.processHandleId) return
      stopBackgroundProcess(task.processHandleId, {
        projectId: task.projectId,
        threadId: task.threadId,
      })
      taskIdsByProcess.delete(
        processKey({ projectId: task.projectId, threadId: task.threadId }, task.processHandleId),
      )
    })
  }
  installationReferences += 1
  let released = false
  return () => {
    if (released) return
    released = true
    installationReferences -= 1
    if (installationReferences > 0) return
    disposeCanceller?.()
    disposeCanceller = null
    supervisor = null
    taskIdsByProcess.clear()
  }
}

export interface StartSupervisedBackgroundProcessOptions extends Omit<
  StartBackgroundProcessOptions,
  'owner' | 'onCompletion'
> {
  owner: ThreadExecutionOwner
  onCompletion?: (completion: BackgroundProcessCompletion) => void | Promise<void>
}

export async function startSupervisedBackgroundProcess(
  opts: StartSupervisedBackgroundProcessOptions,
): Promise<BackgroundProcessInfo> {
  const installedSupervisor = activeSupervisor()
  if (!installedSupervisor) throw new Error('Background process supervisor is unavailable')

  let completion: BackgroundProcessCompletion | null = null
  let supervisedTaskId: string | null = null
  let settled = false
  const settle = async (): Promise<void> => {
    if (settled || !completion || !supervisedTaskId) return
    settled = true
    taskIdsByProcess.delete(processKey(opts.owner, completion.info.id))
    const succeeded = completion.info.exitCode === 0 && !completion.info.timedOut
    const task = succeeded
      ? await installedSupervisor.completeExternal(opts.owner.projectId, supervisedTaskId, {
          kind: 'handler',
          ref: completion.info.id,
        })
      : await installedSupervisor.failExternal(
          opts.owner.projectId,
          supervisedTaskId,
          completion.info.timedOut
            ? 'background process timed out'
            : `background process exited with code ${String(completion.info.exitCode)}`,
        )
    if (task?.state !== (succeeded ? 'completed' : 'failed')) return
    await opts.onCompletion?.(completion)
  }

  const info = await startBackgroundProcess({
    ...opts,
    onCompletion: async (completed): Promise<void> => {
      completion = completed
      await settle()
    },
  })

  try {
    const executionTarget = resolveSshExecutionTargetForCwd(info.cwd)
    const task = await installedSupervisor.adoptRunning(
      {
        projectId: opts.owner.projectId,
        threadId: opts.owner.threadId,
        handler: BACKGROUND_PROCESS_HANDLER,
        provenance: 'agent',
        trigger: { kind: 'immediate' },
        permissionSnapshot: {
          capturedAt: Date.now(),
          autoRunSandboxCommands: getSetting<boolean>('autoRunSandboxCommands', true),
          projectSandboxEnabled: isProjectSandboxEnabled(),
          executionRoot: info.cwd,
          workspaceTargetKind: executionTarget?.kind ?? 'local',
          ...(executionTarget?.kind === 'ssh' ? { workspaceTargetId: executionTarget.hostId } : {}),
        },
        reapproveOnWake: true,
        concurrencyClass: BACKGROUND_PROCESS_HANDLER,
        ...(opts.timeoutMs !== undefined
          ? { resourceBudget: { maxDurationMs: opts.timeoutMs } }
          : {}),
        maxAttempts: 1,
      },
      info.id,
    )
    supervisedTaskId = task.taskId
    taskIdsByProcess.set(processKey(opts.owner, info.id), task.taskId)
    void settle().catch((error: unknown) => {
      console.warn('[supervised-background-process] completion failed:', error)
    })
    return info
  } catch (error) {
    stopBackgroundProcess(info.id, opts.owner)
    throw error
  }
}

export async function stopSupervisedBackgroundProcess(
  processId: string,
  owner: ThreadExecutionOwner,
): Promise<boolean> {
  const taskId = taskIdsByProcess.get(processKey(owner, processId))
  const installedSupervisor = activeSupervisor()
  if (taskId && installedSupervisor) {
    await installedSupervisor.cancel(owner.projectId, taskId)
    // Scoped/headless supervisors do not install the desktop singleton's
    // external canceller. Keep process termination as a fail-safe so their
    // metadata cannot say "cancelled" while the child continues running.
    stopBackgroundProcess(processId, owner)
    return true
  }
  return stopBackgroundProcess(processId, owner)
}

export async function cancelAllSupervisedBackgroundProcesses(): Promise<void> {
  const installedSupervisor = activeSupervisor()
  if (!installedSupervisor) return
  const tasks = installedSupervisor
    .list()
    .filter(
      (task) =>
        task.handler === BACKGROUND_PROCESS_HANDLER &&
        task.state === 'running' &&
        task.processHandleId !== undefined,
    )
  await Promise.all(tasks.map((task) => installedSupervisor.cancel(task.projectId, task.taskId)))
}

export async function stopSupervisedBackgroundProcessesForThread(
  owner: ThreadExecutionOwner,
): Promise<string[]> {
  const installedSupervisor = activeSupervisor()
  const tasks =
    installedSupervisor
      ?.list(owner.projectId)
      .filter(
        (task) =>
          task.threadId === owner.threadId &&
          task.handler === BACKGROUND_PROCESS_HANDLER &&
          task.state === 'running' &&
          task.processHandleId !== undefined,
      ) ?? []
  const processIds = tasks.flatMap((task) =>
    task.processHandleId === undefined ? [] : [task.processHandleId],
  )
  if (installedSupervisor) {
    await Promise.all(tasks.map((task) => installedSupervisor.cancel(task.projectId, task.taskId)))
  }
  const remaining = await stopBackgroundProcessesForThread(owner)
  return [...new Set([...processIds, ...remaining])]
}
