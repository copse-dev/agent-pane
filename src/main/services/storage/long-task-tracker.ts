import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { at } from '@shared/array-utils.ts'
import { getActiveProjectRoot } from '../workspace.ts'
import { copseDataRoot } from './copse-paths.ts'
import { projectStoreNamespaceDir } from './project-namespace.ts'

/**
 * Experimental, opt-in "long-horizon tasks" feature (tracked in
 * https://github.com/jonathanKingston/agent-pane/issues/558).
 *
 * Some work within a single PR is a grind, not a one-shot: clearing a large
 * lint/type-safety backlog (cf. #508), or a deep research/investigation pass.
 * This gives the agent a durable, resumable checkpoint for such a task — a
 * checklist of steps with done/remaining state and a cursor — so it can sustain
 * progress across many turns and sessions, resume after an interruption, and
 * know when it is actually finished rather than stopping after one round.
 *
 * State persists per project as JSON under
 * `~/.copse/long-tasks/<workspace>/tasks.json` (mirroring the memories store's
 * workspace namespacing). It complements the in-thread `todos` (#530), which is
 * scoped to a single thread; a long task outlives the *turn* but still belongs
 * to the thread that opened it — see {@link isOwnedByThread}. Off by default:
 * the `copse.long-horizon-tasks` first-party pack gates the `track_long_task`
 * tool registration (see `registry-bootstrap.ts`) so the feature is fully inert
 * until the user opts in via Settings → Packs.
 */

const stepSchema = z.object({
  id: z.string(),
  label: z.string(),
  done: z.boolean(),
})

export type LongTaskStep = z.infer<typeof stepSchema>

const longTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  steps: z.array(stepSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * Thread that created the task. The store is per workspace root, so without
   * this every thread in a project reads every other thread's checklist as if it
   * were its own plan. Optional because tasks written before this field existed
   * name no owner; {@link isOwnedByThread} treats those as belonging to no
   * thread rather than to whichever one asks.
   */
  threadId: z.string().optional(),
})

export type LongTask = z.infer<typeof longTaskSchema>

const longTaskFileSchema = z.object({ tasks: z.array(longTaskSchema) })

export interface LongTaskProgress {
  done: number
  total: number
  /** True once every step is done (the task's terminal condition). */
  complete: boolean
  /** The next not-done step's label, or null when complete. */
  nextStep: string | null
}

let rootOverride: string | null = null

/** @internal test helper — point the store at a temp dir instead of `~/.copse`. */
export function setLongTaskRootForTest(path: string | null): void {
  rootOverride = path
}

function longTaskBaseDir(): string {
  return rootOverride ?? join(copseDataRoot(), 'long-tasks')
}

function longTaskFile(root?: string | null): string {
  const scope = root === undefined ? getActiveProjectRoot() : root
  return join(projectStoreNamespaceDir(longTaskBaseDir(), scope), 'tasks.json')
}

/** Load this project's long tasks, oldest first. Missing/corrupt file → []. */
export function loadLongTasks(): LongTask[] {
  return loadLongTasksForRoot(getActiveProjectRoot())
}

/** Load long tasks for an explicitly trusted project root. */
export function loadLongTasksForRoot(root: string | null): LongTask[] {
  let raw: string
  try {
    raw = readFileSync(longTaskFile(root), 'utf8')
  } catch {
    return []
  }
  try {
    return longTaskFileSchema.parse(JSON.parse(raw)).tasks
  } catch {
    return []
  }
}

function writeLongTasks(tasks: LongTask[], root?: string | null): void {
  const file = longTaskFile(root)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ tasks }, null, 2)}\n`)
}

function nextId(existing: LongTask[]): string {
  const max = existing.reduce((acc, task) => {
    const n = Number.parseInt(task.id.replace(/^t/, ''), 10)
    return Number.isFinite(n) && n > acc ? n : acc
  }, 0)
  return `t${String(max + 1)}`
}

export interface CreateLongTaskInput {
  title: string
  goal: string
  steps: string[]
  /** Owning thread; omitted only by callers with no thread of their own. */
  threadId?: string
}

/**
 * Whether `task` is this thread's to resume.
 *
 * A task with no recorded owner (written before tasks carried one) belongs to no
 * thread. Handing it to whichever thread happens to ask is how an unrelated
 * checklist gets adopted as the current plan, so unowned tasks stay visible only
 * through an explicit workspace-wide listing.
 */
export function isOwnedByThread(task: LongTask, threadId: string): boolean {
  return task.threadId !== undefined && task.threadId === threadId
}

/** Create a long task with a checklist of step labels. */
export function createLongTask(
  input: CreateLongTaskInput,
  root: string | null = getActiveProjectRoot(),
): LongTask {
  const tasks = loadLongTasksForRoot(root)
  const now = new Date().toISOString()
  const task: LongTask = {
    id: nextId(tasks),
    title: input.title.trim(),
    goal: input.goal.trim(),
    steps: input.steps.map((label, i) => ({
      id: `s${String(i + 1)}`,
      label: label.trim(),
      done: false,
    })),
    createdAt: now,
    updatedAt: now,
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
  }
  writeLongTasks([...tasks, task], root)
  return task
}

/** Mark a step done/undone. Returns the updated task, or null if not found. */
export function setStepDone(
  taskId: string,
  stepId: string,
  done: boolean,
  root: string | null = getActiveProjectRoot(),
): LongTask | null {
  const tasks = loadLongTasksForRoot(root)
  const taskIndex = tasks.findIndex((task) => task.id === taskId)
  if (taskIndex === -1) return null
  const task = at(tasks, taskIndex)
  const stepIndex = task.steps.findIndex((step) => step.id === stepId)
  if (stepIndex === -1) return null
  const steps = task.steps.map((step) => (step.id === stepId ? { ...step, done } : step))
  const updated: LongTask = { ...task, steps, updatedAt: new Date().toISOString() }
  tasks[taskIndex] = updated
  writeLongTasks(tasks, root)
  return updated
}

/** Progress summary for a task: counts, completion, and the next step to do. */
export function taskProgress(task: LongTask): LongTaskProgress {
  const done = task.steps.filter((step) => step.done).length
  const next = task.steps.find((step) => !step.done)
  return {
    done,
    total: task.steps.length,
    complete: task.steps.length > 0 && done === task.steps.length,
    nextStep: next ? next.label : null,
  }
}
