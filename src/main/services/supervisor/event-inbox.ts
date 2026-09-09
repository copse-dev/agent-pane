import { z } from 'zod'
import {
  automationDeliverySchema,
  eventAutomationBindingSchema,
  type AutomationDelivery,
  type EventAutomationBinding,
  type EventInboxRecord,
} from '@shared/supervisor/event-inbox-schema.ts'
import { runSerialized } from '../storage/write-queue.ts'
import { eventDigest, eventInboxKey, type EventInboxStore } from './event-inbox-store.ts'
import { TaskSupervisor, type SupervisedTaskHandlerResult } from './task-supervisor.ts'

const HANDLER = 'automation_event_prepare'
const handlerInputSchema = z.strictObject({ inboxKey: z.string().regex(/^[a-f0-9]{64}$/) })

type MatchResult = { kind: 'match' } | { kind: 'filtered'; reason: string }

/** Host-registered, authenticated adapter. Never constructed from event payload fields. */
export interface EventInboxAdapter {
  sourceId: string
  connectionId: string
  eventType: string
  evaluate(binding: EventAutomationBinding, delivery: AutomationDelivery): Promise<MatchResult>
}

export interface EventInboxHost {
  resolve(
    automationId: string,
  ): Promise<{ enabled: boolean; binding: EventAutomationBinding } | null>
  /** Recheck project/resource availability, permissions and run/worktree limits without side effects. */
  authorize(
    record: EventInboxRecord,
  ): Promise<{ allowed: true } | { allowed: false; reason: string }>
  /**
   * Create/recover a draft using runId as thread ID. Must be idempotent, observe signal,
   * and compare the saved binding under the definition writer lock at the commit boundary.
   * This boundary must not start a model turn or perform external writes: recovery may call it again.
   */
  prepareRun(record: EventInboxRecord & { runId: string }, signal: AbortSignal): Promise<void>
}

function pending(record: EventInboxRecord): boolean {
  return record.state === 'admitted' || record.state === 'claimed' || record.state === 'queued'
}

function lifecycleKey(projectId: string, automationId: string): string {
  return `event-lifecycle:${projectId}\0${automationId}`
}

function contentHash(record: EventInboxRecord): string {
  return eventDigest(JSON.stringify([record.binding, record.delivery]))
}

/**
 * Durable ingress and draft preparation. Deliberately not installed by app startup until
 * a real saved-definition writer and authenticated adapter exist (proposal slice B).
 */
export class AutomationEventInbox {
  private readonly supervisor: TaskSupervisor
  private readonly store: EventInboxStore
  private readonly adapter: EventInboxAdapter
  private readonly host: EventInboxHost
  private readonly now: () => number
  private readonly unregister: () => void

  constructor(dependencies: {
    supervisor: TaskSupervisor
    store: EventInboxStore
    adapter: EventInboxAdapter
    host: EventInboxHost
    now?: () => number
  }) {
    this.supervisor = dependencies.supervisor
    this.store = dependencies.store
    this.adapter = dependencies.adapter
    this.host = dependencies.host
    this.now = dependencies.now ?? Date.now
    this.unregister = this.supervisor.registerHandler(HANDLER, async (task, { signal }) => {
      // Read afresh across awaits: AbortSignal.aborted is mutable at runtime.
      const isAborted = (): boolean => signal.aborted
      const input = handlerInputSchema.safeParse(task.handlerInput)
      if (!input.success) return { blockedReason: 'Invalid event inbox task input' }
      const record = await this.store.get(task.projectId, input.data.inboxKey)
      if (
        !record ||
        record.runId !== task.taskId ||
        task.threadId !== task.taskId ||
        task.contentHash !== contentHash(record)
      ) {
        return { blockedReason: 'Event task does not match its durable claim' }
      }
      if (record.state === 'prepared') return this.result(task.threadId)
      if (!pending(record))
        return { blockedReason: record.reason ?? 'Event delivery is not pending' }
      const reason = await this.check(record)
      if (reason) {
        await this.hold(record, reason)
        return { blockedReason: reason }
      }
      // Fencing may have happened during an asynchronous permission/resource check.
      const current = await this.store.get(task.projectId, record.key)
      if (!current || !pending(current) || isAborted()) {
        return { blockedReason: 'Event delivery was fenced before preparation' }
      }
      try {
        await this.host.prepareRun({ ...current, runId: task.taskId }, signal)
      } catch (error) {
        if (!isAborted())
          await this.hold(current, 'Run preparation failed; inspect the supervised task')
        throw error
      }
      if (isAborted()) return { blockedReason: 'Event preparation interrupted' }
      await this.store.update(task.projectId, record.key, (latest) => {
        if (!latest) throw new Error('Event claim disappeared')
        return pending(latest) ? { ...latest, state: 'prepared', updatedAt: this.now() } : latest
      })
      return this.result(task.threadId)
    })
  }

  dispose(): void {
    this.unregister()
  }

