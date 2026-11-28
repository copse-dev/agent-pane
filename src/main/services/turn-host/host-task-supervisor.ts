import type { SupervisedTaskMeta, TaskResultRef } from '@shared/supervisor/task-schema.ts'
import type { BackgroundProcessSupervisor } from '../exec/supervised-background-process.ts'
import type {
  EnqueueSupervisedTaskInput,
  SupervisedExternalTaskCanceller,
} from '../supervisor/task-supervisor.ts'

/**
 * Background commands for host turns (`docs/plans/local-turn-worker.md`,
 * "Every turn in a turn host", H7).
 *
 * A command a host turn sends to the background runs in the host, but its task
 * record is the app's: the app's task supervisor owns the profile's task store,
 * shows the Background tasks control, and cancels from it. So the host's
 * supervisor keeps no store of its own. It asks the app to adopt, settle and
 * cancel each task, keeps a copy of the records it got back for the reads the
 * command makes, and takes the app's later changes to them (`changed`).
 */

export type HostTaskCall =
  | { op: 'adopt'; input: EnqueueSupervisedTaskInput; processHandle: string }
  | { op: 'complete'; projectId: string; taskId: string; resultRef?: TaskResultRef | undefined }
  | { op: 'fail'; projectId: string; taskId: string; reason: string }
  | { op: 'cancel'; projectId: string; taskId: string }

export type HostTaskCallResult = { task: SupervisedTaskMeta | null } | { error: string }

const key = (projectId: string, taskId: string): string => `${projectId}\0${taskId}`

export class HostTaskSupervisor implements BackgroundProcessSupervisor {
  private readonly tasks = new Map<string, SupervisedTaskMeta>()
  private readonly cancellers = new Map<string, SupervisedExternalTaskCanceller>()
  private readonly call: (call: HostTaskCall) => Promise<HostTaskCallResult>

  constructor(call: (call: HostTaskCall) => Promise<HostTaskCallResult>) {
    this.call = call
  }

  registerExternalCanceller(kind: string, canceller: SupervisedExternalTaskCanceller): () => void {
    this.cancellers.set(kind, canceller)
    return () => {
      if (this.cancellers.get(kind) === canceller) this.cancellers.delete(kind)
    }
  }

  async adoptRunning(
    input: EnqueueSupervisedTaskInput,
    processHandle: string,
  ): Promise<SupervisedTaskMeta> {
    const task = await this.ask({ op: 'adopt', input, processHandle })
    if (!task) throw new Error('The app did not record the background task.')
    return task
  }

  completeExternal(
    projectId: string,
    taskId: string,
    resultRef?: TaskResultRef,
  ): Promise<SupervisedTaskMeta | null> {
    return this.ask({ op: 'complete', projectId, taskId, resultRef })
  }

  failExternal(
    projectId: string,
    taskId: string,
    reason: string,
  ): Promise<SupervisedTaskMeta | null> {
    return this.ask({ op: 'fail', projectId, taskId, reason })
  }

  cancel(projectId: string, taskId: string): Promise<SupervisedTaskMeta | null> {
    return this.ask({ op: 'cancel', projectId, taskId })
  }

  get(projectId: string, taskId: string): SupervisedTaskMeta | null {
    const task = this.tasks.get(key(projectId, taskId))
    return task ? structuredClone(task) : null
  }

  list(projectId?: string): SupervisedTaskMeta[] {
    return [...this.tasks.values()]
      .filter((task) => projectId === undefined || task.projectId === projectId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((task) => structuredClone(task))
  }

  /**
   * The app changed a task this host runs (a cancel from the Background tasks
   * control, say). A cancel stops the process here as the app's own would.
   */
  changed(task: SupervisedTaskMeta): void {
    const previous = this.tasks.get(key(task.projectId, task.taskId))
    if (!previous) return
    this.remember(task)
    if (previous.state === 'running' && task.state === 'cancelled') {
      void Promise.resolve(this.cancellers.get(task.handler)?.(task)).catch(() => undefined)
    }
  }

  /** Whether this host runs the command behind a task the app holds. */
  runs(task: Pick<SupervisedTaskMeta, 'projectId' | 'taskId'>): boolean {
    return this.tasks.has(key(task.projectId, task.taskId))
  }

  private async ask(call: HostTaskCall): Promise<SupervisedTaskMeta | null> {
    const result = await this.call(call)
    if ('error' in result) throw new Error(result.error)
    if (result.task) this.remember(result.task)
    return result.task
  }

  private remember(task: SupervisedTaskMeta): void {
    this.tasks.set(key(task.projectId, task.taskId), structuredClone(task))
  }
}
