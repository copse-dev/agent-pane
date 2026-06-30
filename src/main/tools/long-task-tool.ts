import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  createLongTask,
  loadLongTasks,
  setStepDone,
  taskProgress,
  type LongTask,
} from '../services/long-task-tracker.ts'

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
 * `longHorizonTasksEnabled` is on.
 */
export const trackLongTaskTool = defineTool({
  name: 'track_long_task',
  description:
    'Track a long, multi-step task within this PR durably across sessions. `create` records a goal and a checklist of steps; `check` marks a step done (or undone); `status` shows progress and the next step; `list` shows all tracked tasks. Use it for grind work (lint/type backlogs, deep research) so you can resume from the last checkpoint and know when every step is complete.',
  parameters: z.object({
    action: z.enum(['create', 'check', 'status', 'list']),
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
  }),
  execute({ action, title, goal, steps, taskId, stepId, done }) {
    if (action === 'create') {
      if (!title?.trim()) return 'track_long_task create requires a title.'
      if (!steps || steps.length === 0) return 'track_long_task create requires at least one step.'
      const task = createLongTask({ title, goal: goal ?? '', steps })
      return `Created long task ${task.id}.\n${formatTask(task)}`
    }
    if (action === 'check') {
      if (!taskId || !stepId) return 'track_long_task check requires taskId and stepId.'
      const updated = setStepDone(taskId, stepId, done ?? true)
      if (!updated) return `No task/step matching ${taskId}/${stepId}.`
      const p = taskProgress(updated)
      const tail = p.complete ? ' — all steps complete ✓' : ` — next: ${p.nextStep ?? '(none)'}`
      return `Updated ${taskId}/${stepId} (${String(p.done)}/${String(p.total)})${tail}`
    }
    if (action === 'status') {
      if (!taskId) return 'track_long_task status requires a taskId.'
      const task = loadLongTasks().find((t) => t.id === taskId)
      return task ? formatTask(task) : `No task with id "${taskId}".`
    }
    const tasks = loadLongTasks()
    if (tasks.length === 0) {
      return 'No long tasks tracked. Use track_long_task create to start one.'
    }
    return tasks.map(formatTask).join('\n\n')
  },
})
