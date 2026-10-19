import { randomUUID } from 'node:crypto'
import type { AskUserQuestion } from '@copse/agent/ask-user-format.ts'

/** Identity supplied by an authenticated transport, never by the decision payload. */
export interface HumanDecisionPrincipal {
  id: string
  label: string
  /** Absent preserves the existing authenticated phone transport's identity. */
  source?: 'plugin-client'
}

export function humanDecisionSource(principal: HumanDecisionPrincipal): string {
  return `${principal.source ?? 'mobile'}:${principal.id} (${principal.label})`
}

export function humanDecisionActor(principal: HumanDecisionPrincipal): 'user' | 'mobile-device' {
  return principal.source === 'plugin-client' ? 'user' : 'mobile-device'
}

export type HumanDecision =
  | { id: string; kind: 'approval'; title: string; body: string; advice?: string; footer?: string }
  | { id: string; kind: 'question'; questions: AskUserQuestion[] }

export type HumanDecisionAnswer =
  | { kind: 'approval'; approved: boolean }
  | { kind: 'question'; answers: string[] }

export interface HumanDecisionRequest {
  projectId: string
  threadId: string
  revision: number
  decision: HumanDecision
  /** Set only by a host producer whose approve-once semantics this preview represents. */
  interactiveClientSupported?: true
}

export interface HumanDecisionSnapshot {
  sessionId: string
  sequence: number
  requests: HumanDecisionRequest[]
}

/** Every field is checked against the pending registration before accepting an answer. */
export interface HumanDecisionReference {
  sessionId: string
  projectId: string
  threadId: string
  requestId: string
  revision: number
}

interface PendingDecision {
  request: HumanDecisionRequest
  answer: (answer: HumanDecisionAnswer, principal: HumanDecisionPrincipal) => void
}

/**
 * Shared pending prompts beneath human-facing transports. This is not a permission grant:
 * callers must authenticate and authorize their principal before reading or answering.
 * Only prompts registered by the desktop lifecycle can be answered here.
 */
export class HumanDecisions {
  private readonly sessionId = randomUUID()
  private sequence = 0
  private readonly pending = new Map<string, PendingDecision>()
  private readonly subscriptions = new Set<{
    listener: (snapshot: HumanDecisionSnapshot) => void
  }>()
  private notificationQueued = false

  register(
    projectId: string,
    threadId: string,
    decision: HumanDecision,
    answer: PendingDecision['answer'],
    options: { interactiveClientSupported?: boolean } = {},
  ): () => void {
    const requestId = decision.id
    const entry: PendingDecision = {
      request: {
        projectId,
        threadId,
        revision: this.sequence + 1,
        decision: structuredClone(decision),
        ...(options.interactiveClientSupported ? { interactiveClientSupported: true } : {}),
      },
      answer,
    }
    this.pending.set(requestId, entry)
    this.changed()
    return () => {
      // A replaced registration owns its own lifetime, even when an ID is reused.
      if (this.pending.get(requestId) !== entry) return
      this.pending.delete(requestId)
      this.changed()
    }
  }

  /** Detached copies prevent readers, publishers and subscribers from changing approval meaning. */
  snapshot(): HumanDecisionSnapshot {
    return {
      sessionId: this.sessionId,
      sequence: this.sequence,
      requests: [...this.pending.values()].map((entry) => structuredClone(entry.request)),
    }
  }

  /**
   * Initial state and changes arrive after the current registration/settlement stack completes.
   * Notifications coalesce into complete snapshots, not a lossless history of transitions.
   */
  subscribe(listener: (snapshot: HumanDecisionSnapshot) => void): () => void {
    const subscription = { listener }
    this.subscriptions.add(subscription)
    this.notify()
    return () => this.subscriptions.delete(subscription)
  }

  respond(
    reference: HumanDecisionReference,
    answer: HumanDecisionAnswer,
    principal: HumanDecisionPrincipal,
  ): boolean {
    const entry = this.pending.get(reference.requestId)
    if (
      reference.sessionId !== this.sessionId ||
      !entry ||
      entry.request.projectId !== reference.projectId ||
      entry.request.threadId !== reference.threadId ||
      entry.request.revision !== reference.revision ||
      entry.request.decision.kind !== answer.kind
    )
      return false
    if (
      entry.request.decision.kind === 'question' &&
      answer.kind === 'question' &&
      entry.request.decision.questions.length !== answer.answers.length
    )
      return false

    // Remove before invoking either a response callback or an observer. A second client,
    // including a reentrant callback, can never answer this registration again.
    this.pending.delete(reference.requestId)
    this.changed()
    entry.answer(answer, principal)
    return true
  }

  private changed(): void {
    this.sequence++
    this.notify()
  }

  private notify(): void {
    if (this.notificationQueued || this.subscriptions.size === 0) return
    this.notificationQueued = true
    queueMicrotask(() => {
      this.notificationQueued = false
      const snapshot = this.snapshot()
      for (const subscription of [...this.subscriptions]) {
        if (!this.subscriptions.has(subscription)) continue
        try {
          subscription.listener(structuredClone(snapshot))
        } catch (error) {
          // Device delivery must not break the desktop approval or other subscribers.
          console.warn('[human-decisions] Snapshot subscriber failed:', error)
        }
      }
    })
  }
}

export const humanDecisions = new HumanDecisions()
