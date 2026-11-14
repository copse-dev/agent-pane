import type { AgentDispatchPayload } from './agent-dispatcher.ts'
import type { Thread } from '@shared/types/thread.ts'

const MAX_PENDING_GRANTS = 4096
const ACTIVATED_GRANT_LIFETIME_MS = 10_000

interface ThreadPromptDispatchGrant {
  senderId: number
  projectId: string
  parentThreadId: string
  childThreadId: string
  content: string
  payload: AgentDispatchPayload
  messageId?: string
  activatedAt?: number
  stillAuthorized: () => boolean
}

export interface ThreadPromptDispatchGrantInput {
  id: string
  senderId: number
  projectId: string
  parentThreadId: string
  childThreadId: string
  content: string
  payload: AgentDispatchPayload
}

export interface ThreadPromptDispatchGrantClaim {
  senderId: number
  projectId: string
  parentThreadId: string
  childThreadId: string
  content: string
  messageId: string
}

export interface ThreadPromptDispatchGrantValue {
  payload: AgentDispatchPayload
  messageId: string
}

export interface ThreadPromptGrantActivationClaim {
  id: string
  messageId: string
  sourceThreadId: string
  content: string
}

export type ThreadPromptGrantActivation = 'activated' | 'rejected'

/**
 * Decide whether this is the exact first Main-authored queue entry. Main only
 * mints these grants for a newly created owned child, so renderer-controlled
 * status, pause and budget metadata are deliberately not authorization inputs.
 */
export function threadPromptGrantActivation(
  thread: Thread,
  claim: ThreadPromptGrantActivationClaim,
): ThreadPromptGrantActivation {
  const queued = thread.pendingMessages?.find((item) => item.messageId === claim.messageId)
  const exactQueued =
    queued?.threadPromptGrantId === claim.id &&
    queued.autoDispatch !== false &&
    queued.payload.content === claim.content &&
    queued.origin?.kind === 'machine' &&
    queued.origin.operationId === `subthread:${claim.sourceThreadId}` &&
    thread.pendingMessages?.find((item) => item.autoDispatch !== false)?.messageId ===
      claim.messageId
  if (!exactQueued) return 'rejected'
  return 'activated'
}

/**
 * One-use authority for a prompt Main itself asked the renderer to enqueue.
 *
 * Renderer state may carry the opaque id, but it cannot change the canonical
 * prompt, target, parent, or payload that the model-authorized command froze.
 */
export class ThreadPromptDispatchGrants {
  private readonly pending = new Map<string, ThreadPromptDispatchGrant>()

  mint(input: ThreadPromptDispatchGrantInput, stillAuthorized: () => boolean): void {
    this.pending.delete(input.id)
    this.pending.set(input.id, {
      ...input,
      payload: structuredClone(input.payload),
      stillAuthorized,
    })
    while (this.pending.size > MAX_PENDING_GRANTS) {
      const oldest = this.pending.keys().next().value
      if (oldest === undefined) break
      this.pending.delete(oldest)
    }
  }

  activate(id: string, senderId: number, messageId: string): boolean {
    const grant = this.pending.get(id)
    if (!grant || grant.senderId !== senderId || grant.messageId !== undefined) {
      this.pending.delete(id)
      return false
    }
    if (!grant.stillAuthorized()) {
      this.pending.delete(id)
      return false
    }
    grant.messageId = messageId
    grant.activatedAt = Date.now()
    return true
  }

  consume(
    id: string,
    claim: ThreadPromptDispatchGrantClaim,
  ): ThreadPromptDispatchGrantValue | null {
    const grant = this.pending.get(id)
    // Every attempted spend is terminal. A compromised renderer cannot probe a
    // real id with altered fields and then replay it with a corrected request.
    this.pending.delete(id)
    if (
      !grant ||
      grant.senderId !== claim.senderId ||
      grant.projectId !== claim.projectId ||
      grant.parentThreadId !== claim.parentThreadId ||
      grant.childThreadId !== claim.childThreadId ||
      grant.content !== claim.content ||
      grant.messageId === undefined ||
      grant.messageId !== claim.messageId ||
      grant.activatedAt === undefined ||
      Date.now() - grant.activatedAt > ACTIVATED_GRANT_LIFETIME_MS ||
      !grant.stillAuthorized()
    )
      return null
    return {
      payload: structuredClone(grant.payload),
      messageId: grant.messageId,
    }
  }

  revoke(id: string): void {
    this.pending.delete(id)
  }

  revokeSender(senderId: number): void {
    for (const [id, grant] of this.pending) {
      if (grant.senderId === senderId) this.pending.delete(id)
    }
  }

  revokeMessage(projectId: string, threadId: string, messageId: string): void {
    for (const [id, grant] of this.pending) {
      if (
        grant.projectId === projectId &&
        grant.childThreadId === threadId &&
        grant.messageId === messageId
      )
        this.pending.delete(id)
    }
  }
}

export const threadPromptDispatchGrants = new ThreadPromptDispatchGrants()
