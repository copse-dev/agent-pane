import type { AgentHost } from '@copse/agent/agent-host.ts'
import { planAgentTextChunk } from '@copse/agent/agent-text-chunk.ts'
import type { StreamChunk } from '@shared/types'
import { classifyAutomationFailureMessage } from '@shared/automation-failure.ts'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  appendAcpContentBlock,
  replaceAcpContentBlocks,
  appendReasoning,
  appendToken,
  addToolCall,
  findToolCallOwner,
  getThreadById,
  setMessageTurnOutcome,
  updateToolCall,
} from '@shared/store/thread-helpers.ts'
import { appendMessage } from '../thread-store.ts'

/**
 * Persists a scheduled automation's turn straight to the thread spine instead
 * of relying on the renderer to echo `agent:chunk` into `appendMessage` calls
 * (see docs/plans/automations.md — that echo only happens for a thread the
 * renderer has loaded). Reuses the real transcript-mutation helpers
 * (`addMessage`/`appendToken`/`addToolCall`/…) against a throwaway, in-memory
 * `AppStore` seeded with just this one thread, so message/tool-call assembly
 * stays identical to the interactive path instead of a second hand-rolled
 * implementation drifting out of sync with it.
 *
 * Deliberately narrower than the renderer's `agent.ts`: handles the chunk
 * types that produce persisted transcript content (text, reasoning, ACP
 * content, tool calls, turn outcome, done) and ignores the rest (usage, subagent_*,
 * panel_update, …), which are UI/metadata-only and not needed for a faithful
 * transcript once the project is next opened.
 */
export interface HeadlessAutomationRun {
  host: AgentHost<StreamChunk>
  /** Add and persist the prompt that starts this turn. */
  appendUserMessage(prompt: string): Promise<void>
  /** Resolve once every `appendMessage` call queued by the run has settled. */
  flush(): Promise<void>
  /** Why the turn failed, from its `turn_outcome`; null when it did not fail. */
  failure(): { code: string; message: string } | null
}

