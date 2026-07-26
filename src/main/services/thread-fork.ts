import type {
  ForkedHistoryResult,
  LLMMessage,
  Message,
  ToolResult,
  UserContent,
} from '@shared/types'
import { stripPastePlaceholders } from '@shared/threads/prompt-placeholders.ts'
import { getProjectThread, loadAgentHistory, saveAgentHistory } from './thread-store.ts'

/**
 * Seeding a forked thread's provider-format history (`agent-history.json`).
 *
 * The renderer copies the visible transcript into the new thread; without this
 * the fork would start with an empty LLM context and the model would not
 * remember a word of the conversation the user can see. Two cases:
 *
 * - **Whole-thread fork** — the source sidecar is copied **verbatim**. That is
 *   the highest-fidelity result: it preserves the loop's own additions (nudges,
 *   trimming, the exact tool-call ids) alongside the turns.
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
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- persisted/legacy messages may predate the toolCalls field
  return (message.toolCalls ?? []).map((toolCall) => ({
    toolCallId: toolCall.id,
    result: toolCall.result ?? '',
  }))
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
  for (const message of messages) {
    if (message.role === 'error') continue
    if (message.role === 'user') {
      history.push({ role: 'user', content: userContentOf(message) })
      continue
    }
    const text = message.content.trim()
    if (text) history.push({ role: 'assistant', content: message.content })
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- persisted/legacy messages may predate the toolCalls field
    const toolCalls = message.toolCalls ?? []
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

/**
 * Seed `targetThreadId`'s history from `sourceThreadId`. Both ids are trusted
 * main-process values resolved against the same project. `throughMessageId`
 * selects the partial-fork path; omitting it (or naming the source's last
 * message) copies the sidecar verbatim.
 */
export async function forkThreadHistory(
  projectId: string,
  sourceThreadId: string,
  targetThreadId: string,
  throughMessageId?: string,
): Promise<ForkedHistoryResult> {
  if (sourceThreadId === targetThreadId) {
    throw new Error('Cannot fork a thread onto itself')
  }
  const source = await getProjectThread(projectId, sourceThreadId)
  if (!source)
    throw new Error(`Thread "${sourceThreadId}" does not belong to project "${projectId}"`)

  const isWholeThread =
    throughMessageId === undefined || source.messages.at(-1)?.id === throughMessageId
  if (isWholeThread) {
    const history = await loadAgentHistory(projectId, sourceThreadId)
    // Nothing recorded yet (a thread whose first run never completed): leave the
    // fork without a sidecar so it falls back to fresh provider history.
    if (history.length === 0) return { source: 'empty', messageCount: 0 }
    await saveAgentHistory(projectId, targetThreadId, history)
    return { source: 'copied', messageCount: history.length }
  }

  const slice = sliceThrough(source.messages, throughMessageId)
  if (!slice) throw new Error(`Message "${throughMessageId}" is not in thread "${sourceThreadId}"`)
  const history = rebuildAgentHistory(slice)
  if (history.length === 0) return { source: 'empty', messageCount: 0 }
  await saveAgentHistory(projectId, targetThreadId, history)
  return { source: 'rebuilt', messageCount: history.length }
}
