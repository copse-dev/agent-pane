import { randomUUID } from 'node:crypto'
import type { LLMMessage, QueuedUserMessage, UserContent } from '@shared/types'
import type { UserSteeringReceipt } from '@copse/thread-store/user-steering.ts'
import {
  appendUserSteeringReceipt,
  getThreadMeta,
  loadUserSteeringReceipts,
} from './thread-store.ts'

export interface NativeSteeringResult {
  state: 'applied' | 'held'
}

/** The production hook/redaction gate, shared by every steered note. */
export async function prepareNativeSteeringNote(
  text: string,
  deps: {
    submit: (text: string) => Promise<{ blocked: string | null; injectContext?: string }>
    redact: (text: string) => Promise<{ content: UserContent; notice?: string }>
    signal: AbortSignal
    inject: (context: string | undefined) => void
    notice: (text: string) => void
  },
): Promise<LLMMessage[]> {
  const submitted = await deps.submit(text)
  if (submitted.blocked) throw new Error(submitted.blocked)
  const redacted = await deps.redact(text)
  deps.signal.throwIfAborted()
  deps.inject(submitted.injectContext)
  if (redacted.notice) deps.notice(redacted.notice)
  return [{ role: 'user', content: redacted.content }]
}

interface PendingNote {
  item: QueuedUserMessage
  text: string
  settle: (result: NativeSteeringResult) => void
  reject: (error: unknown) => void
}

interface SteeringDependencies {
  loadQueue: (projectId: string, threadId: string) => Promise<QueuedUserMessage[]>
  record: (projectId: string, threadId: string, receipt: UserSteeringReceipt) => Promise<void>
  receipts: (projectId: string, threadId: string) => Promise<UserSteeringReceipt[]>
}

const defaults: SteeringDependencies = {
  loadQueue: async (projectId, threadId) =>
    (await getThreadMeta(projectId, threadId))?.pendingMessages ?? [],
  record: appendUserSteeringReceipt,
  receipts: loadUserSteeringReceipts,
}

/** One mailbox per primary native loop; nested loops never receive this object. */
export class NativeSteeringSession {
  readonly runId = randomUUID()
  private closed = false
  private readonly pending: PendingNote[] = []
  private readonly admissions = new Map<string, Promise<NativeSteeringResult>>()
  private admitting: Promise<void> = Promise.resolve()
  readonly projectId: string
  readonly threadId: string
  private readonly epoch: string
  private readonly signal: AbortSignal
  private readonly deps: SteeringDependencies

  constructor(
    projectId: string,
    threadId: string,
    epoch: string,
    signal: AbortSignal,
    deps: SteeringDependencies = defaults,
  ) {
    this.projectId = projectId
    this.threadId = threadId
    this.epoch = epoch
    this.signal = signal
    this.deps = deps
  }

  enqueue(messageId: string): Promise<NativeSteeringResult> {
    const existing = this.admissions.get(messageId)
    if (existing) return existing
    if (this.admissions.size >= 16)
      return Promise.reject(
        new Error('This turn has reached its 16-note steering limit. Your note remains held.'),
      )
    const admission = new Promise<NativeSteeringResult>((settle, reject) => {
      this.admitting = this.admitting
        .then(() => this.accept(messageId, settle, reject))
        .catch(reject)
    })
    this.admissions.set(messageId, admission)
    return admission
  }

  private receipt(messageId: string, state: UserSteeringReceipt['state']): Promise<void> {
    return this.deps.record(this.projectId, this.threadId, {
      messageId,
      runId: this.runId,
      epoch: this.epoch,
      at: Date.now(),
      state,
    })
  }

  /** Re-read mutable cancellation state after each asynchronous admission/preparation step. */
  private stopped(): boolean {
    return this.closed || this.signal.aborted
  }

  private async accept(
    messageId: string,
    settle: PendingNote['settle'],
    reject: PendingNote['reject'],
  ): Promise<void> {
    if (this.stopped()) {
      settle({ state: 'held' })
      return
    }
    const receipts = await this.deps.receipts(this.projectId, this.threadId)
    if (
      receipts.some((receipt) => receipt.messageId === messageId && receipt.state === 'applied')
    ) {
      settle({ state: 'applied' })
      return
    }
    if (
      receipts.some((receipt) => receipt.messageId === messageId && receipt.state === 'accepted')
    ) {
      throw new Error(
        'This note has an earlier delivery attempt. Inspect the saved conversation before releasing it as a new turn.',
      )
    }
    const queue = await this.deps.loadQueue(this.projectId, this.threadId)
    const item = queue.find((entry) => entry.messageId === messageId)
    if (
      !item ||
      item.autoDispatch !== false ||
      item.steeringRequested !== this.runId ||
      item.origin !== undefined ||
      typeof item.payload.content !== 'string' ||
      !item.payload.content.trim() ||
      (item.payload.invokedSkills?.length ?? 0) > 0 ||
      item.payload.invokedAgent !== undefined
    ) {
      throw new Error(
        'Steering requires a held, human-authored plain-text note without skills or agents.',
      )
    }
    if (item.payload.content.length > 16_000)
      throw new Error('Steering notes must be at most 16,000 characters.')
    const text = item.payload.content
    await this.receipt(messageId, 'accepted')
    if (this.stopped()) {
      await this.receipt(messageId, 'held')
      settle({ state: 'held' })
      return
    }
    this.pending.push({ item, text, settle, reject })
  }

  /** Called only after a full tool batch, before the next primary model request. */
  async drain(
    messages: LLMMessage[],
    commit: () => Promise<void>,
    applied: (item: QueuedUserMessage, text: string) => void,
    prepare: (text: string) => Promise<LLMMessage[]>,
  ): Promise<void> {
    await this.admitting
    if (this.stopped() || this.pending.length === 0) return
    const notes = this.pending.splice(0)
    for (const note of notes) {
      let additions: LLMMessage[]
      try {
        additions = await prepare(note.text)
      } catch (error) {
        note.reject(error)
        continue
      }
      if (this.stopped()) {
        note.settle({ state: 'held' })
        continue
      }
      const originalLength = messages.length
      messages.push(...additions)
      try {
        // A receipt never claims durable application before provider history is saved.
        await commit()
        await this.receipt(note.item.messageId, 'applied')
        applied(note.item, note.text)
        note.settle({ state: 'applied' })
      } catch (error) {
        // Fail the turn rather than making a provider request from uncertain history.
        messages.splice(originalLength)
        for (const remaining of notes) remaining.reject(error)
        throw error
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await this.admitting
    const notes = this.pending.splice(0)
    const outcomes = await Promise.allSettled(
      notes.map(async (note) => {
        try {
          await this.receipt(note.item.messageId, 'held')
        } finally {
          note.settle({ state: 'held' })
        }
      }),
    )
    const failure = outcomes.find((outcome) => outcome.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
}

const active = new Map<string, NativeSteeringSession>()

export function bindNativeSteering(session: NativeSteeringSession): () => void {
  const key = `${session.projectId}\0${session.threadId}`
  if (active.has(key)) throw new Error('A native steering session already owns this thread.')
  active.set(key, session)
  return () => {
    if (active.get(key) === session) active.delete(key)
  }
}

export function steerNativeParent(
  projectId: string,
  threadId: string,
  messageId: string,
  runId: string,
): Promise<NativeSteeringResult> {
  const session = active.get(`${projectId}\0${threadId}`)
  if (!session)
    throw new Error(
      'Steering is available only during a native parent turn. Your note remains held.',
    )
  if (session.runId !== runId)
    throw new Error('That native turn has ended. Your note remains held.')
  return session.enqueue(messageId)
}
