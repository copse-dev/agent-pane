import { randomUUID } from 'node:crypto'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import type {
  AutomationFailureCode,
  AutomationSchedulerHealth,
  AutomationPermission,
  AutomationProblem,
  AutomationCleanupResult,
  AutomationPermissionOption,
  AutomationRetainedWorktree,
  AutomationSchedule,
  AutomationScheduleInput,
  AutomationTriggerEvent,
  Thread,
} from '@shared/types'
import { AUTOMATION_RETAINED_REASONS, automationPermissionKey } from '@shared/types'
import { automationRunBlock } from '@shared/automation-run-state.ts'
import { classifyAutomationFailureMessage } from '@shared/automation-failure.ts'
import { getPluginService } from '../plugins/plugin-service.ts'
import { storageGet, storageUpdate } from '../storage/storage.ts'
import { createThread, loadProjectThreads } from '../thread-store.ts'
import {
  releaseCompletedAutomationWorktree,
  type AutomationWorktreeRelease,
} from '../worktree-parking.ts'
import { getAutomationWorktreeReuse } from '../automation-worktree-reuse.ts'
import { listMcpPermissionCandidates } from '../mcp/mcp-registry.ts'
import { parseMcpToolName } from '../mcp/mcp-config.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { cronMatches, validateCronExpression } from './cron.ts'
import {
  getTaskSupervisor,
  type EnqueueSupervisedTaskInput,
  type SupervisedTaskHandler,
} from '../supervisor/task-supervisor.ts'
import type { SupervisedTaskMeta } from '@shared/supervisor/task-schema.ts'

const STORAGE_KEY = `plugin.${AUTOMATIONS_PLUGIN_ID}.storage`
const SCHEDULER_HANDLER = 'automation_scheduler_tick'
const SCHEDULER_MAX_DURATION_MS = 120_000
const SCHEDULER_RECOVERY_DELAY_MS = 5_000
/** How late a wake may be and still run the minute it was armed for rather than the current one. */
const MAX_WAKE_LATENESS_MS = 2 * 60_000

interface CopseAutomationAction {
  toolName: string
  label: string
  detail: string
}

const COPSE_AUTOMATION_ACTIONS: readonly CopseAutomationAction[] = [
  {
    toolName: 'gh_pr_create',
    label: 'Create pull requests',
    detail: 'Pushes the current thread branch and opens a pull request in this project repository.',
  },
  {
    toolName: 'gh_pr_rerun_failed_ci',
    label: 'Re-run failed CI',
    detail: 'Re-runs failed checks for pull requests in this project repository.',
  },
  {
    toolName: 'gh_pr_approve',
    label: 'Approve pull requests',
    detail: 'Submits a GitHub approval for pull requests in this project repository.',
  },
  {
    toolName: 'gh_pr_mark_ready',
    label: 'Mark pull requests ready',
    detail: 'Moves draft pull requests in this project repository into review.',
  },
  {
    toolName: 'gh_pr_enable_auto_merge',
    label: 'Enable pull request auto-merge',
    detail: 'Enables the repository-preferred auto-merge strategy for a pull request.',
  },
]

function isAutomationPermission(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    (value['kind'] === 'copse-action' || value['kind'] === 'mcp-tool') &&
    typeof value['toolName'] === 'string' &&
    value['toolName'].length > 0 &&
    value['toolName'].length <= 512
  )
}

function normalizePermissions(
  permissions: readonly AutomationPermission[],
): AutomationPermission[] {
  const unique = new Map<string, AutomationPermission>()
  for (const permission of permissions) {
    unique.set(automationPermissionKey(permission), permission)
  }
  return [...unique.values()]
}

function humanizeToolName(toolName: string): string {
  const spaced = toolName.replace(/[_-]+/g, ' ').trim()
  return spaced ? `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}` : toolName
}

function mcpPermissionDetail(
  candidate: ReturnType<typeof listMcpPermissionCandidates>[number],
): string {
  const hints: string[] = [`${candidate.server} MCP server`]
  if (candidate.annotations?.destructiveHint) hints.push('marked destructive')
  else if (candidate.annotations?.readOnlyHint) hints.push('marked read-only')
  if (candidate.annotations?.openWorldHint) hints.push('may access external systems')
  return hints.join(' · ')
}

