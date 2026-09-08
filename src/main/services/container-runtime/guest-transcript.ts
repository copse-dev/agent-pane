/**
 * The guest's transcript as the launching thread shows it
 * (`docs/plans/thread-in-container.md`, decision A13).
 *
 * The harness in the guest emits the same stream the desktop renders live —
 * text, reasoning, tool calls and their results — but nobody is watching, so
 * the worker folds it into the messages a subagent card holds and writes them
 * beside the result. The host reads them back into the record, and the thread
 * that launched the run gets the run's timeline as a card, persisted with the
 * thread. Folding is close to what `run-subagent.ts` does for a subagent's
 * own loop: text after a tool turn opens a new assistant message, so the
 * timeline reads as prose, the tools it led to, then prose again.
 *
 * Bounded on purpose: a two-hour run's tool output is not something to write
 * into a thread's spine in full. Results are cut at a fixed size and the count
 * of messages is capped, keeping the end of the run, which is where the
 * answer is.
 */
import { z } from 'zod'
import type { StreamChunk, SubagentMessage, ToolCall } from '@shared/types'
import { planAgentTextChunk, type AgentTextChunkState } from '@copse/agent/agent-text-chunk.ts'

/** Longest tool result carried, in characters; the rest is cut with a note. */
export const TRANSCRIPT_RESULT_LIMIT = 8_000
/** Most messages carried; earlier ones are dropped and counted in a marker. */
export const TRANSCRIPT_MESSAGE_LIMIT = 400

