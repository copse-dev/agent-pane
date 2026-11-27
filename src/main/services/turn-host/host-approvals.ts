import { randomUUID } from 'node:crypto'
import type { ApprovalRequest, ApprovalResponse } from '../approval.ts'
import type { QueueEntry } from '../diff-queue.ts'
import type { SshPromptRequest, SshPromptResponse } from '../ssh-workspace/ssh-prompt.ts'
import type { ThreadPromptResult } from '@shared/thread-prompt.ts'
import type {
  HostApprovalAnswer,
  HostThreadPromptCommand,
  HostToApp,
} from './turn-host-protocol.ts'

/**
 * The prompts host turns are waiting on (`docs/plans/local-turn-worker.md`,
 * "Every turn in a turn host", H3 and H3b): approvals, staged edits for the diff
 * panel, SSH password and host-key prompts, and prompts to other threads (the
 * window submits those, as it does for an in-process turn).
 *
 * A host turn asks here instead of a window. Each prompt goes to every attached
 * app, waits for an answer however long none is attached, and is asked again of
 * each app that attaches, so a prompt raised while the window was closed is
 * there when it opens. The first answer settles it, and every app is told to
 * take it down.
 */

type PromptMessage = Extract<
  HostToApp,
  { t: 'approval' | 'review-diff' | 'ssh-prompt' | 'thread-prompt' }
>

const DENIED: ApprovalResponse = { approved: false, remember: false }
const CANCELLED: ThreadPromptResult = { ok: false, error: 'Sending was cancelled.' }

interface OpenPrompt<T> {
  message: PromptMessage
  resolve: (answer: T) => void
}

export class HostApprovals {
  /** Waiting prompts by kind, so each settles only with an answer of its own type. */
  private readonly approvals = new Map<string, OpenPrompt<ApprovalResponse>>()
  private readonly diffs = new Map<string, OpenPrompt<boolean>>()
  private readonly ssh = new Map<string, OpenPrompt<SshPromptResponse>>()
  private readonly threadPrompts = new Map<string, OpenPrompt<ThreadPromptResult>>()
  /** Every waiting prompt in the order it was raised, for an app that attaches. */
  private readonly raised = new Map<string, PromptMessage>()
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
      this.approvals,
      { t: 'approval', id: this.createId(), projectId, threadId, request },
      DENIED,
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
      this.diffs,
      { t: 'review-diff', id: this.createId(), projectId, threadId, entry },
      false,
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
      this.ssh,
      { t: 'ssh-prompt', id: this.createId(), projectId, threadId, request },
      { value: '' },
    )
  }

  /** Have the window submit a prompt to another thread. A Stop cancels it. */
  sendThreadPrompt(
    projectId: string,
    threadId: string,
    command: HostThreadPromptCommand,
    signal?: AbortSignal,
  ): Promise<ThreadPromptResult> {
    return this.prompt(
      this.threadPrompts,
      { t: 'thread-prompt', id: this.createId(), projectId, threadId, command },
      CANCELLED,
      signal,
    )
  }

  /** An app answered an approval. A prompt already settled ignores it. */
  answer(id: string, answer: HostApprovalAnswer): void {
    this.settle(this.approvals, id, {
      approved: answer.approved,
      remember: answer.remember,
      ...(answer.grantScope ? { grantScope: answer.grantScope } : {}),
      resolution: 'user',
    })
  }

  answerDiff(id: string, approved: boolean): void {
    this.settle(this.diffs, id, approved)
  }

  answerSsh(id: string, response: SshPromptResponse): void {
    this.settle(this.ssh, id, response)
  }

  answerThreadPrompt(id: string, result: ThreadPromptResult): void {
    this.settle(this.threadPrompts, id, result)
  }

  /** Ask an app that just attached everything still waiting. */
  replay(send: (message: HostToApp) => void): void {
    for (const message of this.raised.values()) send(message)
  }

  pendingCount(): number {
    return this.raised.size
  }

  private prompt<T>(
    open: Map<string, OpenPrompt<T>>,
    message: PromptMessage,
    unanswered: T,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted === true) return Promise.resolve(unanswered)
    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.settle(open, message.id, unanswered)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      open.set(message.id, {
        message,
        resolve: (answer): void => {
          signal?.removeEventListener('abort', onAbort)
          resolve(answer)
        },
      })
      this.raised.set(message.id, message)
      this.send(message)
    })
  }

  /** Settle a prompt of this kind; an id of another kind, or one settled, is ignored. */
  private settle<T>(open: Map<string, OpenPrompt<T>>, id: string, answer: T): void {
    const prompt = open.get(id)
    if (!prompt) return
    open.delete(id)
    this.raised.delete(id)
    this.send({ t: 'approval-cancel', id })
    prompt.resolve(answer)
  }
}
