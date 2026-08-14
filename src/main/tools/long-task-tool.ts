import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  createLongTask,
  isOwnedByThread,
  loadLongTasksForRoot,
  setStepDone,
  taskProgress,
  type LongTask,
} from '../services/storage/long-task-tracker.ts'
import {
  getThreadExecutionContext,
  requireThreadExecutionOwner,
  resolveThreadExecutionContext,
} from '../services/thread-execution-context.ts'
import { getActiveRunTurnTreeId } from '../services/thread-models.ts'
import { scheduleLongTaskWake } from '../services/supervisor/long-task-wake.ts'

/**
 * One task as a checklist. `viewerThreadId` marks ownership, and is passed only
 * by the workspace-wide listing — where the whole point is telling this thread's
 * work apart from everyone else's.
 */
function formatTask(task: LongTask, viewerThreadId?: string): string {
  const p = taskProgress(task)
  const owner =
    viewerThreadId === undefined
      ? ''
      : isOwnedByThread(task, viewerThreadId)
        ? ' [this thread]'
        : ' [another thread]'
  const head = `[${task.id}]${owner} ${task.title} — ${String(p.done)}/${String(p.total)}${p.complete ? ' ✓ complete' : ''}`
  const steps = task.steps.map((step) => `  ${step.done ? '[x]' : '[ ]'} ${step.id} ${step.label}`)
  const next = p.complete ? '' : `\n  next: ${p.nextStep ?? '(none)'}`
  return [head, ...steps].join('\n') + next
}

/**
 * Experimental long-horizon task tool (issue #558). Lets the agent keep a
 * durable, resumable checklist for a grind-it-out task within a PR (clearing a
 * lint backlog, a deep research pass) so progress survives across turns and
 * sessions and the agent knows when it is actually done. Registered only when
 * the `copse.long-horizon-tasks` first-party plugin is enabled.
 *
 * The store is namespaced per workspace root, not per thread, so `list` filters
 * to the calling thread's own tasks. It used to return every task in the
 * workspace: a turn that had lost its context read that as its own plan and
 * resumed whatever was unfinished, which is how one thread ended up
 * implementing another thread's feature. Lookups by explicit id (`status`,
 * `check`, `continue`) stay workspace-wide — an id has to come from somewhere,
 * and the supervised wake path resolves tasks that way.
 */
export const trackLongTaskTool = defineTool({
  name: 'track_long_task',
  description:
    "Track a long, multi-step task for this thread durably across sessions. `create` records a goal and checklist; `check` marks a step done; `status` and `list` inspect progress; `continue` schedules one supervised follow-up turn. Use it for grind work so you can resume from the last checkpoint and know when every step is complete. `list` shows only this thread's tasks — other threads in the workspace keep their own, and theirs are not yours to resume.",
  parameters: z.object({
    action: z.enum(['create', 'check', 'status', 'list', 'continue']),
    scope: z
      .enum(['thread', 'workspace'])
      .optional()
      .describe(
        'For action=list: "thread" (default) lists this thread\'s tasks; "workspace" lists every task in the workspace, including other threads\'.',
      ),
    title: z.string().optional().describe('For action=create: short task title.'),
    goal: z
      .string()
      .optional()
      .describe('For action=create: the terminal condition, e.g. "lint count to zero".'),
    steps: z
      .array(z.string())
      .optional()
      .describe('For action=create: ordered step labels for the checklist.'),
    taskId: z.string().optional().describe('For check/status: the task id, e.g. "t1".'),
    stepId: z.string().optional().describe('For action=check: the step id, e.g. "s3".'),
    done: z
      .boolean()
      .optional()
      .describe('For action=check: whether the step is done (default true).'),
    delaySeconds: z
      .number()
      .min(0.1)
      .max(3600)
      .optional()
      .describe('For action=continue: delay before one supervised continuation (default 1s).'),
  }),
  async execute({ action, scope, title, goal, steps, taskId, stepId, done, delaySeconds }) {
    const owner = requireThreadExecutionOwner()
    const context =
      getThreadExecutionContext() ??
      (await resolveThreadExecutionContext(owner.projectId, owner.threadId))
    if (action === 'create') {
      if (!title?.trim()) return 'track_long_task create requires a title.'
      if (!steps || steps.length === 0) return 'track_long_task create requires at least one step.'
      const task = createLongTask(
        { title, goal: goal ?? '', steps, threadId: owner.threadId },
        context.projectRoot,
      )
      return `Created long task ${task.id}.\n${formatTask(task)}`
    }
    if (action === 'check') {
      if (!taskId || !stepId) return 'track_long_task check requires taskId and stepId.'
      const updated = setStepDone(taskId, stepId, done ?? true, context.projectRoot)
      if (!updated) return `No task/step matching ${taskId}/${stepId}.`
      const p = taskProgress(updated)
      const tail = p.complete ? ' — all steps complete ✓' : ` — next: ${p.nextStep ?? '(none)'}`
      return `Updated ${taskId}/${stepId} (${String(p.done)}/${String(p.total)})${tail}`
    }
    if (action === 'status') {
      if (!taskId) return 'track_long_task status requires a taskId.'
      const task = loadLongTasksForRoot(context.projectRoot).find((t) => t.id === taskId)
      return task ? formatTask(task) : `No task with id "${taskId}".`
    }
    if (action === 'continue') {
      if (!taskId) return 'track_long_task continue requires a taskId.'
      const task = loadLongTasksForRoot(context.projectRoot).find(
        (candidate) => candidate.id === taskId,
      )
      if (!task) return `No task with id "${taskId}".`
      if (taskProgress(task).complete) return `Long task ${taskId} is already complete.`
      const turnTreeId = getActiveRunTurnTreeId()
      if (!turnTreeId) return 'Cannot schedule a continuation outside an active turn tree.'
      const scheduled = await scheduleLongTaskWake({
        context,
        turnTreeId,
        longTaskId: taskId,
        delayMs: (delaySeconds ?? 1) * 1_000,
      })
      return `Scheduled one supervised continuation for long task ${taskId} at ${new Date(scheduled.wakeAt).toISOString()} (task ${scheduled.taskId}).`
    }
    const all = loadLongTasksForRoot(context.projectRoot)
    if (scope === 'workspace') {
      if (all.length === 0) {
        return 'No long tasks tracked in this workspace. Use track_long_task create to start one.'
      }
      return all.map((task) => formatTask(task, owner.threadId)).join('\n\n')
    }
    // The store is per workspace root, so an unfiltered list hands this thread
    // every other thread's checklist. A turn that has lost its context reads
    // that as its own plan and picks up whatever is unfinished — which is how an
    // unrelated task gets adopted. Other threads' work is reported as a count,
    // not as a to-do list.
    const mine = all.filter((task) => isOwnedByThread(task, owner.threadId))
    const others = all.length - mine.length
    const elsewhere =
      others > 0
        ? `\n\n(${String(others)} other long task${others === 1 ? '' : 's'} in this workspace belong${
            others === 1 ? 's' : ''
          } to other threads. They are not this thread's to resume; pass scope "workspace" to see them.)`
        : ''
    if (mine.length === 0) {
      return `No long tasks tracked for this thread. Use track_long_task create to start one.${elsewhere}`
    }
    return `${mine.map((task) => formatTask(task)).join('\n\n')}${elsewhere}`
  },
})
