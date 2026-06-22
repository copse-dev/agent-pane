import type { StreamChunk, UserContent } from './types/index.ts'

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

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/)
  if (!match) {
    throw new Error('Remote agents only support image attachments encoded as base64 data URLs.')
  }
  return { mimeType: match[1]!, data: match[2]! }
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

function parseJsonEventData<T>(event: SseEvent): T {
  try {
    return JSON.parse(event.data) as T
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
    const payload = parseJsonEventData<{ text?: string }>(event)
    if (!payload.text) return []
    state.assistantText += payload.text
    return [{ type: 'text', text: payload.text }]
  }

  if (event.event === 'tool_call') {
    const payload = parseJsonEventData<CursorToolCallEvent>(event)
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
    const payload = parseJsonEventData<{ status?: string; text?: string }>(event)
    state.terminalStatus = payload.status ?? null
    state.resultText = payload.text ?? ''
    if (!state.assistantText && payload.text) {
      state.assistantText = payload.text
      return [{ type: 'text', text: payload.text }]
    }
    return []
  }

  if (event.event === 'error') {
    const payload = parseJsonEventData<{ code?: string; message?: string }>(event)
    const suffix = payload.code ? ` (${payload.code})` : ''
    throw new Error(`Remote agent stream error${suffix}: ${payload.message ?? 'unknown error'}`)
  }

  return []
}
