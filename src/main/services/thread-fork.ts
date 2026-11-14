import type {
  ForkedHistoryResult,
  LLMMessage,
  Message,
  Thread,
  ToolResult,
  UserContent,
} from '@shared/types'
import { isDeepStrictEqual } from 'node:util'
import { stripPastePlaceholders } from '@shared/threads/prompt-placeholders.ts'
import { explicitAgentForMessage } from '@shared/threads/explicit-agent.ts'
import { buildForkedThread } from '@shared/store/fork-thread.ts'
import { isRecord } from '@copse/std/unknown-value.ts'
import {
  assertAcceptedUserMessageIds,
  createThreadWithAgentHistory,
  getProjectThread,
  loadAgentHistory,
} from './thread-store.ts'
import { buildAgentReportHistory } from './agents/custom-agent-strategy.ts'

/**
 * Seeding a forked thread's provider-format history (`agent-history.json`).
 *
 * The renderer copies the visible transcript into the new thread; without this
 * the fork would start with an empty LLM context and the model would not
 * remember a word of the conversation the user can see. Two cases:
 *
 * - **Whole-thread fork** — the source sidecar is copied **verbatim** when it
 *   exists. That is the highest-fidelity result: it preserves the loop's own
 *   additions (nudges, trimming, the exact tool-call ids) alongside the turns.
 *   If no sidecar has been committed yet (for example, the first run is still
 *   in progress), history is rebuilt from the visible transcript instead. A
 *   fork must not show inherited messages that its next model turn cannot see.
 * - **Fork through an earlier message** — the sidecar cannot be cut faithfully.
 *   The agent loop pushes synthetic `user` nudges (truncation, loop, stuck-tool
 *   recovery) into history, so provider `user` messages do not correspond 1:1
 *   with transcript turns and there is no reliable index to cut at. Instead the
 *   history is **rebuilt from the copied transcript**, which is the store's own
 *   record of the conversation. The rebuild reproduces the loop's message shape
 *   exactly (see {@link rebuildAgentHistory}); what it cannot reproduce is
 *   content that only ever existed in the run payload — the fenced blocks that
 *   `buildTextWithAttachments` inlines for `@`-file / `@`-thread / shell chips.
 *   Callers surface that to the user rather than hiding it.
 */

/** Tool results the loop pushes as one `tool` message per step. */
function toolResultsOf(message: Message): ToolResult[] {
  return message.toolCalls.map((toolCall) => {
    const agentName =
      toolCall.name === 'task' && isRecord(toolCall.args)
        ? toolCall.args['subagent_type']
        : undefined
    const result = toolCall.result ?? ''
    return {
      toolCallId: toolCall.id,
      result: typeof agentName === 'string' ? buildAgentReportHistory(agentName, result) : result,
    }
  })
}

function userContentOf(message: Message): UserContent {
  // The stored prompt keeps inline pastes as U+FFFC placeholders; the pasted
  // text only ever existed in the run payload, so the placeholders go too.
  const text = stripPastePlaceholders(message.content)
  const images = message.images ?? []
  if (images.length === 0) return text
  return [
    ...images.map((dataUrl) => ({ type: 'image' as const, dataUrl })),
    { type: 'text' as const, text },
  ]
}

/**
 * Rebuild provider history from a transcript, mirroring how `runAgentLoop`
 * appends to `messages`:
 *
 * - a user turn becomes one `user` message (images first, then text, matching
 *   the composer's own content ordering);
 * - an assistant turn's answer text becomes an `assistant` message;
 * - its tool calls become a second `assistant` message holding only the
 *   tool-call blocks (the loop never mixes text and tool calls in one message),
 *   followed by a single `tool` message carrying every result for that step.
 *
 * `error` messages are app-level transcript notes that were never sent upstream,
 * so they are skipped — as are assistant turns with neither text nor tool calls.
 */
