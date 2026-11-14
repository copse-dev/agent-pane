import { createHash, randomUUID } from 'node:crypto'
import type { LLMMessage, QueuedUserMessage, UserContent } from '@shared/types'
import type { UserSteeringReceipt } from '@copse/thread-store/user-steering.ts'
import { withRunDeadlinePaused } from './hooks/run-deadline.ts'
import {
  appendUserSteeringReceipt,
  acceptReviewedQueuedUserMessage,
  freezeQueuedUserMessage,
  type QueuedUserMessageSnapshot,
  loadUserSteeringReceipts,
} from './thread-store.ts'

export interface NativeSteeringResult {
  state: 'applied' | 'held'
}

export interface PreparedNativeSteeringNote {
  apply: () => LLMMessage[]
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
): Promise<PreparedNativeSteeringNote> {
  const submitted = await deps.submit(text)
  if (submitted.blocked) throw new Error(submitted.blocked)
  const redacted = await deps.redact(text)
  deps.signal.throwIfAborted()
  return {
    apply: (): LLMMessage[] => {
      deps.inject(submitted.injectContext)
      if (redacted.notice) deps.notice(redacted.notice)
      return [{ role: 'user', content: redacted.content }]
    },
  }
}

export interface NativeSteeringApproval {
  text: string
  claim: () => boolean
}

export type NativeSteeringReview = (note: {
  text: string
  messageId: string
  runId: string
  model: string
  revision: string
  signal: AbortSignal
}) => Promise<NativeSteeringApproval | null>

interface PendingNote {
  snapshot: QueuedUserMessageSnapshot
  claim: () => boolean
  item: QueuedUserMessage
  text: string
  settle: (result: NativeSteeringResult) => void
  reject: (error: unknown) => void
}

interface SteeringDependencies {
  freeze: typeof freezeQueuedUserMessage
  accept: typeof acceptReviewedQueuedUserMessage
  record: (projectId: string, threadId: string, receipt: UserSteeringReceipt) => Promise<void>
  receipts: (projectId: string, threadId: string) => Promise<UserSteeringReceipt[]>
}

const defaults: SteeringDependencies = {
  freeze: freezeQueuedUserMessage,
  accept: acceptReviewedQueuedUserMessage,
  record: appendUserSteeringReceipt,
  receipts: loadUserSteeringReceipts,
}

/** One mailbox per primary native loop; nested loops never receive this object. */
export class NativeSteeringSession {
  readonly runId = randomUUID()
  private closed = false
  private readonly reviewController = new AbortController()
  private readonly pending: PendingNote[] = []
  private readonly admissions = new Map<string, Promise<NativeSteeringResult>>()
  private admitting: Promise<void> = Promise.resolve()
  readonly projectId: string
  readonly threadId: string
  private readonly epoch: string
  private readonly signal: AbortSignal
  private readonly model: string
  private readonly deps: SteeringDependencies

  constructor(
    projectId: string,
    threadId: string,
    epoch: string,
    model: string,
    signal: AbortSignal,
    deps: SteeringDependencies = defaults,
  ) {
    this.projectId = projectId
    this.threadId = threadId
    this.epoch = epoch
    this.signal = signal
    this.model = model
    this.deps = deps
  }

  enqueue(messageId: string, review: NativeSteeringReview): Promise<NativeSteeringResult> {
    const existing = this.admissions.get(messageId)
    if (existing) return existing
    if (this.admissions.size >= 16)
      return Promise.reject(
        new Error('This turn has reached its 16-note steering limit. Your note remains held.'),
      )
    const admission = new Promise<NativeSteeringResult>((settle, reject) => {
      this.admitting = this.admitting
        .then(() => this.accept(messageId, review, settle, reject))
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
    review: NativeSteeringReview,
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
    const snapshot = await this.deps.freeze(this.projectId, this.threadId, messageId)
    const item = snapshot.queued
    if (
      item.autoDispatch !== false ||
      item.steeringRequested !== this.runId ||
      item.origin !== undefined ||
      typeof item.payload.content !== 'string' ||
      item.payload.content !== snapshot.message.content ||
      (snapshot.message.images?.length ?? 0) > 0 ||
      (snapshot.message.attachments?.length ?? 0) > 0 ||
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
    if (this.stopped()) {
      settle({ state: 'held' })
      return
    }
    const approval = await withRunDeadlinePaused(this.threadId, () =>
      review({
        text: snapshot.message.content,
        messageId,
        runId: this.runId,
        model: this.model,
        revision: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
        signal: AbortSignal.any([this.signal, this.reviewController.signal]),
      }),
    )
    if (approval === null || this.stopped()) {
      settle({ state: 'held' })
      return
    }
    const { text, claim } = approval
    if (!text.trim() || text.length > 16_000)
      throw new Error('Reviewed steering notes must contain 1 to 16,000 characters.')
    this.pending.push({ snapshot, claim, item, text, settle, reject })
  }

  /** Called only after a full tool batch, before the next primary model request. */
  async drain(
    messages: LLMMessage[],
    commit: () => Promise<void>,
    applied: (item: QueuedUserMessage, text: string) => void,
    prepare: (text: string) => Promise<PreparedNativeSteeringNote>,
  ): Promise<void> {
    await this.admitting
    if (this.stopped() || this.pending.length === 0) return
    const notes = this.pending.splice(0)
    for (const note of notes) {
      let prepared: PreparedNativeSteeringNote
      try {
        prepared = await prepare(note.text)
      } catch (error) {
        note.reject(error)
        continue
      }
      if (this.stopped()) {
        note.settle({ state: 'held' })
        continue
      }
      const originalLength = messages.length
      try {
        // The same saved identity/revision must still win against retirement.
        // This durable canonical acceptance is distinct from mailbox admission.
        const accepted = await this.deps.accept(
          this.projectId,
          this.threadId,
          note.snapshot,
          note.text,
          () => !this.stopped(),
          note.claim,
        )
        if (!accepted) {
          note.settle({ state: 'held' })
          continue
        }
        await this.receipt(note.item.messageId, 'accepted')
        // Acceptance is terminal. Finish the local checkpoint and queue removal
        // even if Stop arrived; the loop checks abort before its next request.
        messages.push(...prepared.apply())
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
    this.reviewController.abort()
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
  review: NativeSteeringReview,
): Promise<NativeSteeringResult> {
  const session = active.get(`${projectId}\0${threadId}`)
  if (!session)
    throw new Error(
      'Steering is available only during a native parent turn. Your note remains held.',
    )
  if (session.runId !== runId)
    throw new Error('That native turn has ended. Your note remains held.')
  return session.enqueue(messageId, review)
}