function permissionOptions(): AutomationPermissionOption[] {
  const copse = COPSE_AUTOMATION_ACTIONS.map((action): AutomationPermissionOption => ({
    permission: { kind: 'copse-action', toolName: action.toolName },
    label: action.label,
    detail: action.detail,
  }))
  const mcp = listMcpPermissionCandidates().map((candidate): AutomationPermissionOption => {
    const parsed = parseMcpToolName(candidate.toolName)
    const annotatedTitle = candidate.annotations?.title?.trim()
    return {
      permission: { kind: 'mcp-tool', toolName: candidate.toolName },
      label:
        annotatedTitle && annotatedTitle.length > 0
          ? annotatedTitle
          : humanizeToolName(parsed?.tool ?? candidate.toolName),
      detail: mcpPermissionDetail(candidate),
    }
  })
  return [...copse, ...mcp]
}

function canGrantPermissionFromPrompt(permission: AutomationPermission): boolean {
  if (!isAutomationPermission(permission)) return false
  if (permission.kind === 'copse-action') {
    return COPSE_AUTOMATION_ACTIONS.some((action) => action.toolName === permission.toolName)
  }
  const parsed = parseMcpToolName(permission.toolName)
  return parsed !== null && parsed.server.length > 0 && parsed.tool.length > 0
}

function isAutomationProblem(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['at'] === 'number' &&
    Number.isFinite(value['at']) &&
    (value['kind'] === 'failed' || value['kind'] === 'pending-start') &&
    typeof value['message'] === 'string'
  )
}

function isRetainedWorktree(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['threadId'] === 'string' &&
    typeof value['title'] === 'string' &&
    AUTOMATION_RETAINED_REASONS.some((reason) => reason === value['reason']) &&
    (value['paths'] === undefined ||
      (Array.isArray(value['paths']) && value['paths'].every((path) => typeof path === 'string')))
  )
}

