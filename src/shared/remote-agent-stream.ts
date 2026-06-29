import type { LLMMessage, StreamChunk, UserContent } from './types/index.ts'
import { at } from '@shared/array-utils.ts'

export interface PromptPayload {
  text: string
  images?: Array<{ data: string; mimeType: string }>
}

export interface SseEvent {
  id?: string
  event: string
  data: string
}

export interface RemoteStreamState {
  seenToolCalls: Set<string>
  assistantText: string
  resultText: string
  terminalStatus: string | null
}

interface CursorToolCallEvent {
  callId?: string
  name?: string
  status?: string
  args?: unknown
  result?: unknown
  truncated?: {
    args?: true
    result?: true
  }
}

interface RemoteGitInfo {
  branches?: Array<{ repoUrl?: string; branch?: string; prUrl?: string }>
}

/**
 * Cursor Cloud agents push branches / open PRs rather than editing the local
 * working tree, so the transcript surfaces that as the parity equivalent of the
 * Changes pane for a local chat run.
 */
export function formatRemoteGitSummary(git: RemoteGitInfo | undefined): string {
  const branches = git?.branches?.filter((b) => b.branch) ?? []
  if (branches.length === 0) return ''
  const lines = branches.map((b) => {
    const repo = b.repoUrl ? ` on ${b.repoUrl}` : ''
    const pr = b.prUrl ? ` — ${b.prUrl}` : ''
    return `- Pushed branch \`${String(b.branch)}\`${repo}${pr}`
  })
  return `\n\n---\n_Remote agent updated the repository:_\n${lines.join('\n')}`
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/)
  if (!match) {
    throw new Error('Remote agents only support image attachments encoded as base64 data URLs.')
  }
  return { mimeType: at(match, 1), data: at(match, 2) }
}

export function userContentToText(content: UserContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/** Keep the handoff prompt well under Cursor's input limits; trim the oldest turns first. */
const MAX_CONTEXT_PREAMBLE_CHARS = 16_000

export interface RemoteAgentContextInput {
  /** Prior local conversation for this thread (system/tool turns are ignored). */
  priorMessages: LLMMessage[]
  /** Current local git branch, when the thread is working on one. */
  branch?: string | null
}

/**
 * When a thread is first handed off to a remote agent, the remote machine has no
 * memory of the local chat that preceded it. Dump that context — the prior
 * conversation and the current branch — into the first prompt so the remote agent
 * can pick up where the local chat left off instead of starting cold.
 */
export function buildRemoteAgentContextPreamble(input: RemoteAgentContextInput): string {
  const lines: string[] = []
  for (const message of input.priorMessages) {
    if (message.role === 'user') {
      const text = userContentToText(message.content).trim()
      if (text) lines.push(`User: ${text}`)
    } else if (message.role === 'assistant') {
      if (typeof message.content === 'string') {
        const text = message.content.trim()
        if (text) lines.push(`Assistant: ${text}`)
      } else {
        const tools = message.content.map((call) => call.name).filter(Boolean)
        if (tools.length) lines.push(`Assistant: (used tools: ${tools.join(', ')})`)
      }
    }
    // System prompts and raw tool results are intentionally skipped to keep the
    // handoff compact and free of local-only tooling noise.
  }

  const branch = input.branch?.trim()
  const hasChat = lines.length > 0
  if (!hasChat && !branch) return ''

  const sections: string[] = [
    'You are continuing an existing Copse chat that is now being handed off to you. ' +
      'Use the context below to pick up where it left off.',
  ]
  if (branch) sections.push(`Current branch: \`${branch}\``)
  if (hasChat) {
    let transcript = lines.join('\n\n')
    if (transcript.length > MAX_CONTEXT_PREAMBLE_CHARS) {
      transcript = `…(earlier messages trimmed)…\n\n${transcript.slice(-MAX_CONTEXT_PREAMBLE_CHARS)}`
    }
    sections.push(`--- Prior conversation ---\n${transcript}\n--- End prior conversation ---`)
  }
  return sections.join('\n\n')
}

export function promptPayloadFromUserContent(content: UserContent): PromptPayload {
  if (typeof content === 'string') return { text: content }

  const textBlocks: string[] = []
  const images: Array<{ data: string; mimeType: string }> = []
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text.trim()) textBlocks.push(block.text)
    } else {
      images.push(parseDataUrl(block.dataUrl))
    }
  }

  return images.length
    ? { text: textBlocks.join('\n\n'), images }
    : { text: textBlocks.join('\n\n') }
}

function formatJson(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function isRemoteToolError(value: unknown): boolean {
  return (
    !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'error')
  )
}

function parseJsonEventData(event: SseEvent): unknown {
  try {
    return JSON.parse(event.data)
  } catch {
    throw new Error(`Remote agent stream returned invalid JSON for ${event.event}`)
  }
}

export function parseSseBlock(block: string): SseEvent | null {
  let event = 'message'
  let id: string | undefined
  const dataLines: string[] = []

  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator >= 0 ? line.slice(0, separator) : line
    const rawValue = separator >= 0 ? line.slice(separator + 1) : ''
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue
    if (field === 'event') event = value
    else if (field === 'id') id = value
    else if (field === 'data') dataLines.push(value)
  }

  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n'), ...(id !== undefined ? { id } : {}) }
}

export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (value) {
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = parseSseBlock(block)
        if (event) yield event
        boundary = buffer.indexOf('\n\n')
      }
    }
    if (done) break
  }

  const trailing = buffer.trim()
  if (trailing) {
    const event = parseSseBlock(trailing)
    if (event) yield event
  }
}

export function remoteStreamEventToChunks(
  event: SseEvent,
  state: RemoteStreamState,
): StreamChunk[] {
  if (event.event === 'assistant') {
    const payload = parseJsonEventData(event) as { text?: string }
    if (!payload.text) return []
    state.assistantText += payload.text
    return [{ type: 'text', text: payload.text }]
  }

  if (event.event === 'tool_call') {
    const payload = parseJsonEventData(event) as CursorToolCallEvent
    if (!payload.callId || !payload.name) return []

    const chunks: StreamChunk[] = []
    if (!state.seenToolCalls.has(payload.callId)) {
      state.seenToolCalls.add(payload.callId)
      chunks.push({
        type: 'tool_call',
        toolCall: {
          id: payload.callId,
          name: payload.name,
          args: payload.truncated?.args ? { truncated: true } : (payload.args ?? {}),
        },
      })
    }

    if (payload.status === 'completed') {
      chunks.push({
        type: 'tool_result',
        toolCallId: payload.callId,
        result: payload.truncated?.result
          ? '[Remote tool result truncated]'
          : formatJson(payload.result),
        isError: isRemoteToolError(payload.result),
      })
    }
    return chunks
  }

  if (event.event === 'result') {
    const payload = parseJsonEventData(event) as {
      status?: string
      text?: string
      git?: RemoteGitInfo
    }
    state.terminalStatus = payload.status ?? null
    state.resultText = payload.text ?? ''
    const chunks: StreamChunk[] = []
    if (!state.assistantText && payload.text) {
      state.assistantText = payload.text
      chunks.push({ type: 'text', text: payload.text })
    }
    const gitSummary = formatRemoteGitSummary(payload.git)
    if (gitSummary) chunks.push({ type: 'text', text: gitSummary })
    return chunks
  }

  if (event.event === 'error') {
    const payload = parseJsonEventData(event) as { code?: string; message?: string }
    const suffix = payload.code ? ` (${payload.code})` : ''
    throw new Error(`Remote agent stream error${suffix}: ${payload.message ?? 'unknown error'}`)
  }

  return []
}
