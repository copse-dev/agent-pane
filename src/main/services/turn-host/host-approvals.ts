import { randomUUID } from 'node:crypto'
import type { ApprovalRequest, ApprovalResponse } from '../approval.ts'
import type { QueueEntry } from '../diff-queue.ts'
import type { SshPromptRequest, SshPromptResponse } from '../ssh-workspace/ssh-prompt.ts'
import type { HostApprovalAnswer, HostToApp } from './turn-host-protocol.ts'

/**
 * The prompts host turns are waiting on (`docs/plans/local-turn-worker.md`,
 * "Every turn in a turn host", H3 and H3b): approvals, staged edits for the diff
 * panel, and SSH password and host-key prompts.
 *
 * A host turn asks here instead of a window. Each prompt goes to every attached
 * app, waits for an answer however long none is attached, and is asked again of
 * each app that attaches, so a prompt raised while the window was closed is
 * there when it opens. The first answer settles it, and every app is told to
 * take it down.
 */

type PromptMessage = Extract<HostToApp, { t: 'approval' | 'review-diff' | 'ssh-prompt' }>

const DENIED: ApprovalResponse = { approved: false, remember: false }

interface OpenPrompt {
  message: PromptMessage
  settle: (answer: unknown) => void
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
    return this.prompt(
      { t: 'approval', id: this.createId(), projectId, threadId, request },
      DENIED,
      isApprovalResponse,
      signal,
    )
  }

  /**
   * Show a staged edit in the window's diff panel. Resolves whether the user
   * approved it; the host applies it, so it is written once, where the turn runs.
   */
  reviewDiff(
    projectId: string,
    threadId: string,
    entry: QueueEntry,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.prompt(
      { t: 'review-diff', id: this.createId(), projectId, threadId, entry },
      false,
      (answer) => typeof answer === 'boolean',
      signal,
    )
  }

  /** Ask for an SSH password or host-key answer. Empty means no answer. */
  askSsh(
    projectId: string,
    threadId: string,
    request: SshPromptRequest,
  ): Promise<SshPromptResponse> {
    return this.prompt(
      { t: 'ssh-prompt', id: this.createId(), projectId, threadId, request },
      { value: '' },
      isSshPromptResponse,
    )
  }

  /** An app answered an approval. A prompt already settled ignores it. */
  answer(id: string, answer: HostApprovalAnswer): void {
    this.settle(id, 'approval', {
      approved: answer.approved,
      remember: answer.remember,
      ...(answer.grantScope ? { grantScope: answer.grantScope } : {}),
      resolution: 'user',
    } satisfies ApprovalResponse)
  }

  answerDiff(id: string, approved: boolean): void {
    this.settle(id, 'review-diff', approved)
  }

  answerSsh(id: string, response: SshPromptResponse): void {
    this.settle(id, 'ssh-prompt', response)
  }

  /** Ask an app that just attached everything still waiting. */
  replay(send: (message: HostToApp) => void): void {
    for (const prompt of this.open.values()) send(prompt.message)
  }

  pendingCount(): number {
    return this.open.size
  }

  private prompt<T>(
    message: PromptMessage,
    unanswered: T,
    is: (answer: unknown) => answer is T,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted === true) return Promise.resolve(unanswered)
    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.settle(message.id, message.t, unanswered)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.open.set(message.id, {
        message,
        settle: (answer): void => {
          signal?.removeEventListener('abort', onAbort)
          resolve(is(answer) ? answer : unanswered)
        },
      })
      this.send(message)
    })
  }

  /** Settle a prompt with an answer of its own kind; any other answer is ignored. */
  private settle(id: string, kind: PromptMessage['t'], answer: unknown): void {
    const prompt = this.open.get(id)
    if (prompt?.message.t !== kind) return
    this.open.delete(id)
    this.send({ t: 'approval-cancel', id })
    prompt.settle(answer)
  }
}

function isApprovalResponse(answer: unknown): answer is ApprovalResponse {
  return typeof answer === 'object' && answer !== null && 'approved' in answer
}

function isSshPromptResponse(answer: unknown): answer is SshPromptResponse {
  return typeof answer === 'object' && answer !== null && 'value' in answer
}