function isSchedule(value: unknown): value is AutomationSchedule {
  if (!isRecord(value)) return false
  const maxLiveWorktrees = value['maxLiveWorktrees']
  const lastWorktreeLimitAt = value['lastWorktreeLimitAt']
  const permissions = value['permissions']
  const lastProblem = value['lastProblem']
  const blockedBy = value['lastWorktreeLimitBlockedBy']
  return (
    typeof value['id'] === 'string' &&
    typeof value['projectId'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['cron'] === 'string' &&
    typeof value['prompt'] === 'string' &&
    typeof value['model'] === 'string' &&
    typeof value['enabled'] === 'boolean' &&
    (maxLiveWorktrees === undefined ||
      maxLiveWorktrees === 1 ||
      maxLiveWorktrees === 2 ||
      maxLiveWorktrees === 3) &&
    (lastWorktreeLimitAt === undefined ||
      (typeof lastWorktreeLimitAt === 'number' && Number.isFinite(lastWorktreeLimitAt))) &&
    (blockedBy === undefined ||
      (Array.isArray(blockedBy) && blockedBy.every(isRetainedWorktree))) &&
    (permissions === undefined ||
      (Array.isArray(permissions) && permissions.every(isAutomationPermission))) &&
    (lastProblem === undefined || isAutomationProblem(lastProblem)) &&
    typeof value['createdAt'] === 'number' &&
    typeof value['updatedAt'] === 'number'
  )
}

function readSchedules(): AutomationSchedule[] {
  const raw = storageGet(STORAGE_KEY)
  if (!Array.isArray(raw)) return []
  return raw
    .filter(isSchedule)
    .map((schedule) =>
      schedule.permissions
        ? { ...schedule, permissions: normalizePermissions(schedule.permissions) }
        : schedule,
    )
}

/**
 * Rewrite the readable schedules in storage while carrying every other row
 * through untouched. A row this version cannot read (for example one written
 * by a newer build) is not ours to delete, and rewriting from the filtered list
 * used to drop it on the next unrelated edit or run.
 */
function updateSchedules(
  update: (schedules: AutomationSchedule[]) => AutomationSchedule[],
): Promise<void> {
  return storageUpdate(STORAGE_KEY, (raw) => {
    const rows: unknown[] = Array.isArray(raw) ? raw : []
    return [...rows.filter((row) => !isSchedule(row)), ...update(rows.filter(isSchedule))]
  })
}

function minuteStamp(timestamp: number): number {
  return Math.floor(timestamp / 60_000)
}

export interface AutomationService {
  list(projectId: string): AutomationSchedule[]
  permissionOptions(): AutomationPermissionOption[]
  permissionPreferenceForThread(
    projectId: string,
    threadId: string,
    automation: NonNullable<Thread['automation']>,
    permission: AutomationPermission,
  ): { scheduleName: string; allowed: boolean } | null
  grantPermission(
    projectId: string,
    scheduleId: string,
    permission: AutomationPermission,
  ): Promise<boolean>
  upsert(projectId: string, input: AutomationScheduleInput): Promise<AutomationSchedule>
  remove(projectId: string, scheduleId: string): Promise<void>
  runNow(projectId: string, scheduleId: string): Promise<AutomationTriggerEvent>
  /**
   * Release every finished run's checkout that is safe to remove, through the
   * same path the scheduler uses, and report the runs that must stay.
   */
  cleanupRuns(projectId: string, scheduleId: string): Promise<AutomationCleanupResult>
  /**
   * Record why a run this schedule created could not start. Only the schedule's latest
   * run may report; any other thread id changes nothing and returns false.
   */
  reportStartFailure(
    projectId: string,
    threadId: string,
    failure: { code: AutomationFailureCode; message: string },
  ): Promise<boolean>
  health(): AutomationSchedulerHealth
  onHealthChange(listener: (health: AutomationSchedulerHealth) => void): () => void
  start(notify: (event: AutomationTriggerEvent) => void): void
  sync(): Promise<void>
  stop(): void
  /**
   * Run the schedules due now. `scheduledFor` is the minute the supervisor's timer
   * was armed for: a timer that fires late still runs the minute it was owed.
   */
  tick(scheduledFor?: number): Promise<void>
}

/**
 * The supervisor surface the scheduler owner needs. `TaskSupervisor` satisfies
 * this structurally; the narrow shape lets tests drive the durable-load
 * ordering that `start()` imposes without touching the workspace on disk.
 */
export interface AutomationTaskSupervisor {
  start(): Promise<void>
  syncCronTasks(): void
  list(projectId?: string): SupervisedTaskMeta[]
  cancel(projectId: string, taskId: string): Promise<SupervisedTaskMeta | null>
  enqueue(input: EnqueueSupervisedTaskInput): Promise<SupervisedTaskMeta>
  registerHandler(kind: string, handler: SupervisedTaskHandler): () => void
  subscribe(listener: (task: SupervisedTaskMeta) => void): () => void
}

export interface AutomationServiceDependencies {
  now(): number
  createProjectThread(projectId: string, thread: Thread): Promise<void>
  loadProjectThreads(projectId: string): Promise<Thread[]>
  releasePreviousRun(projectId: string, threadId: string): Promise<AutomationWorktreeRelease>
  /**
   * Whether this retained checkout is the one the next run will take over. A checkout that is
   * about to be handed on is not an extra live worktree, so it does not count against the cap.
   */
  canReusePreviousRun?(projectId: string, threadId: string): Promise<boolean>
  isPluginEnabled(): boolean
  supervisor?: () => AutomationTaskSupervisor
  /** Pause before replacing a scheduler task that died, so a task that dies instantly cannot spin. */
  recoveryDelayMs?: number
}

export function createAutomationService(
  dependencies: AutomationServiceDependencies,
): AutomationService {
  let notify: ((event: AutomationTriggerEvent) => void) | null = null
  let disposeSupervisorHandler: (() => void) | null = null
  let disposeSupervisorSubscription: (() => void) | null = null
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null
  let schedulerSync = Promise.resolve()
  let schedulerHealth: AutomationSchedulerHealth = { state: 'ok', since: null, message: null }
  const healthListeners = new Set<(health: AutomationSchedulerHealth) => void>()
  const inFlight = new Set<string>()
  const attemptedMinutes = new Map<string, number>()

  function setHealth(state: AutomationSchedulerHealth['state'], message: string | null): void {
    if (schedulerHealth.state === state && schedulerHealth.message === message) return
    schedulerHealth = {
      state,
      since: state === 'ok' ? null : (schedulerHealth.since ?? dependencies.now()),
      message,
    }
    for (const listener of healthListeners) listener(schedulerHealth)
  }

  async function recordProblem(
    schedule: AutomationSchedule,
    problem: AutomationProblem,
  ): Promise<void> {
    try {
      await updateSchedules((schedules) => {
        return schedules.map((candidate) =>
          candidate.projectId === schedule.projectId && candidate.id === schedule.id
            ? { ...candidate, lastProblem: problem }
            : candidate,
        )
      })
    } catch (error) {
      // The ledger is a courtesy; never let it turn a skipped run into a crash.
      console.error('[automations] Could not record a trigger problem:', error)
    }
  }

  async function logTriggerFailure(schedule: AutomationSchedule, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[automations] Failed to create task for “${schedule.name}”: ${message}`)
    await recordProblem(schedule, {
      at: dependencies.now(),
      kind: 'failed',
      message,
      code: classifyAutomationFailureMessage(message),
    })
  }

  async function replaceSchedule(next: AutomationSchedule): Promise<void> {
    await updateSchedules((schedules) => {
      return [...schedules.filter((schedule) => schedule.id !== next.id), next]
    })
  }

  async function recordWorktreeLimit(
    projectId: string,
    scheduleId: string,
    triggeredAt: number,
    attemptedLimit: number,
    blockedBy: AutomationRetainedWorktree[],
  ): Promise<void> {
    await updateSchedules((schedules) => {
      return schedules.map((schedule) =>
        schedule.projectId === projectId &&
        schedule.id === scheduleId &&
        (schedule.maxLiveWorktrees ?? 1) === attemptedLimit
          ? { ...schedule, lastWorktreeLimitAt: triggeredAt, lastWorktreeLimitBlockedBy: blockedBy }
          : schedule,
      )
    })
  }

  async function clearWorktreeLimit(projectId: string, scheduleId: string): Promise<void> {
    await updateSchedules((schedules) => {
      return schedules.map((schedule) => {
        if (schedule.projectId !== projectId || schedule.id !== scheduleId) return schedule
        const updated = { ...schedule }
        delete updated.lastWorktreeLimitAt
        delete updated.lastWorktreeLimitBlockedBy
        return updated
      })
    })
  }

  /** Keep a recorded skip's blocker list honest after some of its runs were released. */
  async function refreshWorktreeLimitBlockers(
    projectId: string,
    scheduleId: string,
    blockedBy: AutomationRetainedWorktree[],
  ): Promise<void> {
    await updateSchedules((schedules) => {
      return schedules.map((schedule) =>
        schedule.projectId === projectId &&
        schedule.id === scheduleId &&
        schedule.lastWorktreeLimitAt !== undefined
          ? { ...schedule, lastWorktreeLimitBlockedBy: blockedBy }
          : schedule,
      )
    })
  }

  async function recordScheduleRun(
    projectId: string,
    scheduleId: string,
    triggeredAt: number,
    threadId: string,
  ): Promise<void> {
    await updateSchedules((schedules) => {
      return schedules.map((schedule) => {
        if (schedule.projectId !== projectId || schedule.id !== scheduleId) return schedule
        const updated = {
          ...schedule,
          updatedAt: Math.max(schedule.updatedAt, triggeredAt),
          lastRunAt: triggeredAt,
          lastCreatedThreadId: threadId,
        }
        delete updated.lastWorktreeLimitAt
        delete updated.lastWorktreeLimitBlockedBy
        delete updated.lastProblem
        return updated
      })
    })
  }

  async function syncSupervisorTask(): Promise<void> {
    const supervisor = (dependencies.supervisor ?? getTaskSupervisor)()
    // The supervisor only holds durable tasks once `start()` has read them back
    // off disk, and app startup registers this scheduler before it starts the
    // supervisor. Awaiting the (idempotent) load first is what keeps the dedupe
    // below honest — scanning an empty map used to enqueue one surplus
    // `automation_scheduler_tick` per launch, each ticking every minute.
    await supervisor.start()
    supervisor.syncCronTasks()
    const unfinished = supervisor
      .list()
      .filter(
        (task) =>
          task.handler === SCHEDULER_HANDLER &&
          task.state !== 'cancelled' &&
          task.state !== 'failed' &&
          task.state !== 'completed',
      )
    // A blocked task is never woken again (an interrupted tick leaves it so after
    // a restart). Adopting it as the owner would leave nothing ticking at all, so
    // retire it and let a fresh task take over below.
    const blocked = unfinished.filter((task) => task.state === 'blocked')
    await Promise.all(blocked.map((task) => supervisor.cancel(task.projectId, task.taskId)))
    const existing = unfinished.filter((task) => task.state !== 'blocked')
    if (!dependencies.isPluginEnabled()) {
      await Promise.all(existing.map((task) => supervisor.cancel(task.projectId, task.taskId)))
      return
    }
    const enabledSchedules = readSchedules().filter((schedule) => schedule.enabled)
    const owner = enabledSchedules[0]
    if (!owner) {
      await Promise.all(existing.map((task) => supervisor.cancel(task.projectId, task.taskId)))
      return
    }
    const retained = existing.find((task) =>
      enabledSchedules.some(
        (schedule) => schedule.projectId === task.projectId && schedule.id === task.threadId,
      ),
    )
    await Promise.all(
      existing
        .filter((task) => task !== retained)
        .map((task) => supervisor.cancel(task.projectId, task.taskId)),
    )
    if (retained) return
    await supervisor.enqueue({
      projectId: owner.projectId,
      threadId: owner.id,
      handler: SCHEDULER_HANDLER,
      provenance: 'schedule',
      trigger: { kind: 'cron', expression: '* * * * *' },
      permissionSnapshot: {
        capturedAt: dependencies.now(),
        autoRunSandboxCommands: false,
        projectSandboxEnabled: false,
      },
      reapproveOnWake: false,
      concurrencyClass: 'schedule',
      resourceBudget: { maxDurationMs: SCHEDULER_MAX_DURATION_MS },
      // An interrupted tick is re-queued on relaunch with its attempt already
      // counted, so a budget of one would fail it on the spot as exhausted. The
      // count resets whenever a tick completes and the task goes back to waiting.
      maxAttempts: 3,
      // The tick is idempotent per minute, so an interrupted one is safe to rerun.
      restartPolicy: 'retry',
      contentHash: SCHEDULER_HANDLER,
    })
  }

  function scheduleRecovery(): void {
    if (recoveryTimer !== null) return
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null
      void ensureSupervisorTask().catch((error: unknown) => {
        console.error('[automations] Scheduler recovery failed:', error)
        setHealth(
          'stopped',
          `Scheduled triggers are not firing: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }, dependencies.recoveryDelayMs ?? SCHEDULER_RECOVERY_DELAY_MS)
    recoveryTimer.unref()
  }

  function ensureSupervisorTask(): Promise<void> {
    const next = schedulerSync.then(syncSupervisorTask).then(() => {
      // A completed sync means a live scheduler task exists (or none is wanted).
      setHealth('ok', null)
    })
    schedulerSync = next.catch((): void => {})
    return next
  }

  /** Release each finished run's checkout that is safe to remove; report what must stay. */
  async function releaseFinishedRuns(
    projectId: string,
    threads: Thread[],
  ): Promise<AutomationCleanupResult> {
    const released: string[] = []
    const retained: AutomationRetainedWorktree[] = []
    for (const thread of threads) {
      if (!thread.worktree || thread.worktree.retiredAt !== undefined) continue
      const release = await dependencies
        .releasePreviousRun(projectId, thread.id)
        .catch((error: unknown): AutomationWorktreeRelease => {
          console.warn(`[automations] Could not release the worktree of ${thread.id}:`, error)
          return { released: false, reason: 'in-use' }
        })
      if (release.released) {
        released.push(thread.id)
        continue
      }
      retained.push({
        threadId: thread.id,
        title: thread.title,
        reason: release.reason,
        ...(release.paths?.length ? { paths: release.paths } : {}),
      })
    }
    return { released, retained }
  }

  async function trigger(
    schedule: AutomationSchedule,
    triggeredAt: number,
    source: 'schedule' | 'manual',
  ): Promise<AutomationTriggerEvent> {
    if (inFlight.has(schedule.id)) throw new Error('This automation is already creating a task')
    inFlight.add(schedule.id)
    try {
      const scheduleThreads = (await dependencies.loadProjectThreads(schedule.projectId)).filter(
        (thread) => thread.automation?.scheduleId === schedule.id,
      )
      const previous = schedule.lastCreatedThreadId
        ? (scheduleThreads.find((thread) => thread.id === schedule.lastCreatedThreadId) ?? null)
        : null
      const busy = scheduleThreads.find((thread) => automationRunBlock(thread) !== null)

      if (busy) {
        if (automationRunBlock(busy) === 'pending-start') {
          await recordProblem(schedule, {
            at: triggeredAt,
            kind: 'pending-start',
            message:
              'An earlier run was created but never started, so this one was skipped. ' +
              'Open the project to start it, or send or discard its draft.',
          })
        }
        return {
          projectId: schedule.projectId,
          scheduleId: schedule.id,
          threadId: busy.id,
          triggeredAt,
          disposition: 'coalesced',
          coalescedReason: 'busy',
        }
      }

      // Recycle free checkouts and discount at most one eligible hand-over.
      const retained: AutomationRetainedWorktree[] = []
      let handOverClaimed = false
      for (const thread of scheduleThreads) {
        if (!thread.worktree || thread.worktree.retiredAt !== undefined) continue
        const release = await dependencies
          .releasePreviousRun(schedule.projectId, thread.id)
          .catch((error: unknown): AutomationWorktreeRelease => {
            console.warn(`[automations] Could not release the worktree of ${thread.id}:`, error)
            return { released: false, reason: 'in-use' }
          })
        if (release.released) continue
        if (
          !handOverClaimed &&
          (await dependencies
            .canReusePreviousRun?.(schedule.projectId, thread.id)
            .catch(() => false)) === true
        ) {
          handOverClaimed = true
          continue
        }
        retained.push({
          threadId: thread.id,
          title: thread.title,
          reason: release.reason,
          ...(release.paths?.length ? { paths: release.paths } : {}),
        })
      }
      // The cap stops an unattended schedule leaking checkouts. A person asking
      // for a run right now is not that, so a manual start is never refused for it.
      const maxLiveWorktrees = schedule.maxLiveWorktrees ?? 1
      if (source === 'schedule' && retained.length >= maxLiveWorktrees) {
        await recordWorktreeLimit(
          schedule.projectId,
          schedule.id,
          triggeredAt,
          maxLiveWorktrees,
          retained,
        )
        const event: AutomationTriggerEvent = {
          projectId: schedule.projectId,
          scheduleId: schedule.id,
          threadId: previous?.id ?? scheduleThreads[0]?.id ?? schedule.id,
          triggeredAt,
          disposition: 'coalesced',
          coalescedReason: 'worktree-limit',
          blockedBy: retained,
        }
        notify?.(event)
        return event
      }

      const threadId = randomUUID()
      const provenance = {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        triggeredAt,
      }
      const thread: Thread = {
        id: threadId,
        title: schedule.name,
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        model: schedule.model,
        draftPrompt: schedule.prompt,
        automation: provenance,
        createdAt: triggeredAt,
        updatedAt: triggeredAt,
      }
      await dependencies.createProjectThread(schedule.projectId, thread)
      // The user may edit or delete the schedule while the filesystem work
      // above is pending. Merge only the run metadata into the current row;
      // never restore the stale snapshot that started this run.
      await recordScheduleRun(schedule.projectId, schedule.id, triggeredAt, threadId)
      const event = {
        projectId: schedule.projectId,
        scheduleId: schedule.id,
        threadId,
        triggeredAt,
        disposition: 'started' as const,
      }
      notify?.(event)
      return event
    } finally {
      inFlight.delete(schedule.id)
    }
  }

  const service: AutomationService = {
    list(projectId) {
      return readSchedules()
        .filter((schedule) => schedule.projectId === projectId)
        .sort((a, b) => a.createdAt - b.createdAt)
    },
    permissionOptions,
    permissionPreferenceForThread(projectId, threadId, automation, permission) {
      const schedule = service
        .list(projectId)
        .find(
          (candidate) =>
            candidate.id === automation.scheduleId &&
            candidate.lastCreatedThreadId === threadId &&
            candidate.lastRunAt === automation.triggeredAt,
        )
      if (!schedule) return null
      const key = automationPermissionKey(permission)
      return {
        scheduleName: schedule.name,
        allowed: (schedule.permissions ?? []).some(
          (candidate) => automationPermissionKey(candidate) === key,
        ),
      }
    },
    async grantPermission(projectId, scheduleId, permission) {
      if (!canGrantPermissionFromPrompt(permission)) return false
      let found = false
      await updateSchedules((schedules) => {
        return schedules.map((schedule) => {
          if (schedule.projectId !== projectId || schedule.id !== scheduleId) return schedule
          found = true
          const key = automationPermissionKey(permission)
          if (
            (schedule.permissions ?? []).some(
              (candidate) => automationPermissionKey(candidate) === key,
            )
          ) {
            return schedule
          }
          const permissions = normalizePermissions([...(schedule.permissions ?? []), permission])
          return { ...schedule, permissions, updatedAt: dependencies.now() }
        })
      })
      return found
    },
    async upsert(projectId, input) {
      validateCronExpression(input.cron)
      const existing = input.id
        ? readSchedules().find(
            (schedule) => schedule.id === input.id && schedule.projectId === projectId,
          )
        : undefined
      if (input.id && !existing) throw new Error('Automation schedule not found in this project')
      const now = dependencies.now()
      const maxLiveWorktrees = input.maxLiveWorktrees ?? existing?.maxLiveWorktrees ?? 1
      const permissions = normalizePermissions(input.permissions ?? existing?.permissions ?? [])
      const selectable = new Set(
        service.permissionOptions().map((option) => automationPermissionKey(option.permission)),
      )
      const retained = new Set(
        (existing?.permissions ?? []).map((permission) => automationPermissionKey(permission)),
      )
      const unavailable = permissions.find((permission) => {
        const key = automationPermissionKey(permission)
        return !selectable.has(key) && !retained.has(key)
      })
      if (unavailable) {
        throw new Error(`Automation permission is not available: ${unavailable.toolName}`)
      }
      const schedule: AutomationSchedule = {
        id: existing?.id ?? randomUUID(),
        projectId,
        name: input.name.trim(),
        cron: input.cron.trim(),
        prompt: input.prompt.trim(),
        model: input.model.trim(),
        enabled: input.enabled,
        maxLiveWorktrees,
        ...(permissions.length > 0 ? { permissions } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(existing?.lastRunAt !== undefined ? { lastRunAt: existing.lastRunAt } : {}),
        ...(existing?.lastCreatedThreadId !== undefined
          ? { lastCreatedThreadId: existing.lastCreatedThreadId }
          : {}),
        ...(existing?.lastWorktreeLimitAt !== undefined &&
        maxLiveWorktrees === (existing.maxLiveWorktrees ?? 1)
          ? {
              lastWorktreeLimitAt: existing.lastWorktreeLimitAt,
              ...(existing.lastWorktreeLimitBlockedBy
                ? { lastWorktreeLimitBlockedBy: existing.lastWorktreeLimitBlockedBy }
                : {}),
            }
          : {}),
        ...(existing?.lastProblem !== undefined ? { lastProblem: existing.lastProblem } : {}),
      }
      await replaceSchedule(schedule)
      // The minute tick reads schedule settings from storage. Editing fields such
      // as the worktree limit does not change the supervisor's single scheduler
      // task, so a slow supervisor must not hold up an already-saved edit.
      const schedulerMembershipChanged = existing
        ? existing.enabled !== schedule.enabled
        : schedule.enabled
      if (disposeSupervisorHandler && schedulerMembershipChanged) await ensureSupervisorTask()
      return schedule
    },
    async remove(projectId, scheduleId) {
      await updateSchedules((schedules) => {
        return schedules.filter(
          (schedule) => !(schedule.projectId === projectId && schedule.id === scheduleId),
        )
      })
      if (disposeSupervisorHandler) await ensureSupervisorTask()
    },
    async reportStartFailure(projectId, threadId, failure) {
      const schedule = service
        .list(projectId)
        .find((candidate) => candidate.lastCreatedThreadId === threadId)
      if (!schedule) return false
      await recordProblem(schedule, {
        at: dependencies.now(),
        kind: 'failed',
        message: failure.message.slice(0, 500),
        code: failure.code,
        threadId,
      })
      return true
    },
    health() {
      return schedulerHealth
    },
    onHealthChange(listener) {
      healthListeners.add(listener)
      return () => {
        healthListeners.delete(listener)
      }
    },
    async runNow(projectId, scheduleId) {
      if (!dependencies.isPluginEnabled()) throw new Error('Enable the automations plugin first')
      const schedule = service.list(projectId).find((candidate) => candidate.id === scheduleId)
      if (!schedule) throw new Error('Automation schedule not found in this project')
      return trigger(schedule, dependencies.now(), 'manual')
    },
    async cleanupRuns(projectId, scheduleId) {
      if (!dependencies.isPluginEnabled()) throw new Error('Enable the automations plugin first')
      const schedule = service.list(projectId).find((candidate) => candidate.id === scheduleId)
      if (!schedule) throw new Error('Automation schedule not found in this project')
      // Serialise with a trigger of the same schedule: both remove checkouts.
      if (inFlight.has(schedule.id)) throw new Error('This automation is already creating a task')
      inFlight.add(schedule.id)
      try {
        const threads = (await dependencies.loadProjectThreads(projectId)).filter(
          (thread) => thread.automation?.scheduleId === schedule.id,
        )
        // A pending or running run owns its checkout; leave it alone.
        const idle = threads.filter((thread) => automationRunBlock(thread) === null)
        const result = await releaseFinishedRuns(projectId, idle)
        if (result.retained.length < (schedule.maxLiveWorktrees ?? 1)) {
          await clearWorktreeLimit(projectId, scheduleId)
        } else {
          await refreshWorktreeLimitBlockers(projectId, scheduleId, result.retained)
        }
        return result
      } finally {
        inFlight.delete(schedule.id)
      }
    },
    start(sender) {
      notify = sender
      disposeSupervisorHandler ??= (dependencies.supervisor ?? getTaskSupervisor)().registerHandler(
        SCHEDULER_HANDLER,
        async (task) => {
          await service.tick(task.nextWakeAt)
          return {}
        },
      )
      // The scheduler task can fail (duration budget, thrown error) with nothing
      // else to replace it until the next launch, so replace it as soon as it dies.
      disposeSupervisorSubscription ??= (dependencies.supervisor ?? getTaskSupervisor)().subscribe(
        (task) => {
          if (task.handler !== SCHEDULER_HANDLER) return
          if (task.state === 'failed' || task.state === 'blocked') {
            setHealth(
              'recovering',
              task.lastError ?? 'The scheduler task stopped unexpectedly and is being replaced.',
            )
            scheduleRecovery()
          }
        },
      )
      void ensureSupervisorTask().catch((error: unknown) => {
        console.error('[automations] Scheduler registration failed:', error)
      })
    },
    sync() {
      return ensureSupervisorTask()
    },
    stop() {
      disposeSupervisorHandler?.()
      disposeSupervisorHandler = null
      disposeSupervisorSubscription?.()
      disposeSupervisorSubscription = null
      if (recoveryTimer !== null) clearTimeout(recoveryTimer)
      recoveryTimer = null
      healthListeners.clear()
      notify = null
    },
    async tick(scheduledFor) {
      if (!dependencies.isPluginEnabled()) return
      const clock = dependencies.now()
      // Matching against the wall clock alone skips a schedule whenever the timer
      // fires after the minute it was armed for (a slow previous tick, a busy main
      // process): the next minute is evaluated and the owed one is never seen.
      const now =
        scheduledFor !== undefined &&
        scheduledFor <= clock &&
        clock - scheduledFor < MAX_WAKE_LATENESS_MS
          ? scheduledFor
          : clock
      const date = new Date(now)
      const currentMinute = minuteStamp(now)
      const due: AutomationSchedule[] = []
      for (const schedule of readSchedules()) {
        if (!schedule.enabled || inFlight.has(schedule.id)) continue
        if (
          attemptedMinutes.get(schedule.id) === currentMinute ||
          (schedule.lastRunAt !== undefined && minuteStamp(schedule.lastRunAt) === currentMinute)
        ) {
          continue
        }
        try {
          if (!cronMatches(schedule.cron, date)) continue
        } catch {
          // Persisted expressions can outlive parser changes; leave them visible
          // for the editor to repair instead of crashing the scheduler.
          continue
        }
        attemptedMinutes.set(schedule.id, currentMinute)
        due.push(schedule)
      }
      // Run due schedules side by side: each one does git worktree work, and a
      // sequential pass over many schedules due on the same minute could outlast
      // the scheduler task's duration budget and take the whole scheduler down.
      await Promise.all(
        due.map(async (schedule) => {
          try {
            await trigger(schedule, now, 'schedule')
          } catch (error) {
            // Isolate failures so one project cannot prevent other matching
            // schedules from running. Do not retry repeatedly in the same minute.
            await logTriggerFailure(schedule, error)
          }
        }),
      )
    },
  }
  return service
}

let singleton: AutomationService | null = null

export function getAutomationService(): AutomationService {
  singleton ??= createAutomationService({
    now: () => Date.now(),
    createProjectThread: createThread,
    loadProjectThreads,
    releasePreviousRun: releaseCompletedAutomationWorktree,
    canReusePreviousRun: (projectId, threadId) =>
      getAutomationWorktreeReuse().canReusePreviousRun(projectId, threadId),
    isPluginEnabled: () => getPluginService().registry.isEnabled(AUTOMATIONS_PLUGIN_ID),
  })
  return singleton
}