export function rebuildAgentHistory(messages: readonly Message[]): LLMMessage[] {
  const history: LLMMessage[] = []
  for (const [index, message] of messages.entries()) {
    if (message.role === 'error') continue
    if (message.role === 'user') {
      history.push({ role: 'user', content: userContentOf(message) })
      continue
    }
    const text = message.content.trim()
    // A partial fork or missing sidecar must preserve the same provenance as
    // the explicit worker's normal checkpoint, including its visible report.
    const agentName = explicitAgentForMessage(messages, index)
    if (text)
      history.push({
        role: 'assistant',
        content:
          typeof agentName === 'string'
            ? buildAgentReportHistory(agentName, message.content)
            : message.content,
      })
    const toolCalls = message.toolCalls
    if (toolCalls.length === 0) continue
    history.push({
      role: 'assistant',
      content: toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
      })),
    })
    history.push({ role: 'tool', toolResults: toolResultsOf(message) })
  }
  return history
}

/** Transcript slice a fork inherits, ending at `throughMessageId` (inclusive). */
function sliceThrough(messages: readonly Message[], throughMessageId: string): Message[] | null {
  const cut = messages.findIndex((m) => m.id === throughMessageId)
  if (cut === -1) return null
  return messages.slice(0, cut + 1)
}

function settledMessages(thread: Thread): Message[] {
  const queued = new Set((thread.pendingMessages ?? []).map((item) => item.messageId))
  return thread.messages.filter((message) => !queued.has(message.id))
}

function selectedMessages(thread: Thread, throughMessageId?: string): Message[] | null {
  const settled = settledMessages(thread)
  if (throughMessageId === undefined) return settled
  return sliceThrough(settled, throughMessageId)
}

function messageWithoutId(message: Message): Omit<Message, 'id'> {
  const { id: _id, ...rest } = message
  return rest
}

function assertFreshCopiedMessages(
  target: Thread,
  expected: readonly Message[],
  sourceMessages: readonly Message[],
): void {
  if (target.pendingMessages !== undefined) {
    throw new Error('A fork target cannot carry queued messages')
  }
  const sourceIds = new Set(sourceMessages.map((message) => message.id))
  const targetIds = new Set<string>()
  for (const message of target.messages) {
    if (sourceIds.has(message.id) || targetIds.has(message.id)) {
      throw new Error('A fork target must use fresh unique message ids')
    }
    targetIds.add(message.id)
  }
  if (!isDeepStrictEqual(target.messages.map(messageWithoutId), expected.map(messageWithoutId))) {
    throw new Error('Fork target messages do not match the accepted source transcript')
  }
}

