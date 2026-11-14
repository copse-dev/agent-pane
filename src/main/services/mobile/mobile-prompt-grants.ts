import { isDeepStrictEqual } from 'node:util'
import type { LLMMessage, UserContent } from '@shared/types'

const QUEUED_GRANT_TTL_MS = 24 * 60 * 60 * 1000

export interface MobilePromptGrant {
  id: string
  senderId: number
  projectId: string
  threadId: string
  content: UserContent
  /** Main-owned provider history frozen when the authenticated phone request arrived. */
  history: LLMMessage[]
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
): LLMMessage[] | null {
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

  mint(grant: MobilePromptGrant, stillAuthorized: () => boolean): void {
    this.prune()
    if (this.grants.has(grant.id)) throw new Error('Mobile prompt grant identity already exists')
    this.grants.set(grant.id, { grant: structuredClone(grant), stillAuthorized })
  }

  consume(
    id: string,
    expected: {
      senderId: number
      projectId: string
      threadId: string
      content: UserContent
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
      this.grants.delete(id)
      return null
    }
    if (
      stored.grant.senderId !== expected.senderId ||
      stored.grant.projectId !== expected.projectId ||
      stored.grant.threadId !== expected.threadId ||
      !isDeepStrictEqual(stored.grant.content, expected.content)
    )
      return null
    // Delete synchronously before returning authority. No downstream provider,
    // tool or persistence failure may make a consumed phone prompt replayable.
    this.grants.delete(id)
    const grant = stored.grant
    return {
      id: grant.id,
      senderId: grant.senderId,
      projectId: grant.projectId,
      threadId: grant.threadId,
      content: grant.content,
      history: grant.history,
      ...(grant.model !== undefined ? { model: grant.model } : {}),
      expiresAt: grant.expiresAt,
    }
  }

  markQueued(id: string): void {
    const stored = this.grants.get(id)
    if (stored) stored.grant.expiresAt = Date.now() + QUEUED_GRANT_TTL_MS
  }

  revoke(id: string): void {
    this.grants.delete(id)
  }

  revokeSender(senderId: number): void {
    for (const [id, stored] of this.grants)
      if (stored.grant.senderId === senderId) this.grants.delete(id)
  }

  private prune(): void {
    const now = Date.now()
    for (const [id, stored] of this.grants)
      if (stored.grant.expiresAt <= now) this.grants.delete(id)
  }
}

export const mobilePromptGrants = new MobilePromptGrants()
