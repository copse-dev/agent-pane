import { randomUUID } from 'node:crypto'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import type {
  AutomationPermission,
  AutomationPermissionOption,
  AutomationSchedule,
  AutomationScheduleInput,
  AutomationTriggerEvent,
  Thread,
} from '@shared/types'
import { automationPermissionKey } from '@shared/types'
import { getPluginService } from '../plugins/plugin-service.ts'
import { storageGet, storageUpdate } from '../storage/storage.ts'
import { createThread, loadProjectThreads } from '../thread-store.ts'
import { releaseCompletedAutomationWorktree } from '../worktree-parking.ts'
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

function isSchedule(value: unknown): value is AutomationSchedule {
  if (!isRecord(value)) return false
  const maxLiveWorktrees = value['maxLiveWorktrees']
  const permissions = value['permissions']
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
    (permissions === undefined ||
      (Array.isArray(permissions) && permissions.every(isAutomationPermission))) &&
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

function minuteStamp(timestamp: number): number {
  return Math.floor(timestamp / 60_000)
}

export interface AutomationService {
  list(projectId: string): AutomationSchedule[]
  permissionOptions(): AutomationPermissionOption[]
  permissionPreference(
    projectId: string,
    scheduleId: string,
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
  start(notify: (event: AutomationTriggerEvent) => void): void
  sync(): Promise<void>
  stop(): void
  tick(): Promise<void>
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
}

export interface AutomationServiceDependencies {
  now(): number
  createProjectThread(projectId: string, thread: Thread): Promise<void>
  loadProjectThreads(projectId: string): Promise<Thread[]>
  releasePreviousRun(projectId: string, threadId: string): Promise<boolean>
  isPluginEnabled(): boolean
  supervisor?: () => AutomationTaskSupervisor
}

export function createAutomationService(
  dependencies: AutomationServiceDependencies,
): AutomationService {
  let notify: ((event: AutomationTriggerEvent) => void) | null = null
  let disposeSupervisorHandler: (() => void) | null = null
  let schedulerSync = Promise.resolve()
  const inFlight = new Set<string>()
  const attemptedMinutes = new Map<string, number>()

  function logTriggerFailure(schedule: AutomationSchedule, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[automations] Failed to create task for “${schedule.name}”: ${message}`)
  }

  async function replaceSchedule(next: AutomationSchedule): Promise<void> {
    await storageUpdate(STORAGE_KEY, (raw) => {
      const schedules = Array.isArray(raw) ? raw.filter(isSchedule) : []
      return [...schedules.filter((schedule) => schedule.id !== next.id), next]
    })
  }

  async function recordScheduleRun(
    projectId: string,
    scheduleId: string,
    triggeredAt: number,
    threadId: string,
  ): Promise<void> {
    await storageUpdate(STORAGE_KEY, (raw) => {
      const schedules = Array.isArray(raw) ? raw.filter(isSchedule) : []
      return schedules.map((schedule) =>
        schedule.projectId === projectId && schedule.id === scheduleId
          ? {
              ...schedule,
              updatedAt: Math.max(schedule.updatedAt, triggeredAt),
              lastRunAt: triggeredAt,
              lastCreatedThreadId: threadId,
            }
          : schedule,
      )
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
    const existing = supervisor
      .list()
      .filter(
        (task) =>
          task.handler === SCHEDULER_HANDLER &&
          task.state !== 'cancelled' &&
          task.state !== 'failed' &&
          task.state !== 'completed',
      )
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
      resourceBudget: { maxDurationMs: 30_000 },
      maxAttempts: 1,
      contentHash: SCHEDULER_HANDLER,
    })
  }

  function ensureSupervisorTask(): Promise<void> {
    const next = schedulerSync.then(syncSupervisorTask)
    schedulerSync = next.catch((): void => {})
    return next
  }

  async function trigger(
    schedule: AutomationSchedule,
    triggeredAt: number,
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
      const busy = scheduleThreads.find(
        (thread) => thread.status === 'running' || Boolean(thread.draftPrompt?.trim()),
      )

      if (busy) {
        return {
          projectId: schedule.projectId,
          scheduleId: schedule.id,
          threadId: busy.id,
          triggeredAt,
          disposition: 'coalesced',
          coalescedReason: 'busy',
        }
      }

      let retainedWorktrees = 0
      for (const thread of scheduleThreads) {
        if (!thread.worktree || thread.worktree.retiredAt !== undefined) continue
        if (!(await dependencies.releasePreviousRun(schedule.projectId, thread.id))) {
          retainedWorktrees += 1
        }
      }
      const maxLiveWorktrees = schedule.maxLiveWorktrees ?? 1
      if (retainedWorktrees >= maxLiveWorktrees) {
        return {
          projectId: schedule.projectId,
          scheduleId: schedule.id,
          threadId: previous?.id ?? scheduleThreads[0]?.id ?? schedule.id,
          triggeredAt,
          disposition: 'coalesced',
          coalescedReason: 'worktree-limit',
        }
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
    permissionPreference(projectId, scheduleId, permission) {
      const schedule = service.list(projectId).find((candidate) => candidate.id === scheduleId)
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
      await storageUpdate(STORAGE_KEY, (raw) => {
        const schedules = Array.isArray(raw) ? raw.filter(isSchedule) : []
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
        maxLiveWorktrees: input.maxLiveWorktrees ?? existing?.maxLiveWorktrees ?? 1,
        ...(permissions.length > 0 ? { permissions } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(existing?.lastRunAt !== undefined ? { lastRunAt: existing.lastRunAt } : {}),
        ...(existing?.lastCreatedThreadId !== undefined
          ? { lastCreatedThreadId: existing.lastCreatedThreadId }
          : {}),
      }
      await replaceSchedule(schedule)
      if (disposeSupervisorHandler) await ensureSupervisorTask()
      return schedule
    },
    async remove(projectId, scheduleId) {
      await storageUpdate(STORAGE_KEY, (raw) => {
        const schedules = Array.isArray(raw) ? raw.filter(isSchedule) : []
        return schedules.filter(
          (schedule) => !(schedule.projectId === projectId && schedule.id === scheduleId),
        )
      })
      if (disposeSupervisorHandler) await ensureSupervisorTask()
    },
    async runNow(projectId, scheduleId) {
      if (!dependencies.isPluginEnabled()) throw new Error('Enable the automations plugin first')
      const schedule = service.list(projectId).find((candidate) => candidate.id === scheduleId)
      if (!schedule) throw new Error('Automation schedule not found in this project')
      return trigger(schedule, dependencies.now())
    },
    start(sender) {
      notify = sender
      disposeSupervisorHandler ??= (dependencies.supervisor ?? getTaskSupervisor)().registerHandler(
        SCHEDULER_HANDLER,
        async () => {
          await service.tick()
          return {}
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
      notify = null
    },
    async tick() {
      if (!dependencies.isPluginEnabled()) return
      const now = dependencies.now()
      const date = new Date(now)
      const currentMinute = minuteStamp(now)
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
        try {
          await trigger(schedule, now)
        } catch (error) {
          // Isolate failures so one project cannot prevent other matching
          // schedules from running. Do not retry repeatedly in the same minute.
          logTriggerFailure(schedule, error)
        }
      }
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
    isPluginEnabled: () => getPluginService().registry.isEnabled(AUTOMATIONS_PLUGIN_ID),
  })
  return singleton
}