async function assertCanonicalForkTarget(
  projectId: string,
  source: Thread,
  target: Thread,
  throughMessageId?: string,
): Promise<{ historySource: Message[]; sourceSnapshots: Thread[] }> {
  if (target.automation !== undefined) {
    throw new Error('A fork target cannot claim automation provenance')
  }
  if (target.sideChat !== undefined) {
    if (
      source.sideChat !== undefined ||
      target.sideChat.parentThreadId !== source.id ||
      target.sideChat.anchorMessageId !== throughMessageId ||
      target.messages.length !== 0
    ) {
      throw new Error('Side-chat target does not match its accepted parent anchor')
    }
    const selected = selectedMessages(source, throughMessageId)
    if (!selected) throw new Error(`Message "${throughMessageId}" is not in thread "${source.id}"`)
    await assertAcceptedUserMessageIds(
      projectId,
      source.id,
      selected.filter((message) => message.role === 'user').map((message) => message.id),
    )
    return { historySource: selected, sourceSnapshots: [source] }
  }

  if (source.sideChat !== undefined) {
    const parent = await getProjectThread(projectId, source.sideChat.parentThreadId)
    if (!parent) throw new Error('The side chat parent is no longer available')
    const parentMessages = selectedMessages(parent, source.sideChat.anchorMessageId)
    const ownMessages = selectedMessages(source)
    if (!parentMessages || !ownMessages) throw new Error('The promoted side chat is incomplete')
    const prefix = buildForkedThread(parent, {
      throughMessageId: source.sideChat.anchorMessageId,
      excludeMessageIds: new Set((parent.pendingMessages ?? []).map((item) => item.messageId)),
    })
    const own = buildForkedThread(source, {
      excludeMessageIds: new Set((source.pendingMessages ?? []).map((item) => item.messageId)),
    })
    const expected = [...(prefix?.messages ?? []), ...(own?.messages ?? [])]
    const selected = [...parentMessages, ...ownMessages]
    assertFreshCopiedMessages(target, expected, selected)
    await assertAcceptedUserMessageIds(
      projectId,
      parent.id,
      parentMessages.filter((message) => message.role === 'user').map((message) => message.id),
    )
    await assertAcceptedUserMessageIds(
      projectId,
      source.id,
      ownMessages.filter((message) => message.role === 'user').map((message) => message.id),
    )
    return { historySource: ownMessages, sourceSnapshots: [parent, source] }
  }

  const selected = selectedMessages(source, throughMessageId)
  if (!selected)
    throw new Error(`Message "${throughMessageId ?? 'latest'}" is not in thread "${source.id}"`)
  const expected = buildForkedThread(source, {
    ...(throughMessageId !== undefined ? { throughMessageId } : {}),
    excludeMessageIds: new Set((source.pendingMessages ?? []).map((item) => item.messageId)),
  })
  if (!expected) throw new Error('There is no accepted transcript to fork')
  assertFreshCopiedMessages(target, expected.messages, selected)
  await assertAcceptedUserMessageIds(
    projectId,
    source.id,
    selected.filter((message) => message.role === 'user').map((message) => message.id),
  )
  return { historySource: selected, sourceSnapshots: [source] }
}

/**
 * Create a fresh fork and seed its provider history from `sourceThreadId` in
 * one store write. The renderer supplies the already-built visible fork, but
 * it cannot name an existing target: `createThreadWithAgentHistory` rejects
 * every pre-existing id under the same per-project write queue.
 * `throughMessageId` selects the partial-fork path; omitting it (or naming the
 * source's last message) copies the sidecar verbatim.
 */
export async function forkThreadHistory(
  projectId: string,
  sourceThreadId: string,
  target: Thread,
  throughMessageId?: string,
): Promise<ForkedHistoryResult> {
  if (sourceThreadId === target.id) {
    throw new Error('Cannot fork a thread onto itself')
  }
  const source = await getProjectThread(projectId, sourceThreadId)
  if (!source)
    throw new Error(`Thread "${sourceThreadId}" does not belong to project "${projectId}"`)
  const canonical = await assertCanonicalForkTarget(projectId, source, target, throughMessageId)

  const isWholeThread =
    throughMessageId === undefined || settledMessages(source).at(-1)?.id === throughMessageId
  let result: ForkedHistoryResult
  let history: LLMMessage[]
  if (isWholeThread) {
    history = await loadAgentHistory(projectId, sourceThreadId)
    if (history.length > 0) {
      result = { source: 'copied', messageCount: history.length }
    } else {
      // The provider snapshot is committed only when a run finishes. Forking a
      // thread during its first run therefore has a visible prompt but no sidecar
      // yet. Rebuild from that transcript so the fork's UI and model context agree.
      history = rebuildAgentHistory(canonical.historySource)
      result = {
        source: history.length === 0 ? 'empty' : 'rebuilt',
        messageCount: history.length,
      }
    }
  } else {
    history = rebuildAgentHistory(canonical.historySource)
    result = {
      source: history.length === 0 ? 'empty' : 'rebuilt',
      messageCount: history.length,
    }
  }
  await createThreadWithAgentHistory(
    projectId,
    target,
    history,
    canonical.sourceSnapshots,
    result.source === 'copied' ? { threadId: sourceThreadId, history } : undefined,
  )
  return result
}
