import { randomUUID } from 'node:crypto'
import { AUTOMATIONS_PACK_ID } from '@copse/agent/packs/automations-pack.ts'
import type {
  AutomationSchedule,
  AutomationScheduleInput,
  AutomationTriggerEvent,
  Thread,
} from '@shared/types'
import { getPackService } from '../packs/pack-service.ts'
import { storageGet, storageUpdate } from '../storage/storage.ts'
import { createThread } from '../thread-store.ts'
import { cronMatches, validateCronExpression } from './cron.ts'
import { getTaskSupervisor } from '../supervisor/task-supervisor.ts'

const STORAGE_KEY = `pack.${AUTOMATIONS_PACK_ID}.storage`
const SCHEDULER_HANDLER = 'automation_scheduler_tick'

function isSchedule(value: unknown): value is AutomationSchedule {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Partial<AutomationSchedule>
  return (
    typeof row.id === 'string' &&
    typeof row.projectId === 'string' &&
    typeof row.name === 'string' &&
    typeof row.cron === 'string' &&
    typeof row.prompt === 'string' &&
    typeof row.model === 'string' &&
    typeof row.enabled === 'boolean' &&
    typeof row.createdAt === 'number' &&
    typeof row.updatedAt === 'number'
  )
}

function readSchedules(): AutomationSchedule[] {
  const raw = storageGet(STORAGE_KEY)
  if (!Array.isArray(raw)) return []
  return raw.filter(isSchedule)
}

function minuteStamp(timestamp: number): number {
  return Math.floor(timestamp / 60_000)
}

export interface AutomationService {
  list(projectId: string): AutomationSchedule[]
  upsert(projectId: string, input: AutomationScheduleInput): Promise<AutomationSchedule>
  remove(projectId: string, scheduleId: string): Promise<void>
  runNow(projectId: string, scheduleId: string): Promise<AutomationTriggerEvent>
  start(notify: (event: AutomationTriggerEvent) => void): void
  sync(): Promise<void>
  stop(): void
  tick(): Promise<void>
}

export interface AutomationServiceDependencies {
  now(): number
  createProjectThread(projectId: string, thread: Thread): Promise<void>
  isPackEnabled(): boolean
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

  async function syncSupervisorTask(): Promise<void> {
    const supervisor = getTaskSupervisor()
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
    if (!dependencies.isPackEnabled()) {
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
      const threadId = randomUUID()
      const thread: Thread = {
        id: threadId,
        title: schedule.name,
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        model: schedule.model,
        draftPrompt: schedule.prompt,
        automation: {
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          triggeredAt,
        },
        createdAt: triggeredAt,
        updatedAt: triggeredAt,
      }
      await dependencies.createProjectThread(schedule.projectId, thread)
      await replaceSchedule({
        ...schedule,
        updatedAt: triggeredAt,
        lastRunAt: triggeredAt,
        lastCreatedThreadId: threadId,
      })
      const event = {
        projectId: schedule.projectId,
        scheduleId: schedule.id,
        threadId,
        triggeredAt,
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
    async upsert(projectId, input) {
      validateCronExpression(input.cron)
      const existing = input.id
        ? readSchedules().find(
            (schedule) => schedule.id === input.id && schedule.projectId === projectId,
          )
        : undefined
      if (input.id && !existing) throw new Error('Automation schedule not found in this project')
      const now = dependencies.now()
      const schedule: AutomationSchedule = {
        id: existing?.id ?? randomUUID(),
        projectId,
        name: input.name.trim(),
        cron: input.cron.trim(),
        prompt: input.prompt.trim(),
        model: input.model.trim(),
        enabled: input.enabled,
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
      if (!dependencies.isPackEnabled()) throw new Error('Enable the automations pack first')
      const schedule = service.list(projectId).find((candidate) => candidate.id === scheduleId)
      if (!schedule) throw new Error('Automation schedule not found in this project')
      return trigger(schedule, dependencies.now())
    },
    start(sender) {
      notify = sender
      disposeSupervisorHandler ??= getTaskSupervisor().registerHandler(
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
      if (!dependencies.isPackEnabled()) return
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
    isPackEnabled: () => getPackService().registry.isEnabled(AUTOMATIONS_PACK_ID),
  })
  return singleton
}

export function __resetAutomationServiceForTests(): void {
  singleton?.stop()
  singleton = null
}
