import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  createLongTask,
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

function formatTask(task: LongTask): string {
  const p = taskProgress(task)
  const head = `[${task.id}] ${task.title} — ${String(p.done)}/${String(p.total)}${p.complete ? ' ✓ complete' : ''}`
  const steps = task.steps.map((step) => `  ${step.done ? '[x]' : '[ ]'} ${step.id} ${step.label}`)
  const next = p.complete ? '' : `\n  next: ${p.nextStep ?? '(none)'}`
  return [head, ...steps].join('\n') + next
}

/**
 * Experimental long-horizon task tool (issue #558). Lets the agent keep a
 * durable, resumable checklist for a grind-it-out task within a PR (clearing a
 * lint backlog, a deep research pass) so progress survives across turns and
 * sessions and the agent knows when it is actually done. Registered only when
 * the `copse.long-horizon-tasks` first-party pack is enabled.
 */
export const trackLongTaskTool = defineTool({
  name: 'track_long_task',
  description:
    'Track a long, multi-step task within this PR durably across sessions. `create` records a goal and checklist; `check` marks a step done; `status` and `list` inspect progress; `continue` schedules one supervised follow-up turn. Use it for grind work so you can resume from the last checkpoint and know when every step is complete.',
  parameters: z.object({
    action: z.enum(['create', 'check', 'status', 'list', 'continue']),
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
  async execute({ action, title, goal, steps, taskId, stepId, done, delaySeconds }) {
    const owner = requireThreadExecutionOwner()
    const context =
      getThreadExecutionContext() ??
      (await resolveThreadExecutionContext(owner.projectId, owner.threadId))
    if (action === 'create') {
      if (!title?.trim()) return 'track_long_task create requires a title.'
      if (!steps || steps.length === 0) return 'track_long_task create requires at least one step.'
      const task = createLongTask({ title, goal: goal ?? '', steps }, context.projectRoot)
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
    const tasks = loadLongTasksForRoot(context.projectRoot)
    if (tasks.length === 0) {
      return 'No long tasks tracked. Use track_long_task create to start one.'
    }
    return tasks.map(formatTask).join('\n\n')
  },
})