function cut(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… (${String(text.length - limit)} more characters not carried)`
}

/**
 * Fold the harness stream into the messages of a subagent timeline. Nested
 * subagent chunks are left out: the run's own loop is the story.
 */
export function foldGuestTranscript(
  chunks: readonly StreamChunk[],
  options: { messageLimit?: number; resultLimit?: number } = {},
): SubagentMessage[] {
  const messageLimit = options.messageLimit ?? TRANSCRIPT_MESSAGE_LIMIT
  const resultLimit = options.resultLimit ?? TRANSCRIPT_RESULT_LIMIT
  const messages: SubagentMessage[] = []
  // A holder rather than a bare `let`: `open` below assigns it, which
  // control-flow narrowing cannot see.
  const cursor: { current: SubagentMessage | null } = { current: null }
  let sequence = 0
  const open = (): SubagentMessage => {
    sequence += 1
    const message: SubagentMessage = {
      id: `guest-${String(sequence)}`,
      role: 'assistant',
      content: '',
      toolCalls: [],
      createdAt: Date.now(),
    }
    cursor.current = message
    messages.push(message)
    return message
  }
  // Text after a tool turn opens a new message, as the desktop's own stream
  // does (`planAgentTextChunk`, shared so the two never disagree): an agent
  // that narrates between commands reads as one message per step, not as one
  // run-on block, and a sentence a tool call interrupted is not stranded.
  let textState: AgentTextChunkState = { msgId: null, toolSinceText: false, currentText: '' }
  const byId = new Map<string, ToolCall>()
  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'text': {
        const { plan, state } = planAgentTextChunk(textState, chunk.text)
        if (plan.action === 'ignore') break
        const message = plan.startNewMessage || cursor.current === null ? open() : cursor.current
        message.content += plan.text
        textState = { ...state, msgId: message.id }
        break
      }
      case 'reasoning': {
        const message = cursor.current === null || textState.toolSinceText ? open() : cursor.current
        message.reasoning = (message.reasoning ?? '') + chunk.text
        textState = { ...textState, msgId: message.id, toolSinceText: false }
        break
      }
      case 'tool_call': {
        const toolCall: ToolCall = {
          id: chunk.toolCall.id,
          name: chunk.toolCall.name,
          args: chunk.toolCall.args,
          status: 'running',
          result: null,
        }
        const message = cursor.current ?? open()
        message.toolCalls.push(toolCall)
        byId.set(toolCall.id, toolCall)
        textState = { ...textState, msgId: message.id, toolSinceText: true }
        break
      }
      case 'tool_result': {
        const toolCall = byId.get(chunk.toolCallId)
        if (!toolCall) break
        toolCall.status = chunk.isError ? 'error' : 'done'
        toolCall.result = cut(chunk.result, resultLimit)
        if (chunk.editStats) toolCall.editStats = chunk.editStats
        if (chunk.resultFormat) toolCall.resultFormat = chunk.resultFormat
        break
      }
      // An external ACP agent reports its tool calls as patches — a title, the
      // input, streamed output, and finally a status — rather than one result.
      // The first real Codex run showed every call as failed because these
      // were ignored and the end-of-run rule below took "never answered" for
      // "failed".
      case 'tool_call_update': {
        const toolCall = byId.get(chunk.toolCallId)
        if (!toolCall) break
        if (chunk.name !== undefined) toolCall.name = chunk.name
        if (chunk.args !== undefined) toolCall.args = chunk.args
        if (chunk.status !== undefined) toolCall.status = chunk.status
        if (chunk.result !== undefined) toolCall.result = cut(chunk.result, resultLimit)
        if (chunk.resultFormat !== undefined) toolCall.resultFormat = chunk.resultFormat
        break
      }
      default:
        break
    }
  }
  // A call the stream never answered — the run was stopped mid-tool — is not
  // still running now that the guest is gone.
  for (const toolCall of byId.values()) {
    if (toolCall.status === 'running') {
      toolCall.status = 'error'
      toolCall.result = 'no result: the run ended before this tool finished'
    }
  }
  const kept = messages.filter(
    (message) =>
      message.content.length > 0 || message.toolCalls.length > 0 || message.reasoning !== undefined,
  )
  if (kept.length <= messageLimit) return kept
  const dropped = kept.length - messageLimit
  return [
    {
      id: 'guest-dropped',
      role: 'assistant',
      content: `… ${String(dropped)} earlier message${dropped === 1 ? '' : 's'} not carried`,
      toolCalls: [],
      createdAt: kept[0]?.createdAt ?? Date.now(),
    },
    ...kept.slice(dropped),
  ]
}

/**
 * What the run came to, in the agent's words: the last message with prose,
 * which is the report the desktop would show last. Not the raw assistant
 * text of the turn — under an ACP harness that is every narration between
 * commands run together with nothing between them.
 */
export function finalGuestText(messages: readonly SubagentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.content.trim() ?? ''
    if (content.length > 0) return content
  }
  return ''
}

const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.unknown(),
  status: z.enum(['running', 'done', 'error']),
  result: z.string().nullable(),
  editStats: z.object({ additions: z.number(), deletions: z.number() }).optional(),
  kind: z.string().optional(),
  resultFormat: z.literal('markdown').optional(),
})

const messageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  toolCalls: z.array(toolCallSchema),
  createdAt: z.number().optional(),
  reasoning: z.string().optional(),
})

/** The transcript file as the host reads it back; null when it is not one. */
export function decodeGuestTranscript(value: unknown): SubagentMessage[] | null {
  const parsed = z.array(messageSchema).safeParse(value)
  if (!parsed.success) return null
  return parsed.data.map(({ createdAt, reasoning, toolCalls, ...message }) => ({
    ...message,
    toolCalls: toolCalls.map(({ editStats, kind, resultFormat, ...toolCall }) => ({
      ...toolCall,
      ...(editStats !== undefined ? { editStats } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(resultFormat !== undefined ? { resultFormat } : {}),
    })),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  }))
}

/** Where the guest's checkout lives; the same as `GUEST_WORKSPACE` in the runner. */
const GUEST_WORKSPACE_PREFIX = '/workspace/repo/'

/**
 * Turn the guest's absolute paths into checkout-relative ones, so a link the
 * agent wrote (`/workspace/repo/src/main/index.ts:214`) opens the same file
 * on the desktop. A path the guest alone had — a scratch log under `.tmp/`
 * that never came back — stays a dead link, which is the truth.
 */
export function relocateGuestPaths(text: string): string {
  return text.split(GUEST_WORKSPACE_PREFIX).join('')
}

/** The transcript with every guest path relocated: prose, reasoning and tool results. */
export function relocateTranscript(messages: SubagentMessage[]): SubagentMessage[] {
  return messages.map((message) => ({
    ...message,
    content: relocateGuestPaths(message.content),
    ...(message.reasoning !== undefined
      ? { reasoning: relocateGuestPaths(message.reasoning) }
      : {}),
    toolCalls: message.toolCalls.map((toolCall) => ({
      ...toolCall,
      result: toolCall.result === null ? null : relocateGuestPaths(toolCall.result),
    })),
  }))
}
