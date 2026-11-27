import { randomUUID } from 'node:crypto'
import type { ApprovalRequest, ApprovalResponse } from '../approval.ts'
import type { HostApprovalAnswer, HostToApp } from './turn-host-protocol.ts'

/**
 * The prompts host turns are waiting on (`docs/plans/local-turn-worker.md`,
 * "Every turn in a turn host", H3).
 *
 * A gate in a host turn asks here instead of a window. Each prompt goes to
 * every attached app, waits for an answer however long none is attached, and
 * is asked again of each app that attaches, so a prompt raised while the window
 * was closed is there when it opens. The first answer settles it, and every app
 * is told to take it down.
 */

type ApprovalMessage = Extract<HostToApp, { t: 'approval' }>

const DENIED: ApprovalResponse = { approved: false, remember: false }

interface OpenPrompt {
  message: ApprovalMessage
  settle: (response: ApprovalResponse) => void
}

export class HostApprovals {
  private readonly open = new Map<string, OpenPrompt>()
  private readonly send: (message: HostToApp) => void
  private readonly createId: () => string

  constructor(send: (message: HostToApp) => void, createId: () => string = randomUUID) {
    this.send = send
    this.createId = createId
  }

  /** Ask the window on behalf of a thread's turn. A Stop (the signal) denies. */
  ask(
    projectId: string,
    threadId: string,
    request: ApprovalRequest,
    signal?: AbortSignal,
  ): Promise<ApprovalResponse> {
    if (signal?.aborted === true) return Promise.resolve(DENIED)
    const id = this.createId()
    const message: ApprovalMessage = { t: 'approval', id, projectId, threadId, request }
    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.settle(id, DENIED)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.open.set(id, {
        message,
        settle: (response): void => {
          signal?.removeEventListener('abort', onAbort)
          resolve(response)
        },
      })
      this.send(message)
    })
  }

  /** An app answered. A prompt already settled ignores it. */
  answer(id: string, answer: HostApprovalAnswer): void {
    this.settle(id, {
      approved: answer.approved,
      remember: answer.remember,
      ...(answer.grantScope ? { grantScope: answer.grantScope } : {}),
      resolution: 'user',
    })
  }

  /** Ask an app that just attached everything still waiting. */
  replay(send: (message: HostToApp) => void): void {
    for (const prompt of this.open.values()) send(prompt.message)
  }

  pendingCount(): number {
    return this.open.size
  }

  private settle(id: string, response: ApprovalResponse): void {
    const prompt = this.open.get(id)
    if (!prompt) return
    this.open.delete(id)
    this.send({ t: 'approval-cancel', id })
    prompt.settle(response)
  }
}