  /** Poll cursors may advance only after this resolves. Admission never enqueues work. */
  async admit(
    automationId: string,
    definitionRevision: string,
    raw: unknown,
  ): Promise<EventInboxRecord> {
    const delivery = automationDeliverySchema.parse(raw)
    const resolved = await this.host.resolve(automationId)
    if (!resolved?.enabled) throw new Error('Automation is deleted, paused or unavailable')
    const binding = eventAutomationBindingSchema.parse(resolved.binding)
    if (
      binding.automationId !== automationId ||
      binding.definitionRevision !== definitionRevision
    ) {
      throw new Error('Event definition revision does not match the saved automation')
    }
    const reason = this.bindingMismatch(binding, delivery)
    if (reason) throw new Error(reason)
    const key = eventInboxKey({ binding, delivery })
    return runSerialized(lifecycleKey(binding.projectId, automationId), async () => {
      const receivedAt = this.now()
      const match = delivery.originAutomationId
        ? ({
            kind: 'filtered',
            reason: 'Automation-originated events are not eligible',
          } satisfies MatchResult)
        : await this.adapter.evaluate(binding, delivery)
      const record: EventInboxRecord = {
        v: 1,
        key,
        binding,
        delivery,
        receivedAt,
        updatedAt: receivedAt,
        payloadSha256: eventDigest(delivery.payload),
        state: match.kind === 'match' ? 'admitted' : 'filtered',
        ...(match.kind === 'filtered' ? { reason: match.reason.slice(0, 512) } : {}),
      }
      const latest = await this.host.resolve(automationId)
      if (
        !latest?.enabled ||
        JSON.stringify(eventAutomationBindingSchema.parse(latest.binding)) !==
          JSON.stringify(binding)
      ) {
        throw new Error('Automation changed during event admission')
      }
      return this.store.update(binding.projectId, key, (current) => {
        if (current && contentHash(current) !== contentHash(record)) {
          throw new Error(
            'Event delivery identity was reused with different evidence or definition',
          )
        }
        return current ?? record
      })
    })
  }

  /** Recover admitted/claimed deliveries; safe after any interrupted persistence boundary. */
  async reconcile(projectId: string): Promise<void> {
    await this.supervisor.start()
    for (const record of await this.store.list(projectId)) {
      if (!pending(record)) continue
      await runSerialized(`event-admission:${projectId}:${record.key}`, async () => {
        const current = await this.store.get(projectId, record.key)
        if (!current || !pending(current)) return
        const reason = await this.check(current)
        if (reason) {
          await this.hold(current, reason)
          return
        }
        const claimed = await this.store.update(projectId, current.key, (latest) => {
          if (!latest) throw new Error('Event delivery disappeared before claim')
          return latest.state === 'admitted'
            ? { ...latest, state: 'claimed', runId: `event-${latest.key}`, updatedAt: this.now() }
            : latest
        })
        if (!pending(claimed) || !claimed.runId) return
        await this.supervisor.enqueueOnce(claimed.runId, {
          projectId,
          threadId: claimed.runId,
          handler: HANDLER,
          handlerInput: { inboxKey: claimed.key },
          provenance: 'system',
          trigger: { kind: 'immediate' },
          permissionSnapshot: claimed.binding.permissionSnapshot,
          reapproveOnWake: true,
          concurrencyClass: `automation-event:${claimed.binding.automationId}`,
          maxAttempts: 3,
          contentHash: contentHash(claimed),
        })
        await this.store.update(projectId, claimed.key, (latest) => {
          if (!latest) throw new Error('Event claim disappeared after enqueue')
          return latest.state === 'claimed'
            ? { ...latest, state: 'queued', updatedAt: this.now() }
            : latest
        })
      })
    }
  }

  /** Host lifecycle hook: fence pending evidence before stopping a plugin/source or removing a definition. */
  async fence(projectId: string, automationId: string, reason: string): Promise<void> {
    await runSerialized(lifecycleKey(projectId, automationId), async () => {
      for (const record of await this.store.list(projectId)) {
        if (record.binding.automationId !== automationId || !pending(record)) continue
        const held = await this.hold(record, reason)
        // These tasks only prepare drafts. An already-prepared user's task is never cancelled here.
        if (held.state === 'fenced' && held.runId)
          await this.supervisor.cancel(projectId, held.runId)
      }
    })
  }

  private hold(record: EventInboxRecord, reason: string): Promise<EventInboxRecord> {
    return this.store.update(record.binding.projectId, record.key, (latest) => {
      if (!latest) throw new Error('Event delivery disappeared while fencing')
      return pending(latest)
        ? { ...latest, state: 'fenced', reason: reason.slice(0, 512), updatedAt: this.now() }
        : latest
    })
  }

  private bindingMismatch(
    binding: EventAutomationBinding,
    delivery: AutomationDelivery,
  ): string | null {
    if (
      binding.sourceId !== this.adapter.sourceId ||
      binding.connectionId !== this.adapter.connectionId ||
      binding.eventType !== this.adapter.eventType ||
      delivery.sourceId !== binding.sourceId ||
      delivery.connectionId !== binding.connectionId ||
      delivery.eventType !== binding.eventType
    ) {
      return 'Event source or authenticated connection does not match the automation'
    }
    if (binding.projectId !== delivery.projectId || binding.repositoryId !== delivery.repositoryId)
      return 'Event target does not belong to the automation'
    return null
  }

  private async check(record: EventInboxRecord): Promise<string | null> {
    const resolved = await this.host.resolve(record.binding.automationId)
    if (!resolved?.enabled) return 'Automation is deleted, paused or unavailable'
    const current = eventAutomationBindingSchema.parse(resolved.binding)
    if (JSON.stringify(current) !== JSON.stringify(record.binding))
      return 'Saved automation changed; pending delivery needs review'
    const mismatch = this.bindingMismatch(current, record.delivery)
    if (mismatch) return mismatch
    if (record.delivery.originAutomationId) return 'Automation-originated events are not eligible'
    const match = await this.adapter.evaluate(current, record.delivery)
    if (match.kind === 'filtered') return match.reason
    const authorized = await this.host.authorize(record)
    if (!authorized.allowed) return authorized.reason
    const latest = await this.host.resolve(record.binding.automationId)
    if (
      !latest?.enabled ||
      JSON.stringify(eventAutomationBindingSchema.parse(latest.binding)) !== JSON.stringify(current)
    )
      return 'Automation changed during dispatch checks'
    return null
  }

  private result(threadId: string): SupervisedTaskHandlerResult {
    return { resultRef: { kind: 'handler', ref: threadId } }
  }
}
