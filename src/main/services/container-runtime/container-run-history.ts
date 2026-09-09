/**
 * A container run as the thread's model history sees it (decision A14).
 *
 * The run is a turn on the thread — its prompt as a user message, its card as
 * an assistant tool call with the review record as the result — but it never
 * goes through the agent dispatcher, which is what writes `agent-history.json`
 * and keeps the in-memory copy of it. After the first real run, a message
 * sent to the thread started with no history at all: the sidecar still held
 * what the dispatcher last wrote, and the dispatcher's cache had been filled
 * by the composer's context estimate before the run's card existed. The turn
 * answered as if nothing had happened, under a notice saying so.
 *
 * So a settled run is written into the history the way the dispatcher would
 * have written it: appended to the sidecar when there is one, rebuilt from
 * the transcript plus the card when there is not (the card may not be on
 * disk yet, so it is supplied rather than read back), and the dispatcher's
 * cache is dropped so the next turn loads what was written.
 */
import type { ContainerRunProgress } from '@shared/types/container-run.ts'
import type { LLMMessage, Message, Thread } from '@shared/types'
import { CONTAINER_RUN_TOOL, containerRunToolCall } from '@shared/store/container-run-card.ts'
import { rebuildAgentHistory } from '../thread-fork.ts'

export interface ContainerRunHistoryDeps {
  loadHistory: (projectId: string, threadId: string) => Promise<LLMMessage[]>
  saveHistory: (projectId: string, threadId: string, messages: LLMMessage[]) => Promise<void>
  loadThread: (projectId: string, threadId: string) => Promise<Thread | null>
  /** Drop the dispatcher's in-memory copy, so the next turn reads the sidecar. */
  forgetHistory: (projectId: string, threadId: string) => void
}

/** The run as transcript messages: what the thread shows for it. */
function turnMessages(progress: ContainerRunProgress): Message[] {
  const toolCall = containerRunToolCall(progress)
  return [
    {
      id: `${toolCall.id}:prompt`,
      role: 'user',
      content: progress.prompt,
      toolCalls: [],
      createdAt: progress.startedAt,
    },
    {
      id: `${toolCall.id}:card`,
      role: 'assistant',
      content: '',
      toolCalls: [toolCall],
      createdAt: progress.finishedAt ?? progress.startedAt,
    },
  ]
}

/** Whether a transcript message is this run's card, whatever id the renderer gave it. */
function isCardOf(message: Message, toolCallId: string): boolean {
  return message.toolCalls.some(
    (toolCall) => toolCall.name === CONTAINER_RUN_TOOL && toolCall.id === toolCallId,
  )
}

/**
 * Write a settled run into the thread's model history. Returns the history
 * written, for tests; never throws, since a thread that cannot be read is a
 * diagnostic problem and not a reason to fail the run.
 */
export async function recordContainerRunTurn(
  projectId: string,
  progress: ContainerRunProgress,
  deps: ContainerRunHistoryDeps,
): Promise<LLMMessage[] | null> {
  const [prompt, card] = turnMessages(progress)
  if (!prompt || !card) return null
  const cardToolCallId = card.toolCalls[0]?.id ?? ''
  try {
    const existing = await deps.loadHistory(projectId, progress.threadId)
    let history: LLMMessage[]
    if (existing.length > 0) {
      // The dispatcher wrote earlier turns; this one joins them. Its prompt
      // was added by the renderer, so the sidecar does not have it either.
      history = [...existing, ...rebuildAgentHistory([prompt, card])]
    } else {
      // No sidecar: the thread's history is its transcript, which already
      // holds the prompt and may or may not hold the card yet.
      const thread = await deps.loadThread(projectId, progress.threadId)
      const transcript = (thread?.messages ?? []).filter(
        (message) => !isCardOf(message, cardToolCallId),
      )
      const hasPrompt = transcript.some(
        (message) => message.role === 'user' && message.content === progress.prompt,
      )
      history = rebuildAgentHistory([...transcript, ...(hasPrompt ? [] : [prompt]), card])
    }
    await deps.saveHistory(projectId, progress.threadId, history)
    deps.forgetHistory(projectId, progress.threadId)
    return history
  } catch (error) {
    console.warn('[container-run] could not record the run in the thread history:', error)
    return null
  }
}
