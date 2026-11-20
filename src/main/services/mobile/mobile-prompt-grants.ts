import { isDeepStrictEqual } from 'node:util'
import type { LLMMessage, UserContent } from '@shared/types'
import type { StoredThreadPlan } from '@copse/thread-store/plan-schema.ts'

const QUEUED_GRANT_TTL_MS = 24 * 60 * 60 * 1000

export interface MobilePromptGrant {
  id: string
  /** Main-minted identity of the only transcript bubble this grant may accept. */
  messageId: string
  senderId: number
  projectId: string
  threadId: string
  content: UserContent
  /** Main-owned provider history frozen when the authenticated phone request arrived. */
  history: LLMMessage[]
  /** Main reserved this target for a phone-created thread with no prior context. */
  createsThread: boolean
  /** Exact main-served plan revision reviewed by the authenticated phone. */
  plan: StoredThreadPlan | null
  model?: string
  expiresAt: number
}

/**
 * Admit only provider-history growth after the authenticated phone request.
 * Main owns this sidecar; renderer-authored transcript or plan state never
 * participates. Replacement or truncation means the frozen context changed
 * incompatibly and requires ordinary desktop review.
 */
export function extendMobilePromptHistory(
  frozen: readonly LLMMessage[],
  current: readonly LLMMessage[],
  createsThread = false,
): LLMMessage[] | null {
  // An empty prefix matches every history. For a new phone target, accepting
  // that ordinary prefix rule would let renderer XSS fork arbitrary canonical
  // history into the reserved UUID before consuming the grant.
  if (createsThread) return frozen.length === 0 && current.length === 0 ? [] : null
  if (current.length < frozen.length || !isDeepStrictEqual(current.slice(0, frozen.length), frozen))
    return null
  return structuredClone([...current])
}

/** One-use authority minted only after Mobile Companion bearer authentication. */
export class MobilePromptGrants {
  private readonly grants = new Map<
    string,
    { grant: MobilePromptGrant; stillAuthorized: () => boolean }
  >()
  /** New phone-thread identities stay main-owned until protected dispatch has admitted them. */
  private readonly reservedTargets = new Map<string, string>()
  private readonly targetByGrant = new Map<string, string>()

  private targetKey(projectId: string, threadId: string): string {
    return JSON.stringify([projectId, threadId])
  }

  private removeUnconsumed(id: string): void {
    if (!this.grants.delete(id)) return
    this.releaseTarget(id)
  }

  mint(grant: MobilePromptGrant, stillAuthorized: () => boolean): void {
    this.prune()
    if (this.grants.has(grant.id)) throw new Error('Mobile prompt grant identity already exists')
    if (grant.createsThread) {
      const key = this.targetKey(grant.projectId, grant.threadId)
      if (this.reservedTargets.has(key))
        throw new Error('Mobile prompt target identity is already reserved')
      this.reservedTargets.set(key, grant.id)
      this.targetByGrant.set(grant.id, key)
    }
    this.grants.set(grant.id, { grant: structuredClone(grant), stillAuthorized })
  }

  consume(
    id: string,
    expected: {
      senderId: number
      projectId: string
      threadId: string
      content: UserContent
      messageId: string | undefined
    },
  ): MobilePromptGrant | null {
    this.prune()
    const stored = this.grants.get(id)
    if (!stored) return null
    let authorized = false
    try {
      authorized = stored.stillAuthorized()
    } catch {
      // A broken revocation source is denial, never ambient authority.
    }
    if (!authorized) {
      this.removeUnconsumed(id)
      return null
    }
    if (
      stored.grant.senderId !== expected.senderId ||
      stored.grant.projectId !== expected.projectId ||
      stored.grant.threadId !== expected.threadId ||
      stored.grant.messageId !== expected.messageId ||
      !isDeepStrictEqual(stored.grant.content, expected.content)
    )
      return null
    // Delete synchronously before returning authority. No downstream provider,
    // tool or persistence failure may make a consumed phone prompt replayable.
    // A new-thread reservation deliberately outlives the grant until dispatch
    // has frozen its context; otherwise delete/recreate could race this return.
    this.grants.delete(id)
    const grant = stored.grant
    return {
      id: grant.id,
      messageId: grant.messageId,
      senderId: grant.senderId,
      projectId: grant.projectId,
      threadId: grant.threadId,
      content: grant.content,
      history: grant.history,
      createsThread: grant.createsThread,
      plan: grant.plan,
      ...(grant.model !== undefined ? { model: grant.model } : {}),
      expiresAt: grant.expiresAt,
    }
  }

  markQueued(id: string): void {
    const stored = this.grants.get(id)
    if (stored) stored.grant.expiresAt = Date.now() + QUEUED_GRANT_TTL_MS
  }

  revoke(id: string): void {
    this.removeUnconsumed(id)
  }

  /** A durable queued-message deletion also retires its unconsumed phone authority. */
  revokeMessage(projectId: string, threadId: string, messageId: string): void {
    for (const [id, stored] of this.grants)
      if (
        stored.grant.projectId === projectId &&
        stored.grant.threadId === threadId &&
        stored.grant.messageId === messageId
      )
        this.removeUnconsumed(id)
  }

  revokeSender(senderId: number): void {
    for (const [id, stored] of this.grants)
      if (stored.grant.senderId === senderId) this.removeUnconsumed(id)
  }

  isTargetReserved(projectId: string, threadId: string): boolean {
    return this.reservedTargets.has(this.targetKey(projectId, threadId))
  }

  /** Release only after protected dispatch has finished admitting the frozen inputs. */
  releaseTarget(id: string): void {
    const key = this.targetByGrant.get(id)
    if (key === undefined) return
    if (this.reservedTargets.get(key) === id) this.reservedTargets.delete(key)
    this.targetByGrant.delete(id)
  }

  private prune(): void {
    const now = Date.now()
    for (const [id, stored] of this.grants)
      if (stored.grant.expiresAt <= now) this.removeUnconsumed(id)
  }
}

export const mobilePromptGrants = new MobilePromptGrants()