export function createHeadlessAutomationRun(
  projectId: string,
  threadId: string,
): HeadlessAutomationRun {
  const store = createStore({
    threads: [
      {
        id: threadId,
        title: '',
        status: 'running',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })

  let pending: Promise<void> = Promise.resolve()
  const persist = (messageId: string): void => {
    pending = pending.then(async () => {
      const message = getThreadById(store, threadId)?.messages.find((m) => m.id === messageId)
      if (!message) return
      await appendMessage(projectId, threadId, message)
    })
  }

  store.on('message_done', persist)
  store.on('tool_call_started', persist)
  store.on('tool_call_updated', persist)

  let msgId: string | null = null
  let toolSinceText = false
  let currentText = ''
  let acpMessageId: string | null = null
  let acpThoughtMessageId: string | null = null
  const acpMessageOwners: Array<{
    channel: 'message' | 'thought'
    messageId: string
    ownerId: string
  }> = []
  let failure: { code: string; message: string } | null = null

  const startBubble = (): string => addMessage(store, threadId, 'assistant', '')

  const appendText = (text: string): void => {
    const { plan, state } = planAgentTextChunk({ msgId, toolSinceText, currentText }, text)
    if (plan.action === 'ignore') return
    if (plan.startNewMessage) {
      if (plan.finalizeMsgId) persist(plan.finalizeMsgId)
      msgId = startBubble()
    }
    toolSinceText = state.toolSinceText
    currentText = state.currentText ?? ''
    if (msgId === null) return
    appendToken(store, msgId, plan.text)
  }

  /** Reasoning and non-text blocks after a tool call open the next step's bubble. */
  const bubbleAfterTools = (): string => {
    if (!msgId || toolSinceText) {
      if (toolSinceText && msgId) persist(msgId)
      msgId = startBubble()
      toolSinceText = false
      currentText = ''
    }
    return msgId
  }

  const acpOwner = (channel: 'message' | 'thought', messageId: string): string | undefined =>
    acpMessageOwners.find((entry) => entry.channel === channel && entry.messageId === messageId)
      ?.ownerId

  const rememberAcpOwner = (
    channel: 'message' | 'thought',
    messageId: string | undefined,
  ): void => {
    if (messageId === undefined || msgId === null || acpOwner(channel, messageId)) return
    acpMessageOwners.push({ channel, messageId, ownerId: msgId })
  }

  const host: AgentHost<StreamChunk> = {
    emit(chunkThreadId, chunk): void {
      if (chunkThreadId !== threadId) return
      switch (chunk.type) {
        case 'text': {
          appendText(chunk.text)
          return
        }
        case 'reasoning': {
          appendReasoning(store, bubbleAfterTools(), chunk.text)
          return
        }
        case 'acp_content': {
          // Mirrors the renderer's `agent.ts`: a new ACP message id on the same
          // channel closes the current bubble before its content lands.
          const previousId = chunk.channel === 'message' ? acpMessageId : acpThoughtMessageId
          if (
            chunk.messageId !== undefined &&
            previousId !== null &&
            chunk.messageId !== previousId &&
            msgId
          ) {
            persist(msgId)
            msgId = null
            toolSinceText = false
            currentText = ''
          }
          if (chunk.messageId !== undefined) {
            if (chunk.channel === 'message') acpMessageId = chunk.messageId
            else acpThoughtMessageId = chunk.messageId
          }
          if (chunk.content.type !== 'text') {
            appendAcpContentBlock(store, bubbleAfterTools(), chunk.channel, chunk.content)
          } else if (chunk.channel === 'thought') {
            appendReasoning(store, bubbleAfterTools(), chunk.content.text)
          } else {
            // Match the shared reducer: only an ACP message boundary splits text.
            toolSinceText = false
            appendText(chunk.content.text)
          }
          rememberAcpOwner(chunk.channel, chunk.messageId)
          return
        }
        case 'acp_content_replace': {
          let ownerId = acpOwner(chunk.channel, chunk.messageId)
          if (ownerId === undefined) {
            const previousId = chunk.channel === 'message' ? acpMessageId : acpThoughtMessageId
            if (previousId !== null && previousId !== chunk.messageId && msgId) {
              persist(msgId)
              msgId = null
              toolSinceText = false
              currentText = ''
            }
            if (chunk.channel === 'message') acpMessageId = chunk.messageId
            else acpThoughtMessageId = chunk.messageId
            ownerId = bubbleAfterTools()
            rememberAcpOwner(chunk.channel, chunk.messageId)
          }
          replaceAcpContentBlocks(store, ownerId, chunk.channel, chunk.content)
          if (ownerId === msgId && chunk.channel === 'message') {
            currentText = chunk.content
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('')
          }
          return
        }
        case 'tool_call': {
          if (findToolCallOwner(store, threadId, chunk.toolCall.id)) return
          msgId ??= startBubble()
          addToolCall(store, msgId, {
            id: chunk.toolCall.id,
            name: chunk.toolCall.name,
            ...(chunk.toolCall.title !== undefined ? { title: chunk.toolCall.title } : {}),
            ...(chunk.toolCall.programmaticName !== undefined
              ? { programmaticName: chunk.toolCall.programmaticName }
              : {}),
            args: chunk.toolCall.args,
            status: 'running',
            result: null,
            ...(chunk.toolCall.kind !== undefined ? { kind: chunk.toolCall.kind } : {}),
          })
          toolSinceText = true
          return
        }
        case 'tool_call_update': {
          const ownerId = findToolCallOwner(store, threadId, chunk.toolCallId)
          if (!ownerId) return
          updateToolCall(store, ownerId, chunk.toolCallId, {
            ...(chunk.name !== undefined ? { name: chunk.name } : {}),
            ...(chunk.title !== undefined ? { title: chunk.title } : {}),
            ...(chunk.programmaticName !== undefined
              ? { programmaticName: chunk.programmaticName }
              : {}),
            ...(chunk.args !== undefined ? { args: chunk.args } : {}),
            ...(chunk.kind !== undefined ? { kind: chunk.kind } : {}),
            ...(chunk.status !== undefined ? { status: chunk.status } : {}),
            ...(chunk.result !== undefined ? { result: chunk.result } : {}),
            ...(chunk.resultFormat !== undefined ? { resultFormat: chunk.resultFormat } : {}),
            ...(chunk.images !== undefined ? { images: chunk.images } : {}),
            ...(chunk.content !== undefined ? { content: chunk.content } : {}),
            ...(chunk.locations !== undefined ? { locations: chunk.locations } : {}),
            ...(chunk.commandPhase !== undefined ? { commandPhase: chunk.commandPhase } : {}),
          })
          return
        }
        case 'tool_result': {
          const ownerId = findToolCallOwner(store, threadId, chunk.toolCallId) ?? msgId
          if (!ownerId) return
          updateToolCall(store, ownerId, chunk.toolCallId, {
            status: chunk.isError ? 'error' : 'done',
            result: chunk.result,
            ...(chunk.editStats ? { editStats: chunk.editStats } : {}),
            ...(chunk.resultFormat ? { resultFormat: chunk.resultFormat } : {}),
            ...(chunk.appendedReminderLengths
              ? { appendedReminderLengths: chunk.appendedReminderLengths }
              : {}),
            ...(chunk.images ? { images: chunk.images } : {}),
          })
          return
        }
        case 'turn_outcome': {
          // As in the renderer's `agent.ts`: a provider can fail before its first
          // token, so give the outcome an otherwise-empty bubble to persist on.
          msgId ??= startBubble()
          setMessageTurnOutcome(store, threadId, msgId, chunk.outcome)
          const error = chunk.outcome.status === 'failed' ? chunk.outcome.error : undefined
          if (error) {
            failure = {
              code: classifyAutomationFailureMessage(
                `${error.message} ${error.code === undefined ? '' : String(error.code)}`,
              ),
              message: error.message.slice(0, 500),
            }
          }
          return
        }
        case 'done': {
          if (msgId) persist(msgId)
          msgId = null
          toolSinceText = false
          currentText = ''
          return
        }
        default:
          return
      }
    },
  }

  return {
    host,
    async appendUserMessage(prompt: string): Promise<void> {
      const id = addMessage(store, threadId, 'user', prompt)
      persist(id)
      await pending
    },
    async flush(): Promise<void> {
      await pending
    },
    failure(): { code: string; message: string } | null {
      return failure
    },
  }
}
